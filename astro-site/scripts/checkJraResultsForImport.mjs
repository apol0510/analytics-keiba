#!/usr/bin/env node

/**
 * checkJraResultsForImport.mjs — JRA results の取込要否を shared の per-venue 正本で判定する
 *
 * ## なぜ必要か
 *
 * `import-results-jra-daily.yml` は `checkSharedDailyFile.mjs --date "$DATE"` を使い、
 * **統合 daily ファイル**（`jra/results/YYYY/MM/YYYY-MM-DD.json`）だけを見ていた。
 * keiba-data-shared の JRA results 正本は **per-venue**
 * （`jra/results/2026/08/2026-08-08-CHU.json`）で統合ファイルは存在しないため、
 * `FOUND` は常に false → `has_missing=false` → **取込が一度も起動しない**。
 * 実開催日（例 2026-08-08 は CHU/NII/SAP で 36R）でも「results 無し」と誤判定していた。
 * verify-archive-sync の同型ノーオペ（PR #277 で修正）と同じ根因。
 *
 * ## 判定の考え方
 *
 * 開催会場を暦や決め打ちで推測しない。月ディレクトリ一覧から
 * `YYYY-MM-DD-{CODE}.json` に一致するファイルを拾い、**shared に実在するものだけ**を
 * その日の開催会場とする。`EXPECTED_VENUES` はその実在会場数であり、
 * workflow 側の「archive 済み会場数 < 実在会場数なら再取込」判定にそのまま使える
 * （旧 unified 実装の `EXPECTED_VENUES`＝data.races の venue ユニーク数と同義）。
 *
 * 「予想はあるが results がまだ無い」（＝当日の未完了/未投入）と
 * 「そもそも非開催」を区別するため、computer 予想の有無も一覧 1 GET で見る。
 * racebook は前倒し/日付誤りの stray があるため根拠にしない。
 *
 * ## API GET の最小化
 *
 * results / predictions の月ディレクトリ一覧をそれぞれ 1 回だけ取り cache する
 * （同一 run で同じディレクトリを二度取らない）。件数が要る results の実在ファイルだけ GET し、
 * 非開催日にはファイル GET を撃たない。
 *
 * ## 使い方
 *   node scripts/checkJraResultsForImport.mjs --date 2026-08-08
 *
 * ## stdout（機械可読。token / response body は出さない）
 *   FOUND=true
 *   STATE=complete
 *   RESULT_VENUES=CHU,NII,SAP
 *   EXPECTED_VENUES=3
 *   TOTAL_RACES=36
 *   DEFERRED=false
 *   UNKNOWN_VENUE_CODES=
 *
 * STATE:
 *   complete    … 実在会場すべてが 1 会場あたり閾値以上のレース数を持つ
 *   partial     … results はあるが未完了の会場がある（当日の投入途中など）
 *   not_posted  … 予想はあるが results が 1 件も無い
 *   no_race     … results も予想も無い＝非開催
 *   deferred    … 一時エラーで確定できなかった
 *
 * ## exit code
 *   0 … 判定できた（FOUND の真偽を問わない）
 *   2 … 一時エラー（rate limit / timeout / 5xx）で確定不能＝deferred。呼び出し側は取込を見送る
 *   1 … token 未設定 / 401 / 権限不足 / schema 不一致 ＝ fail-closed（成功扱いしない）
 *
 * 「取得できなかった」を「results 無し」に丸めない（偽の false を作らない）。
 */

import { pathToFileURL } from 'node:url';
import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';
import { createMonthIndex, isTransientSharedFetchError, EXIT_TRANSIENT } from './lib/sharedCheckerSupport.mjs';
import { venuesFromNames, ArchiveCoverageSchemaError, JRA_VENUES } from './checkArchiveCoverage.mjs';

const SHARED_REF = 'main';

/** 1 会場あたりこのレース数以上そろっていれば「その会場は完了」とみなす。 */
export const MIN_RACES_PER_VENUE = 10;

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_DEFERRED = EXIT_TRANSIENT; // 2

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') args.date = argv[++i];
  }
  return args;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {object} [options.client] sharedFetch クライアント（テスト用に注入可）
 * @param {Function} [options.resolveToken]
 * @param {object} [options.logger]
 * @returns {Promise<{found: boolean, state: string, resultVenues: string[], expectedVenues: number,
 *   totalRaces: number, deferred: boolean, unknownVenueCodes: string[]}>}
 *   fatal（token/auth/権限/schema）は throw する。
 */
