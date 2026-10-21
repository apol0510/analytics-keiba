/**
 * unverifiedCheckoutRecord.js — 「未ログインの定期課金申込で作った、まだ無料のレコード」の単一源（純粋・I/O なし）
 *
 * 2026-10-21: 無料会員・初めての方が PayPal 月額・年額を申し込めるよう、未ログインの申込は
 * **入力されたメールアドレス**で会員を決め、該当が無ければ無料会員のレコードを作る
 * （`billing/paypal/paypalSubscriptionServer.js` の resolveCheckoutRecord）。
 *
 * そのメールアドレスは**本人確認していない**（誰でも他人のアドレスを入力できる）。
 * そのため、支払いが確認されて有料になるまでは、**こちらから一切メールを送らない**:
 *   - メルマガ（newsletter/audience-resolver.js の resolveAudienceRecipients）
 *   - キャンペーン・連続配信・DRM・無料体験・カムバック等（marketing/customerMarketingAudience.js の resolveSendability）
 *   - 送信直前の再確認（netlify/functions/marketing-campaign-dispatch.js）
 *   - Airtable 側で絞る経路は withUnverifiedCheckoutExcluded(formula)
 * 支払いが確認されると Webhook がプランを Premium に書くので、この判定から自然に外れる
 * （Source は書き換えない。以後は通常の有料会員として扱う）。
 *
 * どの経路が覆われているかは `unverifiedCheckoutRecord.guard.test.mjs` が固定する。
 */

/** 未ログインの定期課金申込で作るレコードの Source（この値でだけ判別する）*/
export const UNVERIFIED_CHECKOUT_SOURCE = 'paypal-subscription-checkout';

const str = (v) => String(v ?? '').trim();

/**
 * まだ本人確認も支払いも無いレコードか（= 送信してはいけない）。
 * Source が一致し、プランが空か Free のときだけ true。有料（Premium 等）になったら false。
 */
export function isUnverifiedCheckoutRecord(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  if (str(f.Source) !== UNVERIFIED_CHECKOUT_SOURCE) return false;
  const plan = str(f['プラン'] ?? f.Plan).toLowerCase();
  return plan === '' || plan === 'free';
}

/**
 * Airtable の formula で同じ判定を除外する部分式。
 * ⚠️ `!= BLANK()` は常に真になる（本番実測）ため使わない。空は `= BLANK()` で書く。
 */
export const UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA =
  `NOT(AND({Source} = '${UNVERIFIED_CHECKOUT_SOURCE}', OR({プラン} = BLANK(), LOWER({プラン}) = 'free')))`;

/** 既存の formula に除外を AND で足す（空なら除外だけ）*/
export function withUnverifiedCheckoutExcluded(formula) {
  const f = str(formula);
  return f ? `AND(${f}, ${UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA})` : UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA;
}
