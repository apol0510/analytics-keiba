// 配信履歴取得Function
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

  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { status: 405, headers }
    );
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Airtable configuration missing');
    }

    // ScheduledEmailsテーブルから配信履歴を取得  
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/ScheduledEmails`;
    
    // 最新の配信順にソート (ScheduledForでソート)
    const queryParams = new URLSearchParams({
      sort: JSON.stringify([{field: "ScheduledFor", direction: "desc"}]),
      maxRecords: "20"
    });
    
    const response = await fetch(`${url}?${queryParams}`, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status}`);
    }

    const data = await response.json();
    
    // 配信履歴データを整形
    const history = data.records.map(record => {
      const fields = record.fields;
      
      // 配信対象の日本語化（TargetPlanフィールドに対応）
      let targetPlanJa = fields.TargetPlan || fields.targetPlan || 'all';
      switch(targetPlanJa) {
        case 'free': targetPlanJa = 'Free会員'; break;
        case 'standard': targetPlanJa = 'Standard会員'; break;
        case 'premium': targetPlanJa = 'Premium会員'; break;
        case 'test': targetPlanJa = 'テスト'; break;
        case 'all': targetPlanJa = '全員'; break;
        default: targetPlanJa = '全員';
      }
      
      return {
        id: record.id,
        subject: fields.Subject || '-',
        targetPlan: targetPlanJa,
        recipientCount: fields.RecipientCount || 0,
        status: fields.Status || 'UNKNOWN',
        scheduledFor: fields.ScheduledFor,
        sentAt: fields.SentAt,
        createdAt: fields.ScheduledFor,
        jobId: fields.JobId,
        errorMessage: fields.ErrorMessage,
        failedCount: fields.FailedCount || 0,
        notes: fields.Notes || ''
      };
    });

    return new Response(
      JSON.stringify(history),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Newsletter history error:', error);
    
    return new Response(
      JSON.stringify([]), // エラー時は空の配列を返す
      { status: 200, headers }
    );
  }
}