// ドメイン保護システム - 配信失敗追跡・自動停止
// 5回失敗したら自動的に配信を停止してドメイン評価を保護

export default async function handler(request, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    switch (action) {
      case 'check-email':
        return await checkEmailStatus(request, headers);
      case 'report-failure':
        return await reportFailure(request, headers);
      case 'get-stats':
        return await getDomainStats(request, headers);
      case 'get-blacklist':
        return await getBlacklistStatus(request, headers);
      case 'whitelist-email':
        return await whitelistEmail(request, headers);
      default:
        return new Response(
          JSON.stringify({ error: 'Invalid action parameter' }),
          { status: 400, headers }
        );
    }

  } catch (error) {
    console.error('Domain protection error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// メールアドレスの配信可否をチェック
async function checkEmailStatus(request, headers) {
  const { emails } = await request.json();

  if (!Array.isArray(emails)) {
    return new Response(
      JSON.stringify({ error: 'emails must be an array' }),
      { status: 400, headers }
    );
  }

  const results = [];

  for (const email of emails) {
    const status = await getEmailDeliverabilityStatus(email);
    results.push({
      email,
      canDeliver: status.canDeliver,
      reason: status.reason,
      failureCount: status.failureCount,
      riskLevel: status.riskLevel,
      lastFailure: status.lastFailure
    });
  }

  return new Response(
    JSON.stringify({
      success: true,
      results,
      summary: {
        total: emails.length,
        deliverable: results.filter(r => r.canDeliver).length,
        blocked: results.filter(r => !r.canDeliver).length
      }
    }),
    { status: 200, headers }
  );
}

// 配信失敗を報告・記録
async function reportFailure(request, headers) {
  const { email, errorType, errorMessage, statusCode } = await request.json();

  if (!email) {
    return new Response(
      JSON.stringify({ error: 'email is required' }),
      { status: 400, headers }
    );
  }

  // バウンス種別を自動判定
  const bounceInfo = analyzeBounceType(errorType, errorMessage, statusCode);

  // 失敗記録を更新
  const updateResult = await updateFailureRecord(email, bounceInfo);

  // ドメイン統計を更新
  await updateDomainStatistics(email, bounceInfo);

  return new Response(
    JSON.stringify({
      success: true,
      email,
      bounceType: bounceInfo.type,
      newFailureCount: updateResult.newFailureCount,
      isBlocked: updateResult.isBlocked,
      riskLevel: updateResult.riskLevel,
      message: updateResult.message
    }),
    { status: 200, headers }
  );
}

// ドメイン統計取得
async function getDomainStats(request, headers) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return new Response(
      JSON.stringify({ error: 'Airtable configuration missing' }),
      { status: 500, headers }
    );
  }

  try {
    // EmailBlacklistテーブルから統計を取得
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status}`);
    }

    const data = await response.json();

    // 統計計算
    const stats = {
      total: data.records.length,
      hardBounces: 0,
      softBounces: 0,
      complaints: 0,
      recentFailures: 0, // 24時間以内
      blockedEmails: 0,
      riskLevels: { low: 0, medium: 0, high: 0, critical: 0 },
      domainBreakdown: {}
    };

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    data.records.forEach(record => {
      const fields = record.fields;
      const bounceType = fields.BounceType || 'unknown';
      const status = fields.Status || 'UNKNOWN';
      const bounceCount = fields.BounceCount || 0;
      const lastBounce = fields.LastBounceDate;
      const email = fields.Email || '';

      // 種別カウント
      if (bounceType === 'hard' || status === 'HARD_BOUNCE') {
        stats.hardBounces++;
        stats.blockedEmails++;
      } else if (bounceType === 'soft') {
        stats.softBounces++;
        if (bounceCount >= 5) stats.blockedEmails++;
      } else if (status === 'COMPLAINT') {
        stats.complaints++;
        stats.blockedEmails++;
      }

      // 最近の失敗
      if (lastBounce && new Date(lastBounce) > oneDayAgo) {
        stats.recentFailures++;
      }

      // リスクレベル判定
      let riskLevel = 'low';
      if (bounceCount >= 5 || status === 'HARD_BOUNCE' || status === 'COMPLAINT') {
        riskLevel = 'critical';
      } else if (bounceCount >= 3) {
        riskLevel = 'high';
      } else if (bounceCount >= 1) {
        riskLevel = 'medium';
      }
      stats.riskLevels[riskLevel]++;

      // ドメイン別統計
      if (email.includes('@')) {
        const domain = email.split('@')[1].toLowerCase();
        if (!stats.domainBreakdown[domain]) {
          stats.domainBreakdown[domain] = { total: 0, failed: 0, blocked: 0 };
        }
        stats.domainBreakdown[domain].total++;
        stats.domainBreakdown[domain].failed++;
        if (riskLevel === 'critical') {
          stats.domainBreakdown[domain].blocked++;
        }
      }
    });

    // リスク評価
    const totalCustomers = await getTotalCustomerCount();
    const failureRate = totalCustomers > 0 ? (stats.total / totalCustomers) * 100 : 0;

    let overallRisk = 'low';
    if (failureRate > 10) overallRisk = 'critical';
    else if (failureRate > 5) overallRisk = 'high';
    else if (failureRate > 2) overallRisk = 'medium';

    return new Response(
      JSON.stringify({
        success: true,
        stats,
        riskAssessment: {
          overallRisk,
          failureRate: Math.round(failureRate * 100) / 100,
          recommendations: generateRecommendations(stats, failureRate)
        },
        lastUpdated: new Date().toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Domain stats error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// ブラックリスト状況取得
async function getBlacklistStatus(request, headers) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  try {
    // 🔧 2025-11-12修正: LastBounceDateフィールドは存在しないためソート条件を削除
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status}`);
    }

    const data = await response.json();

    const blacklist = data.records.map(record => ({
      id: record.id,
      email: record.fields.Email,
      bounceCount: record.fields.BounceCount || 0,
      bounceType: record.fields.BounceType || 'unknown',
      status: record.fields.Status || 'UNKNOWN',
      lastBounce: record.fields.AddedAt, // 🔧 2025-11-12修正: LastBounceDateの代わりにAddedAtを使用
      notes: record.fields.Notes,
      canWhitelist: record.fields.BounceType === 'soft' && (record.fields.BounceCount || 0) < 5
    }));

    return new Response(
      JSON.stringify({
        success: true,
        blacklist,
        summary: {
          total: blacklist.length,
          hardBounces: blacklist.filter(item => item.status === 'HARD_BOUNCE').length,
          softBounces: blacklist.filter(item => item.bounceType === 'soft').length,
          complaints: blacklist.filter(item => item.status === 'COMPLAINT').length,
          whitelistable: blacklist.filter(item => item.canWhitelist).length
        }
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Blacklist status error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// メールアドレスをホワイトリストに登録
async function whitelistEmail(request, headers) {
  const { email, reason } = await request.json();

  if (!email) {
    return new Response(
      JSON.stringify({ error: 'email is required' }),
      { status: 400, headers }
    );
  }

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  try {
    // 既存記録を検索
    const searchResponse = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist?filterByFormula=SEARCH('${email}',{Email})`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!searchResponse.ok) {
      throw new Error(`Search failed: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();

    if (searchData.records.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Email not found in blacklist' }),
        { status: 404, headers }
      );
    }

    const record = searchData.records[0];

    // Hard Bounceや苦情は手動復旧のみ許可
    if (record.fields.Status === 'HARD_BOUNCE' || record.fields.Status === 'COMPLAINT') {
      return new Response(
        JSON.stringify({
          error: 'Cannot whitelist hard bounces or complaints automatically',
          requiresManualReview: true
        }),
        { status: 400, headers }
      );
    }

    // レコードを削除（ホワイトリスト化）
    const deleteResponse = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist/${record.id}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!deleteResponse.ok) {
      throw new Error(`Delete failed: ${deleteResponse.status}`);
    }

    // ホワイトリスト履歴記録（オプション）
    await recordWhitelistAction(email, reason);

    return new Response(
      JSON.stringify({
        success: true,
        email,
        message: 'Email successfully whitelisted',
        previousStatus: record.fields.Status,
        previousBounceCount: record.fields.BounceCount || 0
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Whitelist error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// === ユーティリティ関数 ===

// メールアドレスの配信可否判定
async function getEmailDeliverabilityStatus(email) {
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
      // API失敗時は安全のため配信許可
      return { canDeliver: true, reason: 'api-error', failureCount: 0, riskLevel: 'unknown' };
    }

    const data = await response.json();

    if (data.records.length === 0) {
      return { canDeliver: true, reason: 'clean', failureCount: 0, riskLevel: 'low' };
    }

    const record = data.records[0].fields;
    const bounceCount = record.BounceCount || 0;
    const bounceType = record.BounceType || 'unknown';
    const status = record.Status || 'UNKNOWN';

    // 配信不可条件
    if (status === 'HARD_BOUNCE' || status === 'COMPLAINT') {
      return {
        canDeliver: false,
        reason: status === 'HARD_BOUNCE' ? 'hard-bounce' : 'complaint',
        failureCount: bounceCount,
        riskLevel: 'critical',
        lastFailure: record.LastBounceDate
      };
    }

    // Soft Bounce 5回以上
    if (bounceType === 'soft' && bounceCount >= 5) {
      return {
        canDeliver: false,
        reason: 'soft-bounce-limit',
        failureCount: bounceCount,
        riskLevel: 'critical',
        lastFailure: record.LastBounceDate
      };
    }

    // 警告レベル（3-4回）
    if (bounceType === 'soft' && bounceCount >= 3) {
      return {
        canDeliver: true,
        reason: 'soft-bounce-warning',
        failureCount: bounceCount,
        riskLevel: 'high',
        lastFailure: record.LastBounceDate
      };
    }

    // 軽度の問題（1-2回）
    return {
      canDeliver: true,
      reason: 'minor-issues',
      failureCount: bounceCount,
      riskLevel: 'medium',
      lastFailure: record.LastBounceDate
    };

  } catch (error) {
    console.error(`Deliverability check error for ${email}:`, error);
    return { canDeliver: true, reason: 'check-error', failureCount: 0, riskLevel: 'unknown' };
  }
}

// バウンス種別の自動判定
function analyzeBounceType(errorType, errorMessage, statusCode) {
  const message = (errorMessage || '').toLowerCase();

  // Hard Bounce判定
  const hardBounceKeywords = [
    'invalid', 'not exist', 'unknown user', 'mailbox not found',
    'no such user', 'user unknown', 'recipient address rejected'
  ];

  // Soft Bounce判定
  const softBounceKeywords = [
    'mailbox full', 'quota', 'temporary failure', 'deferred',
    'try again later', 'service unavailable'
  ];

  if (statusCode === 400 || hardBounceKeywords.some(keyword => message.includes(keyword))) {
    return { type: 'hard', reason: 'invalid-address' };
  }

  if (statusCode === 421 || statusCode === 450 || softBounceKeywords.some(keyword => message.includes(keyword))) {
    return { type: 'soft', reason: 'temporary-failure' };
  }

  // デフォルトはソフトバウンスとして扱う（安全側）
  return { type: 'soft', reason: 'unknown-error' };
}

// 失敗記録の更新
async function updateFailureRecord(email, bounceInfo) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    throw new Error('Airtable configuration missing');
  }

  try {
    // 既存記録チェック
    const searchResponse = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist?filterByFormula=SEARCH('${email}',{Email})`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!searchResponse.ok) {
      throw new Error(`Search failed: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();
    const now = new Date().toISOString();

    if (searchData.records.length > 0) {
      // 既存記録更新
      const record = searchData.records[0];
      const currentCount = record.fields.BounceCount || 0;
      const newCount = currentCount + 1;

      // 5回に達したらハードバウンスに昇格
      const finalType = bounceInfo.type === 'soft' && newCount >= 5 ? 'hard' : bounceInfo.type;
      const finalStatus = finalType === 'hard' ? 'HARD_BOUNCE' : 'SOFT_BOUNCE';

      const updateResponse = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist/${record.id}`,
        {
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
              LastBounceDate: now,
              Notes: `${bounceInfo.reason} (${currentCount}→${newCount}) ${newCount >= 5 && bounceInfo.type === 'soft' ? '[自動昇格]' : ''}`
            }
          })
        }
      );

      if (!updateResponse.ok) {
        throw new Error(`Update failed: ${updateResponse.status}`);
      }

      return {
        newFailureCount: newCount,
        isBlocked: newCount >= 5 || finalType === 'hard',
        riskLevel: newCount >= 5 ? 'critical' : newCount >= 3 ? 'high' : 'medium',
        message: newCount >= 5 ? 'Email blocked due to repeated failures' : `Failure recorded (${newCount}/5)`
      };

    } else {
      // 新規記録作成
      const createResponse = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`,
        {
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
              LastBounceDate: now,
              AddedAt: now,
              Source: 'Domain Protection System',
              Notes: `初回失敗: ${bounceInfo.reason}`
            }
          })
        }
      );

      if (!createResponse.ok) {
        throw new Error(`Create failed: ${createResponse.status}`);
      }

      return {
        newFailureCount: 1,
        isBlocked: bounceInfo.type === 'hard',
        riskLevel: bounceInfo.type === 'hard' ? 'critical' : 'medium',
        message: 'First failure recorded'
      };
    }

  } catch (error) {
    console.error(`Update failure record error for ${email}:`, error);
    throw error;
  }
}

