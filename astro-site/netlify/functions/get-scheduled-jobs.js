// 自作メールスケジューラー - スケジュールジョブ取得Function
// 管理画面での予約配信一覧表示用

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
      return new Response(
        JSON.stringify({ 
          error: 'Airtable configuration missing',
          success: false
        }),
        { status: 500, headers }
      );
    }

    // URLパラメータから状態フィルターを取得
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'all'; // all, PENDING, SENT, FAILED

    // Airtableからスケジュールジョブを取得
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/ScheduledEmails`;
    let queryParams = 'sort[0][field]=ScheduledFor&sort[0][direction]=asc';
    
    // ステータスフィルター
    if (status !== 'all') {
      const filterFormula = `{Status} = '${status}'`;
      queryParams += `&filterByFormula=${encodeURIComponent(filterFormula)}`;
    }

    const airtableResponse = await fetch(`${airtableUrl}?${queryParams}`, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!airtableResponse.ok) {
      throw new Error(`Airtable query failed: ${airtableResponse.status}`);
    }

    const data = await airtableResponse.json();
    const jobs = data.records || [];

    console.log(`📋 スケジュールジョブ取得: ${jobs.length}件 (status: ${status})`);

    // 現在時刻
    const now = new Date();

    // ジョブデータを整形
    const formattedJobs = jobs.map(record => {
      const { id, fields } = record;
      const scheduledFor = new Date(fields.ScheduledFor);
      const isOverdue = scheduledFor < now && fields.Status === 'PENDING';

      return {
        recordId: id,
        jobId: fields.JobId,
        subject: fields.Subject,
        status: fields.Status,
        scheduledFor: fields.ScheduledFor,
        scheduledForJST: scheduledFor.toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }),
        recipients: fields.Recipients,
        recipientCount: fields.Recipients ? fields.Recipients.split(',').length : 0,
        createdBy: fields.CreatedBy,
        createdAt: fields.CreatedAt,
        sentAt: fields.SentAt,
        failedAt: fields.FailedAt,
        errorMessage: fields.ErrorMessage,
        messageId: fields.MessageId,
        retryCount: fields.RetryCount || 0,
        isOverdue,
        timeUntilSend: scheduledFor > now ? 
          Math.round((scheduledFor - now) / (1000 * 60)) : // 分単位
          null
      };
    });

    // 統計情報
    const stats = {
      total: formattedJobs.length,
      pending: formattedJobs.filter(j => j.status === 'PENDING').length,
      sent: formattedJobs.filter(j => j.status === 'SENT').length,
      failed: formattedJobs.filter(j => j.status === 'FAILED').length,
      executing: formattedJobs.filter(j => j.status === 'EXECUTING').length,
      overdue: formattedJobs.filter(j => j.isOverdue).length
    };

    return new Response(
      JSON.stringify({
        success: true,
        jobs: formattedJobs,
        stats,
        requestedStatus: status,
        timestamp: now.toISOString(),
        message: `${formattedJobs.length}件のスケジュールジョブを取得しました`
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Get scheduled jobs error:', error);
    
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