// Queue方式メルマガ配信システム - 送信ワーカー（Background Functions）
// 専門家推奨修正版：10件バッチ更新 + LeaseId二重起動ガード
// PayPal Webhook Phase 7の冪等性設計応用

export default async function handler(request, context) {
  const headers = {
    'Content-Type': 'application/json'
  };

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !SENDGRID_API_KEY) {
      throw new Error('Missing configuration');
    }

    // リクエストボディ解析
    const body = await request.json();
    const { jobId } = body;

    if (!jobId) {
      throw new Error('Missing required field: jobId');
    }

    console.log('🚀 送信ワーカー開始:', jobId);

    // 設定
    const BATCH_SIZE = 100; // 1回あたり100件
    const SEND_RATE_MS = 125; // 8通/秒（125ms/通）
    const MAX_EXECUTION_TIME = 13 * 60 * 1000; // 13分（余裕持たせる）
    const AIRTABLE_RATE_DELAY = 200; // Airtableレート制限対策（5rps）

    // 🔧 専門家推奨: LeaseId（二重起動ガード）
    const LEASE_ID = `worker-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const LEASE_DURATION = 15 * 60 * 1000; // 15分（Background Functions最大実行時間）

    const startTime = Date.now();
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;

    // ===========================================
    // Step 0: ジョブ情報取得
    // ===========================================
    const jobsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/NewsletterJobs`;
    const jobFilterFormula = `{JobId} = "${jobId}"`;
    const jobUrl = `${jobsUrl}?filterByFormula=${encodeURIComponent(jobFilterFormula)}`;

    const jobResponse = await fetch(jobUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`
      }
    });

    if (!jobResponse.ok) {
      throw new Error(`Job fetch failed: ${jobResponse.status}`);
    }

    const jobData = await jobResponse.json();
    if (jobData.records.length === 0) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const job = jobData.records[0];
    const { Subject, Content } = job.fields;

    console.log('📋 ジョブ情報:', Subject);

    // ===========================================
    // メインループ: 時間制限内で繰り返し
    // ===========================================
    while (Date.now() - startTime < MAX_EXECUTION_TIME) {
      console.log('🔄 バッチ処理開始...');

      const queueUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/NewsletterQueue`;

      // 1. pending AND (ClaimedAt is blank OR ClaimedAt < 15分前) のみ取得
      //    🔧 専門家推奨: 二重起動ガード（見かけ上のロック）
      const leaseExpireTime = new Date(Date.now() - LEASE_DURATION);
      const filterFormula = `AND(
        {JobId} = "${jobId}",
        {Status} = "pending",
        OR(
          {ClaimedAt} = BLANK(),
          IS_BEFORE({ClaimedAt}, '${leaseExpireTime.toISOString()}')
        )
      )`;
      const queueFetchUrl = `${queueUrl}?filterByFormula=${encodeURIComponent(filterFormula)}&maxRecords=${BATCH_SIZE}`;

      const queueResponse = await fetch(queueFetchUrl, {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`
        }
      });

      if (!queueResponse.ok) {
        throw new Error(`Queue fetch failed: ${queueResponse.status}`);
      }

      const queueData = await queueResponse.json();
      const queueRecords = queueData.records || [];

      if (queueRecords.length === 0) {
        console.log('✅ 全件送信完了（pendingレコード0件）');
        break;
      }

      console.log(`📊 取得: ${queueRecords.length}件（pending）`);

      // 2. 即座に ClaimedAt + LeaseId 更新（取り込みの印・バッチ操作）
      //    🔧 専門家推奨: 「見かけ上のロック」で二重起動ガード
      const claimPayload = {
        records: queueRecords.map(record => ({
          id: record.id,
          fields: {
            'ClaimedAt': new Date().toISOString(),
            'ClaimedBy': LEASE_ID
          }
        }))
      };

      // ClaimedAtを10件ずつバッチ更新
      const claimBatches = chunkArray(claimPayload.records, 10);
      for (const claimBatch of claimBatches) {
        await fetch(queueUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ records: claimBatch })
        });
        await sleep(AIRTABLE_RATE_DELAY);
      }

      console.log(`✅ Claim完了: LeaseId=${LEASE_ID}`);

      // 3. SendGrid送信（スロットリング付き）+ 結果溜め込み
      //    🔧 専門家推奨: 1件ずつupdateせず、配列に溜めてから10件バッチ更新
      const sendResults = [];

      for (const record of queueRecords) {
        const email = record.fields.Email;
        const recordId = record.id;

        try {
          // 配信停止リンク追加
          const unsubscribeLink = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(email)}`;
          const htmlContent = `
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

          // SendGrid送信
          const emailData = {
            personalizations: [
              {
                to: [{ email: email.trim() }],
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
            tracking_settings: {
              click_tracking: { enable: false },
              open_tracking: { enable: false },
              subscription_tracking: { enable: false }
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
            // 成功 → 結果溜め込み
            sendResults.push({
              id: recordId,
              fields: {
                'Status': 'success',
                'SentAt': new Date().toISOString(),
                'ClaimedAt': null, // Claim解除
                'ClaimedBy': null
              }
            });
            console.log(`✅ 送信成功: ${email}`);

          } else {
            // 失敗 → 結果溜め込み
            const errorData = await sendGridResponse.text();
            sendResults.push({
              id: recordId,
              fields: {
                'Status': 'failed',
                'LastError': errorData.substring(0, 500),
                'RetryCount': (record.fields.RetryCount || 0) + 1,
                'ClaimedAt': null, // Claim解除
                'ClaimedBy': null
              }
            });
            console.error(`❌ 送信失敗: ${email} - ${errorData.substring(0, 100)}`);
          }

        } catch (individualError) {
          // 例外 → 結果溜め込み
          sendResults.push({
            id: recordId,
            fields: {
              'Status': 'failed',
              'LastError': individualError.message.substring(0, 500),
              'RetryCount': (record.fields.RetryCount || 0) + 1,
              'ClaimedAt': null, // Claim解除
              'ClaimedBy': null
            }
          });
          console.error(`❌ 例外発生: ${email} - ${individualError.message}`);
        }

        // スロットリング（8通/秒 = 125ms/通）
        await sleep(SEND_RATE_MS);
      }

      // 4. 🔧 専門家推奨: 10件バッチ更新（Airtable 5rps対策）
      console.log(`📊 Airtableバッチ更新開始: ${sendResults.length}件`);
      const updateBatches = chunkArray(sendResults, 10);

      let batchSuccess = 0;
      let batchFailed = 0;

      for (const updateBatch of updateBatches) {
        const updatePayload = {
          records: updateBatch
        };

        try {
          const updateResponse = await fetch(queueUrl, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
          });

          if (updateResponse.ok) {
            // バッチ更新成功 → 成功/失敗カウント
            updateBatch.forEach(record => {
              if (record.fields.Status === 'success') {
                batchSuccess++;
              } else {
                batchFailed++;
              }
            });
            console.log(`✅ バッチ更新成功: ${updateBatch.length}件`);
          } else {
            console.error('❌ バッチ更新失敗:', updateResponse.status);
            batchFailed += updateBatch.length;
          }
        } catch (updateError) {
          console.error('❌ バッチ更新エラー:', updateError);
          batchFailed += updateBatch.length;
        }

        // Airtableレート制限対策（5rps）
        await sleep(AIRTABLE_RATE_DELAY);
      }

      totalProcessed += queueRecords.length;
      totalSuccess += batchSuccess;
      totalFailed += batchFailed;

      console.log(`📊 バッチ結果: 成功${batchSuccess}件、失敗${batchFailed}件`);

      // 5. Job集計更新
      await fetch(`${jobsUrl}/${job.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'SentSuccess': job.fields.SentSuccess + batchSuccess,
            'SentFailed': job.fields.SentFailed + batchFailed
          }
        })
      });

      await sleep(AIRTABLE_RATE_DELAY);

      // タイムアウトチェック
      if (Date.now() - startTime > MAX_EXECUTION_TIME) {
        console.log('⏱️ タイムアウト接近・次回実行へ');
        break;
      }
    }

    // ===========================================
    // 完了判定
    // ===========================================
    const remainingUrl = `${queueUrl}?filterByFormula=${encodeURIComponent(`AND({JobId} = "${jobId}", {Status} = "pending")`)}`;
    const remainingResponse = await fetch(remainingUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`
      }
    });

    const remainingData = await remainingResponse.json();
    const remainingCount = remainingData.records.length;

    if (remainingCount === 0) {
      // 全件完了
      await fetch(`${jobsUrl}/${job.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'Status': 'completed',
            'CompletedAt': new Date().toISOString()
          }
        })
      });

      console.log('🎉 全件送信完了: completed');
    } else {
      // 送信中
      await fetch(`${jobsUrl}/${job.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'Status': 'sending'
          }
        })
      });

      console.log(`🔄 送信継続中: 残り${remainingCount}件`);
    }

    // ===========================================
    // 完了レスポンス
    // ===========================================
    const result = {
      success: true,
      jobId,
      leaseId: LEASE_ID,
      totalProcessed,
      totalSuccess,
      totalFailed,
      remainingCount,
      status: remainingCount === 0 ? 'completed' : 'sending',
      executionTime: Math.round((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString()
    };

    console.log('✅ ワーカー完了:', result);

    return new Response(
      JSON.stringify(result),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ ワーカーエラー:', error);

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

// ヘルパー関数: 配列を指定サイズのチャンクに分割
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ヘルパー関数: Sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
