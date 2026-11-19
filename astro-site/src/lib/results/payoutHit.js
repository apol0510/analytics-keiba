/**
 * 払戻表（確定払戻）による的中判定。馬単・三連複の実績（importResults*.js）の単一源。
 *
 * 2026-11-19 の監査で、同着のレースを誤判定していたため作った:
 *   - 着順の先頭 2/3 頭だけで判定していた → 同着の馬は結果ファイルの results から 1 頭落ちる（keiba-data-shared の癖）ため、
 *     同着の相手で的中した買い目を不的中にしていた（例 2026-05-22 大井 7R 馬単 3-6 / 6-3・三連複 3-6-9）
 *   - 払戻表の先頭 1 行だけを払戻にしていた → 同着で組が 2 つあると、的中した組と違う払戻や、片方だけの払戻を載せていた
 *     （例 2026-10-06 大井 2R 馬単 1-2 と 2-1 の両方を買っていて 260 円だけ）
 * 方針（hibi src/lib/hibi/settle.js・KL engine/shadow/settle.py と同じ考え方）:
 *   - 的中は「確定払戻にその組がある」ことで決める。払戻は買っていた組の全部を合算する（100 円あたり・1 組 1 点）
 *   - 払戻表が無い・崩れているときは null を返し、呼び出し側は従来の着順判定を使う（払戻が未着のレースを外れにしない）
 */
import { umatanTickets } from './umatanHit.js';

const isNum = (n) => Number.isInteger(n) && n >= 1 && n <= 18;

function parseCombination(v, arity) {
  const parts = String(v ?? '').trim().split(/\s*[-ー－→>]\s*/).map((s) => Number(s));
  if (parts.length !== arity || !parts.every(isNum) || new Set(parts).size !== arity) return null;
  return parts;
}

function parseYen(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v ?? '').trim().replace(/[,円]/g, '');
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
}

/** 払戻表の 1 券種 → [{ numbers, combination, payout }]。形の崩れた行は捨てる。1 行も残らなければ null */
export function normalizePayoutList(list, arity) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const p of list) {
    const numbers = parseCombination(p?.combination ?? p?.numbers ?? p?.number, arity);
    const payout = parseYen(p?.payout);
    if (numbers && payout !== null) out.push({ numbers, combination: String(p.combination ?? numbers.join('-')), payout });
  }
  return out.length ? out : null;
}

/**
 * 馬単。買い目行（"軸↔相手(抑え…)" 等）を、払戻表に載った組で判定する。
 * @param {string[]} bettingLines
 * @param {Array} umatanPayouts 結果ファイルの payouts.umatan
 * @param {{ includeOsae?: boolean }} opts 実績は抑えも含める（checkUmatanHitWithOsae と同じ範囲）
 * @returns {null | { isHit: boolean, hitLines: string[], matched: Array<{combination:string,payout:number}>, payout: number }}
 */
export function settleUmatanByPayout(bettingLines, umatanPayouts, { includeOsae = true } = {}) {
  const list = normalizePayoutList(umatanPayouts, 2);
  if (!list) return null;
  const lines = Array.isArray(bettingLines) ? bettingLines : [];
  const all = umatanTickets(lines, { includeOsae });
  const matched = list.filter((p) => all.has(`${p.numbers[0]}>${p.numbers[1]}`));
  const hitLines = lines.filter((line) => {
    const t = umatanTickets([line], { includeOsae });
    return list.some((p) => t.has(`${p.numbers[0]}>${p.numbers[1]}`));
  });
  return {
    isHit: matched.length > 0,
    hitLines,
    matched: matched.map(({ combination, payout }) => ({ combination, payout })),
    payout: matched.reduce((s, p) => s + p.payout, 0),
  };
}

/**
 * 三連複。買い目（[a,b,c] の組の配列）を、払戻表に載った組で判定する（順不同）。
 * @param {number[][]} lines 展開済みの組
 * @param {Array} sanrenpukuPayouts 結果ファイルの payouts.sanrenpuku
 * @returns {null | { hit: boolean, matched: Array<{combination:string,payout:number}>, payout: number }}
 */
export function settleSanrenpukuByPayout(lines, sanrenpukuPayouts) {
  const list = normalizePayoutList(sanrenpukuPayouts, 3);
  if (!list) return null;
  const key = (nums) => nums.map(Number).sort((a, b) => a - b).join('-');
  const bought = new Set((Array.isArray(lines) ? lines : []).filter((l) => Array.isArray(l) && l.length === 3).map(key));
  const matched = list.filter((p) => bought.has(key(p.numbers)));
  return {
    hit: matched.length > 0,
    matched: matched.map(({ combination, payout }) => ({ combination, payout })),
    payout: matched.reduce((s, p) => s + p.payout, 0),
  };
}

/**
 * 実績 1 レース分の馬単（importResults.js / importResultsJra.js 共通）。
 * 払戻表があれば払戻表で判定し、無ければ従来どおり着順（results の先頭 2 頭）で判定する。
 * umatan.combination は従来の形（"a-b" 1 つ）: 的中なら的中した最初の組、外れなら払戻表の先頭の組。
 * 同着で払戻表に 2 組以上あるときだけ umatan.payoutTable に全組を残す（的中なら payout は買っていた組の合計）。
 */
export function settleUmatanRace(bettingLines, race, fallbackHit) {
  const head = race?.payouts?.umatan?.[0] || null;
  const byPayout = settleUmatanByPayout(bettingLines, race?.payouts?.umatan);
  if (!byPayout) {
    const hitLines = (bettingLines || []).filter((line) => fallbackHit(line, race));
    return {
      isHit: hitLines.length > 0,
      hitLines,
      umatan: { combination: head?.combination || null, payout: head?.payout || null },
    };
  }
  // 同着で払戻表に 2 組以上あるときは全組を残す（再判定 scripts/recalculate-umatan-archive-with-osae.mjs が着順でなく払戻表で判定できるように）
  const list = normalizePayoutList(race.payouts.umatan, 2);
  const table = list.length > 1 ? { payoutTable: list.map(({ combination, payout }) => ({ combination, payout })) } : {};
  const umatan = byPayout.isHit
    ? { combination: byPayout.matched[0].combination, payout: byPayout.payout, ...table }
    : { combination: head?.combination || null, payout: head?.payout || null, ...table };
  return { isHit: byPayout.isHit, hitLines: byPayout.hitLines, umatan };
}
