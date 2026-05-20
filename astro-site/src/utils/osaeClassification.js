/**
 * osaeClassification.js — 抑え / 不要馬 判定の単一源（Single Source of Truth）
 *
 * 目的:
 *   「抑えのはずが不要馬扱い」「直すと別が壊れる」の根本対策。
 *   抑え判定がこれまで以下に分散していた:
 *     - src/lib/shared-prediction-logic.js : isOsaeCandidate / isIneligibleHorse（表示）
 *     - src/utils/mainRaceBetting.js       : ローカル isOsae（買い目・import）
 *     - src/utils/sanrenpukuBetting.js     : ローカル isOsaeRole（三連複・ci 閾値なし）
 *   これらを本モジュールの判定に一本化する。
 *
 * 設計制約:
 *   - **依存ゼロ**（他モジュールを import しない）。
 *     Node 実行の scripts/importPrediction*.js / mainRaceBetting.js からも、
 *     Astro/ブラウザ依存（integrated-data-manager.js 等）を巻き込まずに import できる。
 *   - shared-prediction-logic.js は本モジュールを再エクスポートする薄いラッパーにする。
 *
 * 判定仕様（従来の表示挙動を変更しない）:
 *   getOsaeCi(h):
 *     racebook 系コンピ指数を返す。JRA は sourceComputerIndex 優先、南関は computerIndex。
 *     どちらも 10 未満なら 0（admin の 0–9 編集系スケールは無視）。
 *   isOsaeCandidate(h):
 *     role が '押さえ' / '抑え' / '補欠' かつ getOsaeCi(h) >= MIN_OSAE_CI(=45) → true
 *   isIneligibleHorse(h):
 *     role が HANDLED_ROLES 外 / '無' / 未割当 → true
 *     role が '押さえ' / '抑え' / '補欠' かつ抑え候補でない → true
 *     それ以外（本命 / 対抗 / 単穴 / 連下 / 連下最上位） → false
 *
 * 注意（役割の出どころ）:
 *   - source 予想 JSON では '押さえ' は使われず、すべて '補欠'。adaptLatestPrediction.js が
 *     reserve→'押さえ' に書き換えるため、Astro レンダー時のみ '押さえ' が現れる。
 *   - 抑え判定はこの 3 ロール（押さえ / 抑え / 補欠）を一括で扱う。
 */

export const HANDLED_ROLES = new Set(['本命', '対抗', '単穴', '連下', '連下最上位', '押さえ', '抑え', '補欠']);
export const OSAE_LIKE_ROLES = new Set(['押さえ', '抑え', '補欠']);
export const MIN_OSAE_CI = 45; // COMPI_MIN — normalizePrediction.js の rawScore 昇格閾値と一致

/**
 * racebook 系コンピ指数を取り出す。JRA は sourceComputerIndex、南関は computerIndex。
 * どちらも 10 未満なら 0 を返す（admin の 0–9 編集系スケールは無視）。
 * @param {object} horse
 * @returns {number}
 */
export function getOsaeCi(horse) {
  const sci = Number(horse?.sourceComputerIndex || 0);
  const ci = Number(horse?.computerIndex || 0);
  if (sci >= 10) return sci;
  if (ci >= 10) return ci;
  return 0;
}

/**
 * 抑え候補か？ role が抑え系 かつ racebook 系コンピ指数 >= MIN_OSAE_CI。
 * @param {object} horse
 * @returns {boolean}
 */
export function isOsaeCandidate(horse) {
  if (!horse) return false;
  if (!OSAE_LIKE_ROLES.has(horse.role)) return false;
  return getOsaeCi(horse) >= MIN_OSAE_CI;
}

/**
 * 不要馬か？ HANDLED_ROLES 外 / 抑え系だが抑え候補でない。
 * @param {object} horse
 * @returns {boolean}
 */
export function isIneligibleHorse(horse) {
  if (!horse) return false;
  const role = horse.role;
  if (!HANDLED_ROLES.has(role)) return true;
  if (OSAE_LIKE_ROLES.has(role)) return !isOsaeCandidate(horse);
  return false;
}

/**
 * 抑え候補のソート: pt 降順 → 馬番昇順（視認性優先）。
 * @param {object[]} horses
 * @returns {object[]}
 */
export function sortOsaeCandidates(horses) {
  return [...horses].sort((a, b) => {
    const ptDiff = (Number(b?.pt) || 0) - (Number(a?.pt) || 0);
    if (ptDiff !== 0) return ptDiff;
    return (Number(a?.number ?? a?.horseNumber) || 0) - (Number(b?.number ?? b?.horseNumber) || 0);
  });
}

/**
 * 買い目 "(抑え...)" 用の馬番リストを返す。
 *   - 抑え候補（isOsaeCandidate）から、軸・選出済み相手（excludeNumbers）を除外
 *   - 並びは馬番昇順（評価順ではなく視認性優先）
 *   - 0 件なら空配列（呼び出し側は "(抑え...)" を付与しない）
 *
 * メインレース・通常レース・三連複のいずれも同じこの関数を使うことで、
 * 「表示の抑え」と「買い目の抑え」が構造的に一致する。
 *
 * @param {object[]} horses - レースの全馬
 * @param {Array<number|string>} excludeNumbers - 軸・通常相手など除外する馬番
 * @returns {number[]} 抑え馬番（昇順）
 */
export function selectOsaeNumbers(horses, excludeNumbers = []) {
  if (!Array.isArray(horses)) return [];
  const exclude = new Set(excludeNumbers.map((n) => Number(n)).filter((n) => Number.isFinite(n)));
  return horses
    .filter(isOsaeCandidate)
    .map((h) => Number(h?.number ?? h?.horseNumber))
    .filter((n) => Number.isFinite(n) && !exclude.has(n))
    .sort((a, b) => a - b);
}
