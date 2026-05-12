// SendGridメルマガ配信Function
// 南関競馬の予想結果や攻略情報を配信

export default async function handler(request, context) {
  // CORS対応ヘッダー
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // OPTIONSリクエスト対応
  if (request.method === 'OPTIONS') {
    return new Response('', {
      status: 200,
      headers
    });
  }

  // POSTメソッドのみ受付
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: `Method ${request.method} not allowed` }),
      {
        status: 405,
        headers
      }
    );
  }

  try {
    const requestBody = await request.text();
    console.log('Received request body:', requestBody);

    const { subject, htmlContent, scheduledAt, targetPlan = 'all', targetMailingList = 'all', retryEmails, includeUnsubscribe = true } = JSON.parse(requestBody);

    // 🔍 デバッグログ追加
    console.log('🎯 パラメータ詳細確認:', {
      subject,
      targetPlan,
      targetMailingList,
      scheduledAt,
      hasRetryEmails: !!retryEmails
    });

    // 必須パラメータチェック
    if (!subject || !htmlContent) {
      return new Response(
        JSON.stringify({ error: 'Subject and htmlContent are required' }),
        {
          status: 400,
          headers
        }
      );
    }

    const isScheduledRequest = !!scheduledAt;

    // 予約配信の場合は自作スケジューラーを使用
    if (isScheduledRequest) {
      console.log('📅 予約配信リクエスト - 自作スケジューラーに転送');

      // ⚡ 大量配信対策: 即座に成功レスポンスを返し、バックグラウンドで処理
      // 受信者数の事前確認（簡易版）
      const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
      const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

      // Airtableから簡易カウント取得（1ページのみ）
      let quickFilterFormula = "";
      if (targetPlan === 'all') {
        quickFilterFormula = "{Email} != ''";
      } else if (targetPlan === 'free') {
        quickFilterFormula = "AND({プラン} = 'Free', {Email} != '')";
      } else if (targetPlan === 'standard') {
        quickFilterFormula = "AND(OR({プラン} = 'Standard', {プラン} = 'Premium'), {Email} != '')";
      } else if (targetPlan === 'premium') {
        quickFilterFormula = "AND({プラン} = 'Premium', {Email} != '')";
      }

      const quickCheckUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers?pageSize=1&filterByFormula=${encodeURIComponent(quickFilterFormula)}`;
      const quickResponse = await fetch(quickCheckUrl, {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!quickResponse.ok) {
        throw new Error('Failed to check recipients count');
      }

      const quickData = await quickResponse.json();
      if (!quickData.records || quickData.records.length === 0) {
        return new Response(
          JSON.stringify({ error: 'No recipients found for scheduling' }),
          { status: 400, headers }
        );
      }

      console.log(`✅ 受信者存在確認完了 - バックグラウンドで処理開始`);

      // 🚀 受信者リストを取得せず、targetPlanのみをスケジューラーに保存
      // 配信時にexecute-scheduled-emails.jsが受信者リストを取得する方式
      const baseUrl = request.url.substring(0, request.url.lastIndexOf('/'));
      const scheduleResponse = await fetch(`${baseUrl}/schedule-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          subject,
          content: htmlContent,
          recipients: 'LAZY_LOAD', // 特別な値：配信時に動的取得
          scheduledFor: scheduledAt,
          createdBy: 'admin',
          targetPlan,
          targetMailingList,
          includeUnsubscribe
        })
      });

      if (!scheduleResponse.ok) {
        const errorText = await scheduleResponse.text();
        throw new Error(`スケジューラー登録失敗: ${scheduleResponse.status} - ${errorText}`);
      }

      const scheduleResult = await scheduleResponse.json();
      console.log(`✅ スケジューラー登録完了: JobID ${scheduleResult.jobId}`);

      // 即座に成功レスポンスを返す（バックグラウンド処理中）
      const scheduledTime = new Date(scheduledAt).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: `予約配信を受け付けました。受信者リストの取得と登録をバックグラウンドで処理中です。`,
          processing: 'background',
          isScheduled: true,
          data: {
            subject,
            scheduledTime,
            note: 'バックグラウンドで受信者リスト取得後、自作スケジューラーに登録されます'
          },
          timestamp: new Date().toISOString()
        }),
        { status: 200, headers }
      );
    }

    // 即座に送信の場合
    // 配信リスト取得（再送信の場合は再送信リストを使用）
    let recipients;
    if (retryEmails && Array.isArray(retryEmails)) {
      console.log('再送信モード:', retryEmails.length + '件');
      recipients = retryEmails;
    } else {
      recipients = await getRecipientsList(targetPlan, targetMailingList);
    }

    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No recipients found' }),
        {
          status: 400,
          headers
        }
      );
    }

    // 🛡️ ドメイン保護: 配信前に受信者をフィルタリング
    console.log('🛡️ ドメイン保護チェック開始...');
    const filteredRecipients = await filterRecipientsForDomainProtection(recipients);

    if (filteredRecipients.blocked.length > 0) {
      console.log(`🚫 ドメイン保護により${filteredRecipients.blocked.length}件をブロック:`,
        filteredRecipients.blocked.slice(0, 5).map(b => `${b.email}(${b.reason})`));
    }

    if (filteredRecipients.deliverable.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'All recipients blocked by domain protection',
          details: {
            totalRequested: recipients.length,
            blocked: filteredRecipients.blocked.length,
            blockedReasons: filteredRecipients.summary
          }
        }),
        {
          status: 400,
          headers
        }
      );
    }

    console.log(`✅ 配信許可: ${filteredRecipients.deliverable.length}/${recipients.length}件`);

    // SendGrid APIでメール送信（即座）
    const result = await sendNewsletterViaSendGrid({
      recipients: filteredRecipients.deliverable,
      subject,
      htmlContent,
      includeUnsubscribe
    });

    // 即時配信もAirtableに履歴を保存
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
      try {
        const now = new Date();
        const historyData = {
          fields: {
            Subject: subject,
            Content: htmlContent.substring(0, 10000), // 最初の10000文字のみ保存
            Recipients: recipients.slice(0, 100).join(', '), // 最初の100件のメールのみ
            ScheduledFor: now.toISOString(),
            Status: 'SENT',
            JobId: `immediate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            CreatedBy: 'admin',
            SentAt: now.toISOString(),
            MessageId: result.messageId || `msg_${Date.now()}`,
            RecipientCount: result.totalSent,
            FailedCount: result.totalFailed,
            TargetPlan: targetPlan || 'all',
            Notes: `即時配信: 成功${result.totalSent}件, 失敗${result.totalFailed}件`
          }
        };

        console.log('📝 即時配信履歴をAirtableに保存中...');

        const airtableResponse = await fetch(
          `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/ScheduledEmails`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(historyData)
          }
        );

        if (airtableResponse.ok) {
          console.log('✅ 即時配信履歴をAirtableに保存しました');
        } else {
          console.error('⚠️ 履歴保存に失敗しましたが、配信は成功しています');
        }
      } catch (historyError) {
        console.error('履歴保存エラー（配信は成功）:', historyError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Newsletter sent to ${result.totalSent} recipients`,
        details: result,
        recipientCount: result.totalSent,
        failedCount: result.totalFailed,
        failedEmails: result.failedEmails,
        isScheduled: false,
        actualSendTime: new Date().toISOString()
      }),
      {
        status: 200,
        headers
      }
    );

  } catch (error) {
    console.error('Newsletter send error:', error);

    return new Response(
      JSON.stringify({
        error: error.message || 'Unknown error',
        timestamp: new Date().toISOString()
      }),
      {
        status: 500,
        headers
      }
    );
  }
}

