/**
 * 銀行振込完了の報告フォーム処理
 * 振込完了後のユーザーから報告を受け付け、確認メールを送信する。
 * 事前予約・事前申し込みではないため、サーバー側で振込完了日の未来日を拒否する。
 */

import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
import { buildApplicationFields } from '../../src/lib/payments/bankPaymentFlow.js';
// 申込価格の正本（クーポン適用込み）。**クライアントの言い値を使わない**
import { resolveOrderPricing } from '../../src/lib/premiumPlus/premiumPlusCouponApply.js';
// クーポンの「利用予約」。**振込完了報告が正常受理された時点でだけ**作る
import {
  resolveReservationDecision, buildReservationFields, RESERVATION_REJECT,
  describeCouponLifecycle,
} from '../../src/lib/premiumPlus/premiumPlusCouponReservation.js';
import { describeCouponUsageForMember } from '../../src/lib/premiumPlus/premiumPlusReopenCoupon.js';
import {
  listReservationsFor, createReservation,
} from '../../src/lib/premiumPlus/premiumPlusCouponReservationStore.js';
// 有効期限は「再募集の開始日時 + 14 日」。開始状態はサーバー側の単一源からしか読まない
// （client が期限・開始日時を送ってきても採用しない）。
import { loadReopenStart } from '../../src/lib/premiumPlus/premiumPlusReopenStartStore.js';
import { withReopenStart } from '../../src/lib/premiumPlus/premiumPlusReopenStart.js';
import { checkMemberOnlyPricing } from '../../src/lib/pricing/pricingEligibility.js';
import { resolveOrderSaleDate, buildSaleProductName, isPremiumPlusProductName } from '../../src/lib/premiumPlus/premiumPlusSaleDate.js';
import { shapeRaceCalendar } from '../../src/lib/premiumPlus/premiumPlusRaceCalendar.js';
import { isSaleDateFieldEnabled, SALE_TARGET_DATE_FIELD } from '../../src/lib/payments/bankPaymentFlow.js';
import raceCalendarRaw from '../../src/data/premiumPlusRaceCalendar.json' with { type: 'json' };
import { recordPlusCheckoutStart } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import { normalizeSalePaused, PP_SALE_PAUSE_FIELDS } from '../../src/lib/premiumPlus/premiumPlusRelease.js';

