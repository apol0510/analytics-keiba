/**
 * importResultsJraSanrenpuku.js — 中央競馬(JRA)三連複アーカイブ自動更新スクリプト
 *
 * importResultsSanrenpuku.js（南関）を土台に、入力ソースだけ JRA 用へ差し替えたもの:
 *   - 予想: src/data/predictions/jra/{y}/{m}/{date}.json（ネスト・マルチ会場 venues[].predictions[]）
 *   - 結果: keiba-data-shared の jra/results（統合 or 会場別マージ、importResultsJra.js の fetchSharedResults を再利用）
 *   - 買い目/的中判定は単一源 sanrenpukuBetting.js（会場非依存・南関と同一ロジック）
 *   - 出力: src/data/archiveSanrenpukuResultsJra.json（南関と同じネスト辞書 {YYYY}{MM}{DD}）
 *
 * 使い方:
 *   node scripts/importResultsJraSanrenpuku.js --date 2026-06-28
 *   node scripts/importResultsJraSanrenpuku.js --batch
 *     (--batch は predictions/jra/**\/{date}.json を走査して対象日を反復。結果未投入日は skip)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  buildRaceSanrenpuku,
  checkSanrenpukuHit,
  formatSanrenpukuLine,
} from '../src/utils/sanrenpukuBetting.js';
import { resolveSharedToken } from './lib/sharedFetch.mjs';
import { fetchSharedResults } from './importResultsJra.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_PATH = join(__dirname, '..', 'src', 'data', 'archiveSanrenpukuResultsJra.json');
const PRED_JRA_DIR = join(__dirname, '..', 'src', 'data', 'predictions', 'jra');

// JRA 会場名 → コード（importResultsJra.js と同一マスタ）
const JRA_VENUE_TO_CODE = {
  '東京': 'TOK', '中山': 'NAK', '京都': 'KYO', '阪神': 'HAN',
  '中京': 'CHU', '小倉': 'KOK', '新潟': 'NII', '福島': 'FKS',
  '札幌': 'SAP', '函館': 'HKD',
};
function venueToCode(venue) {
  if (!venue) return '';
  // 既にコード（TOK 等）ならそのまま、会場名ならコードへ
  if (Object.values(JRA_VENUE_TO_CODE).includes(venue)) return venue;
  return JRA_VENUE_TO_CODE[venue] || venue;
}

// JRA 会場の表示優先順（開催規模の大きい順を基準・merge のソートに使用）
const JRA_VENUE_ORDER = ['TOK', 'NAK', 'KYO', 'HAN', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--batch') args.batch = true;
  }
  return args;
}

function loadPredictionJra(date) {
  const [year, month] = date.split('-');
  const path = join(PRED_JRA_DIR, year, month, `${date}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getSanrenpukuPayout(resultRace) {
  const payouts = resultRace?.payouts;
  if (!payouts) return 0;
  const list = payouts.sanrenpuku || payouts['三連複'];
  if (!Array.isArray(list) || list.length === 0) return 0;
  return Number(list[0].payout) || 0;
}

// JRA 結果は着順ソート済み（results[0]=1着）。rank があればそれで並べ、無ければ配列順を採用。
function getTop3(resultRace) {
  const results = Array.isArray(resultRace?.results) ? resultRace.results.slice() : [];
  const hasRank = results.length > 0 && results.every((r) => Number.isFinite(Number(r.rank)));
  const ordered = hasRank
    ? results.sort((a, b) => Number(a.rank) - Number(b.rank))
    : results;
  const top3 = ordered.slice(0, 3).map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
  return top3.length === 3 ? top3 : [];
}

// 通常買い目の集計点数（南関と同一運用: 大勝ち 12 点 / 堅実 9 点）
const BIG_WIN_PAYOUT_THRESHOLD = 20000;
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
    expandedPoints: spec.points || (Array.isArray(spec.lines) ? spec.lines.length : 0),
  };
}

// 1会場分の dayData を予想会場 + 結果全race から構築（南関 processDay 相当）
function buildVenueDayData(predVenue, resultRaces) {
  const venue = predVenue.venue || predVenue.eventInfo?.venue || 'JRA';
  const venueCode = venueToCode(venue);
  const predRaces = Array.isArray(predVenue.predictions) ? predVenue.predictions : [];

  const races = [];
  let hitRaces = 0;
  let totalPayout = 0;
  let narrowHits = 0;

  for (const predRace of predRaces) {
    const rnRaw = predRace?.raceInfo?.raceNumber;
    const rn = typeof rnRaw === 'string' ? parseInt(rnRaw.replace(/[^0-9]/g, ''), 10) : Number(rnRaw);
    if (!Number.isFinite(rn)) continue;

    // 結果 race を会場コード + レース番号で照合（会場混在の結果配列から）
    const resultRace = resultRaces.find((r) => {
      const rNum = typeof r.raceNumber === 'string'
        ? parseInt(String(r.raceNumber).replace(/[^0-9]/g, ''), 10)
        : Number(r.raceNumber);
      if (rNum !== rn) return false;
      return venueToCode(r.venue) === venueCode;
    });
    if (!resultRace) continue;

    const horses = predRace.horses || [];
    const built = buildRaceSanrenpuku(horses);
    const top3 = getTop3(resultRace);
    const sanrenpukuPayout = getSanrenpukuPayout(resultRace);

    const hitNarrow = built.narrow ? checkSanrenpukuHit(top3, built.narrow.lines) : false;
    const hitHonmei = built.normalHonmeiAxis ? checkSanrenpukuHit(top3, built.normalHonmeiAxis.lines) : false;
    const hitTaikou = built.normalTaikouAxis ? checkSanrenpukuHit(top3, built.normalTaikouAxis.lines) : false;
    const hitNormal = hitHonmei || hitTaikou;

    const hitTypes = [];
    if (hitNarrow) hitTypes.push('narrow');
    if (hitHonmei) hitTypes.push('normal-honmei-axis');
    if (hitTaikou) hitTypes.push('normal-taikou-axis');

    if (hitNormal) {
      hitRaces++;
      totalPayout += sanrenpukuPayout;
    }
    if (hitNarrow) narrowHits++;

    races.push({
      raceNumber: `${rn}R`,
      raceName: predRace.raceInfo?.raceName || '-',
      betType: '三連複',
      hit: hitNormal,
      payout: hitNormal ? sanrenpukuPayout : 0,
      hitTypes,
      narrow: specToSummary(built.narrow),
      normalHonmeiAxis: specToSummary(built.normalHonmeiAxis),
      normalTaikouAxis: specToSummary(built.normalTaikouAxis),
    });
  }

  if (races.length === 0) return null;

  const { pointsPerRace, rule: settlementRule } = decideSettlement(totalPayout);
  for (const r of races) r.settlementPoints = pointsPerRace;
  const totalBetPoints = races.length * pointsPerRace;
  const totalInvestment = totalBetPoints * 100;
  const recoveryRate = totalInvestment > 0 ? Math.round((totalPayout / totalInvestment) * 100) : 0;

  return {
    venue,
    venueCode,
    totalRaces: races.length,
    hitRaces,
    perfectHit: hitRaces === races.length && races.length > 0,
    totalPayout,
    recoveryRate,
    totalBetPoints,
    settlementPointsPerRace: pointsPerRace,
    settlementRule,
    rule: 'AI_SANRENPUKU_AXIS_V1',
    narrowSummary: { hitRaces: narrowHits },
    races: races.map((r) => ({ ...r, venue, venueCode })),
  };
}

/**
 * 同日複数会場(JRA)の dayData を冪等マージする（南関 mergeSanrenpukuDayData の JRA 会場順版）。
 * 契約は南関版と同一: 同一 venueCode の既存 races を置換・別会場は保持・順序非依存。
 */
