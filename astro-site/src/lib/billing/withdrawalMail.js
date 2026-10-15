/**
 * withdrawalMail.js — 退会完了のお知らせ（本人宛）と管理者への通知。どちらも best effort（失敗しても退会は戻さない）。
 * マイページの退会（memberWithdrawServer.js）で共通。メールアドレスはログに出さない。
 */
import sgMail from '@sendgrid/mail';
import { SUPPORT_EMAIL, ADMIN_EMAIL } from '../../../netlify/functions/config/email-config.js';
import { buildUnsubscribeUrl } from '../unsubscribe/listUnsubscribeHeaders.js';
import { formatJst } from '../datetime/jstTimestamp.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 本文の箇条書き（種類ごと）。退会 ≠ アカウント削除・買い切りは残る（2026-10-15 MK 確定） */
export function withdrawalCompleteLines({ kind = 'stripe', keeps = {} } = {}) {
  const lines = [];
  if (kind === 'stripe' || kind === 'paypal') {
    lines.push('月額プランのご契約は終了し、今後の請求はありません。');
    lines.push('退会と同時に有料会員としてのご利用は終了しています（残りの期間はご利用いただけません）。');
  }
  if (keeps.premiumLifetime) lines.push('Premium 買い切りは、退会後も引き続きご利用いただけます。');
  if (keeps.sanrenpukuLifetime) lines.push('三連複の買い切りは、退会後も引き続きご利用いただけます。');
  lines.push('これまでと同じメールアドレスでログインでき、マイページと無料予想は引き続きご利用いただけます。');
  lines.push('再び有料プランをご利用いただく場合は、<a href="https://analytics.keiba.link/pricing/">料金ページ</a>から新しくお申し込みください。');
  return lines;
}

/** 退会完了のお知らせ（本人宛・best effort）。opts.kind / opts.keeps で本文を変える */
export async function sendWithdrawalCompleteEmail(env, email, opts = {}) {
  if (!env.SENDGRID_API_KEY || !EMAIL_RE.test(String(email || ''))) return;
  const items = withdrawalCompleteLines(opts).map((l) => `    <li>${l}</li>`).join('\n');
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.7;">
  <p>KEIBA Analytics をご利用いただきありがとうございました。</p>
  <p><strong>退会の手続きが完了しました。</strong>（${formatJst()}）</p>
  <ul>
${items}
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
    console.error(JSON.stringify({ event: 'withdraw_mail_failed' }));
  }
}

const KIND_LABEL = Object.freeze({
  stripe: '月額（クレジットカード・Stripe）',
  paypal: '月額（PayPal）',
  contract: '銀行振込の有料プラン（年払い等）',
  lifetime_only: '買い切りのみ（権利は残る）',
});

/** 管理者への通知（レコード ID と種類だけ。メールアドレス等の個人情報は載せない） */
export async function sendWithdrawalAdminNotice(env, { recordId, kind, failed = false, mode = null } = {}) {
  if (!env.SENDGRID_API_KEY) return;
  const prefix = mode && mode !== 'live' ? '[テスト] ' : '';
  const subject = failed
    ? `${prefix}【KEIBA Analytics】退会の書き込み失敗（要確認）`
    : `${prefix}【KEIBA Analytics】マイページから退会がありました`;
  const lines = [
    failed
      ? '退会の確定で Customers への書き込みに失敗しました。月額は購読を止めているので終了の通知で収束しますが、レコードを確認してください。'
      : 'マイページの「退会する」→ 確認 → 確定で退会がありました。自動で処理済みです（作業は不要）。',
    '',
    `種類: ${KIND_LABEL[kind] || kind}`,
    `レコード: ${recordId}`,
  ];
  try {
    sgMail.setApiKey(env.SENDGRID_API_KEY);
    await sgMail.send({
      to: ADMIN_EMAIL,
      from: { email: SUPPORT_EMAIL, name: 'KEIBA Analytics 退会管理' },
      subject,
      text: lines.join('\n'),
      trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } },
    });
  } catch {
    console.error(JSON.stringify({ event: 'withdraw_admin_notice_failed' }));
  }
}