// Airtableから受信者リストを取得
async function getRecipientsList(targetPlan, targetMailingList = 'all') {
  console.log('📧 getRecipientsList開始:', { targetPlan, targetMailingList });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.error('Airtable設定が見つかりません');
    return [];
  }

  try {
    let filterFormula = '';

    // 🆕 MailingListフィールドベースのフィルタリング（優先使用）
    let mailingListFilter = '';

    if (targetMailingList && targetMailingList !== 'all') {
      if (targetMailingList === '退会者') {
        // 退会者 = 有効期限切れ OR 退会申請済み
        const today = new Date().toISOString().split('T')[0];
        mailingListFilter = `OR(
          IS_BEFORE({有効期限}, '${today}'),
          IS_BEFORE({ValidUntil}, '${today}'),
          IS_BEFORE({ExpiryDate}, '${today}'),
          {WithdrawalRequested} = 1
        )`;
      } else {
        // 通常のMailingListフィルタ
        mailingListFilter = `{MailingList} = '${targetMailingList}'`;
      }
    }

    // 🔧 2025-11-11修正: {メール配信}フィールドが存在しないため、フィルタを無効化
    // Customersテーブルに{メール配信}フィールドが存在しないことを確認
    // 全ての顧客に配信するため、unsubscribeFilterは空文字列に設定
    const unsubscribeFilter = "";

    // 最終的なフィルタ式の構築
    if (mailingListFilter) {
      // MailingListフィルタ優先
      filterFormula = `AND(${mailingListFilter}, {Email} != '')`;
    } else if (targetPlan === 'expired') {
      // 🆕 2025-11-10追加: 退会者（有効期限切れ）フィルタ
      // 有効期限が切れているPremium/Standard会員を抽出
      const today = new Date().toISOString().split('T')[0];
      const expiredFilter = `AND(
        OR(
          IS_BEFORE({有効期限}, '${today}'),
          IS_BEFORE({ValidUntil}, '${today}'),
          IS_BEFORE({ExpiryDate}, '${today}')
        ),
        OR(
          {プラン} = 'Premium',
          {プラン} = 'Standard',
          {プラン} = 'Premium Predictions',
          {プラン} = 'Premium Sanrenpuku',
          {プラン} = 'Premium Combo',
          {プラン} = 'Premium Plus'
        ),
        {Email} != ''
      )`;
      filterFormula = expiredFilter;
      console.log('🔧 退会者フィルタ適用:', { today, expiredFilter });
    } else if (targetPlan && targetPlan !== 'all' && targetPlan !== 'test') {
      // 旧プランフィルタ（後方互換性のため維持）
      let planFilter = '';
      if (targetPlan === 'free') {
        planFilter = "{プラン} = 'Free'";
      } else if (targetPlan === 'standard') {
        planFilter = "{プラン} = 'Standard'";
      } else if (targetPlan === 'premium') {
        planFilter = "OR({プラン} = 'Premium', {プラン} = 'Premium Predictions', {プラン} = 'Premium Sanrenpuku', {プラン} = 'Premium Combo', {プラン} = 'Premium Plus')";
      }
      if (planFilter) {
        filterFormula = `AND(${planFilter}, {Email} != '')`;
      }
    } else if (targetPlan === 'test') {
      // 🔧 2025-11-12修正: Testプラン会員全員を取得（6件）
      filterFormula = "AND(OR({プラン} = 'Test', {プラン} = 'test', {プラン} = 'TEST', {プラン} = 'テスト'), {Email} != '')";
    } else {
      // 🔧 2025-11-12修正: 'all'の場合はEmailが存在するレコードのみ取得（プラン制限なし）
      filterFormula = "{Email} != ''";
    }

    console.log('🔍 フィルター適用:', {
      mailingListFilter,
      unsubscribeFilter,
      finalFormula: filterFormula
    });

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers`;
    const queryParams = filterFormula ? `?filterByFormula=${encodeURIComponent(filterFormula)}` : '';

    console.log('🔍 Airtable検索:', {
      url: url + queryParams,
      filterFormula,
      targetPlan: '指定されたプラン'
    });

    // Airtableページネーション対応: 全レコード取得
    let allRecords = [];
    let offset = null;
    let pageCount = 0;

    do {
      pageCount++;
      let urlWithPagination = url + queryParams;
      if (queryParams) {
        urlWithPagination += offset ? `&offset=${offset}` : '';
      } else {
        urlWithPagination += offset ? `?offset=${offset}` : '';
      }

      console.log(`📄 Airtableページ${pageCount}取得中: ${allRecords.length}件取得済み`);

      const response = await fetch(urlWithPagination, {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Airtable API error: ${response.status}`);
      }

      const data = await response.json();

      if (data.records && data.records.length > 0) {
        allRecords.push(...data.records);
        console.log(`✅ ページ${pageCount}: ${data.records.length}件取得 (累計: ${allRecords.length}件)`);
      }

      offset = data.offset;
    } while (offset);

    console.log('📋 全ページAirtableデータ:', {
      totalRecords: allRecords.length,
      totalPages: pageCount,
      sampleRecords: allRecords.slice(0, 3).map(r => ({
        email: r.fields.Email,
        plan: r.fields['プラン'] || r.fields.Plan
      }))
    });

    const recipients = allRecords
      .map(record => record.fields.Email)
      .filter(email => email && email.includes('@'));

    console.log(`📧 取得した受信者数: ${recipients.length}`);
    console.log(`📧 受信者リスト（最初5件）:`, recipients.slice(0, 5));

    // バウンス管理: 無効なメールアドレスをフィルタリング
    const validRecipients = await filterValidEmails(recipients);
    console.log(`✅ 有効な受信者数: ${validRecipients.length} (除外: ${recipients.length - validRecipients.length}件)`);

    return validRecipients;

  } catch (error) {
    console.error('受信者リスト取得エラー:', error);
    return [];
  }
}

