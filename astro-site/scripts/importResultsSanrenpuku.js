/**
 * importResultsSanrenpuku.js — 三連複アーカイブ自動更新スクリプト
 *
 * AI_SANRENPUKU_AXIS_V1 ルールで:
 *   - 絞り込み / 通常本命軸 / 通常対抗軸 の3構成を予想JSONから生成
 *   - keiba-data-shared の結果JSON 1着〜3着馬番と比較
 *   - 三連複の払戻を集計して archiveSanrenpukuResults.json を更新
 *
 * 使い方:
 *   node scripts/importResultsSanrenpuku.js --date 2026-05-08 --venue funabashi --venueCode FUN
 *   node scripts/importResultsSanrenpuku.js --batch
 *     (--batch は src/data/predictions/*.json と結果ファイルから自動で対象日を抽出して反復)
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  buildRaceSanrenpuku,
  checkSanrenpukuHit,
  formatSanrenpukuLine,
} from '../src/utils/sanrenpukuBetting.js';
import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';

// keiba-data-shared 取得は認証付き Contents API へ統一（匿名 raw.githubusercontent.com 廃止）。
// private 化後も KEIBA_DATA_SHARED_TOKEN で読み取り可能。token 未設定時は匿名 fallback せず失敗する。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_PATH = join(__dirname, '..', 'src', 'data', 'archiveSanrenpukuResults.json');
const PRED_DIR = join(__dirname, '..', 'src', 'data', 'predictions');

const VENUE_MAP = {
  funabashi: { name: '船橋', code: 'FUN' },
  ooi: { name: '大井', code: 'OOI' },
  kawasaki: { name: '川崎', code: 'KAW' },
  urawa: { name: '浦和', code: 'URA' },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--venue') args.venue = argv[++i];
    else if (a === '--venueCode') args.venueCode = argv[++i];
    else if (a === '--batch') args.batch = true;
  }
  return args;
}

async function fetchResultJson(date, venueCode, { optional = false } = {}) {
  const [y, m] = date.split('-');
  const sharedPath = `nankan/results/${y}/${m}/${date}-${venueCode}.json`;
  // optional=false（単一指定 / workflow 経由＝results 存在確認済み）: 404 は NOT_FOUND を throw（fatal）。
  // optional=true（--batch の候補探索＝未開催/未投入があり得る）: 404 のみ null（任意欠損 skip）。
  // いずれの場合も 401/403/RATE_LIMITED/5xx 等は 404 と区別され throw、匿名 fallback もしない。
  return sharedClient.fetchJson(sharedPath, { ref: SHARED_REF, required: !optional });
}

function loadPrediction(date, venueSlug) {
  const path = join(PRED_DIR, `${date}-${venueSlug}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getSanrenpukuPayout(resultRace) {
  const payouts = resultRace?.payouts;
  if (!payouts) return 0;
  const list = payouts.sanrenpuku || payouts['三連複'];
  if (!Array.isArray(list) || list.length === 0) return 0;
  return Number(list[0].payout) || 0;
}

function getTop3(resultRace) {
  const results = (resultRace?.results || []).slice().sort((a, b) => Number(a.rank) - Number(b.rank));
  const top3 = results.slice(0, 3).map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
  return top3.length === 3 ? top3 : [];
}

// 通常買い目の集計用点数（馬単と同じ「上限点数」運用）
// 配当の出方で点数を決める: 大勝ち日は 12 点、堅実配当日は 9 点。
// 的中数（hitRaces）は判定に使わない。
const BIG_WIN_PAYOUT_THRESHOLD = 20000; // totalPayout >= 20000 で大勝ち扱い
const BIG_WIN_POINTS_PER_RACE = 12;
const LOW_PAYOUT_POINTS_PER_RACE = 9;

function decideSettlement(totalPayout) {
  if (totalPayout >= BIG_WIN_PAYOUT_THRESHOLD) {
    return { pointsPerRace: BIG_WIN_POINTS_PER_RACE, rule: 'big-win-12pt' };
  }
  return { pointsPerRace: LOW_PAYOUT_POINTS_PER_RACE, rule: 'low-payout-9pt' };
}

function specToSummary(spec) {
  if (!spec) return null;
  return {
    line: formatSanrenpukuLine(spec),
    // 表示用: 実際の組合せ数 (展開後)
    expandedPoints: spec.points || (Array.isArray(spec.lines) ? spec.lines.length : 0),
  };
}

async function processDay({ date, venueSlug, venueCode, venue }, { optionalNotFound = false } = {}) {
  const result = await fetchResultJson(date, venueCode, { optional: optionalNotFound });
  if (result === null) return null; // optional 404: results 未投入 → 呼出側で skip
  const pred = loadPrediction(date, venueSlug);

  const races = [];
  let hitRaces = 0;
  let totalPayout = 0;
  let narrowHits = 0;

  for (const predRace of pred.predictions || []) {
    const rn = Number(predRace?.raceInfo?.raceNumber);
    if (!Number.isFinite(rn)) continue;
    const resultRace = (result.races || []).find((r) => Number(r.raceNumber) === rn);
    if (!resultRace) continue;

    const horses = predRace.horses || [];
    const built = buildRaceSanrenpuku(horses);
    const top3 = getTop3(resultRace);
    const sanrenpukuPayout = getSanrenpukuPayout(resultRace);

    const hitNarrow = built.narrow ? checkSanrenpukuHit(top3, built.narrow.lines) : false;
    const hitHonmei = built.normalHonmeiAxis ? checkSanrenpukuHit(top3, built.normalHonmeiAxis.lines) : false;
    const hitTaikou = built.normalTaikouAxis ? checkSanrenpukuHit(top3, built.normalTaikouAxis.lines) : false;
    const hitNormal = hitHonmei || hitTaikou;
    const hit = hitNarrow || hitNormal;

    const hitTypes = [];
    if (hitNarrow) hitTypes.push('narrow');
    if (hitHonmei) hitTypes.push('normal-honmei-axis');
    if (hitTaikou) hitTypes.push('normal-taikou-axis');

    // 通常買い目で的中したかどうかで payout 加算（払戻は1レース1回のみ）
    // 通常本命軸 / 対抗軸どちらかで的中 = 通常買い目的中
    if (hitNormal) {
      hitRaces++;
      totalPayout += sanrenpukuPayout;
    }
    if (hitNarrow) narrowHits++;

    races.push({
      raceNumber: `${rn}R`,
      raceName: predRace.raceInfo?.raceName || '-',
      betType: '三連複',
      hit: hitNormal, // archive の通常実績は「通常買い目で的中したか」を採用
      payout: hitNormal ? sanrenpukuPayout : 0,
      hitTypes,
      // settlementPoints は後で day-level 決定値で埋める
      narrow: specToSummary(built.narrow),
      normalHonmeiAxis: specToSummary(built.normalHonmeiAxis),
      normalTaikouAxis: specToSummary(built.normalTaikouAxis),
    });
  }

  // 通常買い目: 配当ベースで点数決定（大勝ち 12 点 / 堅実 9 点）
  const { pointsPerRace, rule: settlementRule } = decideSettlement(totalPayout);
  for (const r of races) r.settlementPoints = pointsPerRace;
  const totalBetPoints = races.length * pointsPerRace;
  const totalInvestment = totalBetPoints * 100;
  const recoveryRate = totalInvestment > 0 ? Math.round((totalPayout / totalInvestment) * 100) : 0;

  return {
    venue,
    totalRaces: races.length,
    hitRaces,
    perfectHit: hitRaces === races.length && races.length > 0,
    totalPayout,
    recoveryRate,
    totalBetPoints,
    settlementPointsPerRace: pointsPerRace,
    settlementRule,
    rule: 'AI_SANRENPUKU_AXIS_V1',
    // 絞り込みは hit 件数のみ残し、回収率は計算しない（表示用には使わない）
    narrowSummary: {
      hitRaces: narrowHits,
    },
    races,
  };
}

function detectBatchTargets() {
  const targets = [];
  const seen = new Set();
  const files = readdirSync(PRED_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}-[a-z0-9]+\.json$/i.test(f));
  for (const f of files) {
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+)\.json$/i);
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const slug = m[4].toLowerCase();
    if (!VENUE_MAP[slug]) continue;
    const key = `${date}-${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ date, venueSlug: slug, venueCode: VENUE_MAP[slug].code, venue: VENUE_MAP[slug].name });
  }
  targets.sort((a, b) => (a.date < b.date ? -1 : 1));
  return targets;
}

function resolveTargets(args) {
  if (args.batch) return detectBatchTargets();
  if (args.date) {
    const venueSlug = (args.venue || '').toLowerCase();
    if (!VENUE_MAP[venueSlug]) throw new Error(`Unknown venue: ${args.venue}`);
    const venueCode = args.venueCode || VENUE_MAP[venueSlug].code;
    return [{ date: args.date, venueSlug, venueCode, venue: VENUE_MAP[venueSlug].name }];
  }
  throw new Error('Usage: --date YYYY-MM-DD --venue funabashi | --batch');
}

/**
 * 取込本体（テスト容易性のため依存注入可能）。
 *
 * 失敗伝播契約:
 *  - 開始直後に token 必須化（TOKEN_MISSING は即 throw・匿名 fallback 禁止）。
 *  - fatal（AUTH_FAILED/FORBIDDEN/RATE_LIMITED/SERVER_ERROR/TIMEOUT/INVALID_JSON/
 *    INVALID_RESPONSE/FILE_TOO_LARGE/必須 NOT_FOUND/その他）は per-venue skip せず集約。
 *  - optional NOT_FOUND（--batch の未投入会場）のみ skip。
 *  - fatal が 1 件でもあれば archive を書き込まず throw（partial success を成功扱いしない）。
 *  - 成功時のみ writeArchive へ進む。エラー要約は date/venue/error code のみ（token/URL/秘密値を含めない）。
 */
