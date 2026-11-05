/**
 * 馬単の本線だけの判定。実績の isHit は checkUmatanHitWithOsae で作る（2026-11-06 MK 指示・docs/BET_POINT_LOGIC.md）。
 * この関数は「抑えで的中したか」の見分けと、取得した買い目の的中判定に使う。
 * 括弧内の (抑え…)／（抑え…） は判定対象外。保存 bettingLines.umatan の形式は不変。
 * 区切り記号 -（旧）/ ↔・⇔（双方向）/ →（片方向）、半角/全角括弧に対応。
 * 例: "4-1.11.2.5.7.9(抑え10.8.6)" → 本線 1.11.2.5.7.9 のみで判定 / "5↔9.11.6.8.4" / "4→8.4.7.5.3"
 */
export function checkUmatanHit(bettingLine, result) {
  const match = String(bettingLine).match(/^(\d+)([\-↔⇔→])(.+)$/);
  if (!match) return false;

  const axis = parseInt(match[1]);
  const separator = match[2];
  const aitePart = match[3];

  // 本線相手馬のみ抽出（(抑え…)／（抑え…）は判定対象外）
  const mainPart = aitePart.replace(/[(（]抑え[^)）]*[)）]/g, '');
  const mainAite = mainPart.split('.').map(n => parseInt(n)).filter(n => !isNaN(n));

  // 1着と2着を取得
  const first = result.results[0]?.number;
  const second = result.results[1]?.number;

  if (!first || !second) return false;

  // → はメインレースの一方向馬単（本命→相手のみ）。↔ / ⇔ / -（旧・通常レース）は双方向。
  const oneWay = separator === '→';

  // パターン1: 軸が1着、本線相手が2着（順目）
  if (axis === first && mainAite.includes(second)) {
    return true;
  }

  // パターン2: 本線相手が1着、軸が2着（裏目）。一方向（→）のときは的中としない。
  if (!oneWay && mainAite.includes(first) && axis === second) {
    return true;
  }

  return false;
}

/**
 * 実績の的中判定（本線＋連下・抑え）。買い目行の全部を有効な買い目として扱う。
 * 括弧内の (抑え…)／（抑え…） の馬も相手として数える。区切り記号の方向は checkUmatanHit と同じ。
 * 回収率の分母も同じ範囲の組（umatanTickets の includeOsae）にそろえる。
 */
export function checkUmatanHitWithOsae(bettingLine, result) {
  return checkUmatanHit(String(bettingLine).replace(/[(（]抑え([^)）]*)[)）]/g, '.$1'), result);
}

/** 買い目行の全体が実際に買う馬単の組（"軸>相手" の Set）。行をまたぐ同じ組は 1 点と数える */
export function umatanTickets(bettingLines, { includeOsae = false } = {}) {
  const tickets = new Set();
  for (const raw of bettingLines || []) {
    const line = includeOsae
      ? String(raw).replace(/[(（]抑え([^)）]*)[)）]/g, '.$1')
      : String(raw).replace(/[(（]抑え[^)）]*[)）]/g, '');
    const m = line.match(/^(\d+)([\-↔⇔→])(.+)$/);
    if (!m) continue;
    const axis = parseInt(m[1]);
    for (const n of m[3].split('.').map((v) => parseInt(v)).filter((v) => !isNaN(v) && v !== axis)) {
      tickets.add(`${axis}>${n}`);
      if (m[2] !== '→') tickets.add(`${n}>${axis}`);
    }
  }
  return tickets;
}
