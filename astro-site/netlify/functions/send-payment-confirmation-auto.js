/**
 * 入金確認メール自動送信（Airtable Automation専用）
 *
 * トリガー: Airtable Status が "pending" → "active" に変更
 * 動作:
 *   1. Airtableからレコード情報取得（email, 氏名, プラン）
 *   2. 二重送信防止チェック（PaymentEmailSentフィールド）
 *   3. メール送信
 *   4. PaymentEmailSent を true に更新
 */

import { SUPPORT_EMAIL } from './config/email-config.js';
import { resolveVerifiedSender } from '../../src/lib/payments/senderIdentity.js';

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
    // リクエストデータ取得（Airtable Automationから渡される）
    const requestData = JSON.parse(event.body);
    const { airtableRecordId, email: rawEmail } = requestData;
    // 📧 email 正規化（fallback 検索用。Automation 側から渡されない場合は空）
    const inputEmail = rawEmail ? String(rawEmail).trim().toLowerCase() : '';

    console.log('📧 Payment confirmation auto trigger:', { airtableRecordId, hasEmailFallback: !!inputEmail });

    // 必須項目チェック（airtableRecordId か email のどちらかは必要）
    if (!airtableRecordId && !inputEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'airtableRecordId or email is required' })
      };
    }

    // Airtable API設定
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    // 🔧 2026-05-12 追加: テーブル名を env var で上書き可能に（フォールバック 'Customers'）
    const AIRTABLE_CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      console.error('❌ Airtable credentials missing', {
        hasApiKey: !!AIRTABLE_API_KEY,
        hasBaseId: !!AIRTABLE_BASE_ID
      });
      throw new Error('Airtable credentials not configured');
    }

    // テーブル名に日本語等を含む可能性を考慮して URL エンコード
    const tableSegment = encodeURIComponent(AIRTABLE_CUSTOMERS_TABLE);

    // ========================================
    // Step 1: Airtableからレコード情報取得
    //   1a. まず airtableRecordId で取得を試みる
    //   1b. 失敗（403/404）かつ email が渡されていれば、email で fallback 検索
    // ========================================
    let fields = null;            // 最終的に使う Customer の fields
    let resolvedRecordId = null;  // PATCH 更新時に使う recordId（fallback 後は新しい値）
    let recordFetchDiagnostics = null;  // 失敗時の診断情報を蓄積

    if (airtableRecordId) {
      const recordUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableSegment}/${airtableRecordId}`;

      // ⚠️ 注意: API キー本体は絶対にログに出さない。先頭7文字のプレフィックスのみ。
      console.log('🔍 Debug info (Step 1a recordId fetch):', {
        AIRTABLE_BASE_ID,
        tableName: AIRTABLE_CUSTOMERS_TABLE,
        airtableRecordId,
        recordUrl,
        tokenPrefix: AIRTABLE_API_KEY.substring(0, 7),
        tokenLength: AIRTABLE_API_KEY.length
      });

      const recordResponse = await fetch(recordUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (recordResponse.ok) {
        const recordData = await recordResponse.json();
        fields = recordData.fields;
        resolvedRecordId = airtableRecordId;
        console.log('✅ recordId fetch 成功:', resolvedRecordId);
      } else {
        const errorText = await recordResponse.text();
        // 🔧 2026-05-12 改善: 403 = recordId 不存在が最有力（PAT問題ではないことが多い）
        recordFetchDiagnostics = {
          stage: 'recordId-fetch',
          airtableStatus: recordResponse.status,
          airtableStatusText: recordResponse.statusText,
          airtableErrorBody: errorText,
          baseId: AIRTABLE_BASE_ID,
          tableName: AIRTABLE_CUSTOMERS_TABLE,
          airtableRecordId,
          tokenPrefix: AIRTABLE_API_KEY.substring(0, 7),
          tokenLength: AIRTABLE_API_KEY.length,
          hints: []
        };
        if (recordResponse.status === 403) {
          recordFetchDiagnostics.hints.push('【最有力】airtableRecordId が Customers テーブルに存在しない / 削除済み / 別Base・別Tableのレコード');
          recordFetchDiagnostics.hints.push('Airtable の INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND は、recordId が見つからない場合にも発生する');
          recordFetchDiagnostics.hints.push('Automation Test の input recordId が古いサンプルを保持している可能性');
          recordFetchDiagnostics.hints.push('Trigger table が Customers でない、または input variable が Trigger record ID を参照していない可能性');
          recordFetchDiagnostics.hints.push('PAT / Base access / data.records:read 不足の可能性（ただし fake recordId で 404 が返れば PAT は正常）');
        } else if (recordResponse.status === 404) {
          recordFetchDiagnostics.hints.push('airtableRecordId のフォーマットが不正（rec + 14文字でない）');
          recordFetchDiagnostics.hints.push('AIRTABLE_BASE_ID が旧 Base を指している可能性');
        } else if (recordResponse.status === 401) {
          recordFetchDiagnostics.hints.push('PAT が無効・期限切れの可能性。Airtable で再発行してください');
        }
        console.warn('⚠️ recordId fetch failed (will try email fallback if available):', recordFetchDiagnostics);
      }
    }

    // ========================================
    // Step 1b: email fallback
    //   recordId 取得に失敗（または airtableRecordId 未指定）かつ email がある場合、
    //   LOWER(TRIM({Email})) で Customers を検索して継続する。
    // ========================================
    if (!fields && inputEmail) {
      const escapedEmail = inputEmail.replace(/'/g, "\\'");
      const filterFormula = `LOWER(TRIM({Email})) = '${escapedEmail}'`;
      const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableSegment}?filterByFormula=${encodeURIComponent(filterFormula)}&maxRecords=5`;

      console.log('🔁 [email fallback] 検索開始:', {
        email: inputEmail,
        tableName: AIRTABLE_CUSTOMERS_TABLE,
        baseId: AIRTABLE_BASE_ID
      });

      const searchResponse = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        const fallbackDiagnostics = {
          stage: 'email-fallback-search',
          airtableStatus: searchResponse.status,
          airtableStatusText: searchResponse.statusText,
          airtableErrorBody: errorText,
          baseId: AIRTABLE_BASE_ID,
          tableName: AIRTABLE_CUSTOMERS_TABLE,
          email: inputEmail,
          tokenPrefix: AIRTABLE_API_KEY.substring(0, 7),
          tokenLength: AIRTABLE_API_KEY.length,
          previousRecordIdFetch: recordFetchDiagnostics,
          hints: [
            'email fallback の Customers 検索自体が失敗',
            'PAT / Base access / data.records:read を確認してください'
          ]
        };
        console.error('❌ [email fallback] Customers 検索失敗:', fallbackDiagnostics);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: 'Internal Server Error',
            message: `Email fallback search failed: ${searchResponse.status}`,
            diagnostics: fallbackDiagnostics
          })
        };
      }

      const searchData = await searchResponse.json();
      const records = searchData.records || [];
      console.log(`🔁 [email fallback] 検索結果: ${records.length}件 ヒット（email=${inputEmail}）`);

      if (records.length === 0) {
        // email でも見つからない場合は最終的なエラーを返す
        const notFoundDiagnostics = {
          stage: 'email-fallback-not-found',
          baseId: AIRTABLE_BASE_ID,
          tableName: AIRTABLE_CUSTOMERS_TABLE,
          email: inputEmail,
          previousRecordIdFetch: recordFetchDiagnostics,
          hints: [
            'recordId / email のいずれでも Customers レコードが見つからなかった',
            'Customers テーブルで該当 Email が存在するか確認してください',
            'email 正規化（trim + lowercase）後の値で検索しています'
          ]
        };
        console.error('❌ [email fallback] 該当 Email が Customers に見つからない:', notFoundDiagnostics);
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({
            error: 'Customer not found by recordId or email',
            diagnostics: notFoundDiagnostics
          })
        };
      }

      if (records.length > 1) {
        console.warn(`⚠️ [email fallback] 同一 Email で複数 Customer 検出: ${inputEmail} / recordIds=${records.map(r => r.id).join(',')}`);
      }

      const fallbackRecord = records[0];
      fields = fallbackRecord.fields;
      resolvedRecordId = fallbackRecord.id;
      console.log(`✅ [email fallback] レコード解決: recordId=${resolvedRecordId} (元の airtableRecordId=${airtableRecordId || 'なし'})`);
    }

    // ========================================
    // Step 1 後の最終確認: recordId / email どちらでも fields を解決できなかった場合
    // ========================================
    if (!fields) {
      // recordId 指定があったが取得失敗、かつ email fallback も使えなかった（email 未指定）
      console.error('❌ recordId fetch 失敗 + email fallback 不可（email 未指定）:', recordFetchDiagnostics);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Internal Server Error',
          message: `Airtable record fetch failed: ${recordFetchDiagnostics?.airtableStatus || 'unknown'}`,
          diagnostics: {
            ...recordFetchDiagnostics,
            emailFallbackAvailable: false,
            hint: 'Airtable Automation の Run a script で input に email を追加すると、recordId が無効でも email で fallback 検索できます'
          }
        })
      };
    }

    // 必須フィールド確認
    const email = fields.Email;
    // 🔧 2026-05-18修正: 氏名が空でも送信を止めない（申込フォーム未経由ケースで頻発）。
    //   空時は「お客様」をフォールバックしてメール本文に使う。
    const fullName = fields['氏名'] || 'お客様';
    const productName = fields['プラン'];
    const planType = fields['PlanType'] || null;  // monthly, annual, lifetime, null for Free
    const expirationDate = fields['有効期限'] || fields['ExpiryDate'] || null;
    const paymentAmount = fields['入金金額'] || fields['金額'] || null;
    const paymentEmailSent = fields.PaymentEmailSent || false;

    console.log('📋 Record info:', { email, fullName, productName, planType, expirationDate, paymentAmount, paymentEmailSent });

    if (!email || !productName) {
      console.error('⚠️ Missing required fields:', { email, productName });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields in Airtable record',
          details: { email, productName }
        })
      };
    }

    // ========================================
    // Step 2: 二重送信防止チェック
    // ========================================
    // 🔧 運用メモ:
    //   PaymentEmailSent=true のレコードは再送信されない。
    //   再送が必要な場合は Airtable 側で PaymentEmailSent のチェックを外す（false/空）
    //   → Status を pending → active に戻して Automation を再トリガーする。
    if (paymentEmailSent === true) {
      const skipStatus = fields.Status || null;
      const skipPlan = fields['プラン'] || fields.Plan || null;
      console.log('ℹ️ Payment email already sent, skipping:', {
        reason: 'PaymentEmailSent=true のため再送信スキップ',
        email,
        airtableRecordId,            // Automation から渡された元 ID
        resolvedRecordId,            // 実際にヒットした recordId（fallback 後は別 ID）
        status: skipStatus,
        plan: skipPlan,
        howToResend: 'Airtable で PaymentEmailSent を空に戻し、Status を pending → active に切り替えると再送できます。'
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          skipped: true,
          message: 'Payment email already sent',
          reason: 'PaymentEmailSent=true',
          email: email,
          airtableRecordId,
          resolvedRecordId,
          howToResend: 'PaymentEmailSent を空に戻して Status pending→active で再トリガー'
        })
      };
    }

    // ========================================
    // Step 3: メール送信
    // ========================================
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

    if (!SENDGRID_API_KEY) {
      throw new Error('SendGrid API key not configured');
    }

    // 送信元は単一源 senderIdentity.js が決める（noreply への fallback 禁止）。
    // 不一致 / 未設定は **SendGrid へ POST する前に fail closed**。
    // ここで throw すると Step 4 の PATCH まで到達しないため、PaymentEmailSent は false のまま
    // （＝状態が「送ったことになる」ズレを作らない）。
    const sender = resolveVerifiedSender(process.env);
    if (!sender.ok) {
      throw new Error(`sender_unverified: ${sender.reason}`);
    }

    // プラン別の情報を取得
    const planInfo = getPlanInfo(productName, planType);

    // 日本時間
    const japanTime = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // ユーザー向けメール
    const userEmailData = {
      personalizations: [{
        to: [{ email: email }],
        subject: `【入金確認】KEIBA Analytics ${productName} - アクセス情報`
      }],
      from: { email: sender.email, name: sender.name },
      content: [{
        type: 'text/html',
        value: generateEmailHTML(fullName, email, productName, planType, expirationDate, paymentAmount, planInfo, japanTime)
      }],
      tracking_settings: {
        click_tracking: { enable: false },
        open_tracking: { enable: false }
      }
    };

    // SendGrid APIでメール送信
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

    console.log('✅ Payment confirmation email sent:', email);

    // ========================================
    // Step 4: PaymentEmailSent を true に更新 + ExpirationDate 設定 + 退会フラグリセット
    // ========================================
    const updatePayload = {
      fields: {
        'PaymentEmailSent': true,
        // 🔧 2026-03-02追加: 入金確認時に退会フラグをリセット（新規プラン購入時）
        'WithdrawalRequested': false,
        'WithdrawalDate': null,
        'WithdrawalReason': null
      }
    };

    // 有効期限計算（2026-02-09価格体系対応）
    // 🔧 2026-05-18修正(2): 既存「有効期限」がある場合は無条件で上書きしない。
    //   bank-transfer-application.js が申込時に必ず有効期限を書くため、Automation 実行時には
    //   通常すでに有効期限が入っており、上書きは Status=pending→active 再トリガー時に既存契約期間を
    //   意図せず延長してしまう事故の原因になっていた。空のときだけ計算して補完する。
    if (!productName.includes('Premium Plus') && !productName.includes('Plus')) {
      const existingExpiration = fields['有効期限'] || fields['ExpiryDate'] || null;

      if (existingExpiration) {
        console.log('🛡️ 既存の有効期限を尊重して上書きスキップ:', existingExpiration, 'for', email);
      } else {
        // 既存値なし = 申込フォーム未経由 + 管理者が有効期限未入力で Status=active にしたケースのみ
        const today = new Date();
        let expirationDate = null;
        const planTypeNormalized = String(planType || '').toLowerCase();

        if (planTypeNormalized === 'lifetime' || productName.includes('Lifetime')) {
          // 買い切りプラン: 2099年12月31日（永久）
          expirationDate = '2099-12-31';
          console.log('📅 新規有効期限設定: 永久アクセス (2099-12-31) for', productName, '/ planType=', planType);
        } else if (planTypeNormalized === 'annual' || productName.includes('Annual')) {
          // 年払いプラン: 1年後
          const expDate = new Date(today);
          expDate.setFullYear(expDate.getFullYear() + 1);
          expirationDate = expDate.toISOString().split('T')[0];
          console.log('📅 新規有効期限設定: 1年後', expirationDate, 'for', productName, '/ planType=', planType);
        } else if (planTypeNormalized === 'monthly' || productName.includes('Monthly')) {
          // 月払いプラン: 1ヶ月後
          const expDate = new Date(today);
          expDate.setMonth(expDate.getMonth() + 1);
          expirationDate = expDate.toISOString().split('T')[0];
          console.log('📅 新規有効期限設定: 1ヶ月後', expirationDate, 'for', productName, '/ planType=', planType);
        } else {
          // デフォルト: 1ヶ月後（planType も productName も判定不能）
          const expDate = new Date(today);
          expDate.setMonth(expDate.getMonth() + 1);
          expirationDate = expDate.toISOString().split('T')[0];
          console.warn('⚠️ 新規有効期限設定: デフォルト1ヶ月後（planType/productName 判定不能）', expirationDate, 'for', productName, '/ planType=', planType);
        }

        updatePayload.fields['有効期限'] = expirationDate;
      }
    } else {
      console.log('💎 Premium Plus: 有効期限設定スキップ（単品商品）');
    }

    // PaymentMethod を "Bank Transfer" と設定（未設定の場合のみ）
    const currentPaymentMethod = fields.PaymentMethod;
    if (!currentPaymentMethod) {
      updatePayload.fields['PaymentMethod'] = 'Bank Transfer';
      console.log('💳 PaymentMethod設定: Bank Transfer');
    }

    // 🔧 2026-05-13 修正: email fallback で recordId が解決された場合に備え、
    //   PATCH 用 URL は resolvedRecordId（最終的に使った recordId）から組み立てる。
    //   recordUrl 変数は Step 1a のブロック内スコープに閉じているため、ここで再構築する。
    const patchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableSegment}/${resolvedRecordId}`;

    const updateResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatePayload)
    });

    if (updateResponse.ok) {
      console.log('✅ PaymentEmailSent updated to true:', { resolvedRecordId, originalAirtableRecordId: airtableRecordId });
      if (updatePayload.fields['ExpirationDate']) {
        console.log('✅ ExpirationDate updated:', updatePayload.fields['ExpirationDate']);
      }
    } else {
      const errorText = await updateResponse.text();
      // メール送信は既に成功しているので fatal にはしない（ログのみ・主原因のヒント付き）
      console.error('⚠️ Airtable PATCH (PaymentEmailSent update) failed:', {
        airtableStatus: updateResponse.status,
        airtableStatusText: updateResponse.statusText,
        airtableErrorBody: errorText,
        baseId: AIRTABLE_BASE_ID,
        tableName: AIRTABLE_CUSTOMERS_TABLE,
        airtableRecordId,
        resolvedRecordId,
        note: 'メール送信は成功済み。PaymentEmailSent が false のまま残るため、次回 Status 変更時に再送される可能性があります。PAT に data.records:write スコープが付与されているか確認してください。'
      });
    }

    // 成功レスポンス
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Payment confirmation email sent successfully',
        email: email,
        productName: productName,
        airtableRecordId,            // Automation から渡された元 ID
        resolvedRecordId,            // 実際に使った recordId（email fallback で別 ID になっている可能性あり）
        emailFallbackUsed: resolvedRecordId !== airtableRecordId
      })
    };

  } catch (error) {
    console.error('Error sending payment confirmation:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      })
    };
  }
};

/**
 * メールHTML生成
 */
function generateEmailHTML(fullName, email, productName, planType, expirationDate, paymentAmount, planInfo, japanTime) {
  // プランタイプ表示用
  let planTypeDisplay = '';
  if (planType === 'lifetime') {
    planTypeDisplay = '（買い切り）';
  } else if (planType === 'annual') {
    planTypeDisplay = '（年払い）';
  } else if (planType === 'monthly') {
    planTypeDisplay = '（月払い）';
  }
  // planType が null または '' の場合（Freeプラン）は何も表示しない

  // 有効期限表示用（買い切りの場合は特別表記）
  let expirationDisplay = '';
  if (expirationDate) {
    if (expirationDate === '2099-12-31' || planType === 'lifetime') {
      expirationDisplay = `${expirationDate}（永久アクセス）`;
    } else {
      expirationDisplay = expirationDate;
    }
  }

  // 入金金額表示用（フォーマット）
  let amountDisplay = '';
  if (paymentAmount) {
    // 数値の場合はカンマ区切り、文字列の場合はそのまま
    const amount = typeof paymentAmount === 'number'
      ? paymentAmount.toLocaleString('ja-JP')
      : paymentAmount;
    amountDisplay = `¥${amount}`;
  }
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #10b981; background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
    .section { background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #10b981; }
    .info-row { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .label { font-weight: bold; color: #475569; display: inline-block; width: 120px; }
    .value { color: #1e293b; }
    .highlight { background: #dbeafe; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
    .login-button { display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 15px 0; }
    .access-list { background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981; margin: 15px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 1.8rem;">🎉 ご入金ありがとうございます</h1>
      <p style="margin: 15px 0 0 0; font-size: 1rem;">入金を確認いたしました</p>
    </div>

    <div class="section">
      <p style="margin: 0 0 15px 0; font-size: 1.1rem;">
        <strong>${fullName} 様</strong>
      </p>
      <p style="margin: 0; color: #475569; line-height: 1.8;">
        この度は <strong>${productName}</strong> をご購入いただき、誠にありがとうございます。<br>
        ご入金を確認いたしました。
      </p>
    </div>

    <div class="highlight">
      <h3 style="margin: 0 0 15px 0; color: #1e40af;">🔑 ログイン情報</h3>
      <div class="info-row">
        <span class="label">プラン:</span>
        <span class="value"><strong>${productName} ${planTypeDisplay}</strong></span>
      </div>
      ${expirationDisplay ? `
      <div class="info-row">
        <span class="label">有効期限:</span>
        <span class="value"><strong>${expirationDisplay}</strong></span>
      </div>
      ` : ''}
      ${amountDisplay ? `
      <div class="info-row">
        <span class="label">お支払い金額:</span>
        <span class="value"><strong>${amountDisplay}</strong></span>
      </div>
      ` : ''}
      <div class="info-row" style="border-bottom: none;">
        <span class="label">ログインURL:</span>
        <div class="value" style="margin-top: 10px;">
          <a href="${planInfo.loginUrl}" class="login-button" target="_blank" style="display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #ffffff !important; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 15px 0;">
            ${planInfo.buttonText}
          </a>
          <p style="margin: 15px 0 0 0; padding: 15px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px; color: #92400e; font-size: 0.95rem;">
            <strong>⚠️ 重要</strong><br>
            一度ログアウトしてから再度ログインしてください
          </p>
        </div>
      </div>
    </div>


    <div class="section">
      <h4 style="margin: 0 0 15px 0; color: #1e293b;">📞 サポート</h4>
      <p style="margin: 0; color: #475569; line-height: 1.8;">
        ご不明な点やログインできない場合は、お気軽にお問い合わせください。<br>
        📧 <a href="mailto:${SUPPORT_EMAIL}" style="color: #3b82f6;">${SUPPORT_EMAIL}</a>
      </p>
    </div>

    <div class="footer">
      <p><strong>KEIBA Analytics</strong></p>
      <p>AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム</p>
      <p><a href="https://analytics.keiba.link" style="color: #3b82f6; text-decoration: none;">https://analytics.keiba.link</a></p>
      <p style="margin-top: 15px; font-size: 0.85rem; color: #94a3b8;">
        ※このメールは入金確認後に自動送信されています
      </p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * プラン別の情報を取得
 */
function getPlanInfo(productName, planType) {
  const baseUrl = 'https://analytics.keiba.link';

  // Standard
  if (productName.includes('Standard')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン'
    };
  }

  // Premium
  if (productName.includes('Premium') && !productName.includes('Sanrenpuku') && !productName.includes('Combo') && !productName.includes('Plus')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン'
    };
  }

  // Premium Sanrenpuku
  if (productName.includes('Premium Sanrenpuku') || productName.includes('Sanrenpuku')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン'
    };
  }

  // Premium Combo
  if (productName.includes('Premium Combo') || productName.includes('Combo')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン'
    };
  }

  // Premium Plus
  if (productName.includes('Premium Plus') || productName.includes('Plus')) {
    return {
      loginUrl: `${baseUrl}/premium-plus-v2/`,
      buttonText: 'Premium Plus ページにアクセス'
    };
  }

  // デフォルト
  return {
    loginUrl: `${baseUrl}/dashboard/`,
    buttonText: 'ダッシュボードにログイン'
  };
}
