/**
 * 入金確認による有料プラン昇格（Airtable Automation 専用）
 *
 * トリガー: Airtable Customers の PaymentConfirmed が checked になったとき
 *
 * 動作:
 *   1. recordId（または email）でレコードを取得
 *   2. 【認可】Airtable 上で PaymentConfirmed が true であることを確認（false なら 403）
 *   3. RequestedPlan / RequestedPlanType から昇格内容を決める（空なら昇格せず管理者へ通知）
 *   4. 入金確認メールを送信し、provider が受理したかを判定する
 *   5. プラン / PlanType / Status=active / 有効期限（入金確認日 JST + 1年）/
 *      PaymentEmailSent（= provider が受理したか）を一括 PATCH
 *
 * 設計上の要点:
 * - MK の操作は「PaymentConfirmed にチェックを入れる」1 アクションのみ。
 *   有効期限は入金確認日を基準に自動計算するため、日付の手入力は不要。
 * - 昇格はこの Function だけが行う。bank-transfer-application.js は
 *   申込内容を Requested* に退避するだけで、有料権限を一切付与しない。
 * - **メール送信は PATCH より先**（Step 4 → Step 5）。PaymentEmailSent を provider の
 *   結果で決めた上で Status='active' と同じ PATCH に載せるため。
 *   分割すると Status 変化で発火する Automation (send-payment-confirmation-auto.js) が
 *   PaymentEmailSent 未チェックを見て二重送信する。
 * - 二重メール防止: PATCH に PaymentEmailSent=<provider が受理したか> を含める。
 *   受理時は Status=active と同時に true になるため既存 Automation はスキップする。
 * - PaymentEmailSent は「送信できた証拠」。旧実装は送信前に無条件で true を立て、
 *   送信失敗も握り潰していたため、メール 0 通でも true になっていた（2026-07-14 修正）。
 * - メール送信が失敗しても昇格は巻き戻さない（権限・PaidAt・有効期限・Requested* クリアは維持）。
 * - ⚠️ provider の 2xx は「受理」までしか保証しない。バウンス抑制リスト等で受理後に
 *   配信が破棄される場合があり、実受信の保証にはならない。
 * - 二重延長防止: PATCH で Requested* をクリアする。再度チェックしても
 *   RequestedPlan が空なので昇格処理は走らない（fail closed）。
 * - 認可: この endpoint は公開 URL なので、Airtable 上の PaymentConfirmed=true を
 *   唯一の権限根拠とする（チェックできるのは Airtable にアクセスできる MK だけ）。
 *   PAYMENT_CONFIRM_SECRET が設定されている場合は x-confirm-secret ヘッダも必須にする。
 *
 * 判定ロジックの単一源: src/lib/payments/bankPaymentFlow.js
 */

import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
import { buildConfirmationFields, evaluateMailOutcome } from '../../src/lib/payments/bankPaymentFlow.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-confirm-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

/**
 * SendGrid へ送信し、結果を構造化して返す（throw しない）。
 * status / messageId だけを返し、API key・本文はけっして返さない。
 */
async function sendMail({ apiKey, to, subject, html }) {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
      reply_to: { email: SUPPORT_EMAIL },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  });
  return {
    status: response.status,
    // provider 側の追跡 ID。秘密情報ではないのでログに残してよい
    messageId: response.headers?.get?.('x-message-id') || null
  };
}

