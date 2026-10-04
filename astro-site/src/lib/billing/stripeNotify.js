/**
 * stripeNotify.js — Stripe 決済の管理者通知（新規契約・要確認）
 *
 * 銀行振込の申込と同じく support@ へ送る。**通知の失敗で決済の反映を止めない**（best effort）。
 * 秘密鍵・カード情報は一切載せない（Stripe から受け取っていない）。
 */

import sgMail from '@sendgrid/mail';
import { planById } from './stripePlans.js';

const ADMIN_EMAIL = 'support@keiba.link';
const FROM_EMAIL = 'noreply@keiba.link';

const CONFLICT_TEXT = {
  duplicate_subscription: '同じ会員に別の Stripe 購読が残っています（二重課金の可能性）。古い方を解約・返金してください。',
  existing_lifetime: 'Premium 買い切り会員が月額を申し込みました。返金・解約をご検討ください（権限は変更していません）。',
  existing_longer_contract: '銀行振込の Premium 期間が残っている会員が月額を申し込みました（権限は変更していません）。返金・解約をご検討ください。',
  unknown_price: '登録されていない Price の購読です。権限は付与していません。Stripe の商品設定を確認してください。',
  no_period_end: '請求期間が読めない購読です。権限は付与していません。',
  duplicate_email_records: '同じメールアドレスの顧客レコードが複数あるため、権限を付与できませんでした。',
  duplicate_subscription_records: '同じ購読 ID を持つ顧客レコードが複数あります。',
  no_email: 'メールアドレスの無い購読です。権限は付与していません。',
};

export function makeStripeNotifier(env, { mode = 'test', send } = {}) {
  const key = env.SENDGRID_API_KEY;
  const doSend = send || (key ? (msg) => { sgMail.setApiKey(key); return sgMail.send(msg); } : null);
  return async function notify(kind, detail = {}) {
    if (!doSend) return;
    const prefix = mode === 'live' ? '' : '[テスト] ';
    const plan = detail.planId ? planById(detail.planId) : null;
    const lines = [];
    let subject;
    if (kind === 'attached') {
      subject = `${prefix}【KEIBA Analytics】Stripe 新規契約: ${plan ? plan.label : '不明'}`;
      lines.push('Stripe で月額プランの新規契約がありました。権限は自動で付与済みです（作業は不要）。');
      lines.push('');
      lines.push(`プラン: ${plan ? `${plan.label}（月額 ¥${plan.amountYen.toLocaleString('ja-JP')}）` : '不明'}`);
      lines.push(`有効期限: ${detail.expiration || '-'}（毎月の決済で自動延長）`);
    } else {
      subject = `${prefix}【KEIBA Analytics】Stripe 要確認: ${detail.reason || kind}`;
      lines.push(CONFLICT_TEXT[detail.reason] || `要確認: ${detail.reason || kind}`);
      lines.push('');
      if (plan) lines.push(`プラン: ${plan.label}`);
    }
    if (detail.recordId) lines.push(`Airtable: https://airtable.com/apptmQUPAlgZMmBC9/tblKnZyqaZiwILaWQ/${detail.recordId}`);
    if (detail.subscriptionId) {
      const base = mode === 'live' ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test';
      lines.push(`Stripe: ${base}/subscriptions/${detail.subscriptionId}`);
    }
    try {
      await doSend({ to: ADMIN_EMAIL, from: FROM_EMAIL, subject, text: lines.join('\n') });
    } catch {
      // 通知の失敗で反映を止めない
    }
  };
}
