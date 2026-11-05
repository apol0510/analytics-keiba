/**
 * AK の回収率の公開スイッチ。計算値の現金回収率と AI算定指標を出すかどうかを決める。
 * 馬・騎手の条件別回収率は AK の成績ではないので対象外。
 */
export const RECOVERY_RATE_PUBLIC = true;

/**
 * 入門講座 Step 1・2・4・5・6・7 の本文は平均回収率 193.9% など過去の成績を前提にしている。
 * 実測と合わないので、本文を書き直すまで true にしない。
 */
export const LEGACY_RECOVERY_LESSONS_PUBLIC = false;

/** 非公開の間は null を返す。テンプレートの `!= null` 判定でカードごと消える */
export const publicRate = (value) => (RECOVERY_RATE_PUBLIC ? value : null);
