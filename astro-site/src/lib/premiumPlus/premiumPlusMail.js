/**
 * premiumPlusMail.js — Premium Plus のメール送信と会員情報の取得（実 I/O の境界）
 *
 * 送信元は決済メールと同じ単一源（`senderIdentity.js` = support@keiba.link）。
 * 未設定・不一致なら**送らない**（noreply へ落とさない）。
 */
import { resolveVerifiedSender } from '../payments/senderIdentity.js';
import { SUPPORT_EMAIL } from '../../../netlify/functions/config/email-config.js';

/** Customers の 1 件（Email / 氏名 だけ使う）。読めなければ null */
export async function fetchCustomerFields(recordId, env = process.env) {
  const key = env.AIRTABLE_API_KEY;
  const base = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
  if (!key || !base || !recordId) return null;
  try {
    const res = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return (await res.json()).fields || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<'sent'|'failed'|'unknown'>} unknown = 届いたか分からない（自動再送しない）
 */
export async function sendPlusMail({ to, subject, text, html, customArgs = {} }, env = process.env) {
  const apiKey = env.SENDGRID_API_KEY;
  const sender = resolveVerifiedSender(env);
  if (!apiKey || !sender.ok || !to) return 'failed';
  const content = [{ type: 'text/plain', value: text }];
  if (html) content.push({ type: 'text/html', value: html });
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: sender.email, name: sender.name },
        reply_to: { email: SUPPORT_EMAIL },
        subject,
        content,
        custom_args: customArgs,
      }),
    });
    return res.status >= 200 && res.status < 300 ? 'sent' : 'failed';
  } catch {
    return 'unknown';
  }
}