function confirmationEmailHtml({ fullName, plan, planType, expiration }) {
  const periodLabel = planType === 'Lifetime' ? '永久アクセス' : `${expiration} まで`;
  return `<!DOCTYPE html>
<html lang="ja"><body style="margin:0;padding:24px;background:#0f172a;font-family:sans-serif;color:#e2e8f0;">
  <div style="max-width:560px;margin:0 auto;background:#1e293b;border-radius:12px;padding:28px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#f1f5f9;">ご入金を確認いたしました</h1>
    <p style="line-height:1.7;">${fullName} 様</p>
    <p style="line-height:1.7;">
      お振込みの確認が取れましたので、下記のプランでのご利用を開始いただけます。<br>
      いつもご利用いただきありがとうございます。
    </p>
    <table style="width:100%;margin:20px 0;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#94a3b8;">プラン</td><td style="padding:8px 0;font-weight:700;">${plan}</td></tr>
      <tr><td style="padding:8px 0;color:#94a3b8;">お支払い区分</td><td style="padding:8px 0;">${planType}</td></tr>
      <tr><td style="padding:8px 0;color:#94a3b8;">ご利用期間</td><td style="padding:8px 0;font-weight:700;">${periodLabel}</td></tr>
    </table>
    <p style="line-height:1.7;">
      <a href="https://analytics.keiba.link/dashboard/" style="color:#60a5fa;">マイページはこちら</a>
    </p>
    <p style="line-height:1.7;font-size:13px;color:#94a3b8;margin-top:24px;">
      ご不明な点は <a href="mailto:${SUPPORT_EMAIL}" style="color:#60a5fa;">${SUPPORT_EMAIL}</a> までお問い合わせください。
    </p>
  </div>
</body></html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method Not Allowed' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const CONFIRM_SECRET = process.env.PAYMENT_CONFIRM_SECRET;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.error('❌ Airtable credentials not configured');
    return jsonResponse(500, { error: 'Airtable credentials missing' });
  }

  // 共有シークレットが設定されている場合のみ必須にする（未設定でも PaymentConfirmed 検証は効く）
  if (CONFIRM_SECRET) {
    const provided = event.headers?.['x-confirm-secret'] || event.headers?.['X-Confirm-Secret'];
    if (provided !== CONFIRM_SECRET) {
      console.warn('🚫 [confirm-bank-payment] シークレット不一致');
      return jsonResponse(403, { error: 'Forbidden' });
    }
  }

  let requestData;
  try {
    requestData = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { airtableRecordId, email: rawEmail } = requestData;
  const inputEmail = rawEmail ? String(rawEmail).trim().toLowerCase() : '';
  if (!airtableRecordId && !inputEmail) {
    return jsonResponse(400, { error: 'airtableRecordId or email is required' });
  }

  try {
    // ── Step 1: レコード取得 ──────────────────────────────
    let recordId = airtableRecordId;
    let fields = null;

    if (recordId) {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CUSTOMERS_TABLE}/${recordId}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
      if (!res.ok) {
        console.error('❌ Airtable record fetch failed:', res.status);
        return jsonResponse(404, { error: 'Record not found' });
      }
      fields = (await res.json()).fields || {};
    } else {
      const formula = `LOWER(TRIM({Email})) = '${inputEmail.replace(/'/g, "\\'")}'`;
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CUSTOMERS_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
      if (!res.ok) return jsonResponse(404, { error: 'Record not found' });
      const records = (await res.json()).records || [];
      if (records.length === 0) return jsonResponse(404, { error: 'Record not found' });
      recordId = records[0].id;
      fields = records[0].fields || {};
    }

    const email = fields['Email'];
    const fullName = fields['氏名'] || 'お客様';

    // ── Step 2: 認可 — Airtable 上で PaymentConfirmed が true か ────
    if (fields['PaymentConfirmed'] !== true) {
      console.warn(`🚫 [confirm-bank-payment] PaymentConfirmed が false: ${email} / ${recordId}`);
      return jsonResponse(403, { error: 'PaymentConfirmed is not checked', recordId });
    }

    // ── Step 3: 昇格内容を決める（fail closed）──────────────
    const confirmedAt = new Date();
    const planned = buildConfirmationFields({
      requestedPlan: fields['RequestedPlan'],
      requestedPlanType: fields['RequestedPlanType'],
      confirmedAt
    });

    if (!planned) {
      // フォーム未経由 / 二重実行 / PlanType 不明。推測で昇格させず管理者へ通知する
      const reason = fields['RequestedPlan']
        ? `RequestedPlanType が不正: ${fields['RequestedPlanType']}`
        : 'RequestedPlan が空（申込フォーム未経由、または既に処理済み）';
      console.warn(`⏸️ [confirm-bank-payment] 昇格スキップ: ${email} / ${reason}`);

      if (SENDGRID_API_KEY) {
        // sendMail は throw しないので、非 2xx も自前で検知してログに残す
        await sendMail({
          apiKey: SENDGRID_API_KEY,
          to: ADMIN_EMAIL,
          subject: `【要手動対応】入金確認の自動昇格をスキップしました - ${email}`,
          html: `<p>${email}（recordId: ${recordId}）の PaymentConfirmed が押されましたが、自動昇格をスキップしました。</p>
                 <p>理由: ${reason}</p>
                 <p>Airtable でプラン・PlanType・有効期限・Status を手動で設定してください。</p>`
        })
          .then((r) => {
            const outcome = evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: r.status });
            if (!outcome.providerAccepted) {
              console.error('管理者通知メール失敗:', { providerStatus: r.status, failureStage: outcome.failureStage });
            }
          })
          .catch((e) => console.error('管理者通知メール失敗（例外）:', e.message));
      }

      return jsonResponse(200, { skipped: true, reason, recordId });
    }

    // ── Step 4: 入金確認メール（昇格 PATCH より先に送る）──────
    //
    // PATCH より前に送るのは、PaymentEmailSent を「provider が受理したか」で決めた上で
    // Status='active' と同じ 1 回の PATCH に載せるため。分割して後から PaymentEmailSent を
    // 立てると、Status 変化で発火する Automation (send-payment-confirmation-auto) が
    // PaymentEmailSent 未チェックを見て二重送信してしまう。
    //
    // メール失敗でも昇格は続行する（Premium 権限・PaidAt・有効期限・Requested* クリアは維持）。
    let providerStatus = null;
    let providerMessageId = null;
    let threw = false;

    if (SENDGRID_API_KEY && email) {
      try {
        const result = await sendMail({
          apiKey: SENDGRID_API_KEY,
          to: email,
          subject: '【KEIBA Analytics】ご入金を確認いたしました',
          html: confirmationEmailHtml({
            fullName,
            plan: planned.fields['プラン'],
            planType: planned.fields['PlanType'],
            expiration: planned.expiration
          })
        });
        providerStatus = result.status;
        providerMessageId = result.messageId;
      } catch (e) {
        threw = true;
        console.error('❌ 入金確認メール送信で例外（昇格は続行）:', e.message);
      }
    }

    const mail = evaluateMailOutcome({
      hasApiKey: !!SENDGRID_API_KEY,
      hasEmail: !!email,
      providerStatus,
      threw
    });

    // 構造化ログ。API key / Authorization / メール本文は出さない
    console.log('📧 [confirm-bank-payment] メール送信結果:', {
      recordId,
      providerAttempted: mail.providerAttempted,
      providerAccepted: mail.providerAccepted,
      providerStatus,
      hasProviderMessageId: !!providerMessageId,
      providerMessageId,
      failureStage: mail.failureStage
    });

    // ── Step 5: 昇格（1 回の PATCH で確定）────────────────
    // PaymentEmailSent は provider が受理したときだけ true。
    const confirmation = buildConfirmationFields({
      requestedPlan: fields['RequestedPlan'],
      requestedPlanType: fields['RequestedPlanType'],
      confirmedAt,
      emailSent: mail.providerAccepted
    });

    const patchRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CUSTOMERS_TABLE}/${recordId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields: confirmation.fields, typecast: true })
      }
    );

    if (!patchRes.ok) {
      const errorText = await patchRes.text();
      console.error('❌ Airtable PATCH failed:', errorText);
      // 握りつぶさない。Automation 側で失敗が見えるように 500 を返す
      return jsonResponse(500, { error: 'Airtable update failed', detail: errorText });
    }

    console.log('✅ [confirm-bank-payment] 昇格完了:', {
      email,
      recordId,
      plan: confirmation.fields['プラン'],
      planType: confirmation.fields['PlanType'],
      expiration: confirmation.expiration,
      paymentEmailSent: confirmation.fields['PaymentEmailSent']
    });

    return jsonResponse(200, {
      success: true,
      recordId,
      plan: confirmation.fields['プラン'],
      planType: confirmation.fields['PlanType'],
      expiration: confirmation.expiration,
      emailSent: mail.providerAccepted,
      emailFailureStage: mail.failureStage
    });
  } catch (error) {
    console.error('❌ [confirm-bank-payment] error:', error);
    return jsonResponse(500, { error: error.message });
  }
};