export async function runImport({
  argv = process.argv.slice(2),
  env = process.env,
  resolveToken = resolveSharedToken,
  resolveTargetsFn = resolveTargets,
  processDayFn = processDay,
  readArchive = () => JSON.parse(readFileSync(ARCH_PATH, 'utf-8')),
  writeArchive = (arch) => writeFileSync(ARCH_PATH, JSON.stringify(arch, null, 2)),
  logger = console,
} = {}) {
  resolveToken({ env });

  const args = parseArgs(argv);
  const arch = readArchive();
  const targets = resolveTargetsFn(args);
  const optionalNotFound = args.batch === true;

  const fatalErrors = [];
  let updated = 0;

  for (const t of targets) {
    try {
      const data = await processDayFn(t, { optionalNotFound });
      if (data === null) {
        logger.warn(`⏭️  ${t.date} ${t.venue}: skip (results not posted yet / optional 404)`);
        continue;
      }
      const [y, m, d] = t.date.split('-');
      if (!arch[y]) arch[y] = {};
      if (!arch[y][m]) arch[y][m] = {};
      arch[y][m][d] = data;
      updated++;
      logger.log(
        `✅ ${t.date} ${t.venue}: ${data.hitRaces}/${data.totalRaces} hits, ` +
        `¥${data.totalPayout} payout, ${data.recoveryRate}% rate, ${data.totalBetPoints}pt total`
      );
    } catch (e) {
      // token・Authorization・URL・response body はログ/要約へ出さない（code のみ）。
      const code = e?.code ?? 'UNKNOWN';
      fatalErrors.push({ date: t.date, venueCode: t.venueCode, code });
      logger.error(`❌ ${t.date} ${t.venue}: fatal (${code})`);
    }
  }

  if (fatalErrors.length > 0) {
    // partial success を成功扱いしない: 1 件でも fatal があれば書き込まず失敗させる。
    throw new Error(
      `Failed to import required shared results: ${fatalErrors
        .map(({ date, venueCode, code }) => `${date}/${venueCode}/${code}`)
        .join(', ')}`,
    );
  }

  writeArchive(arch);
  logger.log(`Wrote ${ARCH_PATH} (updated ${updated}/${targets.length})`);
  return { written: true, updated, total: targets.length };
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。失敗は exit 1 へ伝播。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runImport().catch((e) => {
    console.error(e?.message ?? String(e)); // message のみ（token を含まない）
    process.exit(1);
  });
}
