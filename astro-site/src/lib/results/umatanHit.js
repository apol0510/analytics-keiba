/**
 * 馬単の的中判定（公開本線のみ・2026-07 仕様）
 *
 * Premium でユーザーへ公開した「本線相手」だけを的中対象とする。
 * 括弧内の内部保険 (抑え…)／（抑え…） は判定対象外（公開買い目とアーカイブ実績の基準を一致させる）。
 * 投資額は従来どおり全レース5点固定・保存 bettingLines.umatan の形式は不変（抑え表記は記録として残置）。
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
