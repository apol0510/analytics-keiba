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
import { fileURLToPath } from 'url';
import {
  buildRaceSanrenpuku,
  checkSanrenpukuHit,
  formatSanrenpukuLine,
} from '../src/utils/sanrenpukuBetting.js';

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

async function fetchResultJson(date, venueCode) {
  const [y, m] = date.split('-');
  const url = `https://raw.githubusercontent.com/apol0510/keiba-data-shared/main/nankan/results/${y}/${m}/${date}-${venueCode}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`result fetch failed (${res.status}): ${url}`);
  return res.json();
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
const NORMAL_SETTLEMENT_POINTS_PER_RACE = 12;

function specToSummary(spec) {
  if (!spec) return null;
  return {
    line: formatSanrenpukuLine(spec),
    // 表示用: 実際の組合せ数 (展開後)
    expandedPoints: spec.points || (Array.isArray(spec.lines) ? spec.lines.length : 0),
  };
}

async function processDay({ date, venueSlug, venueCode, venue }) {
  const result = await fetchResultJson(date, venueCode);
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
      // 通常買い目の集計用点数（馬単と同じ「上限点数」運用、12点固定）
      settlementPoints: NORMAL_SETTLEMENT_POINTS_PER_RACE,
      narrow: specToSummary(built.narrow),
      normalHonmeiAxis: specToSummary(built.normalHonmeiAxis),
      normalTaikouAxis: specToSummary(built.normalTaikouAxis),
    });
  }

  // 通常買い目は 1レース 12 点で集計（馬単と同じ思想）
  const totalBetPoints = races.length * NORMAL_SETTLEMENT_POINTS_PER_RACE;
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
    settlementPointsPerRace: NORMAL_SETTLEMENT_POINTS_PER_RACE,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const arch = JSON.parse(readFileSync(ARCH_PATH, 'utf-8'));
  let targets = [];
  if (args.batch) {
    targets = detectBatchTargets();
  } else if (args.date) {
    const venueSlug = (args.venue || '').toLowerCase();
    if (!VENUE_MAP[venueSlug]) throw new Error(`Unknown venue: ${args.venue}`);
    const venueCode = args.venueCode || VENUE_MAP[venueSlug].code;
    targets = [{ date: args.date, venueSlug, venueCode, venue: VENUE_MAP[venueSlug].name }];
  } else {
    throw new Error('Usage: --date YYYY-MM-DD --venue funabashi | --batch');
  }

  for (const t of targets) {
    try {
      const data = await processDay(t);
      const [y, m, d] = t.date.split('-');
      if (!arch[y]) arch[y] = {};
      if (!arch[y][m]) arch[y][m] = {};
      arch[y][m][d] = data;
      console.log(
        `✅ ${t.date} ${t.venue}: ${data.hitRaces}/${data.totalRaces} hits, ` +
        `¥${data.totalPayout} payout, ${data.recoveryRate}% rate, ${data.totalBetPoints}pt total`
      );
    } catch (e) {
      console.warn(`⏭️  ${t.date} ${t.venue}: skip (${e.message})`);
    }
  }

  writeFileSync(ARCH_PATH, JSON.stringify(arch, null, 2));
  console.log(`Wrote ${ARCH_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