export function mergeSanrenpukuDayDataJra(existing, incoming) {
  const incomingVenueCode = incoming.venueCode || venueToCode(incoming.venue);
  if (!incomingVenueCode) {
    throw new Error(`mergeSanrenpukuDayDataJra: cannot resolve venueCode for venue="${incoming.venue}"`);
  }

  const incomingRaces = (incoming.races || []).map((r) => ({
    ...r,
    venue: r.venue || incoming.venue,
    venueCode: r.venueCode || incomingVenueCode,
  }));

  if (existing === null) {
    return {
      ...incoming,
      venueCode: incomingVenueCode,
      venues: incoming.venues ?? (incoming.venue ? [incoming.venue] : []),
      races: incomingRaces,
    };
  }

  const existingDayCode = existing.venueCode || venueToCode(existing.venue);
  const existingDayVenue = existing.venue;
  const taggedExistingRaces = (existing.races || []).map((r) => ({
    ...r,
    venue: r.venue || existingDayVenue,
    venueCode: r.venueCode || venueToCode(r.venue) || existingDayCode,
  }));

  const existingRaces = taggedExistingRaces.filter((r) => {
    const code = r.venueCode || venueToCode(r.venue);
    return code !== incomingVenueCode;
  });

  const allRaces = [...existingRaces, ...incomingRaces];

  allRaces.sort((a, b) => {
    const ca = a.venueCode || venueToCode(a.venue) || '';
    const cb = b.venueCode || venueToCode(b.venue) || '';
    const ia = JRA_VENUE_ORDER.indexOf(ca);
    const ib = JRA_VENUE_ORDER.indexOf(cb);
    const sa = ia === -1 ? 999 : ia;
    const sb = ib === -1 ? 999 : ib;
    if (sa !== sb) return sa - sb;
    return (parseInt(String(a.raceNumber), 10) || 0) - (parseInt(String(b.raceNumber), 10) || 0);
  });

  const venueNames = [];
  const seenCodes = new Set();
  for (const r of allRaces) {
    const code = r.venueCode || venueToCode(r.venue);
    if (code && !seenCodes.has(code)) {
      seenCodes.add(code);
      if (r.venue) venueNames.push(r.venue);
    }
  }

  const totalRaces = allRaces.length;
  const hitRaces = allRaces.filter((r) => !!(r.hit ?? r.isHit)).length;
  const totalPayout = allRaces.reduce((s, r) => s + (Number(r.payout) || 0), 0);
  const totalBetPoints = allRaces.reduce((s, r) => s + (Number(r.settlementPoints) || 0), 0);
  const totalInvestment = totalBetPoints * 100;
  const recoveryRate = totalInvestment > 0 ? Math.round((totalPayout / totalInvestment) * 100) : 0;

  return {
    ...existing,
    venue: venueNames.length === 1 ? venueNames[0] : venueNames.join('・'),
    venues: venueNames,
    venueCode: venueNames.length === 1 ? incomingVenueCode : undefined,
    totalRaces,
    hitRaces,
    perfectHit: totalRaces > 0 && hitRaces === totalRaces,
    totalPayout,
    recoveryRate,
    totalBetPoints,
    generatedAt: incoming.generatedAt,
    narrowSummary: {
      hitRaces: allRaces.filter((r) => r.hitTypes?.includes('narrow')).length,
    },
    races: allRaces,
  };
}