// ドメイン統計の更新
async function updateDomainStatistics(email, bounceInfo) {
  // 将来的な機能: ドメイン別統計テーブルの更新
  // 現在はEmailBlacklistテーブルのみ使用
  console.log(`Domain statistics updated for ${email}: ${bounceInfo.type} bounce`);
}

// 総顧客数取得
async function getTotalCustomerCount() {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  try {
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return 0;
    }

    const data = await response.json();
    return data.records.length;

  } catch (error) {
    console.error('Total customer count error:', error);
    return 0;
  }
}

// 推奨事項生成
function generateRecommendations(stats, failureRate) {
  const recommendations = [];

  if (failureRate > 10) {
    recommendations.push({
      level: 'critical',
      action: '配信を一時停止してリストを徹底的にクリーニング',
      reason: `失敗率${failureRate}%は危険レベル`
    });
  } else if (failureRate > 5) {
    recommendations.push({
      level: 'high',
      action: '新規配信を制限してリストを見直し',
      reason: `失敗率${failureRate}%は要注意レベル`
    });
  }

  if (stats.hardBounces > 50) {
    recommendations.push({
      level: 'medium',
      action: 'ハードバウンス(${stats.hardBounces}件)の原因分析と除去',
      reason: 'ドメイン評価悪化の主要因'
    });
  }

  if (stats.complaints > 10) {
    recommendations.push({
      level: 'high',
      action: 'スパム苦情(${stats.complaints}件)の調査と配信内容見直し',
      reason: 'スパム認定リスク'
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      level: 'good',
      action: '現在の配信品質を維持',
      reason: 'ドメイン評価は良好'
    });
  }

  return recommendations;
}

// ホワイトリスト履歴記録
async function recordWhitelistAction(email, reason) {
  // 将来的な機能: ホワイトリスト履歴テーブルの作成・記録
  console.log(`Whitelist action recorded: ${email} - ${reason}`);
}