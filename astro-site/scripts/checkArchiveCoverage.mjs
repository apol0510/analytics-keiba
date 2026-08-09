#!/usr/bin/env node

/**
 * checkArchiveCoverage.mjs — shared（per-venue 構造）と archive の突き合わせ監視
 *
 * ## なぜ必要か
 *
 * 従来 verify-archive-sync.yml は `checkSharedDailyFile.mjs` で
 * **統合 daily ファイル**（`jra/results/YYYY/MM/YYYY-MM-DD.json`）だけを見ていた。
 * しかし keiba-data-shared の正本は **per-venue 構造**
 * （`jra/results/2026/08/2026-08-08-CHU.json`）であり、統合ファイルは存在しない。
 *
 * 結果、実開催日でも常に 404 →「Not found」→ アラート判定に一切入らず
 * 「✅ All dates synchronized」で終わっていた（2026-08-09 に実 run ログで確認。
 * 7日 × 2カテゴリの全14チェックが Not found。08-08 は実際には CHU/NII/SAP で 36R）。
 * つまり **監視が成立しておらず、偽の緑を出していた**。
 *
 * 本 script は shared の現行 per-venue 構造をそのまま読み、archive 欠落を検出する。
 *
 * ## 会場の列挙方法
 *
 * 「その日にどの会場が開催されたか」を暦や決め打ちで推測しない。
 * 月ディレクトリ一覧から `YYYY-MM-DD-{CODE}.json` に一致するファイルを拾う＝
 * **shared に実在するものだけ**を開催会場とみなす。
 *
 * ## API GET の最小化
 *
 * 1 プロセスで N 日ぶんをまとめて処理し、月ディレクトリ一覧を cache する
 * （同一 run 内で同じディレクトリを二度取らない）。
 * results は件数が要るので実在ファイルのみ GET する。predictions は
 * 存在確認だけなので一覧のみで完結し GET しない。
 *
 * ## 使い方
 *   node scripts/checkArchiveCoverage.mjs --category jra --days 7
 *   node scripts/checkArchiveCoverage.mjs --category nankan --days 7
 *
 * 既定では **当日を監視対象に含めない**（当日はレース前で結果が無いのが正常なため）。
 * 調査目的で当日も見たい場合のみ --include-today を付ける。
 *
 * ## stdout（機械可読。token / response body は出さない）
 *   DATE=2026-08-08 STATE=ok RESULT_RACES=36 RESULT_VENUES=CHU,NII,SAP PREDICTION_VENUES=CHU,NII,SAP ARCHIVED=true
 *   ...
 *   ARCHIVE_MISSING_DATES=2026-08-02
 *   NO_RESULTS_DATES=
 *   DEFERRED_DATES=
 *   UNKNOWN_VENUE_CODES=
 *
 * ## exit code
 *   0 … 全日を確定でき、欠落なし
 *   3 … 実データ欠落を検出（archive 未反映 or 予想はあるのに結果なし）＝ Failure
 *   2 … 一時エラー（rate limit / timeout / 5xx）で確定できない日がある＝ deferred。
 *        次回実行で再検証されるので run は落とさない
 *   1 … token 未設定 / 401 / 権限不足 / schema 不一致 ＝ 運用者の対応が要る fatal
 *
 * 欠落があるのに 0 を返すことはない（偽の緑を作らない）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedClient, resolveSharedToken, SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';
import { createMonthIndex, isTransientSharedFetchError, EXIT_TRANSIENT } from './lib/sharedCheckerSupport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_DEFERRED = EXIT_TRANSIENT; // 2
export const EXIT_DATA_GAP = 3;

const SHARED_REF = 'main';

/** 函館は HKD が正準。HAK は keiba-data-shared に存在しない誤コード。 */
const JRA_VENUES = ['TOK', 'KYO', 'HAN', 'NAK', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'];
const NANKAN_VENUES = ['OOI', 'FUN', 'KAW', 'URA'];

const CATEGORY_CONFIG = Object.freeze({
  jra: {
    label: 'JRA',
    venues: JRA_VENUES,
    minRaces: 10,
    resultsDir: (y, m) => `jra/results/${y}/${m}`,
    // 予想の有無は computer 予想で判定する。racebook は出馬表であり、
    // 前倒し/日付誤りの stray が「予想あり」と誤検知されるため根拠にしない。
    predictionsDir: (y, m) => `jra/predictions/computer/${y}/${m}`,
    archiveFile: 'archiveResultsJra.json',
    unifiedResults: false,
  },
  nankan: {
    label: '南関',
    venues: NANKAN_VENUES,
    minRaces: 12,
    resultsDir: (y, m) => `nankan/results/${y}/${m}`,
    predictionsDir: (y, m) => `nankan/predictions/${y}/${m}`,
    archiveFile: 'archiveResults.json',
    unifiedResults: true,
  },
});

/** schema 違反は運用者の対応が要るので transient と混ぜない。 */
export class ArchiveCoverageSchemaError extends Error {
  constructor(message, sharedPath) {
    super(message);
    this.name = 'ArchiveCoverageSchemaError';
    this.sharedPath = sharedPath; // shared 内 path のみ（token を含まない）
  }
}

export function parseArgs(argv) {
  const args = { category: 'jra', days: 7 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--category') args.category = argv[++i];
    else if (argv[i] === '--days') args.days = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--archive') args.archive = argv[++i];
    // 当日を含めるかどうか。既定は含めない（getDateRange の説明を参照）。
    else if (argv[i] === '--include-today') args.includeToday = true;
  }
  return args;
}

/**
 * 監視対象日を JST 基準で「古い→新しい」順に返す。
 *
 * **当日は含めない**（endOffsetDays=1 が既定）。
 * 当日はレースがまだ終わっておらず「予想はあるが結果がない」のが正常な状態なので、
 * 含めると毎日 results_missing の誤アラートが出る
 * （2026-08-09 の実データ回帰で検出。予想 CHU/NII/SAP は投入済み・結果は当然未投入）。
 * 本 workflow は 0:00 JST に走るため、対象の最新日 D-1 はレース終了から数時間経っている。
 *
 * @param {number} days 監視する日数
 * @param {Date} now 現在時刻
 * @param {number} endOffsetDays 最新の監視対象日を「何日前」にするか（既定 1＝前日まで）
 */
export function getDateRange(days, now = new Date(), endOffsetDays = 1) {
  const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const dates = [];
  for (let i = days - 1 + endOffsetDays; i >= endOffsetDays; i--) {
    const d = new Date(jstNow);
    d.setDate(d.getDate() - i);
    dates.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  }
  return dates;
}

/** archive JSON に載っている日付集合。読めない場合は throw（欠落判定を空振りさせない）。 */
export function loadArchivedDates(archivePath) {
  if (!existsSync(archivePath)) {
    throw new ArchiveCoverageSchemaError(`archive file not found: ${archivePath}`, null);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(archivePath, 'utf-8'));
  } catch (e) {
    throw new ArchiveCoverageSchemaError(`archive file is not valid JSON: ${archivePath}`, null);
  }
  if (!Array.isArray(parsed)) {
    throw new ArchiveCoverageSchemaError(`archive file is not an array: ${archivePath}`, null);
  }
  return new Set(parsed.map((e) => e && e.date).filter(Boolean));
}

