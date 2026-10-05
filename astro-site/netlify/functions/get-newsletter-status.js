// Queue方式メルマガ配信システム - 進捗取得API
// 🔧 専門家推奨: 管理画面のAPI Key露出対策（Functions経由）

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'get-newsletter-status' });
export default async function handler(request, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Missing configuration');
    }

    // URLパラメータからjobId取得
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');

    if (!jobId) {
      return new Response(
        JSON.stringify({
          error: 'Missing required parameter: jobId',
          success: false
        }),
        { status: 400, headers }
      );
    }

    console.log('📊 進捗取得開始:', jobId);

    // ===========================================
    // Step 1: ジョブ情報取得
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
      return new Response(
        JSON.stringify({
          error: `Job not found: ${jobId}`,
          success: false
        }),
        { status: 404, headers }
      );
    }

    const job = {
      id: jobData.records[0].id,
      ...jobData.records[0].fields
    };

    console.log('✅ ジョブ情報取得完了:', job.Subject);

    // ===========================================
    // Step 2: Queue統計取得
    // ===========================================
    const queueUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/NewsletterQueue`;
    const queueFilterFormula = `{JobId} = "${jobId}"`;
    const queueFetchUrl = `${queueUrl}?filterByFormula=${encodeURIComponent(queueFilterFormula)}`;

    const queueResponse = await fetch(queueFetchUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`
      }
    });

    if (!queueResponse.ok) {
      throw new Error(`Queue fetch failed: ${queueResponse.status}`);
    }

    const queueData = await queueResponse.json();
    const records = queueData.records || [];

    const queueStats = {
      pending: records.filter(r => r.fields.Status === 'pending').length,
      sending: records.filter(r => r.fields.Status === 'sending').length,
      success: records.filter(r => r.fields.Status === 'success').length,
      failed: records.filter(r => r.fields.Status === 'failed').length,
      total: records.length
    };

    console.log('✅ Queue統計取得完了:', queueStats);

    // ===========================================
    // 完了レスポンス
    // ===========================================
    const result = {
      success: true,
      job,
      queueStats,
      timestamp: new Date().toISOString()
    };

    return new Response(
      JSON.stringify(result),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ 進捗取得エラー:', error);

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