exports.handler = async (event, context) => {
  // CORSヘッダー設定
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // プリフライトリクエスト対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POSTメソッドのみ許可
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // フォームデータ取得
    const formData = JSON.parse(event.body);
    const {
      fullName,
      email: rawEmail,
      transferDate,
      transferTime,
      transferAmount,
      transferName,
      remarks,
      productName,
      // 選択されたクーポン（**id だけ**。割引額・最終価格は受け取らない）
      couponId,
      saleTargetDate,
      funnelSource,
      paymentCompletedConfirm,
      timestamp
    } = formData;

    // 📧 Email 正規化（trim + lowercase）— 検索・登録すべてこの値で行う
    const email = rawEmail ? String(rawEmail).trim().toLowerCase() : '';

    // 必須項目チェック
    if (!fullName || !email || !transferDate || !transferTime || !transferAmount || !transferName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: '必須項目が入力されていません' })
      };
    }

    // ========================================
    // 入金済み確認チェック（必須）
    // 本フォームは振込完了の報告用。チェックなしの送信は受け付けない。
    // フロントの required を DevTools 等で外しても、ここで弾く。
    // ========================================
    if (paymentCompletedConfirm !== true) {
      console.warn('⚠️ Rejected: paymentCompletedConfirm not true:', { paymentCompletedConfirm, email });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: '銀行振込完了後にチェックを入れてから送信してください。'
        })
      };
    }

    // ========================================
    // 振込完了日バリデーション（JST基準）
    // 未来日は絶対に受け付けない。
    // 本フォームは振込完了の報告用のため、報告時点で振込が完了済みである必要がある。
    // ========================================
    const FUTURE_DATE_ERROR = '振込完了日に未来の日付は指定できません。実際に振込を完了してからご送信ください。';

    // YYYY-MM-DD 形式チェック
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(transferDate))) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: '振込完了日の形式が正しくありません（YYYY-MM-DD）' })
      };
    }

    // JST 今日（YYYY-MM-DD）を算出
    const jstTodayStr = (() => {
      const now = new Date();
      const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
      return new Date(jstMs).toISOString().slice(0, 10);
    })();

    // 未来日チェック（文字列比較で YYYY-MM-DD は辞書順 = 時系列）
    if (transferDate > jstTodayStr) {
      console.warn('⚠️ Rejected future transferDate:', { transferDate, jstTodayStr, email });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: FUTURE_DATE_ERROR })
      };
    }

    // 日本時間表示用
    const japanTime = new Date(timestamp).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // ────────────────────────────────────────────────────────────
    // 🔒 会員限定価格（/pricing/ の乗り換え特典価格 '... - Campaign'）の裏づけ確認
    //
    // 価格の出し分けは localStorage 由来の**非権威**情報で行われるため、
    // 実際の請求額に効く申込では **Airtable の課金契約**を根拠に再判定する。
    // 判定の単一源は src/lib/pricing/pricingEligibility.js
    // （無料特典 = promotional grant では価格資格が上がらない）。
    //
    // ⚠️ 資格が確認できなくても申込は拒否しない。本フォームは「振込完了の報告」で、
    //    既に送金した人を締め出すと事故になる。管理者メールに警告を出し、
    //    MK が PaymentConfirmed を押す前に判断できるようにするだけ。
    //    ここでは Airtable を 1 バイトも書かず、金額も書き換えない。
    // 通常価格の申込では Airtable を追加照会しない（Campaign 価格のときだけ 1 回 GET）。
    // ────────────────────────────────────────────────────────────
    // ── Premium Plus: 対象日をサーバーで確定させる ──────────────────
    // ⚠️ 画面の値をそのまま採用しない。フォームを開いたまま 16:30 をまたぐと
    //    「本日分」のつもりの注文が実際には翌日分になる。**サーバーが出し直す**。
    //    ここで確定した商品名（対象日入り）が、管理者通知メール・お客様控え・
    //    申請履歴のすべてを通って残る＝どの日の買い目を届けるかが経路の端まで伝わる。
    const isPremiumPlusOrder = isPremiumPlusProductName(productName);
    // 決済開始の計測に使う recordId。下の対象日照会で引けたら再利用し、
    // 引けなかったときだけ計測直前に 1 回だけ引き直す（Airtable の GET を増やさない）。
    let plusCustomerRecordId = null;
    // 同じ照会で得た会員 fields（販売の一時停止判定に使う）
    let plusCustomerFields = null;
    // ── 既に確定している対象日を読む（冪等の要）──────────────────
    // 未確定の申込（PaymentConfirmed=false）に保存された対象日があれば、
    // **再送・再読込・翌日以降の再実行でもそれを使い、再計算しない**。
    let existingSaleTargetDate = null;
    if (isPremiumPlusOrder && isSaleDateFieldEnabled(process.env)
        && process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) {
      try {
        const q = new URLSearchParams({
          filterByFormula: `LOWER(TRIM({Email})) = '${String(email).toLowerCase().replace(/'/g, "\\'")}'`,
          maxRecords: '1',
        });
        const res = await fetch(
          `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Customers?${q}`,
          { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } },
        );
        if (res.ok) {
          const data = await res.json();
          const rec0 = (data.records || [])[0] || null;
          const f = rec0?.fields || {};
          // 同じ照会で recordId と販売状態も拾っておく（決済開始の計測 / 停止判定で使う）
          if (rec0?.id) plusCustomerRecordId = rec0.id;
          plusCustomerFields = rec0 ? f : null;
          // 入金確認済みの注文の日付は引き継がない（次の注文は新しい対象日）
          if (f['PaymentConfirmed'] !== true) {
            const v = f[SALE_TARGET_DATE_FIELD];
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) existingSaleTargetDate = v;
          }
        }
      } catch (e) {
        // 読めなくても申込は止めない。**新規に確定させる**（推測はしない）
        console.warn('⚠️ [bank-transfer] 既存の対象日を読めませんでした:', e.message);
      }
    }
    let saleOrder = null;
    if (isPremiumPlusOrder) {
      // ⚠️ 画面が送ってきた saleTargetDate は**採用しない**（開いたまま 16:30 をまたぐとズレる）。
      //    既に注文へ保存済みの対象日があればそれが正（冪等）。無ければサーバーが決める。
      const stored = existingSaleTargetDate;
      saleOrder = resolveOrderSaleDate({
        storedDate: stored,
        nowMs: Date.now(),
        calendar: shapeRaceCalendar(raceCalendarRaw),
      });
      if (!stored && saleTargetDate && saleTargetDate !== saleOrder.date) {
        console.warn('⚠️ [bank-transfer] 対象日が画面とズレたためサーバー値を採用:', {
          claimed: saleTargetDate, server: saleOrder.date,
        });
      }
      // 例外が連続する等の異常時のみ売らない（通常は常に販売可）
      if (!saleOrder.sellable) {
        console.warn('🚫 [bank-transfer] 対象日の開催を確認できないため受付しません:', {
          reason: saleOrder.reason,
        });
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: '現在お申し込みを受け付けていません。次回受付時にあらためてお願いいたします。',
            code: `sale_not_available:${saleOrder.reason}`,
            sideEffects: 'none',
          }),
        };
      }
      console.log('📅 [bank-transfer] Premium Plus 対象日:', {
        date: saleOrder.date, reused: saleOrder.reused, reason: saleOrder.reason,
      });
    }

    // ── Premium Plus: 会員単位の販売 一時停止を**サーバーで**確認する ──────────
    // ⚠️ 画面（CTA の非表示 / ボタン disabled）は URL 直打ち・コンソール操作・
    //    古いタブからの再送で回避できる。**申込を止められるのはここだけ。**
    //    停止中の会員の申込は、メール送信より前に・副作用ゼロで打ち切る。
    //
    // 「販売対象外(blocked)」ではなく「一時停止」なので、文言も別にする
    // （顧客には理由を明かさず、再開があり得ることだけ伝える）。
    if (isPremiumPlusOrder) {
      try {
        if (plusCustomerFields === null
            && process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) {
          const q = new URLSearchParams({
            filterByFormula: `LOWER(TRIM({Email})) = '${String(email).toLowerCase().replace(/'/g, "\\'")}'`,
            maxRecords: '1',
          });
          const res = await fetch(
            `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Customers?${q}`,
            { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } },
          );
          if (res.ok) {
            const data = await res.json();
            const rec0 = (data.records || [])[0] || null;
            if (rec0) {
              plusCustomerRecordId = rec0.id;
              plusCustomerFields = rec0.fields || {};
            }
          }
        }
      } catch (e) {
        // 読めなかったときは**通常会員の申込まで巻き添えで止めない**。
        // 停止は正本（PremiumPlusSalePaused）が「停止」と読めたときだけ効かせる。
        // ⚠️ この窓では停止済み会員の申込を捕まえられない。
        //    それでも「Airtable が読めない」だけを理由に全員を止める設計は採らない。
        console.warn('⚠️ [bank-transfer] 会員レコードを読めませんでした:', e.message);
      }
      // ── 停止判定 ───────────────────────────────────────────
      // 正本は Airtable の `PremiumPlusSalePaused` **のみ**。
      // 画面（CTA 非表示・ボタン disabled）は URL 直打ち・古いタブからの再送で
      // 回避できるため、**申込を止められるのはここだけ**。
      if (plusCustomerFields
          && normalizeSalePaused(plusCustomerFields[PP_SALE_PAUSE_FIELDS.PAUSED])) {
        console.warn('🚫 [bank-transfer] Premium Plus 申込を拒否（販売停止）:', {
          recordId: plusCustomerRecordId || null,
        });
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error: '現在お申し込みを受け付けていません。再開までしばらくお待ちください。',
            code: 'sale_paused',
            sideEffects: 'none',
          }),
        };
      }
    }
    // ── クーポン検証（**副作用ゼロの地点で行う**）───────────────────
    // ⚠️ 本人が couponId を**明示的に選んだ**申込で検証に失敗したときは、
    //    黙って通常価格へ落として受理してはいけない。
    //    58,000円のつもりで申し込んだ人が 68,000円の申込を作られるのが最悪の事故。
    //    所持していない / 未知の id / 判定不能 は**申込ごと停止**し、
    //    Customers / PromotionalOffers / queue / メール のどれにも触れずに返す。
    //
    //    クーポンを**最初から選んでいない**申込は従来どおり通常価格で進む。
    let serverPricing = null;
    // 再募集の開始状態（＝クーポン有効期限の確定）。読めなければ期限未確定のまま進む
    let plusCouponDef = null;
    if (isPremiumPlusOrder) {
      // ⚠️ 会員ごとの開始日時。**申込者本人の recordId**で読む（client の申告は使わない）
      const reopenState = await loadReopenStart({
        recordId: plusCustomerRecordId || null, env: process.env,
      });
      plusCouponDef = withReopenStart(reopenState.startsAtIso);
      const selectedCouponId = String(couponId ?? '').trim();
      if (selectedCouponId) {
        // ⚠️ **もう使ったクーポンで割引の申込を作らせない**（2026-08-23）。
        //    保有（Customers の 3 列）は使い終わっても消えないため、
        //    保有だけを見ていると同じクーポンで何度でも 58,000円 の申込が通る。
        //    読めないときも通さない（誤った金額で受け付けない＝ fail closed）。
        let couponUsable = false;
        try {
          const ledger = await listReservationsFor({
            env: process.env, customerRecordId: plusCustomerRecordId || null,
          });
          couponUsable = ledger.available === true && describeCouponUsageForMember({
            lifecycle: describeCouponLifecycle({
              fields: plusCustomerFields,
              offerRows: ledger.records,
              ledgerAvailable: true,
              customerRecordId: plusCustomerRecordId || '',
            }).state,
            ledgerAvailable: true,
            claimed: true,
          }).blocksOrder !== true;
        } catch (e) {
          couponUsable = false;
        }
        if (!couponUsable) {
          console.warn('🚫 [bank-transfer] 利用できないクーポンのため申込を停止');
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: 'このクーポンはご利用済みか、ご利用状況を確認できませんでした。'
                + 'お手数ですが、ページを再読み込みのうえ、もう一度お試しください。',
              code: 'coupon_unavailable',
              sideEffects: 'none',
            }),
          };
        }
        try {
          serverPricing = resolveOrderPricing({
            fields: plusCustomerFields,
            couponId: selectedCouponId,
            nowMs: Date.now(),
            def: plusCouponDef,
          });
        } catch (e) {
          serverPricing = null;  // 判定不能。下で拒否する
        }
        // 検証に落ちた（理由あり）／判定できなかった／割引が乗らなかった → 申込を止める
        if (!serverPricing || serverPricing.reason || !serverPricing.couponApplied) {
          console.warn('🚫 [bank-transfer] クーポン検証に失敗したため申込を停止:', {
            recordId: plusCustomerRecordId || null,
            reason: serverPricing ? serverPricing.reason : 'pricing_unavailable',
          });
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: 'クーポンを確認できませんでした。お手数ですが、'
                + 'ページを再読み込みのうえ、もう一度お試しください。',
              code: 'coupon_unavailable',
              sideEffects: 'none',
            }),
          };
        }
      }
    }

    // 対象日を含む確定商品名。**以後の処理・メール・履歴はこれを使う**
    const orderProductName = (isPremiumPlusOrder && saleOrder && saleOrder.date)
      ? buildSaleProductName(saleOrder.label, 68000)
      : productName;

    let memberPricingWarning = null;
    try {
      const preCheck = checkMemberOnlyPricing({ productName: orderProductName, fields: null });
      if (preCheck.memberOnly) {
        const KEY = process.env.AIRTABLE_API_KEY;
        const BASE = process.env.AIRTABLE_BASE_ID;
        let fields = null;
        if (KEY && BASE) {
          const url = `https://api.airtable.com/v0/${BASE}/Customers?filterByFormula=`
            + encodeURIComponent(`LOWER(TRIM({Email})) = '${email.replace(/'/g, "\\'")}'`)
            + '&maxRecords=1';
          const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
          if (res.ok) fields = ((await res.json()).records || [])[0]?.fields || null;
        }
        const verdict = checkMemberOnlyPricing({ productName: orderProductName, fields });
        if (!verdict.eligible) {
          memberPricingWarning = verdict.warning;
          console.warn('⚠️ [bank-transfer] 会員限定価格の資格が確認できない申込:', {
            email, productName: orderProductName, pricingTier: verdict.tier,
          });
        }
      }
    } catch (e) {
      // 判定できないときは警告を出さない（申込を妨げない）
      console.warn('⚠️ [bank-transfer] 会員限定価格の裏づけ確認に失敗:', e.message);
    }

    // SendGrid API設定
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    // FROM_EMAIL, ADMIN_EMAIL は email-config.js からインポート済み

    if (!SENDGRID_API_KEY) {
      throw new Error('SendGrid API key not configured');
    }

    // 管理者向けメール内容
    const adminPersonalization = {
      to: [{ email: ADMIN_EMAIL }],
      subject: `【入金完了報告】${email} - ${orderProductName}`
    };
    // Make Mailhook転送（環境変数があるときだけ bcc を付ける。空配列は SendGrid が 400 を返す）
    if (process.env.MAKE_MAILHOOK_EMAIL) {
      adminPersonalization.bcc = [{ email: process.env.MAKE_MAILHOOK_EMAIL }];
    }
    const adminEmailData = {
      personalizations: [adminPersonalization],
      from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
      content: [{
        type: 'text/html',
        value: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .section { background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #3b82f6; }
    .info-row { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .label { font-weight: bold; color: #475569; display: inline-block; width: 150px; }
    .value { color: #1e293b; }
    .alert { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">🏦 入金完了報告</h2>
      <p style="margin: 10px 0 0 0; font-size: 0.95rem;">${orderProductName} の入金完了報告が届きました</p>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">📋 報告情報</h3>
      <div class="info-row">
        <span class="label">報告日時:</span>
        <span class="value">${japanTime}</span>
      </div>
      <div class="info-row">
        <span class="label">お名前:</span>
        <span class="value">${fullName}</span>
      </div>
      <div class="info-row">
        <span class="label">メールアドレス:</span>
        <span class="value">${email}</span>
      </div>
      <div class="info-row">
        <span class="label">商品:</span>
        <span class="value">${orderProductName}</span>
      </div>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">💰 振込情報</h3>
      <div class="info-row">
        <span class="label">振込完了日:</span>
        <span class="value">${transferDate}</span>
      </div>
      <div class="info-row">
        <span class="label">振込金額:</span>
        <span class="value">¥${Number(transferAmount).toLocaleString()}</span>
      </div>
      <div class="info-row">
        <span class="label">振込名義人:</span>
        <span class="value">${transferName}</span>
      </div>
      ${remarks ? `
      <div class="info-row" style="border-bottom: none;">
        <span class="label">備考:</span>
        <div class="value" style="margin-top: 10px; white-space: pre-wrap;">${remarks}</div>
      </div>
      ` : ''}
    </div>

    ${memberPricingWarning ? `
    <div class="alert" style="background:#fee2e2;border-left-color:#ef4444;">
      <h4 style="margin: 0 0 10px 0; color: #991b1b;">🔒 会員限定価格の確認が必要です</h4>
      <div style="color:#7f1d1d;">${memberPricingWarning}</div>
    </div>
    ` : ''}

    <div class="alert">
      <h4 style="margin: 0 0 10px 0; color: #92400e;">⚠️ 対応必要事項</h4>
      <ol style="margin: 0; padding-left: 20px; color: #78350f;">
        <li>振込確認（PayPay銀行 本店営業部 普通 8307337）</li>
        <li>入金確認後、${email} へアクセス情報を送信</li>
        <li>Airtableに顧客情報を登録（${orderProductName}）</li>
      </ol>
    </div>

    <div class="footer">
      <p>KEIBA Analytics 管理システム</p>
    </div>
  </div>
</body>
</html>
        `
      }],
      tracking_settings: {
        click_tracking: { enable: false },
        open_tracking: { enable: false }
      }
    };

    // 報告者向けメール内容
    const userEmailData = {
      personalizations: [{
        to: [{ email: email }],
        subject: `【入金完了報告受付】KEIBA Analytics ${orderProductName}`
      }],
      from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
      content: [{
        type: 'text/html',
        value: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
    .section { background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #10b981; }
    .info-row { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .label { font-weight: bold; color: #475569; display: inline-block; width: 150px; }
    .value { color: #1e293b; }
    .highlight { background: #dbeafe; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">✅ 入金完了のご報告ありがとうございます</h2>
      <p style="margin: 10px 0 0 0; font-size: 0.95rem;">入金完了のご報告を受け付けました</p>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">📋 ご報告内容</h3>
      <div class="info-row">
        <span class="label">報告日時:</span>
        <span class="value">${japanTime}</span>
      </div>
      <div class="info-row">
        <span class="label">お名前:</span>
        <span class="value">${fullName}</span>
      </div>
      <div class="info-row">
        <span class="label">メールアドレス:</span>
        <span class="value">${email}</span>
      </div>
      <div class="info-row">
        <span class="label">商品:</span>
        <span class="value">${orderProductName}</span>
      </div>
      <div class="info-row">
        <span class="label">振込完了日:</span>
        <span class="value">${transferDate}</span>
      </div>
      <div class="info-row">
        <span class="label">振込金額:</span>
        <span class="value">¥${Number(transferAmount).toLocaleString()}</span>
      </div>
      <div class="info-row">
        <span class="label">振込名義人:</span>
        <span class="value">${transferName}</span>
      </div>
    </div>

    <div class="highlight">
      <h4 style="margin: 0 0 15px 0; color: #1e40af;">📌 今後の流れ</h4>
      <ol style="margin: 0; padding-left: 20px; color: #1e293b;">
        <li style="margin-bottom: 10px;">
          <strong>振込先口座</strong><br>
          PayPay銀行 本店営業部<br>
          普通 8307337<br>
          ｳｴﾌﾞｹｲﾊﾞ
        </li>
        <li style="margin-bottom: 10px;">
          <strong>入金確認</strong><br>
          入金確認取れ次第、即時にログイン情報をメールでお送りいたします
        </li>
        <li style="margin-bottom: 10px;">
          <strong>アクセス情報送付</strong><br>
          ${orderProductName} のアクセス方法をメールでお送りいたします
        </li>
      </ol>
    </div>

    <div class="section">
      <p style="margin: 0; color: #475569;">
        <strong>ご不明な点がございましたら、お気軽にお問い合わせください。</strong><br>
        📧 <a href="mailto:${SUPPORT_EMAIL}" style="color: #3b82f6;">${SUPPORT_EMAIL}</a>
      </p>
    </div>

    <div class="footer">
      <p><strong>KEIBA Analytics</strong></p>
      <p>AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム</p>
      <p><a href="https://analytics.keiba.link" style="color: #3b82f6; text-decoration: none;">https://analytics.keiba.link</a></p>
    </div>
  </div>
</body>
</html>
        `
      }],
      tracking_settings: {
        click_tracking: { enable: false },
        open_tracking: { enable: false }
      }
    };

    // SendGrid APIでメール送信（管理者向け）
    const adminResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(adminEmailData)
    });

    if (!adminResponse.ok) {
      const errorText = await adminResponse.text();
      console.error('SendGrid admin email error:', errorText);
      throw new Error(`Failed to send admin email: ${adminResponse.status}`);
    }

    // SendGrid APIでメール送信（報告者向け）
    const userResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(userEmailData)
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      console.error('SendGrid user email error:', errorText);
      throw new Error(`Failed to send user email: ${userResponse.status}`);
    }

    // ========================================
    // 決済開始の計測（Premium Plus のみ・サーバー側）
    // ========================================
    // ⚠️ **この直後の Airtable 登録ブロックは Premium Plus を除外する**（単品購入のため
    //    顧客レコードを作り替えない）。計測をそのブロックの中に置くと
    //    `Premium Plus 以外` と `Premium Plus だけ` の条件が重なって**永久に発火しない**。
    //    2026-08-14〜2026-08-17 の本番はこの状態で、決済開始が 1 件も記録されていなかった。
    //    → 計測は必ず**このブロックの外**（Plus を除外しない場所）で行う。
    //
    // 記録は recordId が確定してからだけ行う（Redis の識別子は recordId のみ）。
    // 計測は申込の成否に一切関与しない: 失敗しても握りつぶし、rollback もしない。
    if (isPremiumPlusOrder) {
      try {
        // recordId は上の販売状態チェックで既に確定している（Airtable の GET を増やさない）
        if (plusCustomerRecordId) {
          // 冪等性は store 側の DEDUPE_MS（同一 recordId・同一種別は 30 分に 1 回）が持つ。
          // 再送・二重送信で水増しされない。
          const m = await recordPlusCheckoutStart({
            recordId: plusCustomerRecordId,
            env: process.env,
            nowMs: Date.now(),
            // 導線はフォームが載せた値。**採否はサーバーの allow-list**が決める
            source: funnelSource,
          });
          console.log('📊 [bank-transfer] 決済開始の計測:', { counted: m.counted, reason: m.reason });
        } else {
          // 会員レコードが引けない申込（Plus は既存会員にしか売らないので通常起きない）。
          // **推測の recordId を作らない**。計測しないだけで申込は通す。
          console.warn('⚠️ [bank-transfer] 決済開始を計測できません（会員レコード未特定）');
        }
      } catch (metricError) {
        console.warn('⚠️ [bank-transfer] 決済開始の計測に失敗:', metricError.message);
      }
    }

    // ========================================
    // Airtable登録（Premium Plus以外の月額プラン）
    // ========================================
    if (!isPremiumPlusProductName(productName)) {
      // プラン名から料金部分を削除（Airtable Single select用）
      // 例: "Premium Lifetime (¥78,000（永久アクセス）)" → "Premium Lifetime"
      // 例: "Premium Annual (¥68,000/年)" → "Premium Annual"
      // 例: "Premium Monthly (¥18,000/月)" → "Premium Monthly"
      const fullPlanName = productName
        .replace(/\s*\(.*\)$/, '')  // 最後の(...)を完全削除
        .trim();

      // PlanTypeを判定（Lifetime, Annual, Monthly）
      let planType = 'Monthly';  // デフォルト
      if (fullPlanName.includes('Lifetime') || fullPlanName.includes('買い切り')) {
        planType = 'Lifetime';
      } else if (fullPlanName.includes('Annual') || fullPlanName.includes('年払い')) {
        planType = 'Annual';
      } else if (fullPlanName.includes('Monthly') || fullPlanName.includes('30日')) {
        planType = 'Monthly';
      }

      // プラン名を正規化（Airtable Single select用）
      // "Premium Lifetime" → "Premium"
      // "Premium 買い切り" → "Premium"
      // "Premium 年払い (Standard Upgrade)" → "Premium"
      // "Premium 30日 (Standard Upgrade)" → "Premium"
      // "Premium Sanrenpuku Lifetime" → "Premium Sanrenpuku"
      // "Light - Campaign" → "Light"
      // 後方互換（旧キャッシュ）:
      //   "ライト" / "ライト - Campaign" → "Light"
      //   "Standard" / "Standard (ライト)" / "Standard (ライト) - Campaign" → "Light"
      let planName = fullPlanName
        .replace(/\s*\(Standard Upgrade\)/, '')  // (Standard Upgrade)を削除
        .replace(/\s*-\s*Campaign/, '')  // - Campaignを削除
        .replace(/\s*\(ライト\)/, '')  // (ライト)を削除（旧フォーマット対策）
        .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|30日)$/, '')  // 末尾のプラン種別を削除
        .trim();

      // 旧プラン名は Airtable Single select から削除済み。すべて "Light" に揃える。
      if (planName === 'Standard' || planName === 'standard' ||
          planName === 'ライト' || planName === 'light') {
        planName = 'Light';
      }

      // ─────────────────────────────────────────────
      // 🛡️ 2026-07-10: 申込時点では有効期限を計算しない・書かない
      //
      // 旧実装は申込時に「申込日 + 1年」を書いていたため、
      //   (a) 有効期限の基準日が入金確認日ではなく申込日になる
      //   (b) 既存 active 会員は プラン も同時に上書きされ、入金前に Premium 化する
      // という 2 つの問題があった。
      //
      // 新実装では申込内容を RequestedPlan / RequestedPlanType / RequestedAmount に退避し、
      // 昇格（プラン / PlanType / Status=active / 有効期限）は
      // confirm-bank-payment.js が PaymentConfirmed を起点に行う。
      // 有効期限は入金確認日（JST）基準で自動計算されるため手入力は不要。
      // ─────────────────────────────────────────────
      // ── 申込価格はサーバーが決める ─────────────────────────────
      // ⚠️ 画面の `transferAmount` は**参考値**。Premium Plus の申込では
      //    「本人が本当にそのクーポンを持っているか」を Airtable の実データから
      //    再検証し、**正本の通常価格から 1 回だけ引いた確定値**を採用する。
      //    クライアントが割引額・最終価格を送ってきても読まない（二重適用・改ざん防止）。
      //    検証に落ちたら割引なし（通常価格）へ倒す＝ fail closed。
      const clientAmount = Number.parseInt(transferAmount, 10);
      let requestedAmount = clientAmount;
      let appliedCoupon = null;
      if (isPremiumPlusOrder) {
        // 上で検証済みの結果をそのまま使う（ここで再計算すると判定が割れる）。
        // クーポン未選択のときは通常価格を採用する。
        const pricing = serverPricing || resolveOrderPricing({
          fields: plusCustomerFields, couponId: null, nowMs: Date.now(),
          def: plusCouponDef || undefined,
        });
        if (Number.isFinite(pricing.finalPrice)) {
          requestedAmount = pricing.finalPrice;
          appliedCoupon = pricing.couponApplied;
        }
        if (clientAmount !== requestedAmount) {
          console.warn('⚠️ [bank-transfer] 申込金額をサーバー確定値へ置き換え:', {
            client: Number.isFinite(clientAmount) ? clientAmount : null,
            server: requestedAmount,
            couponApplied: appliedCoupon ? appliedCoupon.couponId : null,
          });
        }
      }

      console.log('📝 申込内容を Requested* に退避:', {
        productName: orderProductName,
        fullPlanName,
        planName,
        planType,
        requestedAmount: Number.isFinite(requestedAmount) ? requestedAmount : null,
        // どのクーポンを適用したか（後から追跡できるように残す）
        couponApplied: appliedCoupon ? appliedCoupon.couponId : null
      });

      // Airtable登録処理
      try {
        const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
        const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

        if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
          console.error('❌ Airtable credentials not configured - CRITICAL ERROR');
          throw new Error('Airtable credentials missing');
        }

        // ─────────────────────────────────────────────
        // 既存顧客チェック（Email 完全一致のみ・LOWER(TRIM()) で大小・空白差を吸収）
        // 旧コードは大小違い等で別レコードを見逃すリスクがあったため正規化比較に変更。
        // ─────────────────────────────────────────────
        const escapedEmail = email.replace(/'/g, "\\'");
        const searchFormula = `LOWER(TRIM({Email})) = '${escapedEmail}'`;
        const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers?filterByFormula=${encodeURIComponent(searchFormula)}&maxRecords=5`;

        const searchResponse = await fetch(searchUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (!searchResponse.ok) {
          throw new Error(`Airtable search failed: ${searchResponse.status}`);
        }

        const searchData = await searchResponse.json();
        const existingRecords = searchData.records || [];
        console.log(`🔍 [bank-transfer] Email 検索結果: ${existingRecords.length}件 ヒット（email=${email}）`);
        if (existingRecords.length > 1) {
          console.warn(`⚠️ [bank-transfer] 同一 Email で複数レコード検出: ${email} / recordIds=${existingRecords.map(r => r.id).join(',')}`);
        }

        if (existingRecords.length > 0) {
          // 既存顧客 - Update
          const existingRecord = existingRecords[0];
          const recordId = existingRecord.id;
          // ⚠️ ここに決済開始の計測を置かないこと。
          //    このブロックは `Premium Plus 以外` のときしか実行されないため、
          //    Plus 限定の計測を置くと条件が重なって**永久に発火しない**（実際に発生した）。
          //    計測はこのブロックの外（上部の「決済開始の計測」）で行う。
          const currentStatus = existingRecord.fields?.Status || null;
          const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers/${recordId}`;

          // ─────────────────────────────────────────────
          // 🛡️ 2026-05-12 修正: active 顧客の pending 降格を防止（現在も維持）
          // 🛡️ 2026-07-10 修正: プラン / PlanType / 有効期限 も申込時には書かない。
          //   既存 active 会員（例: Light）は Light active のまま維持され、
          //   PaymentConfirmed が押されるまで Premium にならない。
          //   判定の単一源は src/lib/payments/bankPaymentFlow.js。
          // ─────────────────────────────────────────────
          const updateFields = buildApplicationFields({
            currentStatus,
            fullName,
            planName,
            planType,
            amount: requestedAmount,
            // 対象日を**構造化項目**として保存（schema 未準備なら書かない）
            saleTargetDate: saleOrder ? saleOrder.date : null,
            saleDateFieldReady: isSaleDateFieldEnabled(process.env)
          });

          if (updateFields['Status'] === 'pending') {
            console.log(`📝 [bank-transfer] Status を pending に設定: ${email} / recordId=${recordId} / 旧 currentStatus=${currentStatus}`);
          } else {
            console.log(`🛡️ [bank-transfer] 既存 active 顧客のため Status / プラン / 有効期限は据え置き: ${email} / recordId=${recordId} / currentStatus=${currentStatus}`);
          }

          const updatePayload = {
            fields: updateFields,
            // Single select に未登録の値が来た場合は自動でオプションを追加（'Light' リネーム前後どちらでも通す）
            typecast: true
          };

          const updateResponse = await fetch(updateUrl, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
          });

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error('❌ Airtable update error details:', errorText);
            throw new Error(`Airtable update failed: ${updateResponse.status} - ${errorText}`);
          }

          console.log('✅ Airtable updated (existing customer):', email);
        } else {
          // ─────────────────────────────────────────────
          // 🔁 2026-05-12 修正: 同時リクエストでの重複作成防止（race-safe re-check）
          // 1回目の検索からこの create までの間に、別リクエストが先に作っていないか
          // もう一度確認してから作成する。
          // ─────────────────────────────────────────────
          console.log(`🔁 [bank-transfer] 新規作成前の再検索: ${email}`);
          const reCheckResponse = await fetch(searchUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json'
            }
          });
          const reCheckData = reCheckResponse.ok ? await reCheckResponse.json() : { records: [] };
          const reCheckRecords = reCheckData.records || [];

          if (reCheckRecords.length > 0) {
            // 直前に他リクエストが作成 → 新規作成せず、既存レコードを update する
            const raceRecord = reCheckRecords[0];
            const recordId = raceRecord.id;
            const raceCurrentStatus = raceRecord.fields?.Status || null;
            console.log(`✅ [bank-transfer] 再検索で既存レコード検出 → create スキップして update: ${email} / recordId=${recordId} / currentStatus=${raceCurrentStatus}`);
            const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers/${recordId}`;

            // 🛡️ active 顧客の pending 降格を防止（メインパスと同じ単一源を使う）
            const raceUpdateFields = buildApplicationFields({
              currentStatus: raceCurrentStatus,
              fullName,
              planName,
              planType,
              amount: requestedAmount,
            // 対象日を**構造化項目**として保存（schema 未準備なら書かない）
            saleTargetDate: saleOrder ? saleOrder.date : null,
            saleDateFieldReady: isSaleDateFieldEnabled(process.env)
            });
            if (raceUpdateFields['Status'] !== 'pending') {
              console.log(`🛡️ [bank-transfer race] 既存 active 顧客のため Status / プラン / 有効期限は据え置き: ${email}`);
            }
            const updatePayload = {
              fields: raceUpdateFields,
              typecast: true
            };
            const updateResponse = await fetch(updateUrl, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(updatePayload)
            });
            if (!updateResponse.ok) {
              const errorText = await updateResponse.text();
              console.error('❌ Airtable update (race fallback) error details:', errorText);
              throw new Error(`Airtable update failed (race fallback): ${updateResponse.status} - ${errorText}`);
            }
          } else {
            // 新規顧客 - Create
            const createUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers`;

            // 新規も Status='pending' のみ。プラン / 有効期限は入金確認まで書かない
            const createPayload = {
              fields: buildApplicationFields({
                currentStatus: null,
                fullName,
                planName,
                planType,
                amount: requestedAmount,
            // 対象日を**構造化項目**として保存（schema 未準備なら書かない）
            saleTargetDate: saleOrder ? saleOrder.date : null,
            saleDateFieldReady: isSaleDateFieldEnabled(process.env),
                isNewRecord: true,
                email
              }),
              // Single select に未登録の値が来た場合は自動でオプションを追加（'Light' リネーム前後どちらでも通す）
              typecast: true
            };

            console.log('📤 Airtable create payload:', JSON.stringify(createPayload, null, 2));

            const createResponse = await fetch(createUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(createPayload)
            });

            if (!createResponse.ok) {
              const errorText = await createResponse.text();
              console.error('❌ Airtable create error details:', errorText);
              throw new Error(`Airtable create failed: ${createResponse.status} - ${errorText}`);
            }

            console.log('✅ Airtable created (new customer):', email);
          }
        }
      } catch (airtableError) {
        console.error('❌ Airtable registration error:', airtableError);
        // Airtableエラーでも処理は続行（メール送信は成功しているため）
      }
    } else {
      console.log('ℹ️ Premium Plus - Airtable registration skipped');
    }

    // ========================================
    // BlastMail読者登録（Premium Plus以外の月額プラン）
    // ========================================
    if (!isPremiumPlusProductName(productName)) {
      try {
        const BLASTMAIL_USERNAME = process.env.BLASTMAIL_USERNAME;
        const BLASTMAIL_PASSWORD = process.env.BLASTMAIL_PASSWORD;
        const BLASTMAIL_API_KEY = process.env.BLASTMAIL_API_KEY;

        if (!BLASTMAIL_USERNAME || !BLASTMAIL_PASSWORD || !BLASTMAIL_API_KEY) {
          console.warn('⚠️ BlastMail credentials not configured, skipping reader registration');
        } else {
          // Step 1: ログイン（access_token取得）
          const loginUrl = 'https://api.bme.jp/rest/1.0/authenticate/login';
          const loginParams = new URLSearchParams({
            username: BLASTMAIL_USERNAME,
            password: BLASTMAIL_PASSWORD,
            api_key: BLASTMAIL_API_KEY,
            format: 'json'
          });

          const loginResponse = await fetch(loginUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: loginParams.toString()
          });

          if (!loginResponse.ok) {
            throw new Error(`BlastMail login failed: ${loginResponse.status}`);
          }

          const loginData = await loginResponse.json();
          const accessToken = loginData.accessToken;

          if (!accessToken) {
            throw new Error('BlastMail access token not returned');
          }

          // Step 2: 読者登録
          const registerUrl = 'https://api.bme.jp/rest/1.0/contact/detail/create';
          const registerParams = new URLSearchParams({
            access_token: accessToken,
            format: 'json',
            c15: email,                    // E-Mail（必須）
            c0: fullName,                  // 氏名
            c19: 'nankan-analytics'        // 登録元サイト（registration_source）
          });

          const registerResponse = await fetch(registerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: registerParams.toString()
          });

          if (!registerResponse.ok) {
            const errorText = await registerResponse.text();
            console.log('⚠️ BlastMail registration response (not ok):', registerResponse.status, errorText);

            // 重複登録エラーは成功として扱う
            if (errorText.includes('Has already been registered') ||
                errorText.includes('already registered') ||
                errorText.includes('既に登録')) {
              console.log('ℹ️ BlastMail reader already registered:', email);
              console.log('ℹ️ Error details:', errorText);
            } else {
              throw new Error(`BlastMail reader registration failed: ${registerResponse.status} - ${errorText}`);
            }
          } else {
            const registerData = await registerResponse.json();
            console.log('✅ BlastMail reader registered:', email, 'ContactID:', registerData.contactID);
          }
        }
      } catch (blastMailError) {
        console.error('❌ BlastMail registration error:', blastMailError);
        // BlastMailエラーでも処理は続行（メール送信・Airtable登録は成功しているため）
      }
    } else {
      console.log('ℹ️ Premium Plus - BlastMail registration skipped');
    }

    // ── クーポンの利用予約（Premium Plus・クーポン適用時のみ）─────────────
    // ⚠️ **ここが無かったため、申込しても入金確認してもクーポンが「所持中」のまま残り、
    //    同じクーポンで何度でも 58,000円 の申込ができる状態だった**（2026-08-23 修正）。
    //
    // 置き場所: 振込完了報告が**正常受理された後**（メール送信済み・この直後に 200 を返す）。
    //   - 予約を作れなくても報告は受理する（決済を巻き戻さない＝ best effort）
    //   - 台帳を読めなければ**作らない**（重複を検出できないまま行を増やさない）
    //   - 既に予約済み / 使用済みなら作らない（`resolveReservationDecision` が判定）
    //   - 使用済みにするのは入金確認（`confirm-bank-payment.js`）
    if (isPremiumPlusOrder && serverPricing && serverPricing.couponApplied && plusCustomerRecordId) {
      let reservationOutcome = null;
      try {
        const ledger = await listReservationsFor({
          env: process.env, customerRecordId: plusCustomerRecordId,
        });
        if (!ledger.available) {
          // 「読めなかった」を「予約 0 件」に丸めない
          reservationOutcome = `ledger_unavailable:${ledger.reason}`;
        } else {
          const decision = resolveReservationDecision({
            fields: plusCustomerFields,
            offerRows: ledger.records,
            customerRecordId: plusCustomerRecordId,
            nowMs: Date.now(),
            env: process.env,
            def: plusCouponDef || undefined,
          });
          if (!decision.ok) {
            // 既に予約済み・使用済みは**正常**（冪等）。それ以外は理由をそのまま残す
            reservationOutcome = decision.reason === RESERVATION_REJECT.ALREADY_RESERVED
              || decision.reason === RESERVATION_REJECT.ALREADY_REDEEMED
              ? `skipped:${decision.reason}` : `rejected:${decision.reason}`;
          } else {
            const built = buildReservationFields({
              customerRecordId: plusCustomerRecordId,
              email,
              // 同じ報告を再送しても 1 行のままにする冪等キーの材料
              applicationId: `${transferDate || ''}|${transferTime || ''}|${transferAmount || ''}`,
              nowMs: Date.now(),
              def: plusCouponDef || undefined,
            });
            const created = await createReservation({ env: process.env, built });
            reservationOutcome = created.outcome;
          }
        }
      } catch (reservationError) {
        reservationOutcome = 'failed_error';
      }
      // ⚠️ 識別子（メール / recordId）を載せない。何が起きたかだけを残す
      console.log('🎟 [bank-transfer] クーポン利用予約:', { outcome: reservationOutcome });
    }

    console.log('✅ Bank transfer completion report submitted:', {
      email,
      fullName,
      transferDate,
      transferTime,
      transferAmount,
      timestamp: japanTime
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '入金完了のご報告を受け付けました。確認メールをお送りしましたのでご確認ください。'
      })
    };

  } catch (error) {
    console.error('Bank transfer completion report error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'サーバーエラーが発生しました。時間をおいて再度お試しください。',
        details: error.message
      })
    };
  }
};
