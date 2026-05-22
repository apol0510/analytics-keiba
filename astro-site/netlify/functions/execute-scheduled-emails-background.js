// 自作メールスケジューラー - 実行エンジン（Netlify Background Function）
// Airtableから予約メールを取得して実行
//
// 2026-05-22: 同期関数（最大26秒）では 1000 件規模を1パスで送れず、SentCount 書込み前に
// kill されて cron 再実行で重複送信するため、ファイル名を *-background.js に変更して
// Background Function 化（最大15分）。内部 8 分グレースフル break までに必ず SentCount を
// 書くため、resume が重複なしで成立する。送信ロジック / LAZY_LOAD 受信者解決 /
// SentCount・CompletedAt 記録 / brand付き配信停止URL / List-Unsubscribe ヘッダーは不変。
// 呼び出し元 cron-email-scheduler.js は本関数を 202 即返しで起動する（結果は Airtable で監視）。

import {
  fetchCustomersReadOnly,
  loadBlacklistEmails,
  BRAND_TO_BASE_ID_ENV,
} from '../../src/lib/newsletter/airtable-fetch.js';
import {
  resolveAudienceRecipients,
  mapLegacyTargetToAudienceType,
} from '../../src/lib/newsletter/audience-resolver.js';

// ScheduledEmails は AK 専用経路。LAZY_LOAD で受信者を解決する時の brand 既定値。
const DEFAULT_BRAND = 'analytics-keiba';

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

  // 🛡️ 止血ガード（2026-05-14 追加）
  // 過去にテスト時の重複配信が発生したため、ScheduledEmails 経由の自動送信は
  // NEWSLETTER_AUTOMATION_ENABLED === 'true' でない限り完全に無効化する。
  // cron-email-scheduler.js のガードに加え、直接POSTされた場合の二重防御。
  // ここで早期 return することで、Airtable / SendGrid に一切到達しない。
  // 本番配信を再開する際は、設計・dry-run・test を整備してから明示的にフラグを立てる。
  if (process.env.NEWSLETTER_AUTOMATION_ENABLED !== 'true') {
    console.log('🛡️ newsletter automation disabled (NEWSLETTER_AUTOMATION_ENABLED !== "true") - execute-scheduled-emails is a no-op');
    return new Response(
      JSON.stringify({
        success: true,
        skipped: true,
        reason: 'newsletter automation disabled',
        flag: 'NEWSLETTER_AUTOMATION_ENABLED',
        flagValue: process.env.NEWSLETTER_AUTOMATION_ENABLED ?? null,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );
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
            // brand=analytics-keiba を付与する（unsubscribe.js は brand 必須。無いと GET の
            // ブランド選択 UI に着地して 1 ステップ増える）。newsletter-send-test.js と統一。
            // List-Unsubscribe ヘッダーでも同じ URL を使うため if 外で定義する。
            const unsubscribeLink = includeUnsubscribe
              ? `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(email)}&brand=analytics-keiba`
              : null;
            let htmlContent;

            if (includeUnsubscribe) {
              htmlContent = `
                ${Content}

                <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
                <div style="text-align: center; padding: 20px; background-color: #f9fafb; font-size: 12px; color: #6b7280; font-family: Arial, sans-serif;">
                  <p style="margin: 0 0 10px 0;">このメールは KEIBA Analytics からお送りしています</p>
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
                name: "KEIBA Analytics",
                email: "noreply@keiba.link"
              },
              content: [
                {
                  type: "text/html",
                  value: htmlContent
                }
              ],
              // RFC 8058 準拠の List-Unsubscribe ヘッダー（Gmail / Outlook のネイティブ配信停止
              // ボタン表示。newsletter-send-test.js D4 と同パターン）。includeUnsubscribe 時のみ付与。
              ...(unsubscribeLink ? {
                headers: {
                  'List-Unsubscribe': `<${unsubscribeLink}>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
              } : {}),
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

// 受信者リストを取得するヘルパー関数（2026-05-19: 5-tier 除外に統一）
//
// 旧実装は {プラン} のみフィルタで unsubscribe / blacklist / withdrawn が抜けていた
// （safety audit D1/D2/D5）。新実装は preview と同じ resolveAudienceRecipients() を使う。
//
// 旧 admin の "退会者" mailingList は 5-tier 除外に反するため明示拒否。
// 期限切れ会員への再エンゲージメントは audienceType='expired' を使う設計に統一。
async function getRecipientsList(targetPlan, targetMailingList, apiKey, baseId) {
  console.log(`🔍 受信者リスト取得開始: targetPlan=${targetPlan}, targetMailingList=${targetMailingList}`);

  if (typeof targetMailingList === 'string' && targetMailingList === '退会者') {
    console.warn('🛑 targetMailingList="退会者" は 5-tier 除外に反するため拒否');
    return [];
  }

  const audienceTypeFilter = mapLegacyTargetToAudienceType({ targetPlan, targetMailingList });
  console.log('🎯 audienceTypeFilter 解決:', { targetPlan, targetMailingList, audienceTypeFilter });

  const records = await fetchCustomersReadOnly(baseId, apiKey);
  const { emails: blacklistEmails, status: blacklistStatus } = await loadBlacklistEmails({
    brand: DEFAULT_BRAND,
    baseId,
    apiKey,
  });
  const today = new Date().toISOString().slice(0, 10);

  const result = resolveAudienceRecipients({
    records,
    brand: DEFAULT_BRAND,
    audienceTypeFilter,
    today,
    blacklistEmails,
  });

  console.log('📊 受信者解決:', {
    audienceTypeFilter,
    totalCustomers: result.counts.totalCustomers,
    matchedCount: result.counts.matchedCount,
    withdrawnExcluded: result.counts.withdrawnExcluded,
    unsubscribeExcluded: result.counts.unsubscribeExcluded,
    blacklistExcluded: result.counts.blacklistExcluded,
    audienceTypeMismatchSkipped: result.counts.audienceTypeMismatchSkipped,
    invalidEmailSkipped: result.counts.invalidEmailSkipped,
    dedupedFromMatched: result.counts.dedupedFromMatched,
    blacklistStatus,
  });

  return result.emails;
}