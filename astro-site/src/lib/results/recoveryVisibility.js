/**
 * AK の回収率を公開するかどうかのスイッチ（2026-11-06 MK 指示で一時非表示）。
 * 再表示するときは true にする。集計・archive のデータはそのまま持ち続ける。
 * 馬・騎手の条件別回収率は AK の成績ではないので、このスイッチの対象外。
 */
export const RECOVERY_RATE_PUBLIC = false;

/** 非公開の間は null を返す。テンプレートの `!= null` 判定でカードごと消える */
export const publicRate = (value) => (RECOVERY_RATE_PUBLIC ? value : null);
