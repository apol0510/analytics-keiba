/**
 * offer-application — 割引オファー経由の「銀行振込完了報告」を受け付ける
 *
 * `/offer/?t=<token>` のフォームから呼ばれる。既存 `/pricing/` 経路
 * （bank-transfer-application）と**同じ着地点**（Customers の Requested* に退避）に落とし、
 * 昇格は従来どおり `PaymentConfirmed` → `confirm-bank-payment` だけが行う。
 *
 * ── 既存経路と違う 1 点だけ ─────────────────────────────────────
 * プランと請求金額を**フォームから取らない**。offer 台帳の行から取る。
 * 割引価格を扱う経路なので、`productName` / `transferAmount` を信じると
 * 「¥1,000 で買い切り Premium」を自己申告できてしまう。
 *   RequestedPlan     ← offer.PlanName を 'Premium' へ正規化した値
 *   RequestedPlanType ← offer.PlanType（Monthly / Annual / Lifetime）
 *   RequestedAmount   ← offer.OfferPrice（請求すべき金額）
 * フォームの申告金額は管理者メールに載せるだけで、Airtable の請求額には影響しない。
 *
 * ── この Function が絶対に書かないもの ───────────────────────────
 *   プラン / PlanType / Status='active' / 有効期限 / PaidAt /
 *   PaymentConfirmed=true / PaymentEmailSent / LifetimeSanrenpuku /
 *   WithdrawalRequested / PremiumPlus* / 特典（Promo*）フィールド
 * 書くのは `buildApplicationFields()`（payments/bankPaymentFlow.js）の戻り値だけ。
 * guard テスト（offerIntakeFunction.guard.test.mjs）が実装を grep して固定する。
 *
 * ── 順序（途中で失敗したときに一番マシな状態で止まるように）───────────
 *   1. token 検証（offer 台帳を read）
 *   2. Customers に申込内容を PATCH（← 唯一の必須書き込み）
 *   3. offer を redeemed に更新（失敗しても申込は成立。二重申込は上書きになるだけ）
 *   4. 管理者メール → 申込者メール（失敗してもロールバックしない。Airtable が正本）
 *
 * gate: COMEBACK_OFFER_TABLE_READY='1' と PROMO_OFFER_SECRET が無ければ 503。
 */

import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
import { buildApplicationFields } from '../../src/lib/payments/bankPaymentFlow.js';
import {
  OFFERS_TABLE,
  verifyOfferToken,
  buildRedeemFields,
  isOfferTableEnabled,
  getOfferSecret,
  parseOfferToken,
  assertOnlyOfferFields,
} from '../../src/lib/promotions/promotionalOffer.js';
import {
  buildOfferKeyFormula,
  resolveOfferApplication,
} from '../../src/lib/promotions/offerIntake.js';
import {
  buildOfferAdminEmail,
  buildOfferUserEmail,
} from '../../src/lib/promotions/offerIntakeEmail.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

const auth = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

