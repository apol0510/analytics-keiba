/**
 * aiBetPoints.js — 的中実績の「購入点数・回収率」を数える単一源（純粋関数・Node/SSR 安全）
 *
 * 【状態】MK 確定仕様（2026-10-06）。本番反映は MK の Deploy Preview 目視後。
 * 正本: docs/BET_POINT_LOGIC.md「MK確定仕様: 実績の購入点数は AI レース別算定」
 *
 * 目的: 実績の購入点数を「全レース 5 点固定」にせず、レースごとに AI が算定する。
 *       これは実績の購入点数の算定方式であり、Premium で提供する新しい買い目ではない。
 *
 * ルール（変えるときは docs と test を同時に直す）:
 *  - Premium の買い目（少ない買い目・通常買い目）は一切変えない。第 3 の買い目は作らない・画面にも出さない。
 *  - AI が算定するのは購入点数だけ（race.aiBet = { v, points }）。
 *    点数 = 少ない買い目（narrowUmatan）の組数 ＋ 通常買い目を参照した 2〜6 組。レース前のデータだけで決める（結果は使わない）。
 *  - 的中（✅）は通常買い目で判定する（importResults*.js の isHit をそのまま使う）。
 *  - 払戻は、通常買い目で記録されたそのレースの払戻（umatan.payout）をそのまま使う。
 *  - 回収率 = 通常買い目で記録された払戻 ÷（AI レース別算定購入点数 × 100 円）。
 *  - 算定が無いレースを含む日は購入点数・回収率を出さない（推測で埋めない）。
 */
import { narrowUmatan } from '../acquisition/predictionContent.js';
import { SELECTION_RULES } from '../acquisition/sanrenpukuSelection.js';

/** v1: 組の一覧も保存していた Preview 初版。v2: 点数だけを保存（MK 確定仕様） */
export const AI_BET_VERSION = 2;
/** 追加する組数の範囲（通常レース） */
export const EXTRA_MIN = 2;
export const EXTRA_MAX = 6;

const ROLE_RANK = { '本命': 0, '対抗': 1, '単穴': 2, '連下最上位': 3, '連下': 4 };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const horseNo = (h) => num(h?.horseNumber ?? h?.number);
const ptOf = (h) => num(h?.pt ?? h?.displayScore ?? h?.rawScore) ?? 0;
const rawIndex = (h) => num(h?.sourceComputerIndex ?? h?.computerIndex);

/** 馬単 1 行を組（"1着-2着"）の配列へ。抑えは含めない。`→` は一方向、それ以外は双方向 */
export function expandUmatanLine(line) {
  const s = String(line || '').replace(/[(（]抑え[^)）]*[)）]/g, '');
  const m = /^\s*(\d+)\s*([-↔⇔→])\s*(.+)$/.exec(s);
  if (!m) return [];
  const axis = Number(m[1]);
  const partners = m[3].split('.').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
  const out = [];
  for (const p of partners) {
    out.push(`${axis}-${p}`);
    if (m[2] !== '→') out.push(`${p}-${axis}`);
  }
  return out;
}

const uniq = (arr) => [...new Set(arr)];

/**
 * 本命と 2 番手の評価差（pt）の区切り。予想データ（レース前）の分布から決めた固定値
 * （2026-02〜10 実測の中央値と上位 25%: 中央 7 / 17、南関 13 / 22）。結果（的中・払戻）は使っていない。
 */
export const GAP_TIERS = Object.freeze({
  jra: Object.freeze({ mid: 7, strong: 17 }),
  nankan: Object.freeze({ mid: 13, strong: 22 }),
});

/**
 * 追加する組数（レース前のデータだけで決める）。
 * 軸が堅い（2 番手との差が大きい・指数が高い）ほど少なく、混戦・指数が低いほど多く。頭数が多いと +1、少ないと −1。
 */
export function extraCount(horses, { cat = 'nankan', horseCount } = {}) {
  const list = Array.isArray(horses) ? horses.filter(Boolean) : [];
  const honmei = list.find((h) => h.role === '本命');
  if (!honmei) return EXTRA_MAX;
  const R = SELECTION_RULES[cat] || SELECTION_RULES.nankan;
  const G = GAP_TIERS[cat] || GAP_TIERS.nankan;
  const idx = rawIndex(honmei) ?? 0;
  const others = list.filter((h) => h !== honmei).map(ptOf).sort((a, b) => b - a);
  const gap = ptOf(honmei) - (others[0] ?? 0);
  let k = gap >= G.strong ? 3 : gap >= G.mid ? 4 : 5;
  if (idx > 0) {                         // 指数が無い（古いデータ）ときは差だけで決める
    if (idx >= R.aMinIndex) k -= 1;
    else if (idx < R.bMinIndex) k += 1;
  }
  const field = num(horseCount) ?? list.length;
  if (field >= 16) k += 1;
  if (field > 0 && field <= 8) k -= 1;
  return Math.max(EXTRA_MIN, Math.min(EXTRA_MAX, k));
}

