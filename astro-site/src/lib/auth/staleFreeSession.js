/**
 * staleFreeSession.js — 「無料のままの端末ログイン」が有料会員に残っていたら一度ログアウトさせる（純粋）
 *
 * ## なぜ（2026-10-05・澤田様の事例）
 *
 * 無料会員は Cookie を持たず、端末（localStorage）に plan='free' を置くだけでログインする。
 * その後に入金して有料会員になっても、端末の plan='free' は自動では変わらない。本人は
 * 「ログインしている」つもりのまま無料の画面を見続け、「入金したのに反映されない」になる。
 * 有料会員はメールのログインリンク（ak_session）でしか有料の画面に入れないので、
 * 端末の古い無料ログインを**一度消して**、ログインし直しへ案内する。
 *
 * ## 何を見て決めるか
 *
 * - 端末: `user-plan` の plan が無料、かつメールアドレスがある（無料ログインの痕跡）
 * - サーバー: そのメールの会員が「有料（ログインリンクが要る）」か（`/api/plan-status.json`）
 * - 確認は 1 端末 12 時間に 1 回（Airtable の API 上限を食わない）
 */

export const STALE_FREE_CHECK_KEY = 'ak-stale-free-check-at';
export const STALE_FREE_CHECK_INTERVAL_MS = 12 * 3600 * 1000;
export const STALE_FREE_NOTICE_KEY = 'ak-relogin-notice';

/** ログアウト時に消す端末のキー（マイページのログアウトと同じ一覧） */
export const AUTH_LOCALSTORAGE_KEYS = Object.freeze([
  'user-plan', 'user_plan', 'isLoggedIn', 'userPlan', 'userData', 'userEmail',
  'hasClaimedReward', 'validUntil', 'isExpired', 'isWithdrawalRequested',
  'originalPlan', 'expiryDate', 'loginInfo', 'submission-history',
]);

const FREE_NAMES = new Set(['free', 'free-registered', 'freeregistered', 'expired', '無料']);

/**
 * 端末の状態から「サーバーに確かめるべきか」を決める。
 * @param {{ userPlanRaw: string|null, lastCheckAt: string|null, nowMs: number }} input
 * @returns {{ check: false } | { check: true, email: string }}
 */
export function planStaleFreeCheck({ userPlanRaw, lastCheckAt, nowMs }) {
  if (!userPlanRaw) return { check: false };
  let up;
  try { up = JSON.parse(userPlanRaw); } catch { return { check: false }; }
  const plan = String(up?.plan ?? '').trim().toLowerCase();
  const email = String(up?.email ?? '').trim().toLowerCase();
  if (!FREE_NAMES.has(plan) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { check: false };
  const last = Number(lastCheckAt);
  if (Number.isFinite(last) && nowMs - last < STALE_FREE_CHECK_INTERVAL_MS) return { check: false };
  return { check: true, email };
}

/** サーバーの答え → 端末をログアウトさせるか */
export function shouldLogoutStaleFree(response) {
  return Boolean(response && response.requiresLogin === true);
}
