/**
 * 入金確認による有料プラン昇格（Airtable Automation 専用）
 *
 * トリガー: Airtable Customers の PaymentConfirmed が checked になったとき
 *
 * 動作:
 *   1. recordId（または email）でレコードを取得
 *   2. 【認可】Airtable 上で PaymentConfirmed が true であることを確認（false なら 403）
 *   3. RequestedPlan / RequestedPlanType から昇格内容を決める（空なら昇格せず管理者へ通知）
 *   4. プラン / PlanType / Status=active / 有効期限（入金確認日 JST + 1年）を一括 PATCH
 *   5. 入金確認メールを送信
 *
 * 設計上の要点:
 * - MK の操作は「PaymentConfirmed にチェックを入れる」1 アクションのみ。
 *   有効期限は入金確認日を基準に自動計算するため、日付の手入力は不要。
 * - 昇格はこの Function だけが行う。bank-transfer-application.js は
 *   申込内容を Requested* に退避するだけで、有料権限を一切付与しない。
 * - 二重メール防止: PATCH に PaymentEmailSent=true を含める。Status pending→active で
 *   発火する既存 Automation (send-payment-confirmation-auto.js) はこのフラグを見て
 *   再送信をスキップするため、メールは常に 1 通になる。
 * - 二重延長防止: PATCH で Requested* をクリアする。再度チェックしても
 *   RequestedPlan が空なので昇格処理は走らない（fail closed）。
 * - 認可: この endpoint は公開 URL なので、Airtable 上の PaymentConfirmed=true を
 *   唯一の権限根拠とする（チェックできるのは Airtable にアクセスできる MK だけ）。
 *   PAYMENT_CONFIRM_SECRET が設定されている場合は x-confirm-secret ヘッダも必須にする。
 *
 * 判定ロジックの単一源: src/lib/payments/bankPaymentFlow.js
 */

import { SUPPORT_EMAIL, ADMIN_EMAIL } from './config/email-config.js';
import { resolveVerifiedSender } from '../../src/lib/payments/senderIdentity.js';
import { buildConfirmationFields } from '../../src/lib/payments/bankPaymentFlow.js';
import { buildV2ConfirmationFields } from '../../src/lib/payments/promotionV2.js';
import { parseGatesFromEnv, shouldConfirmUseV2 } from '../../src/lib/payments/paymentEmailState.js';
import {
  buildSanrenpukuPlusInitFields,
  SANRENPUKU_PAID_AT_FIELD,
  assertOnlyPlusFields,
  isPlusFieldsEnabled,
} from '../../src/lib/premiumPlus/premiumPlusEligibility.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';

/**
 * 三連複購入時の Plus 初期化ログの目印。ログ検索の入口になるので変えない。
 *
 * ⚠️ この PATCH は best effort（失敗しても昇格は巻き戻さない）。だからこそ
 *    **無言で失敗させない**。三連複の購入日時は `SanrenpukuPaidAt` にしか残らず
 *    （`RequestedAmount` は承認時にクリア、金額は管理者宛メールのみ）、
 *    ここが落ちると購入の裏取りが永久に取れなくなる。
 */
const SANRENPUKU_PLUS_INIT_TAG = '[sanrenpuku-plus-init]';

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