/**
 * 月一覧のファイル名から、その日に実在する会場コードを取り出す。
 * 既知コード以外は unknown として別に返す（黙って捨てない）。
 */
export function venuesFromNames(names, date, knownVenues) {
  const found = [];
  const unknown = [];
  const re = new RegExp(`^${date}-([A-Za-z0-9]+)\\.json$`);
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    if (knownVenues.includes(m[1])) found.push(m[1]);
    else unknown.push(m[1]);
  }
  // 会場コードの並びは knownVenues の順に正規化（出力を安定させる）
  found.sort((a, b) => knownVenues.indexOf(a) - knownVenues.indexOf(b));
  return { found, unknown };
}

/**
 * 1 日ぶんの shared 実体を読む。
 * @returns {Promise<{resultVenues: string[], resultRaces: number, predictionVenues: string[], unknown: string[]}>}
 */
async function inspectDate({ date, config, client, monthIndex, listNames }) {
  const [y, m] = date.split('-');
  const resultsDir = config.resultsDir(y, m);
  const predictionsDir = config.predictionsDir(y, m);

  const resultNames = await listNames(resultsDir);
  const predictionNames = await listNames(predictionsDir);

  const res = venuesFromNames(resultNames, date, config.venues);
  const pred = venuesFromNames(predictionNames, date, config.venues);

  const unknown = [...new Set([...res.unknown, ...pred.unknown])];

  // 件数は実在ファイルからしか得られないので、ここだけ GET する。
  let resultRaces = 0;
  const resultVenues = [];

  // 南関は統合 results ファイルが使われる日もあるため先に見る。
  if (config.unifiedResults) {
    const unifiedName = `${date}.json`;
    if ((await monthIndex.status(resultsDir, unifiedName)) === 'present') {
      const sharedPath = `${resultsDir}/${unifiedName}`;
      const data = await client.fetchJson(sharedPath, { ref: SHARED_REF, required: false });
      if (data !== null) {
        if (!Array.isArray(data.races)) {
          throw new ArchiveCoverageSchemaError('results JSON has no races array', sharedPath);
        }
        return {
          resultVenues: ['unified'],
          resultRaces: data.races.length,
          predictionVenues: pred.found,
          unknown,
        };
      }
    }
  }

  for (const code of res.found) {
    const sharedPath = `${resultsDir}/${date}-${code}.json`;
    const data = await client.fetchJson(sharedPath, { ref: SHARED_REF, required: false });
    if (data === null) continue; // 一覧取得後に消えた（極めて稀）。件数 0 として扱う。
    if (!Array.isArray(data.races)) {
      throw new ArchiveCoverageSchemaError('results JSON has no races array', sharedPath);
    }
    resultVenues.push(code);
    resultRaces += data.races.length;
  }

  let predictionVenues = pred.found;
  if (config.unifiedResults && predictionVenues.length === 0) {
    // 南関 predictions は統合ファイル運用の日もある（存在確認のみ・GET しない）
    if ((await monthIndex.status(predictionsDir, `${date}.json`)) === 'present') {
      predictionVenues = ['unified'];
    }
  }

  return { resultVenues, resultRaces, predictionVenues, unknown };
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {object} [options.client] sharedFetch クライアント（テスト用に注入可）
 * @param {Function} [options.resolveToken]
 * @param {Date} [options.now]
 * @param {Set<string>} [options.archivedDates] archive 済み日付（テスト用に注入可）
 * @param {object} [options.logger]
 * @returns {Promise<{rows: object[], archiveMissing: string[], noResults: string[], deferred: string[], unknownVenueCodes: string[]}>}
 *   fatal（token/auth/権限/schema）は throw する。
 */
export async function checkArchiveCoverage({
  argv = process.argv.slice(2),
  env = process.env,
  client: injectedClient,
  resolveToken = resolveSharedToken,
  now = new Date(),
  archivedDates: injectedArchivedDates,
  logger = console,
} = {}) {
  const args = parseArgs(argv);
  const config = CATEGORY_CONFIG[args.category];
  if (!config) throw new Error(`Invalid --category: ${args.category} (expected jra|nankan)`);
  if (!Number.isInteger(args.days) || args.days < 1) throw new Error(`Invalid --days: ${args.days}`);

  resolveToken({ env }); // token 未設定は HTTP 到達前に fatal（匿名 fallback 禁止）

  const client = injectedClient ?? createSharedClient({ env });
  const monthIndex = createMonthIndex(client, SHARED_REF);

  // 月一覧は monthIndex と同じ cache を通す（同一 run で同じ dir を二度取らない）
  const nameCache = new Map();
  async function listNames(dir) {
    if (nameCache.has(dir)) return nameCache.get(dir);
    const entries = await client.listDirectory(dir, { ref: SHARED_REF, required: false });
    const names = entries === null ? [] : entries.filter((e) => e.type === 'file').map((e) => e.name);
    nameCache.set(dir, names);
    return names;
  }

  const archivedDates =
    injectedArchivedDates ?? loadArchivedDates(args.archive ?? join(projectRoot, 'src', 'data', config.archiveFile));

  const dates = getDateRange(args.days, now, args.includeToday ? 0 : 1);
  const rows = [];
  const archiveMissing = [];
  const noResults = [];
  const deferred = [];
  const unknownVenueCodes = new Set();

  for (const date of dates) {
    let info;
    try {
      info = await inspectDate({ date, config, client, monthIndex, listNames });
    } catch (error) {
      // 一時エラーだけを deferred にする。schema/auth/token はここで握り潰さず上へ。
      if (!isTransientSharedFetchError(error)) throw error;
      deferred.push(date);
      rows.push({ date, state: 'deferred', resultRaces: 0, resultVenues: [], predictionVenues: [], archived: archivedDates.has(date) });
      logger.error(`⚠️  ${date}: 一時エラー（${error.code}）— 次回実行で再検証`);
      continue;
    }

    for (const u of info.unknown) unknownVenueCodes.add(u);

    const archived = archivedDates.has(date);
    let state;

    if (info.resultRaces >= config.minRaces) {
      if (archived) {
        state = 'ok';
      } else {
        state = 'archive_missing';
        archiveMissing.push(date);
      }
    } else if (info.resultRaces > 0) {
      // 途中まで投入されている段階。欠落と断定しない（次回実行で揃う）。
      state = archived ? 'ok' : 'partial';
    } else if (info.predictionVenues.length > 0) {
      state = 'results_missing';
      noResults.push(date);
    } else {
      state = 'no_race';
    }

    rows.push({
      date,
      state,
      resultRaces: info.resultRaces,
      resultVenues: info.resultVenues,
      predictionVenues: info.predictionVenues,
      archived,
    });
    logger.error(
      `${state === 'ok' || state === 'no_race' ? '✅' : '❌'} ${date}: ${state} ` +
        `(${info.resultRaces}R / results=${info.resultVenues.join(',') || '-'} / pred=${info.predictionVenues.join(',') || '-'})`,
    );
  }

  return { rows, archiveMissing, noResults, deferred, unknownVenueCodes: [...unknownVenueCodes] };
}

export function formatOutput(result) {
  const lines = result.rows.map(
    (r) =>
      `DATE=${r.date} STATE=${r.state} RESULT_RACES=${r.resultRaces} ` +
      `RESULT_VENUES=${r.resultVenues.join(',')} PREDICTION_VENUES=${r.predictionVenues.join(',')} ARCHIVED=${r.archived}`,
  );
  lines.push(`ARCHIVE_MISSING_DATES=${result.archiveMissing.join(',')}`);
  lines.push(`NO_RESULTS_DATES=${result.noResults.join(',')}`);
  lines.push(`DEFERRED_DATES=${result.deferred.join(',')}`);
  lines.push(`UNKNOWN_VENUE_CODES=${result.unknownVenueCodes.join(',')}`);
  return lines.join('\n') + '\n';
}

/** 欠落があれば必ず非ゼロ。無条件 0 は返さない。 */
export function decideExitCode(result) {
  if (result.archiveMissing.length > 0 || result.noResults.length > 0) return EXIT_DATA_GAP;
  if (result.deferred.length > 0) return EXIT_DEFERRED;
  return EXIT_OK;
}

export function classifyFatal(error) {
  if (error instanceof ArchiveCoverageSchemaError) return 'schema';
  if (error instanceof SharedFetchError) {
    if (error.code === SHARED_FETCH_CODES.TOKEN_MISSING) return 'token';
    if (error.code === SHARED_FETCH_CODES.AUTH_FAILED) return 'auth';
    if (error.code === SHARED_FETCH_CODES.FORBIDDEN) return 'forbidden';
  }
  return 'other';
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  checkArchiveCoverage()
    .then((result) => {
      process.stdout.write(formatOutput(result));
      process.exit(decideExitCode(result));
    })
    .catch((error) => {
      // message のみ（token / response body を含まない）
      process.stderr.write(`[${classifyFatal(error)}] ${error?.message ?? String(error)}\n`);
      if (error?.sharedPath) process.stderr.write(`  path: ${error.sharedPath}\n`);
      process.exit(EXIT_FATAL);
    });
}