/** 追加候補の並び（評価の高い馬どうし・本命 1 着を優先、同点は pt 合計の大きい順→馬番） */
function rankExtras(candidates, horses) {
  const byNo = new Map((horses || []).filter(Boolean).map((h) => [horseNo(h), h]));
  const rank = (n) => ROLE_RANK[byNo.get(n)?.role] ?? 5;
  const pt = (n) => ptOf(byNo.get(n));
  return [...candidates].sort((x, y) => {
    const [a1, a2] = x.split('-').map(Number);
    const [b1, b2] = y.split('-').map(Number);
    const sx = rank(a1) + rank(a2) + (rank(a1) === 0 ? 0 : 0.5);
    const sy = rank(b1) + rank(b2) + (rank(b1) === 0 ? 0 : 0.5);
    return (sx - sy) || ((pt(b1) + pt(b2)) - (pt(a1) + pt(a2))) || (a1 - b1) || (a2 - b2);
  });
}

/**
 * 点数の算定根拠（少ない買い目の組 ＋ 通常買い目から追加する組）。どの組も通常買い目の中。
 * 実績計算の内部でだけ使う（保存しない・画面に出さない・払戻の判定には使わない）。
 * @returns {string[] | null}
 */
export function aiPointBasis(horses, normalLines, { cat = 'nankan', horseCount } = {}) {
  const lines = (Array.isArray(normalLines) ? normalLines : []).filter(Boolean);
  const normal = uniq(lines.flatMap(expandUmatanLine));
  if (normal.length === 0) return null;
  const nar = narrowUmatan(horses, lines);
  const base = nar ? expandUmatanLine(nar.line).filter((c) => normal.includes(c)) : [];
  const rest = rankExtras(normal.filter((c) => !base.includes(c)), horses);
  const k = extraCount(horses, { cat, horseCount });
  return uniq([...base, ...rest.slice(0, k)]);
}

/**
 * 1 レースの実績用購入点数。予想データ（horses）と配信した通常買い目（bettingLines.umatan）から作る。
 * @returns {{ v:number, points:number } | null}
 */
export function buildAiBet(horses, normalLines, opts = {}) {
  const basis = aiPointBasis(horses, normalLines, opts);
  return basis ? { v: AI_BET_VERSION, points: basis.length } : null;
}

const payoutOf = (race) => num(race?.umatan?.payout ?? race?.payout) ?? 0;
const isHitOf = (race) => !!(race?.isHit ?? race?.hit);

/** 1 レースの実績（的中は通常買い目・払戻は通常買い目で記録された払戻・点数は AI 算定） */
export function raceAiResult(race) {
  const points = num(race?.aiBet?.points);
  if (!(points > 0)) return null;
  const hit = isHitOf(race);
  return { points, hit, payout: hit ? payoutOf(race) : 0 };
}

/**
 * 1 日（archive の 1 エントリ）の実績。
 * complete=false（算定の無いレースがある）なら points / recoveryRate は null。
 */
export function summarizeAiDay(entry) {
  const races = Array.isArray(entry?.races) ? entry.races : [];
  const rs = races.map(raceAiResult);
  const complete = races.length > 0 && rs.every(Boolean);
  const totalRaces = races.length;
  const hitRaces = races.filter(isHitOf).length;
  const maxPayout = races.reduce((m, r) => (isHitOf(r) ? Math.max(m, payoutOf(r)) : m), 0) || null;
  if (!complete) {
    return { complete, totalRaces, hitRaces, points: null, investment: null, payout: null, recoveryRate: null, maxPayout };
  }
  const points = rs.reduce((s, r) => s + r.points, 0);
  const payout = rs.reduce((s, r) => s + r.payout, 0);
  const investment = points * 100;
  return {
    complete, totalRaces, hitRaces, points, investment, payout, maxPayout,
    recoveryRate: investment > 0 ? Math.round((payout / investment) * 1000) / 10 : null,
  };
}

/**
 * 複数日の合計。回収率・購入点数は算定のそろった日だけで数える（的中率は全日）。
 */
export function summarizeAiDays(entries) {
  const days = (Array.isArray(entries) ? entries : []).map(summarizeAiDay);
  const sum = (f) => days.reduce((s, d) => s + (f(d) || 0), 0);
  const full = days.filter((d) => d.complete);
  const totalRaces = sum((d) => d.totalRaces);
  const hitRaces = sum((d) => d.hitRaces);
  const points = full.reduce((s, d) => s + d.points, 0);
  const payout = full.reduce((s, d) => s + d.payout, 0);
  const investment = points * 100;
  return {
    days: days.length,
    fullDays: full.length,
    totalRaces,
    hitRaces,
    hitRate: totalRaces > 0 ? Math.round((hitRaces / totalRaces) * 1000) / 10 : null,
    points: full.length ? points : null,
    investment: full.length ? investment : null,
    payout: full.length ? payout : null,
    recoveryRate: investment > 0 ? Math.round((payout / investment) * 1000) / 10 : null,
    maxPayout: days.reduce((m, d) => Math.max(m, d.maxPayout || 0), 0) || null,
  };
}

/** 画面に添える小さな注記（これ以上の内部計算は画面で説明しない） */
export const AI_POINTS_NOTE = '購入点数はAIによるレース別算定';
