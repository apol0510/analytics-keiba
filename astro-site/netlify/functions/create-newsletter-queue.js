// Queue方式メルマガ配信システム - Queue生成Function
// PayPal Webhook Phase 7の冪等性設計応用
// ジョブ作成 → Customers取得 → Queue一括投入

export default async function handler(request, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  // 🛡️ 止血ガード（2026-05-14 追加）
  // Queue方式は admin UI 未統合の死蔵経路だが、外部から直接 POST されると
  // NewsletterJobs / NewsletterQueue にレコードが作成されてしまう。
  // 完全自動化の安全設計が終わるまで、Queue 生成自体を無効化する。
  // cron-email-scheduler.js / execute-scheduled-emails.js / send-newsletter.js /
  // schedule-email.js と同じ思想。
  // ここで早期 return することで、Airtable / NewsletterJobs / NewsletterQueue に一切到達しない。
  // 本番配信を再開する際は、dry-run・test を整備してから明示的にフラグを立てる。
  if (process.env.NEWSLETTER_AUTOMATION_ENABLED !== 'true') {
    console.log('🛡️ newsletter automation disabled (NEWSLETTER_AUTOMATION_ENABLED !== "true") - create-newsletter-queue is a no-op');
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

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return new Response(
        JSON.stringify({
          error: 'Missing configuration',
          success: false
        }),
        { status: 500, headers }
      );
    }

    // リクエストボディ解析
    const body = await request.json();
    const { jobId, subject, content, targetPlan = 'ALL', templateId } = body;

    if (!jobId || !subject || !content) {
      return new Response(
        JSON.stringify({
          error: 'Missing required fields: jobId, subject, content',
          success: false
        }),
        { status: 400, headers }
      );
    }

    console.log('🚀 Queue生成開始:', jobId);
    console.log('📋 対象プラン:', targetPlan);

    const now = new Date();

    // ===========================================
    // Step 1: NewsletterJobs作成（Status='draft'）
    // ===========================================
    console.log('📝 Step 1: ジョブ作成中...');

    const jobsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/NewsletterJobs`;
    const jobData = {
      fields: {
        'JobId': jobId,
        'Subject': subject,
        'Content': content,
        'TemplateId': templateId || '',
        'TargetPlan': targetPlan,
        'Status': 'draft',
        'TotalRecipients': 0,
        'SentSuccess': 0,
        'SentFailed': 0,
        'CreatedAt': now.toISOString()
      }
    };

    const jobResponse = await fetch(jobsUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(jobData)
    });

    if (!jobResponse.ok) {
      const errorData = await jobResponse.text();
      throw new Error(`Job creation failed: ${errorData}`);
    }

    const job = await jobResponse.json();
    console.log('✅ ジョブ作成完了:', job.id);

    // ===========================================
    // Step 2: Customers取得（スナップショット）
    // ===========================================
    console.log('👥 Step 2: Customers取得中...');

    const customersUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers`;

    // プラン別フィルター
    let filterFormula = '{WithdrawalRequested} = FALSE()';

    if (targetPlan !== 'ALL') {
      filterFormula = `AND(${filterFormula}, {プラン} = "${targetPlan}")`;
    }

    const customers = [];
    let offset = undefined;

    do {
      const url = new URL(customersUrl);
      url.searchParams.set('filterByFormula', filterFormula);
      url.searchParams.set('fields[]', 'Email');
      if (offset) {
        url.searchParams.set('offset', offset);
      }

      const customersResponse = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!customersResponse.ok) {
        throw new Error(`Customers fetch failed: ${customersResponse.status}`);
      }

      const data = await customersResponse.json();
      customers.push(...data.records.map(r => ({
        email: r.fields.Email
      })));

      offset = data.offset;

      console.log(`📊 取得中... 現在${customers.length}件`);

      // Airtableレート制限対策（5rps）
      if (offset) {
        await sleep(200); // 200ms待機
      }
    } while (offset);

    console.log(`✅ Customers取得完了: ${customers.length}件`);

    if (customers.length === 0) {
      throw new Error('対象顧客が0件です');
    }

    // ===========================================
    // Step 3: NewsletterQueueにバッチ投入（10件/リクエスト）
    // ===========================================
    console.log('📤 Step 3: Queue投入中...');

    const queueUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/NewsletterQueue`;
    const batches = chunkArray(customers, 10); // 10件ずつバッチ

    let queueCreatedCount = 0;
    let queueFailedCount = 0;

    // 🔧 専門家推奨: performUpsert使用（重複防止）
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        // performUpsert用のペイロード（Key手動設定）
        const queueData = {
          performUpsert: {
            fieldsToMergeOn: ['Key'] // Keyフィールドで重複判定
          },
          records: batch.map(customer => ({
            fields: {
              'Key': `${jobId}:${customer.email.toLowerCase()}`, // 🔧 手動Key生成
              'JobId': [job.id], // Link to another record形式
              'Email': customer.email,
              'Status': 'pending',
              'RetryCount': 0
            }
          }))
        };

        const queueResponse = await fetch(queueUrl, {
          method: 'PATCH', // 🔧 performUpsertはPATCH
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(queueData)
        });

        if (queueResponse.ok) {
          const result = await queueResponse.json();
          const created = result.records.filter(r => r.createdTime).length;
          const updated = result.records.length - created;
          queueCreatedCount += created;
          console.log(`✅ バッチ ${i + 1}/${batches.length}: 新規${created}件、既存${updated}件（重複スキップ）`);
        } else {
          const errorData = await queueResponse.text();
          console.error(`❌ バッチ ${i + 1}/${batches.length} 失敗:`, errorData);
          queueFailedCount += batch.length;
        }
      } catch (batchError) {
        console.error(`❌ バッチ ${i + 1}/${batches.length} エラー:`, batchError);
        queueFailedCount += batch.length;
      }

      // Airtableレート制限対策（5rps）
      await sleep(200); // 200ms待機
    }

    console.log(`📊 Queue投入結果: 成功${queueCreatedCount}件、失敗${queueFailedCount}件`);

    // ===========================================
    // Step 4: Job.Status='queued', TotalRecipients確定
    // ===========================================
    console.log('🔄 Step 4: ジョブステータス更新中...');

    const updateUrl = `${jobsUrl}/${job.id}`;
    const updateData = {
      fields: {
        'Status': 'queued',
        'TotalRecipients': queueCreatedCount,
        'QueuedAt': new Date().toISOString()
      }
    };

    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateData)
    });

    if (!updateResponse.ok) {
      throw new Error(`Job update failed: ${updateResponse.status}`);
    }

    console.log('✅ ジョブステータス更新完了: queued');

    // ===========================================
    // 完了レスポンス
    // ===========================================
    const result = {
      success: true,
      jobId,
      status: 'queued',
      totalRecipients: queueCreatedCount,
      failedRecipients: queueFailedCount,
      targetPlan,
      createdAt: now.toISOString(),
      queuedAt: new Date().toISOString()
    };

    console.log('🎉 Queue生成完了:', result);

    return new Response(
      JSON.stringify(result),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ Queue生成エラー:', error);

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

// ヘルパー関数: Sleep（レート制限対策）
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
