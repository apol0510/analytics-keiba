/**
 * importAkFacts.js — AK 側の事実を「アドレスの集合」に落とす（純粋・I/O なし）
 *
 * ── なぜ切り出したか（2026-08-05 の不具合）────────────────────────
 * この処理は `admin-customer-import.js` の中に直接書かれていて、テストが無かった。
 * そのため **「現役の有料会員を除外する」判定が一度も動いていなかった**:
 *
 *     if (mk.planGroup && mk.planGroup !== MK_PLAN.FREE && ...)   // ❌
 *
 * `resolveCustomerMarketing()` が返すのは `plan` であって `planGroup` ではない。
 * `undefined` との比較なので条件は常に false になり、`paid` は常に空だった。
 * 実 CSV 3 ファイルの下見でも `paid_member: 0` と出ていたが、これは
 * 「有料会員が 1 人も居なかった」のではなく **判定が動いていなかった**という意味。
 *
 * 取り込みの安全条件の中核なので、**純粋モジュールへ出してテストで固定する**。
 */

import { normalizeEmail } from './customerImport.js';
import { resolveCustomerMarketing, MK_PLAN } from '../marketing/customerMarketingAudience.js';
import { checkSelectable } from '../comeback/comebackGrantPlan.js';

/** 停止・テストの判定に使う Status（`checkSelectable` の理由コード） */
const SUSPENDED_REASON = 'account_suspended';

/**
 * この顧客は「現役の有料会員」か。
 *
 * **二重に見る**（どちらかに当たれば有料扱い＝取り込まない側へ倒す）:
 *   1. 契約状態: プランが Free 以外 かつ contract が active
 *   2. 権利: 課金由来の Premium / Light が有効（`premiumActive` / `lightActive`）
 *      ※ これらは**課金契約のみ**で、無料特典（promo*）では true にならない
 *
 * @param {object} mk `resolveCustomerMarketing()` の戻り値
 */
export function isActivePaidCustomer(mk) {
  if (!mk || typeof mk !== 'object') return false;
  const byContract = !!mk.plan && mk.plan !== MK_PLAN.FREE && mk.contract === 'active';
  const byEntitlement = mk.premiumActive === true || mk.lightActive === true;
  return byContract || byEntitlement;
}

/**
 * Customers から取り込み判定に使う集合を作る。**アドレス以外は外へ出さない**。
 *
 * @param {{
 *   records: Array<{fields?: object}>,
 *   nowMs: number,
 *   blacklistHard?: Set<string>,
 *   blacklistSoft?: Set<string>,
 *   testRecipients?: Iterable<string>,
 * }} input
 */
export function buildAkFacts({ records, nowMs, blacklistHard, blacklistSoft, testRecipients } = {}) {
  const hard = blacklistHard instanceof Set ? blacklistHard : new Set();
  const soft = blacklistSoft instanceof Set ? blacklistSoft : new Set();

  const existing = new Set();
  const seen = new Map();
  const duplicateInAk = new Set();
  const paid = new Set();
  const unsubscribed = new Set();
  const suspended = new Set();
  const testAccounts = new Set();
  /** email -> recordId（重複しているアドレスは入れない。書き込み直前の再判定に使う） */
  const recordIdByEmail = new Map();

  for (const rec of (records || [])) {
    const f = (rec && rec.fields) || {};
    const email = normalizeEmail(f.Email);
    if (!email) continue;
    existing.add(email);
    seen.set(email, (seen.get(email) || 0) + 1);
    if (seen.get(email) > 1) { duplicateInAk.add(email); recordIdByEmail.delete(email); }
    else if (rec && rec.id) recordIdByEmail.set(email, rec.id);

    const mk = resolveCustomerMarketing({ fields: f, nowMs, blacklistEmails: hard });
    if (isActivePaidCustomer(mk)) paid.add(email);
    if (Array.isArray(mk.suppressionReasons) && mk.suppressionReasons.includes('unsubscribed')) {
      unsubscribed.add(email);
    }

    const sel = checkSelectable(f, { duplicateEmail: false });
    if (!sel.ok && sel.reason === SUSPENDED_REASON) {
      const status = String(f.Status ?? '').trim().toLowerCase();
      const plan = String(f['プラン'] ?? f.Plan ?? '').trim().toLowerCase();
      if (status === 'test' || plan === 'test') testAccounts.add(email);
      else suspended.add(email);
    }
  }

  for (const t of (testRecipients || [])) {
    const e = normalizeEmail(t);
    if (e) testAccounts.add(e);
  }

  return {
    existing, duplicateInAk, paid, unsubscribed, suspended, testAccounts,
    hardBounce: hard, softBounce: soft, recordIdByEmail,
  };
}

export default buildAkFacts;
