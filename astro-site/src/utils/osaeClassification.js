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
 * G-CI 昇格用の「抑え最上位」を決定的に返す。
 *
 * 抑え候補（isOsaeCandidate: role ∈ {補欠, 押さえ, 抑え} かつ getOsaeCi(h) >= MIN_OSAE_CI）から、
 * **CI 降順 → pt 降順 → 馬番昇順** の決定順で先頭 1 頭を返す。候補が無ければ null。
 *   - import 時は role='補欠'、Astro 表示時は role='押さえ' に別名化されるが、いずれも
 *     OSAE_LIKE_ROLES に含まれるため import と表示で同一の抑え最上位を返す（正本一致）。
 *   - CI 欠落（getOsaeCi < 45）なら候補ゼロ → null を返し、呼び出し側は従来 F3 へフォールバックする。
 *
 * @param {object[]} horses - レースの全馬
 * @returns {object|null} 抑え最上位の horse、無ければ null
 */
export function getTopOsaeCandidate(horses) {
  if (!Array.isArray(horses)) return null;
  const candidates = horses.filter(isOsaeCandidate);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    const ciDiff = getOsaeCi(b) - getOsaeCi(a);
    if (ciDiff !== 0) return ciDiff;
    const ptDiff = (Number(b?.pt) || 0) - (Number(a?.pt) || 0);
    if (ptDiff !== 0) return ptDiff;
    return (Number(a?.number ?? a?.horseNumber) || 0) - (Number(b?.number ?? b?.horseNumber) || 0);
  })[0];
}

/**
 * 買い目 "(抑え...)" 用の馬番リストを返す。
 *
 * 方針 (2026-05-21): **指数45以上の馬を本線から漏らさない**ための role 非依存ルール。
 *   - racebook 系コンピ指数（getOsaeCi）≥ MIN_OSAE_CI(=45) の馬から、軸・選出済み相手
 *     （excludeNumbers）を除外したものを全て抑えに入れる。**role は問わない**。
 *   - 旧仕様（isOsaeCandidate = role が 補欠/押さえ/抑え に限定）では、指数45以上でも
 *     role=連下 で top5 相手に選ばれなかった馬（例 ci50 の連下6番手）が本線にも抑えにも
 *     入らず買い目から漏れていた。これを防ぐため role ゲートを外す。
 *   - これにより「指数45以上の馬は必ず 本線 ∪ 抑え に入る」不変条件が構造的に成立する。
 *   - 並びは馬番昇順、0 件なら空配列。
 *   - 指数44以下（不要馬・見送り）は対象外（= 抑えにしない）。
 *
 * 注意: 表示側の抑えセクション（isOsaeCandidate, role=補欠 限定）とは集合が異なり得る
 *   （連下で本線外の指数45以上馬は表示上は連下セクション、買い目上は抑え）。買い目の
 *   「指数45以上を漏らさない」要件を優先した意図的な差。
 *
 * @param {object[]} horses - レースの全馬
 * @param {Array<number|string>} excludeNumbers - 軸・通常相手など除外する馬番
 * @returns {number[]} 抑え馬番（昇順）
 */
export function selectOsaeNumbers(horses, excludeNumbers = []) {
  if (!Array.isArray(horses)) return [];
  const exclude = new Set(excludeNumbers.map((n) => Number(n)).filter((n) => Number.isFinite(n)));
  return horses
    .filter((h) => getOsaeCi(h) >= MIN_OSAE_CI)
    .map((h) => Number(h?.number ?? h?.horseNumber))
    .filter((n) => Number.isFinite(n) && !exclude.has(n))
    .sort((a, b) => a - b);
}
