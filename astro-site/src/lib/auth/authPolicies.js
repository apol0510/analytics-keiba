/**
 * authPolicies.js — 会員判定結果から各ログイン経路の分岐を決める純粋関数
 *
 * PR-B スコープ: auth-user（無料経路）/ send-magic-link（有料送信）の分岐を
 *   会員判定 1 箇所に紐づけてテスト可能にする。I/O なし。
 */

import { MEMBER_TYPE } from './memberResolution.js';

export const FREE_LOGIN_OUTCOME = Object.freeze({
  // 無料会員 → 即時無料状態。**期限切れ・退会申請の元有料会員もここ**（plan は 'free' 固定）
  FREE: 'free',
  REQUIRES_MAGIC_LINK: 'requires_magic_link', // 有料会員 → マジックリンク必須
  DENIED: 'denied',                   // 停止/強制ログアウト/判定不能 → 即時ログイン不可
});

/**
 * 無料ログイン経路（auth-user）の分岐を決める。
 * 有料会員の plan 名・内部状態は **返さない**（呼び出し側でも漏らさない）。
 * @param {{ memberType: string }} membership
 * @returns {{ outcome: string }}
 */
export function decideFreeLogin(membership) {
  const t = membership?.memberType;
  if (t === MEMBER_TYPE.FREE) return { outcome: FREE_LOGIN_OUTCOME.FREE };
  if (t === MEMBER_TYPE.PAID) return { outcome: FREE_LOGIN_OUTCOME.REQUIRES_MAGIC_LINK };
  return { outcome: FREE_LOGIN_OUTCOME.DENIED };
}

/**
 * マジックリンクを送ってよいか（paid のみ true）。
 * free / denied には送らない（列挙攻撃対策で応答は一定化するのは呼び出し側の責務）。
 * @param {{ memberType: string }} membership
 * @returns {boolean}
 */
export function shouldSendMagicLink(membership) {
  return membership?.memberType === MEMBER_TYPE.PAID;
}