// SendGrid APIでメール送信
async function sendNewsletterViaSendGrid({ recipients, subject, htmlContent, includeUnsubscribe = true }) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid API key not configured');
  }

  const results = {
    totalSent: 0,
    totalFailed: 0,
    failedEmails: []
  };

  // 📧 メール形式検証関数（根本解決）
  const validateEmailFormat = (email) => {
    // RFC 5322準拠の厳格なメール形式チェック
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  };

  // 📝 無効なメールを自動的にEmailBlacklistに記録
  const recordInvalidEmailToBlacklist = async (email, reason) => {
    try {
      const recordData = {
        fields: {
          Email: email,
          BounceCount: 1,
          BounceType: 'hard',
          Status: 'HARD_BOUNCE',
          AddedAt: new Date().toISOString().split('T')[0],
          Notes: `自動検知: ${reason}`
        }
      };

      const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/EmailBlacklist`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(recordData)
      });

      if (response.ok) {
        console.log(`✅ EmailBlacklistに自動記録: ${email} - ${reason}`);
      }
    } catch (error) {
      console.error(`❌ EmailBlacklist記録エラー: ${error.message}`);
    }
  };

  // 🔐 プライバシー保護個別配信システム（BCC問題対応）
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];

    // 🛡️ 送信前の厳格なメール形式チェック（根本解決）
    if (!validateEmailFormat(recipient)) {
      console.log(`🚫 無効なメール形式検出: ${recipient}`);
      results.totalFailed += 1;
      results.failedEmails.push(recipient);

      // 自動的にEmailBlacklistに記録
      await recordInvalidEmailToBlacklist(recipient, '無効なメール形式（@なしまたは形式エラー）');
      continue; // SendGridには送信しない
    }

    try {
      // 配信停止リンクを条件付きで追加
      let htmlWithUnsubscribe;

      if (includeUnsubscribe) {
        const unsubscribeLink = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(recipient)}`;
        htmlWithUnsubscribe = `
          ${htmlContent}

          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
          <div style="text-align: center; padding: 20px; background-color: #f9fafb; font-size: 12px; color: #6b7280; font-family: Arial, sans-serif;">
            <p style="margin: 0 0 10px 0;">このメールは NANKANアナリティクス からお送りしています</p>
            <p style="margin: 10px 0;">
              <a href="${unsubscribeLink}" style="color: #dc2626; text-decoration: underline;">
                🚫 配信停止はこちら
              </a>
            </p>
          </div>
        `;
      } else {
        // 配信解除セクションなし（本文のみ）
        htmlWithUnsubscribe = htmlContent;
      }

      const emailData = {
        personalizations: [
          {
            to: [{ email: recipient }], // 個別配信でプライバシー完全保護
            subject: subject
          }
        ],
        from: {
          name: "NANKANアナリティクス",
          email: "noreply@keiba.link"  // SendGrid認証済みアドレス（Single Sender Verification完了）
        },
        reply_to: {
          name: "NANKANアナリティクス",
          email: "noreply@keiba.link"
        },
        content: [
          {
            type: "text/html",
            value: htmlWithUnsubscribe
          }
        ],
        // 🚨 SendGridトラッキング完全無効化（リンク変換・配信問題防止）
        tracking_settings: {
          click_tracking: {
            enable: false,
            enable_text: false  // テキストメールでも無効化
          },
          open_tracking: {
            enable: false,
            substitution_tag: null
          },
          subscription_tracking: {
            enable: false
          },
          ganalytics: {
            enable: false
          }
        },
        mail_settings: {
          bypass_list_management: {
            enable: false
          },
          footer: {
            enable: false
          },
          sandbox_mode: {
            enable: false
          }
        },
        // RFC 8058準拠のList-Unsubscribeヘッダー（Gmail等が要求）
        headers: {
          "List-Unsubscribe": `<https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(recipient)}>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        }
      };

      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (response.ok) {
        results.totalSent += 1;
        console.log(`✅ 個別送信成功: ${recipient}`);
      } else {
        const errorData = await response.text();
        console.error(`❌ 個別送信失敗 ${recipient}:`, errorData);

        // 🔍 SendGridエラー詳細解析でバウンス検知
        console.log(`🔍 バウンス分析開始: ${recipient} - Status: ${response.status}`);
        console.log(`🔍 Error Data: ${errorData.substring(0, 200)}...`);

        const bounceInfo = await analyzeSendGridBounce(recipient, response.status, errorData);
        console.log(`🔍 バウンス分析結果:`, bounceInfo);

        if (bounceInfo.isBounce) {
          console.log(`🚫 バウンス検知！記録更新開始: ${recipient} (${bounceInfo.type})`);

          try {
            await updateBounceRecord(recipient, bounceInfo);
            console.log(`✅ バウンス記録更新成功: ${recipient}`);
          } catch (updateError) {
            console.error(`❌ バウンス記録更新失敗: ${recipient}`, updateError);
          }

          // 🛡️ ドメイン保護システムに失敗を報告
          try {
            await reportFailureToDomainProtection(recipient, bounceInfo.type, errorData, response.status);
            console.log(`🛡️ ドメイン保護システムに報告完了: ${recipient}`);
          } catch (reportError) {
            console.error(`❌ ドメイン保護報告失敗: ${recipient}`, reportError);
          }
        } else {
          console.log(`ℹ️ バウンスではないエラー: ${recipient} - ${bounceInfo.reason || 'unknown'}`);
        }

        results.totalFailed += 1;
        results.failedEmails.push(recipient);
      }

    } catch (error) {
      console.error(`個別送信エラー ${recipient}:`, error);
      results.totalFailed += 1;
      results.failedEmails.push(recipient);
    }
  }

  return results;
}

// 🛡️ 高度なバウンス管理システム
async function filterValidEmails(emails) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.log('⚠️ バウンス管理: 環境変数未設定のため全メール有効として処理');
    return emails;
  }

  const validEmails = [];
  const invalidEmails = [];
  const quarantinedEmails = []; // 検疫中のメール

  for (const email of emails) {
    try {
      // 基本的なフォーマットチェック
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        invalidEmails.push({ email, reason: 'invalid-format' });
        continue;
      }

      // バウンス履歴チェック
      const bounceStatus = await checkBounceHistory(email);

      if (bounceStatus.isBlacklisted) {
        invalidEmails.push({
          email,
          reason: bounceStatus.reason,
          bounceCount: bounceStatus.bounceCount,
          lastBounce: bounceStatus.lastBounceDate
        });
        continue;
      }

      if (bounceStatus.isQuarantined) {
        quarantinedEmails.push({
          email,
          reason: 'soft-bounce-warning',
          bounceCount: bounceStatus.bounceCount,
          remainingAttempts: 5 - bounceStatus.bounceCount
        });
        // 検疫中でも配信は継続（最後のチャンス）
      }

      validEmails.push(email);

    } catch (error) {
      console.error(`バウンス管理エラー ${email}:`, error);
      // エラー時は安全のため有効として扱う
      validEmails.push(email);
    }
  }

  // 詳細ログ出力
  if (invalidEmails.length > 0) {
    console.log('🚫 ブラックリスト除外:', invalidEmails);
  }
  if (quarantinedEmails.length > 0) {
    console.log('⚠️ 検疫中（最後のチャンス）:', quarantinedEmails);
  }

  console.log(`📊 バウンス管理結果: 有効${validEmails.length}件, 除外${invalidEmails.length}件, 検疫${quarantinedEmails.length}件`);

  return validEmails;
}

// バウンス履歴の詳細チェック
async function checkBounceHistory(email) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  try {
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist?filterByFormula=SEARCH('${email}',{Email})`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return { isBlacklisted: false, isQuarantined: false };
    }

    const data = await response.json();

    if (data.records.length === 0) {
      return { isBlacklisted: false, isQuarantined: false };
    }

    const record = data.records[0].fields;
    const bounceCount = record.BounceCount || 0;
    const bounceType = record.BounceType || 'unknown';
    const status = record.Status || 'UNKNOWN';
    // LastBounceDateフィールドは現在のテーブルに存在しないため削除

    // 永続的エラー（Hard Bounce）= 即座にブラックリスト
    if (bounceType === 'hard' || status === 'HARD_BOUNCE' || status === 'COMPLAINT') {
      return {
        isBlacklisted: true,
        isQuarantined: false,
        reason: bounceType === 'hard' ? 'hard-bounce' : 'complaint',
        bounceCount,
        lastBounceDate
      };
    }

    // 一時的エラー（Soft Bounce）= 5回で昇格
    if (bounceType === 'soft' && bounceCount >= 5) {
      // 5回に達したので永続的エラーに昇格
      await upgradeToHardBounce(email, record);
      return {
        isBlacklisted: true,
        isQuarantined: false,
        reason: 'soft-bounce-upgraded',
        bounceCount,
        lastBounceDate
      };
    }

    // 一時的エラー（Soft Bounce）= 検疫中（3-4回）
    if (bounceType === 'soft' && bounceCount >= 3) {
      return {
        isBlacklisted: false,
        isQuarantined: true,
        reason: 'soft-bounce-warning',
        bounceCount,
        lastBounceDate
      };
    }

    // その他は有効
    return { isBlacklisted: false, isQuarantined: false };

  } catch (error) {
    console.error(`バウンス履歴チェックエラー ${email}:`, error);
    return { isBlacklisted: false, isQuarantined: false };
  }
}