// 1日分（全会場）を処理して各会場 dayData を返す
async function processDay(date, { optionalNotFound = false, fetchResults = fetchSharedResults } = {}) {
  const pred = loadPredictionJra(date);
  if (!pred) return null; // 予想が無い日は対象外
  const predVenues = Array.isArray(pred.venues) ? pred.venues : [];
  if (predVenues.length === 0) return null;

  let result;
  try {
    result = await fetchResults(date);
  } catch (e) {
    if (optionalNotFound && e?.code === 'NOT_FOUND') return null;
    // fetchAndMergeVenueResults は未投入時に「結果データが見つかりません」を throw する。
    // --batch では未投入日として skip、単発では fatal 伝播。
    if (optionalNotFound && /結果データが見つかりません/.test(e?.message || '')) return null;
    throw e;
  }
  const resultRaces = Array.isArray(result?.races) ? result.races : [];
  if (resultRaces.length === 0) return null;

  const venueDayDatas = [];
  for (const predVenue of predVenues) {
    const dd = buildVenueDayData(predVenue, resultRaces);
    if (dd) venueDayDatas.push(dd);
  }
  return venueDayDatas.length > 0 ? venueDayDatas : null;
}

function detectBatchTargets() {
  const targets = [];
  if (!existsSync(PRED_JRA_DIR)) return targets;
  for (const year of readdirSync(PRED_JRA_DIR).filter((n) => /^\d{4}$/.test(n))) {
    const yearPath = join(PRED_JRA_DIR, year);
    for (const month of readdirSync(yearPath).filter((n) => /^\d{2}$/.test(n))) {
      const monthPath = join(yearPath, month);
      for (const f of readdirSync(monthPath).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
        targets.push(f.replace(/\.json$/, ''));
      }
    }
  }
  targets.sort();
  return targets;
}

