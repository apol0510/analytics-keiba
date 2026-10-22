/**
 * nativeWeeklyConfig.js — 元々の会員の週次の**名前と鍵**（依存なし）。
 * 判定は `nativeWeeklySync.js`。ここは画面・監視からも安全に import できる定数だけ。
 */

/** 開けるまで元々の会員を週次へ足さない（既定は不活性）*/
export const NATIVE_GATE_ENV = 'SENDGRID_WEEKLY_NATIVE_ENABLED';
/** 枠ごとの日付付き list の接頭辞 */
export const NATIVE_LIST_PREFIX = 'ak-native-weekly-';
/** Redis の状態（件数・id・digest だけ。アドレスは入れない）*/
export const NATIVE_STATE_PREFIX = 'ak:native-weekly:v1:';
export const NATIVE_STATE_LATEST_KEY = `${NATIVE_STATE_PREFIX}latest`;

export function isNativeGateOpen(env) {
  return String((env || {})[NATIVE_GATE_ENV] || '').trim() === 'true';
}
