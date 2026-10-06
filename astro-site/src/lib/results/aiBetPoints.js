/**
 * aiBetPoints.js — 的中実績の「購入点数・回収率」を数える単一源（純粋関数・Node/SSR 安全）
 *
 * 【状態】MK 確認用 Preview（2026-10-06）。Preview 確認後に最終採否を決定。本番未採用。
 * 正本: docs/BET_POINT_LOGIC.md「検討中Preview仕様: AI レース別購入点数」
 *
 * 目的: 実績を「全レース 5 点固定」でも「通常買い目 最大 20 点を全部買った前提」でもなく、
 *       Premium が実際に配信した買い目の範囲で、レースごとに AI が点数を算定して数える。
 *
 * ルール（変えるときは docs と test を同時に直す）:
 *  - Premium の買い目（通常・点数を絞った買い目）は一切変えない。ここは実績の数え方だけ。
 *  - 算定対象 = 点数を絞った買い目（narrowUmatan）の組 ＋ 通常買い目の残りから AI が選んだ 2〜6 組。
 *    どの組も Premium の通常買い目に含まれる（第 3 の買い目は作らない・画面にも出さない）。
 *  - 追加の組数はレース前のデータだけで決める（本命の指数・本命と 2 番手の評価差・頭数・印）。結果は使わない。
 *  - 的中（✅）は通常買い目で判定する（importResults*.js の isHit をそのまま使う）。
 *  - 回収率の払戻は、勝ち組が算定した組に入っているときだけ数える（買っていない組の払戻は数えない）。
 *  - 算定が無いレースを含む日は購入点数・回収率を出さない（推測で埋めない）。
 */
import { narrowUmatan } from '../acquisition/predictionContent.js';
import { SELECTION_RULES } from '../acquisition/sanrenpukuSelection.js';

export const AI_BET_VERSION = 1;
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
 * 1 レースの算定。予想データ（horses）と配信した通常買い目（bettingLines.umatan）から作る。
 * @returns {{ v:number, points:number, combos:string[] } | null}
 */
export function buildAiBet(horses, normalLines, { cat = 'nankan', horseCount } = {}) {
  const lines = (Array.isArray(normalLines) ? normalLines : []).filter(Boolean);
  const normal = uniq(lines.flatMap(expandUmatanLine));
  if (normal.length === 0) return null;
  const nar = narrowUmatan(horses, lines);
  const base = nar ? expandUmatanLine(nar.line).filter((c) => normal.includes(c)) : [];
  const rest = rankExtras(normal.filter((c) => !base.includes(c)), horses);
  const k = extraCount(horses, { cat, horseCount });
  const combos = uniq([...base, ...rest.slice(0, k)]);
  return { v: AI_BET_VERSION, points: combos.length, combos };
}

const payoutOf = (race) => num(race?.umatan?.payout ?? race?.payout) ?? 0;
const winCombo = (race) => {
  const c = String(race?.umatan?.combination ?? race?.combination ?? '').split('-').map((x) => Number(x.trim()));
  return c.length >= 2 && c.every(Number.isFinite) ? `${c[0]}-${c[1]}` : null;
};
const isHitOf = (race) => !!(race?.isHit ?? race?.hit);

/** 1 レースの実績（的中は通常買い目、払戻は算定した組に入っていたときだけ） */
export function raceAiResult(race) {
  const ai = race?.aiBet;
  if (!ai || !Array.isArray(ai.combos) || !(ai.points > 0)) return null;
  const hit = isHitOf(race);
  const w = winCombo(race);
  const covered = hit && w != null && ai.combos.includes(w);
  return { points: ai.points, hit, covered, payout: covered ? payoutOf(race) : 0 };
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
