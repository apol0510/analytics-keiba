/**
 * cardNotify.js — カード決済（決済会社共通）の管理者通知（support@ 宛て・best effort）。
 * 顧客には送らない（誤通知を作らない。顧客への完了案内は決済会社の完了メールと決済完了画面）。
 * テスト環境では件名に [テスト] を付ける。カード情報・メールアドレスは載せない（recordId と決済 ID だけ）。
 */
import sgMail from '@sendgrid/mail';

const ADMIN_EMAIL = 'support@keiba.link';
const FROM_EMAIL = 'noreply@keiba.link';
const LABEL = { fincode: 'fincode', paddle: 'Paddle', paypal: 'PayPal' };
const TEXT = {
  granted: 'カード決済で Premium を反映しました（作業は不要）。',
  refunded: '全額返金・取消・チャージバックを受け、付与前の状態へ戻しました（作業は不要）。',
  conflict: '決済は成功しましたが、権限は変更していません。返金をご判断ください。',
  refund_conflict: '返金を受けましたが、付与後に別の変更があるため権限を戻していません。手動で確認してください。',
  refund_of_conflict: '権限を変更しなかった決済（要返金判断）の返金を受けました。権限の変更はありません（作業は不要）。',
  partial_refund: '一部返金を受けました。権限は変更していません。必要なら手動で調整してください。',
  mismatch: '決済会社の照会結果が申込と一致しません。権限は変更していません。',
};

export function makeCardNotifier(env, { mode = 'test', provider, send } = {}) {
  const key = env.SENDGRID_API_KEY;
  const doSend = send || (key ? (msg) => { sgMail.setApiKey(key); return sgMail.send(msg); } : null);
  return async function notify(kind, d = {}) {
    if (!doSend) return;
    const p = LABEL[d.provider || provider] || String(d.provider || provider || '');
    const prefix = mode === 'live' ? '' : '[テスト] ';
    const lines = [`[${p}] ${TEXT[kind] || `要確認: ${kind}`}`, ''];
    if (d.reason) lines.push(`理由: ${d.reason}`);
    if (d.productId) lines.push(`商品: ${d.productId}`);
    if (d.expiration) lines.push(`有効期限: ${d.expiration}`);
    if (d.paymentId || d.orderId) lines.push(`決済: ${d.paymentId || d.orderId}`);
    if (d.recordId) lines.push(`Airtable: https://airtable.com/apptmQUPAlgZMmBC9/tblKnZyqaZiwILaWQ/${d.recordId}`);
    try {
      await doSend({ to: ADMIN_EMAIL, from: FROM_EMAIL, subject: `${prefix}【Analytics】カード決済（${p}）: ${kind}`, text: lines.join('\n') });
    } catch { /* 通知の失敗で反映を止めない */ }
  };
}
