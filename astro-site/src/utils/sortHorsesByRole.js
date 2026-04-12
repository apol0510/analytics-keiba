/**
 * sortHorsesByRole.js
 *
 * 馬データを役割順にソートする共通関数
 *
 * 用途:
 * - 無料予想ページ（free-prediction.astro, free-prediction-jra.astro）
 * - 有料予想ページ（prediction.astro, prediction-jra.astro）
 * - その他、馬データを表示する全てのページ
 *
 * ソート順:
 * 1. 本命（◎）
 * 2. 対抗（○）
 * 3. 単穴（▲）
 * 4. 連下最上位（△）
 * 5. 連下（△）
 * 6. 補欠（☆）
 * 7. 無（-）
 *
 * 同じrole内では PT値（降順）でソート
 */

/**
 * 役割順序マップ
 */
const ROLE_ORDER = {
  '本命': 1,
  '対抗': 2,
  '単穴': 3,
  '連下最上位': 4,
  '連下': 5,
  '補欠': 6,
  '無': 7
};

/**
 * 馬データを役割順にソート
 *
 * @param {Array} horses - 馬データ配列
 * @returns {Array} ソート済み馬データ配列
 */
export function sortHorsesByRole(horses) {
  return [...horses].sort((a, b) => {
    const orderA = ROLE_ORDER[a.role] || 99;
    const orderB = ROLE_ORDER[b.role] || 99;

    // 役割順が異なる場合
    if (orderA !== orderB) {
      return orderA - orderB;
    }

    // 同じ役割の場合はPT値でソート（降順）
    const ptA = a.pt || a.rawScore || 0;
    const ptB = b.pt || b.rawScore || 0;
    return ptB - ptA;
  });
}

/**
 * 役割から表示用印記号に変換
 *
 * @param {string} role - 役割名
 * @returns {string} 印記号
 */
export function getRoleMark(role) {
  const markMap = {
    '本命': '◎',
    '対抗': '○',
    '単穴': '▲',
    '連下最上位': '△',
    '連下': '△',
    '補欠': '☆',
    '無': '-'
  };

  return markMap[role] || '-';
}
