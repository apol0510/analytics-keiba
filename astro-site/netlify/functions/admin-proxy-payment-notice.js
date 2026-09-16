/**
 * admin-proxy-payment-notice.js — 運営者による「代理入金連絡」（応急・例外運用）
 *
 * 入金は確認できているのに、顧客本人が入金連絡フォームを送れていない場合に、
 * **運営者が顧客の代わりに申込情報（`Requested*`）だけを登録する**。
 *
 * ## これは何をしないか（誤解防止）
 *
 * - 顧客としてログインし直す機能ではない（なりすましではない）
 * - 有料権限（`プラン` / `PlanType` / `Status='active'` / `有効期限` / `PaidAt`）は**書かない**
 * - 顧客宛メールを**送らない**（利用開始メールは昇格側の責務）
 * - 会員レコードを**新規作成しない**（打ち間違いで空レコードを生やさない）
 * - Premium Plus は**対象外**（対象日・クーポン・会員別の販売停止の判定を迂回させない）
 *
 * 登録後の昇格は従来どおり `PaymentConfirmed` を起点にした既存の単一経路が行う。
 * 運営者の残作業は Airtable で `PaymentConfirmed` にチェックを入れる 1 アクションだけ。
 *
 * ## 認可（fail closed・多層）
 *
 * `premiumPlus/mediaAuth.js` の `decideAdminWrite` をそのまま使う:
 *   POST 限定 / 管理者 secret が設定済み / secret が timing-safe 一致 /
 *   本番 context / Origin が本番オリジンと完全一致。
 * 1 つでも欠ければ Airtable に到達しない。**URL 直打ち・直接 POST では通らない。**
 *
 * secret は `PROXY_NOTICE_ADMIN_SECRET`（無ければ `PAYMENT_ADMIN_SECRET`、
 * さらに無ければ `PREMIUM_PLUS_ADMIN_SECRET`）。admin-comeback-grants と同じ作法。
 *
 * ## action
 *
 * - `preview` … 何が書かれるかを返すだけ。**Airtable を 1 バイトも書かない**
 * - `apply`   … 判定を通ったときだけ 1 回 PATCH する
 *
 * 判定・組み立ての本体は `src/lib/payments/proxyPaymentNotice.js`（純粋・テスト済み）。
 */

import { decideAdminWrite, ADMIN_WRITE } from '../../src/lib/premiumPlus/mediaAuth.js';
import {
  decideProxyPaymentNotice, buildProxyNoticeFields, describeProxyNoticeForLog,
  isProxyAuditFieldsEnabled, normalizeProxyEmail,
} from '../../src/lib/payments/proxyPaymentNotice.js';
import { patchRecord } from '../../src/lib/payments/paymentEmailDeps.js';

const HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

/**
 * Email 完全一致で Customers を 1 件引く（`LOWER(TRIM())` で大小・空白差を吸収）。
 * **見つからなければ null**（新規作成はしない）。
 */
async function findCustomerByEmail(email) {
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('Airtable credentials missing');

  const escaped = String(email).replace(/'/g, "\\'");
  const formula = `LOWER(TRIM({Email})) = '${escaped}'`;
  const url = `https://api.airtable.com/v0/${base}/Customers`
    + `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=2`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Airtable GET ${res.status}`); // Base / 本文はログへ出さない
  const data = await res.json();
  const records = data.records || [];
  return records.length > 0 ? { id: records[0].id, fields: records[0].fields || {} } : null;
}

/** 画面に返してよい範囲の会員情報（PII を増やさない・課金判定はしない）。 */
function summarizeCustomer(record) {
  const f = record.fields || {};
  return {
    recordId: record.id,
    fullName: String(f['氏名'] || ''),
    plan: String(f['プラン'] || ''),
    planType: String(f.PlanType || ''),
    status: String(f.Status || ''),
    expiration: String(f['有効期限'] || ''),
    // 未確認の申込が残っていないか（二重登録の判断材料）
    requestedPlan: String(f.RequestedPlan || ''),
    requestedPlanType: String(f.RequestedPlanType || ''),
    paymentConfirmed: f.PaymentConfirmed === true,
  };
}

exports.handler = async (event) => {
  // ── 認可（Airtable へ触る前に必ず通す）─────────────────────────
  const adminSecret = process.env.PROXY_NOTICE_ADMIN_SECRET
    || process.env.PAYMENT_ADMIN_SECRET
    || process.env.PREMIUM_PLUS_ADMIN_SECRET;

  const auth = await decideAdminWrite({
    method: event.httpMethod,
    adminSecret,
    providedSecret: event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'],
    origin: event.headers?.origin || event.headers?.Origin,
    context: process.env.CONTEXT,
  });
  if (auth.decision !== ADMIN_WRITE.ALLOW) {
    // 理由でレスポンス本文を出し分けない（総当たりの手掛かりを与えない）
    return json(auth.status, { ok: false, error: 'Forbidden', sideEffects: 'none' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON', sideEffects: 'none' });
  }

  const action = String(body.action || 'preview');
  if (action !== 'preview' && action !== 'apply') {
    return json(400, { ok: false, error: 'action は preview か apply', sideEffects: 'none' });
  }

  const email = normalizeProxyEmail(body.email);
  const nowMs = Date.now();

  try {
    // 会員が存在しないときも decide に判定させる（拒否理由と文言を 1 箇所に集約するため）
    const record = email ? await findCustomerByEmail(email) : null;

    const decision = decideProxyPaymentNotice({
      operator: body.operator,
      email: body.email,
      productName: body.productName,
      receivedAmount: body.receivedAmount,
      paidDate: body.paidDate,
      reason: body.reason,
      record,
      replaceExisting: body.replaceExisting === true,
      nowMs,
    });

    if (!decision.ok) {
      return json(422, {
        ok: false,
        code: decision.reason,
        error: decision.message,
        sideEffects: 'none',
        customer: record ? summarizeCustomer(record) : null,
      });
    }

    const auditFieldsReady = isProxyAuditFieldsEnabled(process.env);
    const fields = buildProxyNoticeFields({ decision, auditFieldsReady, nowMs });

    if (action === 'preview') {
      return json(200, {
        ok: true,
        action: 'preview',
        sideEffects: 'none',
        auditFieldsReady,
        customer: summarizeCustomer(record),
        willWrite: fields,
        nextStep: 'Airtable の該当レコードで PaymentConfirmed にチェックを入れると昇格します。',
      });
    }

    await patchRecord(decision.recordId, fields);

    // 監査列が無い本番でも代理登録の事実が残るよう、構造化ログを必ず 1 行出す
    console.log('📝 [admin-proxy-payment-notice]', JSON.stringify(describeProxyNoticeForLog(decision)));

    return json(200, {
      ok: true,
      action: 'apply',
      sideEffects: 'customers_patched',
      auditFieldsReady,
      recordId: decision.recordId,
      wrote: fields,
      nextStep: 'Airtable の該当レコードで PaymentConfirmed にチェックを入れると昇格します。',
    });
  } catch (e) {
    console.error('[admin-proxy-payment-notice] error:', String(e && e.message).slice(0, 200));
    return json(500, { ok: false, error: '処理に失敗しました', sideEffects: action === 'apply' ? 'unknown' : 'none' });
  }
};
