// 自作メールスケジューラー - 実行エンジンFunction
// Airtableから予約メールを取得して実行

export default async function handler(request, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !SENDGRID_API_KEY) {
      return new Response(
        JSON.stringify({ 
          error: 'Missing configuration',
          success: false
        }),
        { status: 500, headers }
      );
    }

    const now = new Date();
    console.log('🕐 スケジューラー実行開始:', now.toISOString());

    // 10分前のタイムスタンプ（タイムアウト検出用）
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // Airtableから実行対象のメールを取得
    // 🔧 修正: PENDING または EXECUTING（10分以上経過）を検索
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/ScheduledEmails`;
    const filterFormula = `AND(
      OR(
        {Status} = 'PENDING',
        AND(
          {Status} = 'EXECUTING',
          IS_BEFORE({ScheduledFor}, '${tenMinutesAgo.toISOString()}')
        )
      ),
      IS_BEFORE({ScheduledFor}, '${now.toISOString()}')
    )`;

    console.log(`🔍 検索条件: PENDING または EXECUTING(10分以上経過)`);

    const airtableResponse = await fetch(
      `${airtableUrl}?filterByFormula=${encodeURIComponent(filterFormula)}`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!airtableResponse.ok) {
      throw new Error(`Airtable query failed: ${airtableResponse.status}`);
    }

    const scheduledEmails = await airtableResponse.json();
    const emailsToSend = scheduledEmails.records || [];

    console.log(`📧 実行対象メール数: ${emailsToSend.length}`);

    if (emailsToSend.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No emails to send',
          executedCount: 0,
          timestamp: now.toISOString()
        }),
        { status: 200, headers }
      );
    }

    const results = [];

    // 各メールを順次実行
    for (const emailRecord of emailsToSend) {
      const { id: recordId, fields } = emailRecord;
      const { Subject, Content, Recipients, JobId } = fields;

      try {
        // 🔍 LAZY_LOAD形式の解析
        let recipientList = [];
        let includeUnsubscribe = true;

        if (Recipients && Recipients.startsWith('LAZY_LOAD:')) {
          // LAZY_LOAD:targetPlan:targetMailingList:includeUnsubscribe 形式
          const [, targetPlan, targetMailingList, unsubscribeFlag] = Recipients.split(':');
          includeUnsubscribe = unsubscribeFlag === 'YES';

          console.log(`🔄 LAZY_LOAD検出: targetPlan=${targetPlan}, targetMailingList=${targetMailingList}, includeUnsubscribe=${includeUnsubscribe}`);

          // getRecipientsList関数を使用して受信者リストを取得
          recipientList = await getRecipientsList(targetPlan, targetMailingList, AIRTABLE_API_KEY, AIRTABLE_BASE_ID);

          console.log(`✅ 受信者リスト取得完了: ${recipientList.length}件`);
        } else {
          // 通常の受信者リスト
          recipientList = Recipients.split(',').map(email => email.trim()).filter(Boolean);
        }

        console.log(`📤 送信開始: ${Subject} (${JobId}) - 受信者: ${recipientList.length}件 - 配信解除: ${includeUnsubscribe ? 'あり' : 'なし'}`);

        // 🔄 進捗確認: 既に送信済みの件数を取得
        let sentCount = fields.SentCount || 0;
        let alreadySent = sentCount;

        // 既に全件送信済みの場合はスキップ
        if (sentCount >= recipientList.length) {
          console.log(`✅ 既に送信完了済み: ${recipientList.length}件`);
          await updateEmailStatus(recordId, 'SENT', AIRTABLE_API_KEY, AIRTABLE_BASE_ID);
          results.push({
            jobId: JobId,
            subject: Subject,
            recipientCount: recipientList.length,
            status: 'ALREADY_SENT'
          });
          continue;
        }

        // 未送信分のみ抽出（送信済み件数から再開）
        const remainingRecipients = recipientList.slice(sentCount);
        console.log(`🔄 前回から再開: ${sentCount}件送信済み、残り${remainingRecipients.length}件`);

        // ステータスを実行中に更新
        await updateEmailStatus(recordId, 'EXECUTING', AIRTABLE_API_KEY, AIRTABLE_BASE_ID, {
          SentCount: sentCount
        });

        // 🔐 プライバシー保護個別配信（SendGrid API使用）
        let successCount = 0;
        let failedCount = 0;

        // ⏱️ タイムアウト対策: 最大8分間のみ送信（2分のバッファ）
        const startTime = Date.now();
        const maxExecutionTime = 8 * 60 * 1000; // 8分

        for (const email of remainingRecipients) {
          // タイムアウトチェック
          if (Date.now() - startTime > maxExecutionTime) {
            console.log(`⏱️ タイムアウト接近: ${successCount}件送信完了、次回実行で続行`);
            break;
          }
          try {
            // 配信停止リンクを条件付きで追加
            let htmlContent;

            if (includeUnsubscribe) {
              const unsubscribeLink = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(email)}`;
              htmlContent = `
                ${Content}

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
              htmlContent = Content;
            }

            const emailData = {
              personalizations: [
                {
                  to: [{ email: email.trim() }], // 個別配信でプライバシー完全保護
                  subject: Subject
                }
              ],
              from: {
                name: "NANKANアナリティクス",
                email: "noreply@keiba.link"
              },
              content: [
                {
                  type: "text/html",
                  value: htmlContent
                }
              ],
              // 🚨 重要：SendGridトラッキング完全無効化（復活防止対策 2025-09-29）
              tracking_settings: {
                click_tracking: {
                  enable: false,
                  enable_text: false
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
              }
            };

            const sendGridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${SENDGRID_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(emailData)
            });

            if (sendGridResponse.ok) {
              successCount++;
              console.log(`✅ 個別送信成功: ${email}`);
            } else {
              failedCount++;
              const errorData = await sendGridResponse.text();
              console.error(`❌ 個別送信失敗 ${email}:`, errorData);
            }
          } catch (individualError) {
            failedCount++;
            console.error(`個別送信エラー ${email}:`, individualError);
          }
        }

        // 🔄 進捗保存: 送信済み件数を更新
        const newSentCount = alreadySent + successCount;
        const isComplete = newSentCount >= recipientList.length;

        console.log(`📊 進捗: ${newSentCount}/${recipientList.length}件送信完了 (${Math.round(newSentCount / recipientList.length * 100)}%)`);

        // 送信結果に基づく処理
        if (successCount > 0) {
          if (isComplete) {
            // 🎉 全件送信完了
            await updateEmailStatus(recordId, 'SENT', AIRTABLE_API_KEY, AIRTABLE_BASE_ID, {
              SentCount: newSentCount,
              CompletedAt: now.toISOString()
            });
            console.log(`✅ 全件送信完了: ${Subject} - ${newSentCount}件`);
          } else {
            // 🔄 一部送信完了（次回実行で続行）
            await updateEmailStatus(recordId, 'EXECUTING', AIRTABLE_API_KEY, AIRTABLE_BASE_ID, {
              SentCount: newSentCount
            });
            console.log(`🔄 一部送信完了: ${Subject} - ${newSentCount}/${recipientList.length}件、次回実行で続行`);
          }

          results.push({
            jobId: JobId,
            subject: Subject,
            recipientCount: recipientList.length,
            sentCount: newSentCount,
            successCount,
            failedCount,
            isComplete,
            status: isComplete ? 'COMPLETED' : 'IN_PROGRESS'
          });
        } else {
          // 全て失敗
          throw new Error(`全受信者への送信に失敗`);
        }

        if (isComplete) {
          console.log(`✅ 送信完了: ${Subject}`);
        } else {
          console.log(`🔄 送信継続中: ${Subject} - 次回実行を待機中`);
        }

      } catch (sendError) {
        console.error(`❌ 送信失敗: ${Subject}`, sendError);

        // 送信失敗 - エラーステータス更新
        await updateEmailStatus(recordId, 'FAILED', AIRTABLE_API_KEY, AIRTABLE_BASE_ID, {
          FailedAt: now.toISOString(),
          ErrorMessage: sendError.message,
          RetryCount: (fields.RetryCount || 0) + 1
        });

        results.push({
          jobId: JobId,
          subject: Subject,
          status: 'FAILED',
          error: sendError.message
        });
      }
    }

    const successCount = results.filter(r => r.status === 'SUCCESS').length;
    const failedCount = results.filter(r => r.status === 'FAILED').length;

    return new Response(
      JSON.stringify({
        success: true,
        message: `スケジューラー実行完了: 成功${successCount}件、失敗${failedCount}件`,
        executedCount: emailsToSend.length,
        successCount,
        failedCount,
        results,
        timestamp: now.toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Scheduler execution error:', error);
    
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Unknown error',
        success: false,
        timestamp: new Date().toISOString()
      }),
      { status: 500, headers }
    );
  }
}

// Airtableのメールステータスを更新するヘルパー関数
async function updateEmailStatus(recordId, status, apiKey, baseId, additionalFields = {}) {
  const updateData = {
    fields: {
      Status: status,
      ...additionalFields
    }
  };

  console.log(`🔄 Updating status for ${recordId} to ${status}:`, updateData);

  const response = await fetch(
    `https://api.airtable.com/v0/${baseId}/ScheduledEmails/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateData)
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Status update failed for ${recordId}:`, errorText);
    throw new Error(`Status update failed: ${errorText}`);
  } else {
    console.log(`✅ Status updated successfully for ${recordId} to ${status}`);
  }
  
  return response.ok;
}

// 受信者リストを取得するヘルパー関数
async function getRecipientsList(targetPlan, targetMailingList, apiKey, baseId) {
  console.log(`🔍 受信者リスト取得開始: targetPlan=${targetPlan}, targetMailingList=${targetMailingList}`);

  let filterFormula = '';

  // targetMailingListフィルタ
  if (targetMailingList === 'expired') {
    // 有効期限切れ会員（Standard/Premium）
    const today = new Date().toISOString().split('T')[0];
    filterFormula = `AND(
      OR({プラン} = 'Standard', {プラン} = 'Premium', {プラン} = 'Premium Predictions', {プラン} = 'Premium Sanrenpuku', {プラン} = 'Premium Combo'),
      OR(
        IS_BEFORE({有効期限}, '${today}'),
        IS_BEFORE({ValidUntil}, '${today}'),
        IS_BEFORE({ExpiryDate}, '${today}')
      )
    )`;
  } else if (targetMailingList === 'test') {
    // テスト用（nankan.analytics@gmail.com）
    filterFormula = `{Email} = 'nankan.analytics@gmail.com'`;
  } else {
    // 通常配信（targetPlan基準）
    if (targetPlan === 'all') {
      // 🔧 2025-11-12修正: シンプルなフィルタでEmailが存在する全レコード取得
      filterFormula = "{Email} != ''";
    } else if (targetPlan === 'free') {
      filterFormula = "{プラン} = 'Free'";
    } else if (targetPlan === 'standard') {
      filterFormula = "{プラン} = 'Standard'";
    } else if (targetPlan === 'premium') {
      filterFormula = "OR({プラン} = 'Premium', {プラン} = 'Premium Predictions', {プラン} = 'Premium Sanrenpuku', {プラン} = 'Premium Combo', {プラン} = 'Premium Plus')";
    }
  }

  console.log(`🔍 フィルタ条件: ${filterFormula}`);

  let allRecipients = [];
  let offset = null;

  // Airtableページネーション（全件取得）
  do {
    let url = `https://api.airtable.com/v0/${baseId}/Customers?pageSize=100&filterByFormula=${encodeURIComponent(filterFormula)}`;
    if (offset) {
      url += `&offset=${offset}`;
    }

    console.log(`📄 ページ取得: offset=${offset || 'なし'}`);

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Airtable query failed: ${response.status}`);
    }

    const data = await response.json();
    const emails = data.records
      .map(record => record.fields.Email)
      .filter(email => email);

    allRecipients.push(...emails);
    offset = data.offset;

    console.log(`✅ ${emails.length}件取得、累計: ${allRecipients.length}件`);

  } while (offset);

  console.log(`🎯 受信者リスト取得完了: 合計${allRecipients.length}件`);

  return allRecipients;
}