export async function checkJraResultsForImport({
  argv = process.argv.slice(2),
  env = process.env,
  client: injectedClient,
  resolveToken = resolveSharedToken,
  logger = console,
} = {}) {
  const args = parseArgs(argv);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error('Usage: --date YYYY-MM-DD');
  }

  resolveToken({ env }); // token 未設定は HTTP 到達前に fatal（匿名 fallback 禁止）

  const client = injectedClient ?? createSharedClient({ env });
  const monthIndex = createMonthIndex(client, SHARED_REF);

  const [y, m] = args.date.split('-');
  const resultsDir = `jra/results/${y}/${m}`;
  const predictionsDir = `jra/predictions/computer/${y}/${m}`;

  // 同一 run で同じ月ディレクトリを二度取らない
  const nameCache = new Map();
  async function listNames(dir) {
    if (nameCache.has(dir)) return nameCache.get(dir);
    const entries = await client.listDirectory(dir, { ref: SHARED_REF, required: false });
    const names = entries === null ? [] : entries.filter((e) => e.type === 'file').map((e) => e.name);
    nameCache.set(dir, names);
    return names;
  }

  const empty = {
    found: false,
    state: 'deferred',
    resultVenues: [],
    expectedVenues: 0,
    totalRaces: 0,
    deferred: true,
    unknownVenueCodes: [],
  };

  let resultNames;
  let predictionNames;
  try {
    resultNames = await listNames(resultsDir);
    predictionNames = await listNames(predictionsDir);
  } catch (error) {
    // 一時エラーだけ deferred。token/認証/権限は上へ投げて fail-closed。
    if (!isTransientSharedFetchError(error)) throw error;
    logger.error(`⚠️  ${args.date}: 一時エラー（${error.code}）— 取込判定を見送る`);
    return empty;
  }

  const res = venuesFromNames(resultNames, args.date, JRA_VENUES);
  const pred = venuesFromNames(predictionNames, args.date, JRA_VENUES);
  const unknownVenueCodes = [...new Set([...res.unknown, ...pred.unknown])];

  // 件数は実在ファイルからしか得られないので、ここだけ GET する。
  const resultVenues = [];
  let totalRaces = 0;
  let incompleteVenue = false;

  for (const code of res.found) {
    const sharedPath = `${resultsDir}/${args.date}-${code}.json`;
    let data;
    try {
      data = await client.fetchJson(sharedPath, { ref: SHARED_REF, required: false });
    } catch (error) {
      if (!isTransientSharedFetchError(error)) throw error;
      logger.error(`⚠️  ${args.date} ${code}: 一時エラー（${error.code}）— 取込判定を見送る`);
      return empty;
    }
    if (data === null) continue; // 一覧取得後に消えた（極めて稀）
    if (!Array.isArray(data.races)) {
      throw new ArchiveCoverageSchemaError('results JSON has no races array', sharedPath);
    }
    const count = data.races.length;
    if (count === 0) continue; // 空ファイルは会場としてカウントしない
    if (count < MIN_RACES_PER_VENUE) incompleteVenue = true;
    resultVenues.push(code);
    totalRaces += count;
    logger.error(`✅ results ${code}: ${count} races`);
  }

  let state;
  if (resultVenues.length > 0) {
    state = incompleteVenue ? 'partial' : 'complete';
  } else if (pred.found.length > 0) {
    state = 'not_posted';
    logger.error(`⏭️  ${args.date}: computer 予想あり（${pred.found.join(',')}）／results 未投入`);
  } else {
    state = 'no_race';
    logger.error(`⏭️  ${args.date}: results も computer 予想も無い＝非開催`);
  }

  // results が 1 件でもあれば取込対象。完了/未完了の差は workflow 側の
  // 「archive 済み会場数 < 実在会場数なら再取込」で自動的に追いつく。
  return {
    found: resultVenues.length > 0,
    state,
    resultVenues,
    expectedVenues: resultVenues.length,
    totalRaces,
    deferred: false,
    unknownVenueCodes,
  };
}

export function formatOutput(r) {
  return (
    `FOUND=${r.found}\n` +
    `STATE=${r.state}\n` +
    `RESULT_VENUES=${r.resultVenues.join(',')}\n` +
    `EXPECTED_VENUES=${r.expectedVenues}\n` +
    `TOTAL_RACES=${r.totalRaces}\n` +
    `DEFERRED=${r.deferred}\n` +
    `UNKNOWN_VENUE_CODES=${r.unknownVenueCodes.join(',')}\n`
  );
}

export function decideExitCode(r) {
  return r.deferred ? EXIT_DEFERRED : EXIT_OK;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  checkJraResultsForImport()
    .then((r) => {
      process.stdout.write(formatOutput(r));
      process.exit(decideExitCode(r));
    })
    .catch((error) => {
      // message のみ（token / response body を含まない）
      process.stderr.write(`${error?.message ?? String(error)}\n`);
      if (error?.sharedPath) process.stderr.write(`  path: ${error.sharedPath}\n`);
      process.exit(EXIT_FATAL);
    });
}