async function sendMail({ apiKey, to, bcc, subject, html }) {
  const personalization = { to: [{ email: to }], subject };
  if (bcc) personalization.bcc = [{ email: bcc }];
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [personalization],
      from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
      content: [{ type: 'text/html', value: html }],
      tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
    }),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method Not Allowed' });

  // ── gate ────────────────────────────────────────────────────
  if (!isOfferTableEnabled(process.env)) {
    return json(503, { success: false, error: '現在このお申し込みはご利用いただけません。サポートへご連絡ください。' });
  }
  const secret = getOfferSecret(process.env);
  if (!secret) {
    return json(503, { success: false, error: '現在このお申し込みはご利用いただけません。サポートへご連絡ください。' });
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  if (!KEY || !BASE) {
    console.error('❌ [offer-application] Airtable 認証情報が未設定');
    return json(500, { success: false, error: 'サーバー設定エラーです。サポートへご連絡ください。' });
  }

  let form = null;
  try {
    form = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { success: false, error: 'リクエストが不正です。' });
  }

  const token = String(form.token || '').trim();
  const parsed = parseOfferToken(token);
  if (!parsed) return json(400, { success: false, error: 'ご案内のリンクが不正です。メール内のリンクをもう一度お開きください。' });

  const formula = buildOfferKeyFormula(parsed.offerKey);
  if (!formula) return json(400, { success: false, error: 'ご案内のリンクが不正です。' });

  // ── 1. offer 台帳を read して token を検証（申込 email との一致も見る）──
  let offerRecord = null;
  try {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}`);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('maxRecords', '1');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`offers fetch failed: HTTP ${res.status}`);
    offerRecord = ((await res.json()).records || [])[0] || null;
  } catch (e) {
    console.error('❌ [offer-application] offer 台帳の参照に失敗:', e.message);
    return json(502, { success: false, error: '一時的なエラーです。時間をおいてお試しください。' });
  }

  const now = Date.now();
  const claimedEmail = String(form.email || '').trim().toLowerCase();
  const verified = verifyOfferToken({ token, record: offerRecord, secret, nowMs: now, claimedEmail });
  if (!verified.ok) {
    console.warn('⚠️ [offer-application] token 検証失敗:', verified.reason, `offerKey=${parsed.offerKey}`);
    const msg = verified.reason === 'email_mismatch'
      ? 'ご案内メールを受け取ったメールアドレスをご入力ください。'
      : (verified.reason === 'expired'
        ? 'このご案内の有効期限が切れています。サポートへご連絡ください。'
        : (String(verified.reason).startsWith('not_issued')
          ? 'このご案内は既にお申し込み済みか、現在ご利用いただけません。'
          : 'ご案内の内容を確認できませんでした。'));
    return json(403, { success: false, error: msg });
  }

  // ── フォーム検証 + 確定値の組み立て（プラン・請求額は offer 由来）──
  const resolved = resolveOfferApplication({ offer: verified.offer, form, nowMs: now });
  if (!resolved.ok) {
    console.warn('⚠️ [offer-application] 申込内容が不正:', resolved.reason);
    return json(400, { success: false, error: resolved.message });
  }
  const app = resolved.application;

  // ── 2. Customers へ申込内容を退避（唯一の必須書き込み）─────────────
  //   offer 発行時の CustomerRecordId を優先し、email 一致を必ず再確認する。
  //   （レコードが差し替わっていた場合に他人のレコードを書かないため）
  let customer = null;
  try {
    if (app.customerRecordId) {
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/${app.customerRecordId}`,
        { headers: { Authorization: `Bearer ${KEY}` } },
      );
      if (res.ok) {
        const rec = await res.json();
        const recEmail = String(rec?.fields?.Email || '').trim().toLowerCase();
        if (recEmail === app.email) customer = { id: rec.id, fields: rec.fields || {} };
        else console.warn('⚠️ [offer-application] CustomerRecordId の Email が不一致 → email 検索へ');
      }
    }
    if (!customer) {
      const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
      url.searchParams.set('filterByFormula', `LOWER(TRIM({Email})) = '${app.email.replace(/'/g, "\\'")}'`);
      url.searchParams.set('maxRecords', '2');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
      if (!res.ok) throw new Error(`customers fetch failed: HTTP ${res.status}`);
      const recs = (await res.json()).records || [];
      if (recs.length > 1) console.warn(`⚠️ [offer-application] 同一 Email で複数レコード: ${app.email}`);
      if (recs[0]) customer = { id: recs[0].id, fields: recs[0].fields || {} };
    }
  } catch (e) {
    console.error('❌ [offer-application] Customers 参照に失敗:', e.message);
    return json(502, { success: false, error: '一時的なエラーです。時間をおいてお試しください。' });
  }

  if (!customer) {
    // offer は既存顧客に対してのみ発行される。見つからない = レコード削除等の異常。
    // 推測で新規作成せず（誤ったレコードを作ると照合が壊れる）、サポート案内で止める。
    console.error('❌ [offer-application] 対象 Customers レコードが見つからない:', app.email);
    return json(409, {
      success: false,
      error: `お客様情報を確認できませんでした。お手数ですが ${SUPPORT_EMAIL} までご連絡ください。`,
    });
  }

  const fields = buildApplicationFields({
    currentStatus: customer.fields.Status || null,
    fullName: app.fullName,
    planName: app.requestedPlan,
    planType: app.requestedPlanType,
    amount: app.requestedAmount,
  });

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/${customer.id}`,
      { method: 'PATCH', headers: auth(KEY), body: JSON.stringify({ fields, typecast: true }) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    console.log('✅ [offer-application] 申込内容を Requested* に退避:', {
      email: app.email, recordId: customer.id, offerId: app.offerId,
      requestedPlan: app.requestedPlan, requestedPlanType: app.requestedPlanType,
      requestedAmount: app.requestedAmount, reportedAmount: app.reportedAmount,
      warnings: resolved.warnings,
    });
  } catch (e) {
    // ここが落ちたら申込は成立していない。メールも送らずエラーを返す（黙って握りつぶさない）
    console.error('❌ [offer-application] Customers 更新に失敗:', e.message);
    return json(502, {
      success: false,
      error: `お申し込みを保存できませんでした。お手数ですが ${SUPPORT_EMAIL} までご連絡ください。`,
    });
  }

  // ── 3. offer を redeemed に（二重利用の防止。失敗しても申込は成立している）──
  let redeemed = false;
  try {
    const redeem = buildRedeemFields({ record: offerRecord, nowMs: now });
    if (redeem.fields && assertOnlyOfferFields(redeem.fields)) {
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}/${offerRecord.id}`,
        { method: 'PATCH', headers: auth(KEY), body: JSON.stringify({ fields: redeem.fields }) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      redeemed = true;
    } else {
      console.warn('⚠️ [offer-application] redeem スキップ:', redeem.skipped || 'unknown');
    }
  } catch (e) {
    console.error('❌ [offer-application] offer の redeemed 更新に失敗（申込は成立）:', e.message);
  }

  // ── 4. 通知メール（Airtable が正本なので失敗しても申込は取り消さない）──
  const reportedAtText = new Date(now).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  let notified = false;
  if (!SENDGRID_API_KEY) {
    console.error('❌ [offer-application] SENDGRID_API_KEY 未設定 → 通知メールなし（申込は保存済み）');
  } else {
    try {
      const adminMail = buildOfferAdminEmail({ application: app, warnings: resolved.warnings, reportedAtText });
      await sendMail({
        apiKey: SENDGRID_API_KEY,
        to: ADMIN_EMAIL,
        bcc: process.env.MAKE_MAILHOOK_EMAIL || null,
        subject: adminMail.subject,
        html: adminMail.html,
      });
      notified = true;
    } catch (e) {
      console.error('❌ [offer-application] 管理者メール送信に失敗（申込は保存済み・要目視）:', e.message);
    }
    try {
      const userMail = buildOfferUserEmail({ application: app, supportEmail: SUPPORT_EMAIL, reportedAtText });
      await sendMail({
        apiKey: SENDGRID_API_KEY,
        to: app.email,
        subject: userMail.subject,
        html: userMail.html,
      });
    } catch (e) {
      console.error('❌ [offer-application] 申込者メール送信に失敗（申込は保存済み）:', e.message);
    }
  }

  return json(200, {
    success: true,
    message: 'お申し込みを受け付けました。入金の確認が取れ次第、ご利用開始のご案内をお送りします。',
    productName: app.productName,
    amount: app.requestedAmount,
    redeemed,
    notified,
  });
};
