/**
 * offerIntakeEmail.js — 割引オファー申込の通知メール本文（純粋・送信しない）
 *
 * 既存 `/pricing/` 経路（`bank-transfer-application.js`）は 300 行の HTML を
 * Function 内に直書きしている。offer 経路で同じものをコピペすると、
 * 金額の出し方を片方だけ直す事故が起きるので、**文面はここで組み立てて**
 * Function は送るだけにする（テスト可能にするのが主目的）。
 *
 * ⚠️ ここに書いてよいのは「申込を受け付けた」ことだけ。
 *    「ご利用開始」「アクセスを開放しました」等、**権限が付いたと誤解させる表現は禁止**
 *    （権限は MK の入金確認 → confirm-bank-payment まで付かない）。guard テストで固定。
 */

import { OFFER_WARNING_LABEL } from './offerIntake.js';

const SUPPORT_SIGNATURE = 'KEIBA Analytics';
const SITE = 'https://analytics.keiba.link';

/** 口座情報（`/pricing/` のモーダルと同じ値。変更時は両方直す） */
export const BANK_ACCOUNT_TEXT = [
  'PayPay銀行 本店営業部',
  '普通 8307337',
  'ｳｴﾌﾞｹｲﾊﾞ',
].join('\n');

function yen(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `¥${Math.round(v).toLocaleString('en-US')}` : '';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label, value) {
  return `<tr><th align="left" style="padding:6px 12px 6px 0;color:#475569;white-space:nowrap;">${esc(label)}</th>`
    + `<td style="padding:6px 0;color:#1e293b;">${esc(value)}</td></tr>`;
}

/**
 * 管理者宛（MK）— 入金照合に必要な値と、差異の警告を必ず載せる。
 *
 * @param {{ application: object, warnings?: string[], reportedAtText?: string }} input
 * @returns {{ subject: string, html: string }}
 */
export function buildOfferAdminEmail({ application, warnings = [], reportedAtText = '' }) {
  const a = application || {};
  const mismatch = Number(a.reportedAmount) !== Number(a.requestedAmount);
  const warnRows = (warnings || [])
    .map((w) => OFFER_WARNING_LABEL[w] || w)
    .map((t) => `<li style="color:#92400e;">${esc(t)}</li>`)
    .join('');

  const subject = `【カムバック割引 入金完了報告】${a.email} - ${a.productName}`
    + (mismatch ? '（金額差異あり）' : '');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;line-height:1.8;color:#333;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <h2 style="margin:0 0 4px;">🎁 カムバック割引オファーの入金完了報告</h2>
  <p style="margin:0 0 20px;color:#64748b;font-size:0.95rem;">
    管理画面から発行した割引オファー経由の申込です（通常価格ではありません）。
  </p>

  <h3 style="margin:20px 0 8px;">📋 申込内容</h3>
  <table style="border-collapse:collapse;font-size:0.95rem;">
    ${row('報告日時', reportedAtText)}
    ${row('お名前', a.fullName)}
    ${row('メールアドレス', a.email)}
    ${row('商品', a.productName)}
    ${row('オファーID', a.offerId)}
    ${row('OfferKey', a.offerKey)}
  </table>

  <h3 style="margin:20px 0 8px;">💰 金額</h3>
  <table style="border-collapse:collapse;font-size:0.95rem;">
    ${row('請求額（オファー価格）', yen(a.requestedAmount))}
    ${row('申告された振込金額', yen(a.reportedAmount))}
    ${row('振込完了日', a.transferDate)}
    ${row('振込名義人', a.transferName)}
  </table>
  ${mismatch ? `<p style="margin:12px 0;padding:12px;background:#fef3c7;border-left:4px solid #f59e0b;">
    ⚠️ 請求額と申告金額が一致していません。<strong>実際の入金額を通帳で確認してから</strong> PaymentConfirmed を押してください。
  </p>` : ''}
  ${warnRows ? `<ul style="margin:12px 0;padding:12px 12px 12px 32px;background:#fef3c7;border-left:4px solid #f59e0b;">${warnRows}</ul>` : ''}

  ${a.remarks ? `<h3 style="margin:20px 0 8px;">📝 備考</h3>
  <div style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:6px;">${esc(a.remarks)}</div>` : ''}

  <h3 style="margin:20px 0 8px;">✅ 対応</h3>
  <ol style="margin:0;padding-left:20px;color:#334155;">
    <li>入金を確認（${esc(BANK_ACCOUNT_TEXT.replace(/\n/g, ' / '))}）</li>
    <li>Airtable Customers の <strong>PaymentConfirmed</strong> にチェック
      （RequestedPlan=${esc(a.requestedPlan)} / RequestedPlanType=${esc(a.requestedPlanType)} で自動昇格）</li>
    <li>この申込では <strong>プラン / 有効期限 / Status は未変更</strong>です（入金確認まで無料相当）</li>
  </ol>

  <p style="margin-top:28px;color:#94a3b8;font-size:0.85rem;">${SUPPORT_SIGNATURE} 管理システム</p>
</div></body></html>`;

  return { subject, html };
}

/**
 * 申込者宛 — 「受け付けた」だけを伝える。開放したとは書かない。
 *
 * @param {{ application: object, supportEmail: string, reportedAtText?: string }} input
 * @returns {{ subject: string, html: string }}
 */
export function buildOfferUserEmail({ application, supportEmail, reportedAtText = '' }) {
  const a = application || {};
  const subject = `【お申し込み受付】${SUPPORT_SIGNATURE} ${a.productName}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;line-height:1.8;color:#333;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <h2 style="margin:0 0 4px;">お申し込みを受け付けました</h2>
  <p style="margin:0 0 20px;color:#475569;">
    ${esc(a.fullName)} 様、お手続きいただきありがとうございます。<br>
    入金の確認が取れ次第、ご利用開始のご案内メールをお送りいたします。
  </p>

  <h3 style="margin:20px 0 8px;">📋 お申し込み内容</h3>
  <table style="border-collapse:collapse;font-size:0.95rem;">
    ${row('受付日時', reportedAtText)}
    ${row('お名前', a.fullName)}
    ${row('メールアドレス', a.email)}
    ${row('内容', a.productName)}
    ${row('お振込金額', yen(a.requestedAmount))}
    ${row('振込完了日', a.transferDate)}
    ${row('振込名義人', a.transferName)}
  </table>

  <div style="margin:20px 0;padding:14px;background:#eff6ff;border-left:4px solid #3b82f6;">
    <strong>今後の流れ</strong><br>
    1. 弊社にて入金を確認いたします（土日祝は翌営業日になる場合があります）<br>
    2. 確認後、ログイン方法をメールでお送りします<br>
    3. ご案内メールが届くまでは、まだご利用いただけません
  </div>

  <p style="margin:20px 0;color:#475569;">
    振込先（お振込がまだの場合）:<br>
    <span style="display:inline-block;margin-top:6px;padding:10px;background:#f8fafc;border-radius:6px;white-space:pre-line;">${esc(BANK_ACCOUNT_TEXT)}</span>
  </p>

  <p style="margin:20px 0;color:#475569;">
    ご不明な点は <a href="mailto:${esc(supportEmail)}" style="color:#3b82f6;">${esc(supportEmail)}</a> までお問い合わせください。
  </p>

  <p style="margin-top:28px;color:#94a3b8;font-size:0.85rem;">
    ${SUPPORT_SIGNATURE}<br><a href="${SITE}" style="color:#3b82f6;text-decoration:none;">${SITE}</a>
  </p>
</div></body></html>`;

  return { subject, html };
}
