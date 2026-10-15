/**
 * withdrawalMail.js — 月額会員の退会完了のお知らせ（本人宛・best effort）。Stripe・PayPal の退会で共通。
 * メールアドレスはログに出さない。
 */
import sgMail from '@sendgrid/mail';
import { SUPPORT_EMAIL } from '../../../netlify/functions/config/email-config.js';
import { buildUnsubscribeUrl } from '../unsubscribe/listUnsubscribeHeaders.js';
import { formatJst } from '../datetime/jstTimestamp.js';

/** 退会完了のお知らせ（本人宛・best effort）。メールアドレスはログに出さない */
export async function sendWithdrawalCompleteEmail(env, email) {
  if (!env.SENDGRID_API_KEY || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return;
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.7;">
  <p>KEIBA Analytics をご利用いただきありがとうございました。</p>
  <p><strong>退会の手続きが完了しました。</strong>（${formatJst()}）</p>
  <ul>
    <li>月額プランのご契約は終了し、今後の請求はありません。</li>
    <li>退会と同時に有料会員としてのご利用は終了しています（残りの期間はご利用いただけません）。</li>
    <li>再びご利用いただく場合は、<a href="https://analytics.keiba.link/pricing/">料金ページ</a>から新しくお申し込みください。</li>
  </ul>
  <p>お心当たりがない場合は、このメールにご返信ください。</p>
  <p style="font-size: 14px; color: #6b7280;">メルマガは引き続き配信されます。配信停止は<a href="${buildUnsubscribeUrl({ email })}">こちら</a>から行えます。</p>
</div>`;
  try {
    sgMail.setApiKey(env.SENDGRID_API_KEY);
    await sgMail.send({
      to: email,
      from: { email: SUPPORT_EMAIL, name: 'KEIBA Analytics サポート' },
      replyTo: SUPPORT_EMAIL,
      subject: '【退会完了】KEIBA Analytics',
      html,
      trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } },
    });
  } catch {
    console.error(JSON.stringify({ event: 'stripe_withdraw_mail_failed' }));
  }
}
