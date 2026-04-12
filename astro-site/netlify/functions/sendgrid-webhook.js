// SendGrid Webhook受信エンドポイント
// バウンス・配信失敗・スパム報告をリアルタイム処理

import { config } from 'dotenv';
config();

export default async (req, context) => {
  console.log('📨 SendGrid Webhook受信開始');

  // POSTのみ受け付け
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const events = await req.json();
    console.log(`📊 受信イベント数: ${events.length}`);

    for (const event of events) {
      console.log(`🔍 イベント処理: ${event.event} - ${event.email}`);

      // バウンス・配信失敗・スパム報告を処理
      if (shouldProcessEvent(event)) {
        await processFailureEvent(event);
      }
    }

    return new Response(JSON.stringify({ success: true, processed: events.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Webhook処理エラー:', error);
    return new Response(JSON.stringify({ error: 'Webhook processing failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// イベント処理判定
function shouldProcessEvent(event) {
  const failureEvents = [
    'bounce',        // バウンス（hard/soft）
    'blocked',       // ブロック
    'dropped',       // ドロップ
    'spamreport',    // スパム報告
    'unsubscribe'    // 配信停止
  ];

  return failureEvents.includes(event.event);
}

// 配信失敗イベント処理
async function processFailureEvent(event) {
  const email = event.email;
  const eventType = event.event;
  const reason = event.reason || '';
  const timestamp = new Date(event.timestamp * 1000).toISOString();

  console.log(`📧 配信失敗処理: ${email} - ${eventType} - ${reason}`);

  // バウンス分析
  const bounceInfo = analyzeWebhookBounce(event);
  console.log(`📊 バウンス分析結果:`, bounceInfo);

  // Airtableに記録
  await recordWebhookBounce(email, bounceInfo, event);
}

// Webhookバウンス分析
function analyzeWebhookBounce(event) {
  const eventType = event.event;
  const reason = (event.reason || '').toLowerCase();
  const status = event.status || '';

  // Hard Bounce判定
  if (eventType === 'bounce') {
    const hardBounceReasons = [
      'invalid',
      'not exist',
      'unknown user',
      'mailbox not found',
      'no such user',
      'user unknown',
      'recipient address rejected'
    ];

    if (hardBounceReasons.some(indicator => reason.includes(indicator))) {
      return {
        type: 'hard',
        reason: `hard-bounce: ${reason}`,
        severity: 'high',
        source: 'webhook'
      };
    } else {
      return {
        type: 'soft',
        reason: `soft-bounce: ${reason}`,
        severity: 'medium',
        source: 'webhook'
      };
    }
  }

  // その他の失敗タイプ
  if (eventType === 'blocked') {
    return {
      type: 'blocked',
      reason: `blocked: ${reason}`,
      severity: 'high',
      source: 'webhook'
    };
  }

  if (eventType === 'dropped') {
    return {
      type: 'dropped',
      reason: `dropped: ${reason}`,
      severity: 'high',
      source: 'webhook'
    };
  }

  if (eventType === 'spamreport') {
    return {
      type: 'spam',
      reason: 'spam report',
      severity: 'critical',
      source: 'webhook'
    };
  }

  return {
    type: eventType,
    reason: reason,
    severity: 'medium',
    source: 'webhook'
  };
}

// Webhookバウンス記録
async function recordWebhookBounce(email, bounceInfo, originalEvent) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.log('⚠️ Airtable環境変数未設定');
    return;
  }

  try {
    // 既存レコード確認
    const existingRecord = await findExistingRecord(email);

    if (existingRecord) {
      // 既存レコード更新
      await updateExistingRecord(existingRecord, bounceInfo, originalEvent);
    } else {
      // 新規レコード作成
      await createNewRecord(email, bounceInfo, originalEvent);
    }

  } catch (error) {
    console.error('❌ Webhookバウンス記録エラー:', error.message);
  }
}

// 既存レコード検索
async function findExistingRecord(email) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist?filterByFormula=SEARCH("${email}", {Email})`;

  const response = await fetch(searchUrl, {
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`
    }
  });

  if (response.ok) {
    const data = await response.json();
    return data.records.length > 0 ? data.records[0] : null;
  }

  return null;
}

// 既存レコード更新
async function updateExistingRecord(record, bounceInfo, originalEvent) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const currentBounceCount = record.fields.BounceCount || 0;
  const newBounceCount = currentBounceCount + 1;

  // Hard bounceまたは閾値到達でステータス更新
  let newStatus = record.fields.Status || 'SOFT_BOUNCE';
  if (bounceInfo.type === 'hard' || bounceInfo.severity === 'critical' || newBounceCount >= 5) {
    newStatus = 'HARD_BOUNCE';
  }

  const updateData = {
    fields: {
      BounceCount: newBounceCount,
      BounceType: bounceInfo.type,
      Status: newStatus,
      Notes: `${record.fields.Notes || ''}\nWebhook ${new Date().toISOString()}: ${bounceInfo.reason}`
    }
  };

  const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist/${record.id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updateData)
  });

  if (response.ok) {
    console.log(`✅ 既存レコード更新成功: ${record.fields.Email} - Bounce Count: ${newBounceCount}`);
  } else {
    const error = await response.text();
    console.log(`❌ 既存レコード更新失敗: ${error}`);
  }
}

// 新規レコード作成
async function createNewRecord(email, bounceInfo, originalEvent) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const recordData = {
    fields: {
      Email: email,
      BounceCount: 1,
      BounceType: bounceInfo.type,
      Status: bounceInfo.type === 'hard' || bounceInfo.severity === 'critical' ? 'HARD_BOUNCE' : 'SOFT_BOUNCE',
      AddedAt: new Date().toISOString().split('T')[0],
      Notes: `Webhook bounce: ${bounceInfo.reason} - Event: ${originalEvent.event}`
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
    console.log(`✅ 新規Webhookレコード作成成功: ${result.id}`);
  } else {
    const error = await response.text();
    console.log(`❌ 新規Webhookレコード作成失敗: ${error}`);
  }
}