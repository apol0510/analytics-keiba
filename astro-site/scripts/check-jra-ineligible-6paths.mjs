/**
 * check-jra-ineligible-6paths.mjs
 *
 * AK(free/light/premium) と KI(free/light/premium) の JRA 6 経路について、
 * 「不要馬 ⇒ 真コンピ指数<=44」「真コンピ指数>=45 の不要馬 0 件」を自動検証する。
 *
 * 各 repo は表示経路ごとに分類関数を共有しているため、データ層の不変条件を満たせば
 * 3 経路すべてが満たされる（静的事実は本ファイル冒頭コメント参照）。
 *   - AK: free-prediction-jra / light-predictions-jra / premium-predictions-jra は
 *         src/lib/shared-prediction-logic.js → osaeClassification.js の isIneligibleHorse を共有。
 *   - KI: prediction/jra / free-prediction/jra / [date] は role 文字列を共有。除外は role==='無' のみ。
 *
 * AK は新 race-scoped 注入で本体(racebook)へ真指数を入れてから分類。
 * KI は computer 本体経路（注入不要）。両者を実モジュールで実行して検査する。
 *
 * 終了コード:
 *   0 = PASS（AK/KI 6経路すべて成立／または --allow-ak-only 指定で AK 3経路のみ成立）
 *   1 = FAIL（AK または KI に違反 / 日付形式不正）
 *   2 = SKIP（shared/computer データ不足・JSON破損・KI repo/モジュール不足）
 * 既定では KI は必須。KI が解決できなければ exit 2（「6経路PASS」とは表示しない）。
 * AK だけ確認したい場合のみ明示的に --allow-ak-only を付ける（出力は「AK 3経路のみPASS / KI未検証」）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAndAdjust as akNormalize, isHorseNameBroken } from '../src/utils/normalizePrediction.js';
import { isIneligibleHorse, getOsaeCi } from '../src/utils/osaeClassification.js';
import { buildRaceScopedComputerMap, injectSourceComputerIndexRaceScoped, normalizeHorseName } from './lib/computerIndexMatch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) { const o = { _: [] }; for (const a of argv) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) o[m[1]] = m[2]; else if (a.startsWith('--')) o[a.slice(2)] = true; else o._.push(a); } return o; }
const A = parseArgs(process.argv.slice(2));
const DATE = A.date || A._[0] || process.env.AUDIT_DATE;
const SHARED = A['shared-dir'] || process.env.KEIBA_DATA_SHARED_DIR || resolve(__dirname, '..', '..', '..', 'keiba-data-shared');
const KI_DIR = A['ki-dir'] || process.env.KI_DIR || resolve(__dirname, '..', '..', '..', 'keiba-intelligence');
const CATEGORY = A.category || 'jra';
const ALLOW_AK_ONLY = A['allow-ak-only'] !== undefined || process.env.ALLOW_AK_ONLY === '1';
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error('❌ --date=YYYY-MM-DD 形式で指定してください (exit 1)'); process.exit(1); }
const [Y, M] = DATE.split('-');
const KI_DISPLAYED = new Set(['本命', '対抗', '単穴', '連下最上位', '連下', '補欠']);

// JSON 読込: 不在=null（呼出側判断）。破損(parse失敗)=入力不足として SKIP(exit 2)。
function load(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.error(`⏭️  SKIP(exit 2): JSON parse 失敗 ${p}: ${e.message}`); process.exit(2); }
}
// 会場コード自動検出（3会場固定にしない）
const compDir = join(SHARED, CATEGORY, 'predictions', 'computer', Y, M);
if (!existsSync(SHARED)) { console.error(`⏭️  SKIP(exit 2): shared dir 無し: ${SHARED}`); process.exit(2); }
if (!existsSync(compDir)) { console.error(`⏭️  SKIP(exit 2): computer ディレクトリ無し: ${compDir}`); process.exit(2); }
const VENUES = {};
for (const f of readdirSync(compDir)) {
  if (!f.startsWith(`${DATE}-`) || !f.endsWith('.json')) continue;
  const code = f.slice(DATE.length + 1, -5);
  VENUES[code] = load(join(compDir, f))?.venue || code;
}
if (Object.keys(VENUES).length === 0) { console.error(`⏭️  SKIP(exit 2): ${DATE} の ${CATEGORY} computer データ無し`); process.exit(2); }

// KI モジュールを動的 import。KI は「6経路」検証の必須依存。
// 解決できなければ偽PASSさせず exit 2（--allow-ak-only 指定時のみ AK 3経路のみで継続）。
let kiNormalize = null, kiAvailable = false, kiReason = '';
{
  const kiPath = join(KI_DIR, 'astro-site', 'src', 'utils', 'normalizePrediction.js');
  if (!existsSync(kiPath)) {
    kiReason = `KI モジュール無し: ${kiPath}`;
  } else {
    try {
      ({ normalizeAndAdjust: kiNormalize } = await import(kiPath));
      if (typeof kiNormalize === 'function') kiAvailable = true;
      else kiReason = 'KI normalizeAndAdjust が関数として解決できない';
    } catch (e) { kiReason = `KI import 失敗: ${e.message}`; }
  }
}
if (!kiAvailable && !ALLOW_AK_ONLY) {
  console.error(`⏭️  SKIP(exit 2): KI 必須依存が不足のため 6経路検証を実施できません。`);
  console.error(`   理由: ${kiReason}`);
  console.error(`   KI dir: ${KI_DIR}（--ki-dir / 環境変数 KI_DIR で指定可）`);
  console.error(`   AK 3経路のみ確認する場合は明示的に --allow-ak-only を付けてください（その場合も「6経路PASS」とは表示しません）。`);
  process.exit(2);
}

const comp = {}, rb = {};
for (const c of Object.keys(VENUES)) {
  comp[c] = load(join(SHARED, CATEGORY, 'predictions', 'computer', Y, M, `${DATE}-${c}.json`));
  rb[c] = load(join(SHARED, CATEGORY, 'racebook', Y, M, `${DATE}-${c}.json`));
}
const realCi = (c, rn, num) => {
  const r = (comp[c].races || []).find(x => Number(x.raceNumber) === rn);
  return r ? (Number(r.horses.find(h => Number(h.number) === num)?.computerIndex) ?? null) : null;
};

// AK 本体組立（fetchRacebookData 相当）
function akVenue(c) {
  const d = rb[c];
  return {
    date: DATE, venue: d.track || d.venue, totalRaces: d.races?.length || 0,
    races: (d.races || []).map(r => ({
      raceInfo: { raceNumber: `${r.raceNumber}R` },
      horses: (r.horses || []).map(h => ({
        number: h.number, name: h.name, totalScore: h.totalScore || 0, assignment: h.assignment || '無',
        jockey: h.jockey || '', trainer: h.trainer || '', seirei: h.sexAge || '',
        kinryo: h.weight != null ? String(h.weight) : '', computerIndex: h.computerIndex || null,
        marks: h.marks || [], _pastRaces: Array.isArray(h.pastRaces) ? h.pastRaces.slice(0, 5) : []
      }))
    }))
  };
}
function compMapInput(c) {
  return { venue: comp[c].venue, races: (comp[c].races || []).map(r => ({ raceNumber: r.raceNumber, horses: (r.horses || []).map(h => ({ number: h.number, name: h.name, computerIndex: h.computerIndex, recentRaces: [] })) })) };
}

// ── AK 経路（free/light/premium 共有 classifier） ──
function runAK() {
  const rows = [];
  for (const [c, vName] of Object.entries(VENUES)) {
    if (!comp[c] || !rb[c]) continue;
    const body = akVenue(c);
    const map = buildRaceScopedComputerMap([compMapInput(c)]);
    injectSourceComputerIndexRaceScoped({ venues: [body] }, map, { isNameBroken: isHorseNameBroken });
    const adj = akNormalize(body);
    for (const race of adj.races) {
      const rn = Number(String(race.raceNumber).match(/\d+/)?.[0]);
      for (const h of race.horses) rows.push({ repo: 'AK', venue: vName, c, rn, num: Number(h.number), name: h.name, ci: realCi(c, rn, Number(h.number)), role: h.role, ineligible: isIneligibleHorse(h), osaeCi: getOsaeCi(h) });
    }
  }
  return rows;
}
// ── KI 経路（free/light/premium 共有 role / 除外は '無' のみ） ──
function runKI() {
  const rows = [];
  for (const [c, vName] of Object.entries(VENUES)) {
    if (!comp[c]) continue;
    const adj = kiNormalize({ date: DATE, venue: comp[c].venue, races: comp[c].races }); // computer 本体
    for (const race of adj.races) {
      const rn = Number(race.raceNumber);
      for (const h of race.horses) rows.push({ repo: 'KI', venue: vName, c, rn, num: Number(h.number), name: h.name, ci: realCi(c, rn, Number(h.number)), role: h.role, ineligible: !KI_DISPLAYED.has(h.role) });
    }
  }
  return rows;
}

const ak = runAK();
const ki = kiAvailable ? runKI() : null;
const expectedRaces = Object.values(comp).filter(Boolean).reduce((s, c) => s + (c.races?.length || 0), 0);
let fail = 0;
function check(label, ok) { console.log(`   ${ok ? '✅' : '❌'} ${label}`); if (!ok) fail++; }

console.log(`════ ${CATEGORY.toUpperCase()} 6 経路 不要馬 検証 ${DATE} ════`);
console.log(`会場: ${Object.entries(VENUES).map(([c, n]) => `${n}(${c})`).join(' ')} / KI: ${kiAvailable ? KI_DIR : 'SKIP(未解決)'}\n`);
const repos = [['AK', ak]];
if (ki) repos.push(['KI', ki]); else console.log('⏭️  KI 経路は SKIP（KI repo 未解決・偽PASSしない）\n');
for (const [repo, rows] of repos) {
  const viol = rows.filter(r => r.ineligible && r.ci != null && r.ci >= 45);
  const dualRole = rows.filter((r, i) => rows.findIndex(x => x.repo === r.repo && x.c === r.c && x.rn === r.rn && x.num === r.num) !== i);
  console.log(`── ${repo} (free / light / premium 共有) ──`);
  check(`${repo}: 真コンピ指数>=45 の不要馬 = 0 (実=${viol.length})`, viol.length === 0);
  if (viol.length) viol.slice(0, 10).forEach(v => console.log(`        ${v.venue} R${v.rn} #${v.num} ${v.name} ci=${v.ci} role=${v.role}`));
  check(`${repo}: 有力/不要の重複(同一馬2分類) = 0`, dualRole.length === 0);
  const races = new Set(rows.map(r => `${r.c}|${r.rn}`)).size;
  check(`${repo}: races が computer 由来と一致 (${races}=${expectedRaces})`, races === expectedRaces && expectedRaces > 0);
}

// ポールセン横断（含まれる日付のみ）
const pAK = ak.find(r => r.c === 'HAN' && r.rn === 11 && r.num === 8);
const pKI = ki?.find(r => r.c === 'HAN' && r.rn === 11 && r.num === 8);
if (pAK) {
  console.log(`\n── ポールセン (阪神R11 #8) 横断 ──`);
  console.log(`   AK: role=${pAK.role} osaeCi=${pAK.osaeCi} ineligible=${pAK.ineligible} (ci=${pAK.ci})`);
  if (pKI) console.log(`   KI: role=${pKI.role} ineligible=${pKI.ineligible} (ci=${pKI.ci})`);
  check('ポールセン AK で不要馬でない', !pAK.ineligible);
  if (pKI) check('ポールセン KI で不要馬でない', !pKI.ineligible);
  if (pKI) check('ポールセン 馬番/真指数が AK=KI で一致', pAK.num === pKI.num && pAK.ci === pKI.ci && pAK.ci === 60);
}

// 同一馬の identity 一致（馬番・正規化馬名・真指数）— role は設計上 repo 間で異なり得る
if (ki) {
  let idMismatch = 0;
  for (const a of ak) {
    const k = ki.find(x => x.c === a.c && x.rn === a.rn && x.num === a.num);
    if (!k) { idMismatch++; continue; }
    if (a.ci !== k.ci) idMismatch++;
    else if (a.name && k.name && normalizeHorseName(a.name) !== normalizeHorseName(k.name) && !isHorseNameBroken(a.name)) idMismatch++;
  }
  check(`AK/KI 同一馬の (馬番・真指数・正規化馬名) 一致 (不一致=${idMismatch})`, idMismatch === 0);
}

if (fail > 0) {
  console.log(`\n総合: ❌ FAIL (${fail}) — ${kiAvailable ? 'AK/KI 6経路' : 'AK 3経路'}`);
  process.exit(1);
}
if (kiAvailable) {
  console.log(`\n総合: ✅ PASS（AK/KI 6経路すべて不変条件成立）`);
  process.exit(0);
}
// ここに到達するのは --allow-ak-only 指定時のみ（通常は上流で exit 2 済み）
console.log(`\n総合: ⚠️ AK 3経路のみ PASS / KI 未検証（--allow-ak-only 指定）。6経路検証は未完です。`);
process.exit(0);