function resolveTargets(args) {
  if (args.batch) return detectBatchTargets();
  if (args.date) return [args.date];
  throw new Error('Usage: --date YYYY-MM-DD | --batch');
}

/**
 * 取込本体（依存注入可能・テスト容易）。失敗伝播契約は南関 importer と同一:
 *  - token 必須化（TOKEN_MISSING は即 throw）
 *  - fatal が 1 件でもあれば archive を書き込まず throw（partial success を成功扱いしない）
 *  - optional NOT_FOUND（--batch の未投入日）のみ skip
 */
export async function runImport({
  argv = process.argv.slice(2),
  env = process.env,
  resolveToken = resolveSharedToken,
  resolveTargetsFn = resolveTargets,
  processDayFn = processDay,
  readArchive = () => (existsSync(ARCH_PATH) ? JSON.parse(readFileSync(ARCH_PATH, 'utf-8')) : {}),
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

  for (const date of targets) {
    try {
      const venueDayDatas = await processDayFn(date, { optionalNotFound });
      if (venueDayDatas === null) {
        logger.warn(`⏭️  ${date}: skip (予想なし / 結果未投入)`);
        continue;
      }
      const [y, m, d] = date.split('-');
      if (!arch[y]) arch[y] = {};
      if (!arch[y][m]) arch[y][m] = {};
      // 会場ごとに冪等マージ（同日複数会場を積み上げ）
      for (const dd of venueDayDatas) {
        arch[y][m][d] = mergeSanrenpukuDayDataJra(arch[y][m][d] ?? null, dd);
      }
      updated++;
      const day = arch[y][m][d];
      logger.log(
        `✅ ${date} ${day.venues?.join('・') || day.venue}: ` +
        `${day.hitRaces}/${day.totalRaces} hits, ¥${day.totalPayout} payout, ${day.recoveryRate}% rate`
      );
    } catch (e) {
      const code = e?.code ?? 'UNKNOWN';
      fatalErrors.push({ date, code });
      logger.error(`❌ ${date}: fatal (${code})`);
    }
  }

  if (fatalErrors.length > 0) {
    throw new Error(
      `Failed to import required JRA shared results: ${fatalErrors
        .map(({ date, code }) => `${date}/${code}`)
        .join(', ')}`,
    );
  }

  writeArchive(arch);
  logger.log(`Wrote ${ARCH_PATH} (updated ${updated}/${targets.length})`);
  return { written: true, updated, total: targets.length };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runImport().catch((e) => {
    console.error(e?.message ?? String(e));
    process.exit(1);
  });
}
