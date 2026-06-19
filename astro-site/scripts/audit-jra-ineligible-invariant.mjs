/**
 * audit-jra-ineligible-invariant.mjs
 *
 * 2026-06-19 不要馬誤判定バグの回帰監査。
 * keiba-data-shared の racebook + computer 実データに対し、AK の実パイプライン
 * （fetchRacebookData 相当の本体組立 → sourceComputerIndex 注入 → normalizeAndAdjust）
 * を再現し、isIneligibleHorse の不変条件を全頭検査する。
 *
 * 旧注入（${馬番}|${馬名} 完全一致）と新注入（race-scoped 馬番主キー helper）の
 * before/after を出力する。
 *
 * 使い方:
 *   node scripts/audit-jra-ineligible-invariant.mjs --date=2026-06-20 [--shared-dir=...] [--category=jra]
 *   npm run audit:jra-ineligible -- --date=2026-06-20
 *   位置引数も後方互換: node ... 2026-06-20 /path/to/keiba-data-shared
 *   既定 shared: 環境変数 KEIBA_DATA_SHARED_DIR、無ければ repo 相対 ../../../keiba-data-shared
 *
 * 終了コード:
 *   0 = PASS
 *   1 = FAIL（真ci>=45の不要馬あり 等 / 日付形式不正）
 *   2 = SKIP（shared/computer データ不足 / JSON破損＝偽PASSしない）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAndAdjust } from '../src/utils/normalizePrediction.js';
import { isHorseNameBroken } from '../src/utils/normalizePrediction.js';
import { isIneligibleHorse, getOsaeCi } from '../src/utils/osaeClassification.js';
import { buildRaceScopedComputerMap, injectSourceComputerIndexRaceScoped, normalizeHorseName } from './lib/computerIndexMatch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const o = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
    else if (a.startsWith('--')) o[a.slice(2)] = true; // bare フラグ
    else o._.push(a);
  }
  return o;
}
const A = parseArgs(process.argv.slice(2));
const DATE = A.date || A._[0] || process.env.AUDIT_DATE;
const SHARED = A['shared-dir'] || A._[1] || process.env.KEIBA_DATA_SHARED_DIR || resolve(__dirname, '..', '..', '..', 'keiba-data-shared');
const CATEGORY = A.category || 'jra';
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error('❌ --date=YYYY-MM-DD 形式で指定してください (exit 1)'); process.exit(1); }
const [Y, M] = DATE.split('-');

// JSON 読込: 不在=null。破損(parse失敗)=入力不足として SKIP(exit 2)。
function loadJson(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.error(`⏭️  SKIP(exit 2): JSON parse 失敗 ${p}: ${e.message}`); process.exit(2); }
}

// 会場コードを computer ディレクトリから自動検出（3会場固定にしない）。VENUES = {code: 会場名}
const compDir = join(SHARED, CATEGORY, 'predictions', 'computer', Y, M);
if (!existsSync(SHARED)) { console.error(`⏭️  SKIP: shared dir なし: ${SHARED}`); process.exit(2); }
if (!existsSync(compDir)) { console.error(`⏭️  SKIP: computer ディレクトリ無し: ${compDir}`); process.exit(2); }
const { readdirSync } = await import('node:fs');
const VENUES = {};
for (const f of readdirSync(compDir)) {
  if (!f.startsWith(`${DATE}-`) || !f.endsWith('.json')) continue;
  const code = f.slice(DATE.length + 1, -5);
  VENUES[code] = (loadJson(join(compDir, f))?.venue) || code;
}
if (Object.keys(VENUES).length === 0) { console.error(`⏭️  SKIP: ${DATE} の ${CATEGORY} computer データ無し (${compDir})`); process.exit(2); }

// fetchRacebookData(importPredictionJra) と同じ本体組立
function rbToSharedVenue(rb) {
  return {
    date: DATE, venue: rb.track || rb.venue, totalRaces: rb.races?.length || 0,
    races: (rb.races || []).map(r => ({
      raceInfo: { raceNumber: `${r.raceNumber}R`, raceName: r.raceClass || '' },
      horses: (r.horses || []).map(h => ({
        number: h.number, name: h.name, totalScore: h.totalScore || 0, assignment: h.assignment || '無',
        jockey: h.jockey || '', trainer: h.trainer || '', seirei: h.sexAge || '',
        kinryo: h.weight != null ? String(h.weight) : '', computerIndex: h.computerIndex || null,
        marks: h.marks || [], ranking: h.ranking || null,
        _pastRaces: Array.isArray(h.pastRaces) ? h.pastRaces.slice(0, 5) : []
      }))
    }))
  };
}
// computer 各会場 → race-scoped 整形（importPredictionJra と同じ）
function compToMapInput(comp) {
  return {
    venue: comp.venue, races: (comp.races || []).map(r => ({
      raceNumber: r.raceNumber,
      horses: (r.horses || []).map(h => ({ number: h.number, name: h.name, computerIndex: h.computerIndex, recentRaces: [] }))
    }))
  };
}
// 旧注入（${num}|${name} 完全一致・venue フラット）
function injectOld(sharedVenue, compVenue) {
  const horseMap = new Map();
  for (const r of (compVenue.races || [])) for (const h of (r.horses || [])) {
    const num = Number(h.number); const name = h.name; const ci = Number(h.computerIndex);
    if (!Number.isFinite(num) || !name) continue;
    horseMap.set(`${num}|${name}`, Number.isFinite(ci) ? ci : null);
  }
  for (const race of (sharedVenue.races || [])) for (const h of (race.horses || [])) {
    const num = Number(h.number); const name = h.name;
    if (!Number.isFinite(num) || !name) continue;
    const ci = horseMap.get(`${num}|${name}`);
    if (Number.isFinite(ci)) h.sourceComputerIndex = ci;
  }
}

const compByCode = {}, rbByCode = {};
for (const code of Object.keys(VENUES)) {
  compByCode[code] = loadJson(join(SHARED, CATEGORY, 'predictions', 'computer', Y, M, `${DATE}-${code}.json`));
  rbByCode[code] = loadJson(join(SHARED, CATEGORY, 'racebook', Y, M, `${DATE}-${code}.json`));
}

// realComp lookup: code -> rn -> number -> {ci,name}
function buildRealComp(comp) {
  const m = new Map();
  for (const r of (comp.races || [])) {
    const rm = new Map();
    for (const h of (r.horses || [])) rm.set(Number(h.number), { ci: Number(h.computerIndex), name: h.name });
    m.set(Number(r.raceNumber), rm);
  }
  return m;
}

function runVariant(useNew) {
  const rows = []; let raceCount = 0;
  let injectStats = { injected: 0, nameRecovered: 0, ambiguous: 0, nameMismatch: 0, unmatched: 0, uncoveredHighCi: 0 };
  for (const [code, venueName] of Object.entries(VENUES)) {
    const comp = compByCode[code]; const rb = rbByCode[code];
    if (!comp || !rb) continue;
    const realComp = buildRealComp(comp);
    const sharedVenue = rbToSharedVenue(rb);
    if (useNew) {
      const map = buildRaceScopedComputerMap([compToMapInput(comp)]);
      const s = injectSourceComputerIndexRaceScoped({ venues: [sharedVenue] }, map, { isNameBroken: isHorseNameBroken });
      injectStats.injected += s.injected; injectStats.nameRecovered += s.nameRecovered;
      injectStats.ambiguous += s.ambiguous; injectStats.nameMismatch += s.nameMismatch;
      injectStats.unmatched += s.unmatched; injectStats.uncoveredHighCi += s.uncoveredHighCi.length;
    } else {
      injectOld(sharedVenue, comp);
    }
    const adjusted = normalizeAndAdjust(sharedVenue);
    for (const race of adjusted.races) {
      raceCount++;
      const rn = Number(String(race.raceNumber).match(/\d+/)?.[0]);
      const rcMap = realComp.get(rn) || new Map();
      for (const h of race.horses) {
        const rc = rcMap.get(Number(h.number));
        rows.push({
          venue: venueName, code, raceNumber: rn, number: Number(h.number),
          name: h.name, realComp: rc?.ci ?? null, compName: rc?.name ?? null,
          role: h.role, osaeCi: getOsaeCi(h),
          classification: isIneligibleHorse(h) ? '不要馬' : 'eligible',
        });
      }
    }
  }
  return { rows, raceCount, injectStats };
}

// 入力データ統計（接頭辞差/PUA/重複馬番/名前差分）
function dataStats() {
  let prefixDiff = 0, pua = 0, dupNumbers = 0, nameDiff = 0, totalHorses = 0;
  for (const code of Object.keys(VENUES)) {
    const comp = compByCode[code], rb = rbByCode[code];
    if (!comp || !rb) continue;
    const compByRn = buildRealComp(comp);
    for (const r of (rb.races || [])) {
      const rn = Number(r.raceNumber); const seen = new Set();
      for (const h of (r.horses || [])) {
        totalHorses++;
        const num = Number(h.number);
        if (seen.has(num)) dupNumbers++; else seen.add(num);
        const cName = compByRn.get(rn)?.get(num)?.name;
        if (isHorseNameBroken(h.name)) pua++;
        else if (cName && normalizeHorseName(cName) === normalizeHorseName(h.name) && cName !== h.name) prefixDiff++;
        else if (cName && normalizeHorseName(cName) !== normalizeHorseName(h.name)) nameDiff++;
      }
    }
  }
  return { prefixDiff, pua, dupNumbers, nameDiff, totalHorses };
}

const before = runVariant(false);
const after = runVariant(true);
const ds = dataStats();

const violB = before.rows.filter(r => r.classification === '不要馬' && r.realComp != null && r.realComp >= 45);
const violA = after.rows.filter(r => r.classification === '不要馬' && r.realComp != null && r.realComp >= 45);

const expectedRaces = Object.values(compByCode).filter(Boolean).reduce((s, c) => s + (c.races?.length || 0), 0);
console.log(`════════ ${CATEGORY.toUpperCase()} 不要馬 不変条件監査 ${DATE} ════════`);
console.log(`shared: ${SHARED}`);
console.log(`会場: ${Object.entries(VENUES).map(([c, n]) => `${n}(${c})`).join(' ')}`);
console.log(`races: ${after.raceCount} (computer由来 期待${expectedRaces}) / horses: ${after.rows.length}`);
console.log(`\n── 入力データ統計 ──`);
console.log(`総出走馬: ${ds.totalHorses} / 接頭辞差(racebook無 vs computer有): ${ds.prefixDiff} / PUA・空名: ${ds.pua} / 名前乖離: ${ds.nameDiff} / racebook内重複馬番: ${ds.dupNumbers}`);
console.log(`\n── 新注入の照合統計 ──`);
console.log(JSON.stringify(after.injectStats));

console.log(`\n── BEFORE (旧 \${馬番}|\${馬名} 完全一致注入) ──`);
console.log(`真コンピ指数>=45 の不要馬: ${violB.length} 件`);
for (const v of violB) console.log(`   ${v.venue} R${v.raceNumber} #${v.number} ${v.name || '(broken)'} realComp=${v.realComp} role=${v.role} osaeCi=${v.osaeCi}`);

console.log(`\n── AFTER (新 race-scoped 馬番主キー注入) ──`);
console.log(`真コンピ指数>=45 の不要馬: ${violA.length} 件`);
for (const v of violA) console.log(`   ${v.venue} R${v.raceNumber} #${v.number} ${v.name || '(broken)'} realComp=${v.realComp} role=${v.role} osaeCi=${v.osaeCi}`);

console.log(`\n── before/after ──  違反: ${violB.length} → ${violA.length}`);

const p = after.rows.find(r => r.code === 'HAN' && r.raceNumber === 11 && r.number === 8);
if (p) { console.log(`\n── ポールセン (阪神R11 #8) AFTER ──`); console.log(JSON.stringify(p)); }

// 整合チェック
const dupRows = (() => { const seen = new Set(), dups = []; for (const r of after.rows) { const k = `${r.code}|${r.raceNumber}|${r.number}`; if (seen.has(k)) dups.push(k); else seen.add(k); } return dups; })();
const eligibleHi = after.rows.filter(r => r.realComp != null && r.realComp >= 45 && r.classification === 'eligible').length;

console.log(`\n── 合格条件チェック ──`);
const checks = [
  [`races が computer 由来と一致 (${after.raceCount}=${expectedRaces})`, after.raceCount === expectedRaces && expectedRaces > 0],
  ['真コンピ指数>=45 の不要馬 = 0', violA.length === 0],
  ['重複(venue|race|number) = 0', dupRows.length === 0],
];
// 既知違反のある日付（修正前に違反が存在する実データ）でのみ before>0→after=0 を要求
if (violB.length > 0) checks.push(['既知違反が全解消 (before>0, after=0)', violA.length === 0]);
// ポールセンが含まれる日付でのみ個別確認
if (p) {
  checks.push(['ポールセン osaeCi=60', p.osaeCi === 60]);
  checks.push(['ポールセンが不要馬でない', p.classification === 'eligible']);
}
for (const [label, ok] of checks) console.log(`   ${ok ? '✅' : '❌'} ${label}`);
const allOk = checks.every(([, ok]) => ok);
console.log(`\n総合: ${allOk ? '✅ PASS' : '❌ FAIL'}  (真ci>=45 eligible: ${eligibleHi} 頭)`);
process.exit(allOk ? 0 : 1);
