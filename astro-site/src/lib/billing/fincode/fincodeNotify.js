/**
 * fincodeNotify.js — fincode 決済の管理者通知（support@ 宛て・best effort）。顧客には送らない（誤通知を作らない）。
 * テスト環境では件名に [テスト] を付ける。カード情報・メールアドレスは載せない（recordId と注文 ID だけ）。
 */
import sgMail from '@sendgrid/mail';

const ADMIN_EMAIL = 'support@keiba.link';
const FROM_EMAIL = 'noreply@keiba.link';
const TEXT = {
  granted: 'カード決済（fincode）で Premium を反映しました（作業は不要）。',
  refunded: 'カード決済（fincode）の取消・返金を受け、付与前の状態へ戻しました（作業は不要）。',
  conflict: 'カード決済（fincode）は成功しましたが、権限は変更していません。返金をご判断ください。',
  refund_conflict: '取消・返金を受けましたが、付与後に別の変更があるため権限を戻していません。手動で確認してください。',
  mismatch: 'カード決済（fincode）の照会結果が申込と一致しません。権限は変更していません。',
};

export function makeFincodeNotifier(env, { mode = 'test', send } = {}) {
  const key = env.SENDGRID_API_KEY;
  const doSend = send || (key ? (msg) => { sgMail.setApiKey(key); return sgMail.send(msg); } : null);
  return async function notify(kind, d = {}) {
    if (!doSend) return;
    const prefix = mode === 'live' ? '' : '[テスト] ';
    const lines = [TEXT[kind] || `要確認: ${kind}`, ''];
    if (d.reason) lines.push(`理由: ${d.reason}`);
    if (d.productId) lines.push(`商品: ${d.productId}`);
    if (d.expiration) lines.push(`有効期限: ${d.expiration}`);
    if (d.orderId) lines.push(`注文: ${d.orderId}`);
    if (d.recordId) lines.push(`Airtable: https://airtable.com/apptmQUPAlgZMmBC9/tblKnZyqaZiwILaWQ/${d.recordId}`);
    try {
      await doSend({ to: ADMIN_EMAIL, from: FROM_EMAIL, subject: `${prefix}【Analytics】カード決済: ${kind}`, text: lines.join('\n') });
    } catch { /* 通知の失敗で反映を止めない */ }
  };
}
