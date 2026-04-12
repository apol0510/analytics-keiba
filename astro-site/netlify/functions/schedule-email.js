// 自作メールスケジューラー - 予約登録Function
// Airtableをジョブキューとして使用した堅牢なスケジューラー

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

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return new Response(
        JSON.stringify({ 
          error: 'Airtable configuration missing',
          success: false
        }),
        { status: 500, headers }
      );
    }

    const body = await request.json();
    const {
      subject,
      content,
      recipients,
      scheduledFor, // ISO string
      createdBy = 'admin',
      targetPlan,
      targetMailingList = 'all',
      includeUnsubscribe = true
    } = body;

    // 🔍 デバッグログ: 受信データ確認
    console.log('📧 schedule-email受信データ:', {
      subject: subject?.substring(0, 50),
      contentLength: content?.length,
      recipientsType: Array.isArray(recipients) ? 'Array' : typeof recipients,
      recipientsLength: Array.isArray(recipients) ? recipients.length : (recipients === 'LAZY_LOAD' ? 'LAZY_LOAD' : recipients?.length),
      recipientsFirst3: Array.isArray(recipients) ? recipients.slice(0, 3) : recipients,
      targetPlan,
      targetMailingList,
      scheduledFor
    });

    // 必須項目チェック
    if (!subject || !content || !recipients || !scheduledFor) {
      console.error('❌ 必須項目不足:', { subject: !!subject, content: !!content, recipients: !!recipients, scheduledFor: !!scheduledFor });
      return new Response(
        JSON.stringify({
          error: 'Missing required fields: subject, content, recipients, scheduledFor',
          success: false
        }),
        { status: 400, headers }
      );
    }

    // 🔍 受信者数チェック（LAZY_LOADの場合はスキップ）
    if (recipients !== 'LAZY_LOAD') {
      const recipientsCount = Array.isArray(recipients) ? recipients.length : (recipients.split(',').length || 0);
      if (recipientsCount === 0) {
        console.error('❌ 受信者数が0です');
        return new Response(
          JSON.stringify({
            error: 'No recipients found for scheduling',
            success: false,
            debug: {
              recipientsType: typeof recipients,
              recipientsValue: recipients
            }
          }),
          { status: 400, headers }
        );
      }
      console.log(`✅ 受信者数確認: ${recipientsCount}件`);
    } else {
      console.log(`✅ LAZY_LOAD指定 - 配信時にtargetPlan="${targetPlan}"から取得`);
    }

    // 過去の時刻チェック
    const scheduledTime = new Date(scheduledFor);
    const now = new Date();
    
    if (scheduledTime <= now) {
      return new Response(
        JSON.stringify({ 
          error: 'Scheduled time must be in the future',
          success: false,
          scheduledTime: scheduledTime.toISOString(),
          currentTime: now.toISOString()
        }),
        { status: 400, headers }
      );
    }

    // Airtableにスケジュールジョブを作成
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/ScheduledEmails`;

    // 🔧 Airtableフィールドを既存のもののみに限定
    const scheduleData = {
      fields: {
        Subject: subject,
        Content: content,
        Recipients: Array.isArray(recipients) ? recipients.join(', ') : recipients,
        ScheduledFor: scheduledTime.toISOString(),
        Status: 'PENDING',
        CreatedBy: createdBy,
        JobId: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        // IncludeUnsubscribe, TargetPlan, TargetMailingList は追加しない（Airtableに存在しないため）
        // 代わりにContent内に情報を埋め込む、またはRecipientsに'LAZY_LOAD:targetPlan'形式で保存
      }
    };

    // LAZY_LOADの場合はRecipientsフィールドに詳細情報を埋め込む
    if (recipients === 'LAZY_LOAD') {
      scheduleData.fields.Recipients = `LAZY_LOAD:${targetPlan}:${targetMailingList}:${includeUnsubscribe ? 'YES' : 'NO'}`;
    }

    console.log('Creating scheduled email job:', scheduleData);

    const airtableResponse = await fetch(airtableUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(scheduleData)
    });

    if (!airtableResponse.ok) {
      const error = await airtableResponse.text();
      console.error('Airtable creation failed:', error);
      throw new Error(`Failed to create schedule: ${error}`);
    }

    const result = await airtableResponse.json();
    
    return new Response(
      JSON.stringify({
        success: true,
        jobId: result.fields.JobId,
        recordId: result.id,
        scheduledFor: scheduledTime.toISOString(),
        message: `メール予約完了: ${subject}`,
        data: {
          subject,
          scheduledTime: scheduledTime.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          }),
          recipientCount: Array.isArray(recipients) ? recipients.length : 1
        }
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Schedule email error:', error);
    
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