async function sendMail({ apiKey, to, subject, html }) {
  // 送信元は単一源 senderIdentity.js が決める（noreply への fallback 禁止）。
  // 不一致 / 未設定は **SendGrid へ POST する前に fail closed**。理由コードのみを投げる（env の値は含めない）。
  const sender = resolveVerifiedSender(process.env);
  if (!sender.ok) {
    throw new Error(`sender_unverified: ${sender.reason}`);
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: sender.email, name: sender.name },
      reply_to: { email: SUPPORT_EMAIL },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SendGrid failed: ${response.status} - ${errorText}`);
  }
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
    // gate が v2（worker が送信できるモード）のときだけ v2 挙動へ切替。
    // 既定（env 未設定）は flow=legacy → useV2=false で従来と完全に同一挙動。
    const useV2 = shouldConfirmUseV2(parseGatesFromEnv(process.env));
    const confirmedAt = new Date();
    const confirmation = useV2
      ? buildV2ConfirmationFields({
          requestedPlan: fields['RequestedPlan'],
          requestedPlanType: fields['RequestedPlanType'],
          confirmedAt,
          recordId,
        })
      : buildConfirmationFields({
          requestedPlan: fields['RequestedPlan'],
          requestedPlanType: fields['RequestedPlanType'],
          confirmedAt
        });

    if (!confirmation) {
      // フォーム未経由 / 二重実行 / PlanType 不明。推測で昇格させず管理者へ通知する
      const reason = fields['RequestedPlan']
        ? `RequestedPlanType が不正: ${fields['RequestedPlanType']}`
        : 'RequestedPlan が空（申込フォーム未経由、または既に処理済み）';
      console.warn(`⏸️ [confirm-bank-payment] 昇格スキップ: ${email} / ${reason}`);

      if (SENDGRID_API_KEY) {
        await sendMail({
          apiKey: SENDGRID_API_KEY,
          to: ADMIN_EMAIL,
          subject: `【要手動対応】入金確認の自動昇格をスキップしました - ${email}`,
          html: `<p>${email}（recordId: ${recordId}）の PaymentConfirmed が押されましたが、自動昇格をスキップしました。</p>
                 <p>理由: ${reason}</p>
                 <p>Airtable でプラン・PlanType・有効期限・Status を手動で設定してください。</p>`
        }).catch((e) => console.error('管理者通知メール失敗:', e.message));
      }

      return jsonResponse(200, { skipped: true, reason, recordId });
    }

    // ── Step 4: 昇格（1 回の PATCH で確定）────────────────
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
      expiration: confirmation.expiration
    });

    // ── Step 4.5: Premium Plus 販売資格の初期化（三連複購入時のみ・best effort）──
    // 三連複の昇格が成功した**後**に、Plus 専用フィールドだけを別 PATCH で書く。
    //   - SanrenpukuPaidAt … Plus 段階公開の anchor（既に値があれば書き換えない）
    //   - PremiumPlusEligibility='review' … 新規候補は必ず管理者確認待ち。自動 eligible にしない
    //     （管理者が設定済みの eligible / blocked は上書きしない）
    // ⚠️ ここが失敗しても昇格・メールを巻き戻さない（決済成功を最優先で保持する）。
    //    フィールド未作成の本番で 422 を出さないよう PREMIUM_PLUS_FIELDS_READY で gate する。
    const isSanrenpukuPromotion = confirmation.fields['LifetimeSanrenpuku'] === true;
    // 結果を必ず 1 つ確定させる。**この PATCH は best effort なので、
    // 失敗しても昇格は巻き戻さない。ただし「無言で失敗」させない**（2026-08-08）。
    // 三連複の購入日時は SanrenpukuPaidAt にしか残らず（RequestedAmount は承認時にクリア、
    // 金額は管理者宛メールのみ）、ここが落ちると購入の裏取りが永久に取れなくなる。
    let plusInitOutcome = null;
    let plusPaidAtRecorded = false;
    // ⚠️ 条件式はこの形のまま（既存 guard が `isSanrenpukuPromotion && isPlusFieldsEnabled(...)` を固定している）
    if (isSanrenpukuPromotion && isPlusFieldsEnabled(process.env)) {
      try {
        const plusInit = buildSanrenpukuPlusInitFields({ fields, confirmedAt });
        if (!plusInit || !assertOnlyPlusFields(plusInit.fields)) {
          // 既に SanrenpukuPaidAt / eligibility があり、書くものが無い（冪等）
          plusInitOutcome = 'nothing_to_write';
        } else {
          const willRecordPaidAt = Object.prototype.hasOwnProperty.call(
            plusInit.fields, SANRENPUKU_PAID_AT_FIELD
          );
          const plusRes = await fetch(
            `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CUSTOMERS_TABLE}/${recordId}`,
            {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ fields: plusInit.fields, typecast: true })
            }
          );
          if (plusRes.ok) {
            plusInitOutcome = 'recorded';
            plusPaidAtRecorded = willRecordPaidAt;
          } else {
            plusInitOutcome = `failed_http_${plusRes.status}`;
          }
        }
      } catch (e) {
        plusInitOutcome = 'failed_error';
      }
    } else if (isSanrenpukuPromotion) {
      // 三連複昇格だが env gate が閉じている（未作成フィールドへ PATCH しない）
      plusInitOutcome = 'gate_closed';
    }
    if (isSanrenpukuPromotion) {
      // 構造化ログ。**識別子を一切載せない**（secret / PII / recordId / メール / 氏名すべて）。
      // 観測に必要なのは「どういう結果になったか」だけで、誰かの特定は不要。
      // ⚠️ 個別の追跡が要るときは**応答**（`sanrenpukuPlusInit` / `sanrenpukuPaidAtRecorded`）を見る。
      //    応答は Airtable Automation にしか渡らず、recordId も同じ応答に含まれている。
      const ok = plusInitOutcome === 'recorded' || plusInitOutcome === 'nothing_to_write';
      const line = `${SANRENPUKU_PLUS_INIT_TAG} ${JSON.stringify({
        outcome: plusInitOutcome,
        sanrenpukuPaidAtRecorded: plusPaidAtRecorded,
        promotion: 'kept', // 昇格は常に保持する（この PATCH の失敗で巻き戻さない）
      })}`;
      if (ok) console.log(line); else console.warn(line);
    }

    // ── Step 5: 入金確認メール ────────────────────────────
    // v2 では confirm は送信しない。pending を作り、送信 worker に委譲する
    // （PaymentEmailStatus='pending' は Step 4 の PATCH で既に書かれている）。
    if (useV2) {
      console.log('📮 [confirm-bank-payment] v2: pending 生成。送信は worker が担当', { recordId });
    } else if (SENDGRID_API_KEY && email) {
      await sendMail({
        apiKey: SENDGRID_API_KEY,
        to: email,
        subject: '【KEIBA Analytics】ご入金を確認いたしました',
        html: confirmationEmailHtml({
          fullName,
          plan: confirmation.fields['プラン'],
          planType: confirmation.fields['PlanType'],
          expiration: confirmation.expiration
        })
      }).catch((e) => {
        // メール失敗で昇格を巻き戻さない。PaymentEmailSent は既に true なので手動再送が必要
        console.error('❌ 入金確認メール送信失敗（昇格は完了済み）:', e.message);
      });
    } else {
      console.warn('⚠️ SENDGRID_API_KEY 未設定 or email 空。メール送信をスキップ');
    }

    return jsonResponse(200, {
      success: true,
      recordId,
      plan: confirmation.fields['プラン'],
      planType: confirmation.fields['PlanType'],
      expiration: confirmation.expiration,
      // 三連複購入のときだけ、購入日時の記録結果を返す（Automation / 運用者が失敗に気づけるように）。
      // ⚠️ ここが 'recorded' 以外でも昇格は成立している（決済成功を最優先で保持する設計）。
      ...(isSanrenpukuPromotion ? {
        sanrenpukuPlusInit: plusInitOutcome,
        sanrenpukuPaidAtRecorded: plusPaidAtRecorded,
      } : {}),
    });
  } catch (error) {
    console.error('❌ [confirm-bank-payment] error:', error);
    return jsonResponse(500, { error: error.message });
  }
};