// Soft BounceをHard Bounceに昇格
async function upgradeToHardBounce(email, currentRecord) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  try {
    const recordId = currentRecord.id || currentRecord.recordId;

    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist/${recordId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          Status: 'HARD_BOUNCE',
          BounceType: 'hard',
          UpgradedAt: new Date().toISOString(),
          Notes: `Soft bounce上限(5回)に達したため永続エラーに昇格`
        }
      })
    });

    console.log(`🔄 ${email}: Soft→Hard Bounce昇格完了`);

  } catch (error) {
    console.error(`Bounce昇格エラー ${email}:`, error);
  }
}

// 🔍 SendGridエラー詳細解析でバウンス種別判定
async function analyzeSendGridBounce(email, statusCode, errorData) {
  const bounceInfo = {
    isBounce: false,
    type: 'unknown',
    reason: 'unknown'
  };

  try {
    // SendGrid APIエラーレスポンス解析
    let errorObj;
    try {
      errorObj = JSON.parse(errorData);
    } catch {
      errorObj = { message: errorData };
    }

    const errorMessage = (errorObj.message || errorData || '').toLowerCase();

    // Hard Bounce判定条件
    const hardBounceIndicators = [
      'invalid',
      'not exist',
      'unknown user',
      'mailbox not found',
      'no such user',
      'user unknown',
      'recipient address rejected',
      'does not match a verified sender identity',
      'does not contain a valid address'
    ];

    // Soft Bounce判定条件
    const softBounceIndicators = [
      'mailbox full',
      'quota',
      'temporary failure',
      'deferred',
      'try again later',
      'service unavailable'
    ];

    // Hard Bounce判定
    if (statusCode === 400 || hardBounceIndicators.some(indicator => errorMessage.includes(indicator))) {
      bounceInfo.isBounce = true;
      bounceInfo.type = 'hard';
      bounceInfo.reason = 'hard-bounce';
    }
    // Soft Bounce判定
    else if (statusCode === 421 || statusCode === 450 || softBounceIndicators.some(indicator => errorMessage.includes(indicator))) {
      bounceInfo.isBounce = true;
      bounceInfo.type = 'soft';
      bounceInfo.reason = 'soft-bounce';
    }
    // 一般的な送信エラー（400番台）もバウンスとして扱う
    else if (statusCode >= 400 && statusCode < 500) {
      bounceInfo.isBounce = true;
      bounceInfo.type = 'hard'; // 安全のためHard Bounceとして扱う
      bounceInfo.reason = 'send-error';
    }

    console.log(`🔍 バウンス解析結果 ${email}:`, {
      statusCode,
      errorMessage: errorMessage.substring(0, 100),
      bounceInfo
    });

  } catch (error) {
    console.error(`バウンス解析エラー ${email}:`, error);
  }

  return bounceInfo;
}

// 📝 バウンス記録更新・新規作成
async function updateBounceRecord(email, bounceInfo) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  console.log(`📝 バウンス記録開始: ${email} - Type: ${bounceInfo.type}, Reason: ${bounceInfo.reason}`);

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.error('❌ Airtable環境変数未設定のためバウンス記録をスキップ');
    console.log('📊 環境変数状況:', {
      hasApiKey: !!AIRTABLE_API_KEY,
      hasBaseId: !!AIRTABLE_BASE_ID
    });
    throw new Error('Airtable環境変数が設定されていません');
  }

  try {
    console.log(`🔍 既存記録をチェック中: ${email}`);

    // 既存記録チェック
    const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist?filterByFormula=SEARCH('${email}',{Email})`;
    console.log(`🔗 Airtable検索URL: ${searchUrl}`);

    const existingRecordResponse = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`📡 Airtable検索レスポンス: ${existingRecordResponse.status} ${existingRecordResponse.statusText}`);

    if (!existingRecordResponse.ok) {
      throw new Error(`既存記録検索失敗: ${existingRecordResponse.status}`);
    }

    const existingData = await existingRecordResponse.json();
    console.log(`📊 検索結果: ${existingData.records.length}件の既存記録`);

    const now = new Date().toISOString();

    if (existingData.records.length > 0) {
      // 既存記録更新
      const record = existingData.records[0];
      const currentCount = record.fields.BounceCount || 0;
      const newCount = currentCount + 1;

      console.log(`📝 既存記録更新: ${email} - ${currentCount}回 → ${newCount}回`);

      // Soft Bounceが5回に達したらHard Bounceに昇格
      const finalType = bounceInfo.type === 'soft' && newCount >= 5 ? 'hard' : bounceInfo.type;
      const finalStatus = finalType === 'hard' ? 'HARD_BOUNCE' : 'SOFT_BOUNCE';

      const updateResponse = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist/${record.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            BounceCount: newCount,
            BounceType: finalType,
            Status: finalStatus,
            Notes: `${bounceInfo.reason} (${currentCount}→${newCount}回)${newCount >= 5 && bounceInfo.type === 'soft' ? ' [自動昇格]' : ''}`
          }
        })
      });

      console.log(`📡 更新レスポンス: ${updateResponse.status} ${updateResponse.statusText}`);

      if (!updateResponse.ok) {
        const updateErrorText = await updateResponse.text();
        console.error(`❌ 更新失敗: ${updateErrorText}`);
        throw new Error(`更新失敗: ${updateResponse.status} - ${updateErrorText}`);
      }

      console.log(`✅ バウンス記録更新完了: ${email} (${currentCount}→${newCount}回, ${finalType})`);

    } else {
      // 新規記録作成
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            Email: email,
            BounceCount: 1,
            BounceType: bounceInfo.type,
            Status: bounceInfo.type === 'hard' ? 'HARD_BOUNCE' : 'SOFT_BOUNCE',
            AddedAt: new Date().toISOString().split('T')[0],
            Notes: `初回バウンス: ${bounceInfo.reason}`
          }
        })
      });

      console.log(`📝 新規バウンス記録作成: ${email} (${bounceInfo.type})`);
    }

  } catch (error) {
    console.error(`バウンス記録更新エラー ${email}:`, error);
  }
}

// 🛡️ ドメイン保護: 配信前フィルタリング
async function filterRecipientsForDomainProtection(recipients) {
  console.log(`🛡️ ドメイン保護チェック開始: ${recipients.length}件`);

  const deliverable = [];
  const blocked = [];
  const summary = { hardBounce: 0, softBounceLimit: 0, complaints: 0, invalidFormat: 0 };

  for (const email of recipients) {
    try {
      // ドメイン保護システムに配信可否を問い合わせ
      const status = await checkEmailDeliverabilityForProtection(email);

      if (status.canDeliver) {
        deliverable.push(email);

        // 警告レベルの場合はログ出力
        if (status.riskLevel === 'high') {
          console.log(`⚠️ 高リスクだが配信許可: ${email} (${status.failureCount}回失敗)`);
        }
      } else {
        blocked.push({
          email,
          reason: status.reason,
          failureCount: status.failureCount,
          riskLevel: status.riskLevel
        });

        // 理由別カウント
        if (status.reason === 'hard-bounce') summary.hardBounce++;
        else if (status.reason === 'soft-bounce-limit') summary.softBounceLimit++;
        else if (status.reason === 'complaint') summary.complaints++;
        else if (status.reason === 'invalid-format') summary.invalidFormat++;
      }

    } catch (error) {
      console.error(`ドメイン保護チェックエラー ${email}:`, error);
      // エラー時は安全のため配信許可
      deliverable.push(email);
    }
  }

  const protectionResult = {
    deliverable,
    blocked,
    summary: {
      total: recipients.length,
      deliverable: deliverable.length,
      blocked: blocked.length,
      ...summary
    }
  };

  console.log('🛡️ ドメイン保護結果:', {
    配信許可: protectionResult.summary.deliverable,
    ブロック: protectionResult.summary.blocked,
    ハードバウンス: summary.hardBounce,
    ソフトバウンス上限: summary.softBounceLimit,
    苦情: summary.complaints
  });

  return protectionResult;
}

// 🛡️ 無効メール自動ブラックリスト登録関数（根本解決）
async function recordInvalidEmailToBlacklist(email, reason) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  try {
    console.log(`🛡️ 自動ブラックリスト登録: ${email} (理由: ${reason})`);

    const recordData = {
      fields: {
        Email: email,
        BounceCount: 1,
        BounceType: 'hard',
        Status: 'HARD_BOUNCE',
        AddedAt: new Date().toISOString().split('T')[0],
        Notes: reason
      }
    };

    const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(recordData)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('✅ 自動ブラックリスト登録成功!');
      console.log('📋 レコードID:', result.id);
      return true;
    } else {
      const error = await response.text();
      console.error('❌ 自動ブラックリスト登録失敗:', error);
      return false;
    }

  } catch (error) {
    console.error('❌ 自動ブラックリスト登録エラー:', error.message);
    return false;
  }
}

// ドメイン保護用の配信可否チェック（軽量版）
async function checkEmailDeliverabilityForProtection(email) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    // 設定なしの場合は配信許可
    return { canDeliver: true, reason: 'no-protection', failureCount: 0, riskLevel: 'unknown' };
  }

  try {
    // 📧 厳密なメール形式検証（根本解決）
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!emailRegex.test(email)) {
      console.log(`⚡ 根本解決発動: 無効メール検出 ${email}`);
      // 🛡️ 無効メールを自動ブラックリスト登録（根本解決）
      await recordInvalidEmailToBlacklist(email, '無効なメール形式（@なしまたは形式エラー）');
      return { canDeliver: false, reason: 'invalid-format', failureCount: 0, riskLevel: 'critical' };
    }

    // Airtableからバウンス履歴をチェック
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist?filterByFormula=SEARCH('${email}',{Email})`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      // API失敗時は配信許可（安全側）
      return { canDeliver: true, reason: 'api-error', failureCount: 0, riskLevel: 'unknown' };
    }

    const data = await response.json();

    if (data.records.length === 0) {
      // クリーンなメールアドレス
      return { canDeliver: true, reason: 'clean', failureCount: 0, riskLevel: 'low' };
    }

    const record = data.records[0].fields;
    const bounceCount = record.BounceCount || 0;
    const bounceType = record.BounceType || 'unknown';
    const status = record.Status || 'UNKNOWN';

    // 🚫 ブロック条件
    if (status === 'HARD_BOUNCE' || status === 'COMPLAINT') {
      return {
        canDeliver: false,
        reason: status === 'HARD_BOUNCE' ? 'hard-bounce' : 'complaint',
        failureCount: bounceCount,
        riskLevel: 'critical'
      };
    }

    // 🚫 ソフトバウンス上限
    if (bounceType === 'soft' && bounceCount >= 5) {
      return {
        canDeliver: false,
        reason: 'soft-bounce-limit',
        failureCount: bounceCount,
        riskLevel: 'critical'
      };
    }

    // ⚠️ 警告レベル（配信は継続）
    if (bounceType === 'soft' && bounceCount >= 3) {
      return {
        canDeliver: true,
        reason: 'soft-bounce-warning',
        failureCount: bounceCount,
        riskLevel: 'high'
      };
    }

    // ✅ 軽微な問題（配信継続）
    return {
      canDeliver: true,
      reason: 'minor-issues',
      failureCount: bounceCount,
      riskLevel: 'medium'
    };

  } catch (error) {
    console.error(`配信可否チェックエラー ${email}:`, error);
    // エラー時は配信許可
    return { canDeliver: true, reason: 'check-error', failureCount: 0, riskLevel: 'unknown' };
  }
}

// ドメイン保護システムに失敗を報告
async function reportFailureToDomainProtection(email, errorType, errorMessage, statusCode) {
  try {
    console.log(`🛡️ ドメイン保護に失敗報告: ${email} (${errorType})`);

    // domain-protection.js のreport-failure機能を呼び出し
    const baseUrl = 'http://localhost:8888'; // 開発環境
    // const baseUrl = process.env.SITE_URL || 'https://analytics.keiba.link'; // 本番環境

    const reportResponse = await fetch(`${baseUrl}/.netlify/functions/domain-protection?action=report-failure`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        errorType,
        errorMessage,
        statusCode
      })
    });

    if (!reportResponse.ok) {
      console.error(`ドメイン保護への報告失敗: ${reportResponse.status}`);
      return;
    }

    const result = await reportResponse.json();
    console.log(`✅ ドメイン保護報告完了: ${email} - ${result.message}`);

    // 5回に達した場合は警告ログ
    if (result.isBlocked) {
      console.warn(`🚨 ドメイン保護により自動ブロック: ${email} (${result.newFailureCount}回失敗)`);
    }

  } catch (error) {
    console.error(`ドメイン保護報告エラー ${email}:`, error);
    // エラーが発生しても配信処理は継続
  }
}