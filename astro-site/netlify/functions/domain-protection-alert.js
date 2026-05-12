// ドメイン保護アラートシステム
// 高リスク状況の早期検知・管理者通知

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
      case 'check-risk':
        return await checkRiskLevel(request, headers);
      case 'send-alert':
        return await sendAlert(request, headers);
      case 'get-alert-history':
        return await getAlertHistory(request, headers);
      default:
        return new Response(
          JSON.stringify({ error: 'Invalid action parameter' }),
          { status: 400, headers }
        );
    }

  } catch (error) {
    console.error('Domain protection alert error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// リスクレベルチェック
async function checkRiskLevel(request, headers) {
  try {
    // domain-protection.jsから統計を取得
    const baseUrl = request.url.substring(0, request.url.lastIndexOf('/'));
    const statsResponse = await fetch(`${baseUrl}/domain-protection?action=get-stats`);

    if (!statsResponse.ok) {
      throw new Error(`Stats API error: ${statsResponse.status}`);
    }

    const statsData = await statsResponse.json();
    const riskAssessment = statsData.riskAssessment;

    // アラート条件判定
    const alerts = [];

    // 失敗率チェック
    if (riskAssessment.failureRate > 10) {
      alerts.push({
        level: 'critical',
        type: 'high_failure_rate',
        message: `失敗率が危険レベル: ${riskAssessment.failureRate}%`,
        action: '配信を一時停止してリストクリーニングを実施',
        priority: 1
      });
    } else if (riskAssessment.failureRate > 5) {
      alerts.push({
        level: 'warning',
        type: 'elevated_failure_rate',
        message: `失敗率が要注意レベル: ${riskAssessment.failureRate}%`,
        action: '新規配信を制限してリスト見直し',
        priority: 2
      });
    }

    // ハードバウンス数チェック
    if (statsData.stats.hardBounces > 50) {
      alerts.push({
        level: 'warning',
        type: 'many_hard_bounces',
        message: `ハードバウンスが多数: ${statsData.stats.hardBounces}件`,
        action: 'ハードバウンスの原因分析と除去',
        priority: 2
      });
    }

    // 苦情数チェック
    if (statsData.stats.complaints > 10) {
      alerts.push({
        level: 'critical',
        type: 'spam_complaints',
        message: `スパム苦情が多数: ${statsData.stats.complaints}件`,
        action: '配信内容の見直しと改善',
        priority: 1
      });
    }

    // 最近の失敗チェック
    if (statsData.stats.recentFailures > 20) {
      alerts.push({
        level: 'warning',
        type: 'recent_failures',
        message: `24時間以内の失敗が増加: ${statsData.stats.recentFailures}件`,
        action: '送信タイミングと内容の見直し',
        priority: 3
      });
    }

    // アラート優先度でソート
    alerts.sort((a, b) => a.priority - b.priority);

    return new Response(
      JSON.stringify({
        success: true,
        overallRisk: riskAssessment.overallRisk,
        alertCount: alerts.length,
        alerts,
        shouldNotify: alerts.some(alert => alert.level === 'critical'),
        stats: {
          failureRate: riskAssessment.failureRate,
          totalBlocked: statsData.stats.blockedEmails,
          recentFailures: statsData.stats.recentFailures
        },
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Risk check error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// アラート送信
async function sendAlert(request, headers) {
  const { alertType, message, riskLevel, stats } = await request.json();

  if (!alertType || !message) {
    return new Response(
      JSON.stringify({ error: 'alertType and message are required' }),
      { status: 400, headers }
    );
  }

  try {
    // SendGrid経由で管理者にアラートメール送信
    const emailResult = await sendAlertEmail({
      alertType,
      message,
      riskLevel,
      stats
    });

    // アラート履歴をAirtableに保存
    await saveAlertHistory({
      alertType,
      message,
      riskLevel,
      stats,
      emailSent: emailResult.success
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Alert sent successfully',
        emailResult,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Send alert error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// アラート履歴取得
async function getAlertHistory(request, headers) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return new Response(
      JSON.stringify({ error: 'Airtable configuration missing' }),
      { status: 500, headers }
    );
  }

  try {
    // AlertHistoryテーブルから履歴を取得（あれば）
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/AlertHistory?sort[0][field]=Timestamp&sort[0][direction]=desc&maxRecords=50`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let history = [];
    if (response.ok) {
      const data = await response.json();
      history = data.records.map(record => ({
        id: record.id,
        alertType: record.fields.AlertType,
        message: record.fields.Message,
        riskLevel: record.fields.RiskLevel,
        timestamp: record.fields.Timestamp,
        emailSent: record.fields.EmailSent
      }));
    }

    return new Response(
      JSON.stringify({
        success: true,
        history,
        count: history.length
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Get alert history error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers }
    );
  }
}

// アラートメール送信
async function sendAlertEmail({ alertType, message, riskLevel, stats }) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid API key not configured');
  }

  const adminEmail = 'noreply@keiba.link'; // 管理者メールアドレス

  const emailData = {
    personalizations: [
      {
        to: [{ email: adminEmail }],
        subject: `🚨 NANKANアナリティクス - ドメイン保護アラート [${riskLevel.toUpperCase()}]`
      }
    ],
    from: {
      name: "NANKAN Domain Protection",
      email: "noreply@keiba.link"
    },
    content: [
      {
        type: "text/html",
        value: generateAlertEmailHtml({ alertType, message, riskLevel, stats })
      }
    ]
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailData)
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`SendGrid error: ${response.status} ${errorData}`);
  }

  return { success: true, sentTo: adminEmail };
}

// アラートメールHTML生成
function generateAlertEmailHtml({ alertType, message, riskLevel, stats }) {
  const riskColor = riskLevel === 'critical' ? '#dc2626' : '#f59e0b';
  const riskIcon = riskLevel === 'critical' ? '🚨' : '⚠️';

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background-color: ${riskColor}; color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
        <h1 style="margin: 0; font-size: 24px;">${riskIcon} ドメイン保護アラート</h1>
        <p style="margin: 10px 0 0 0; font-size: 16px;">リスクレベル: ${riskLevel.toUpperCase()}</p>
      </div>

      <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="color: #1f2937; margin-top: 0;">アラート詳細</h2>
        <p style="color: #374151; font-size: 16px; line-height: 1.6;">${message}</p>

        <div style="margin-top: 20px;">
          <h3 style="color: #1f2937; margin-bottom: 10px;">現在の統計:</h3>
          <ul style="color: #374151; margin: 0; padding-left: 20px;">
            ${stats ? `
              <li>失敗率: ${stats.failureRate || 'N/A'}%</li>
              <li>ブロック中: ${stats.totalBlocked || 'N/A'}件</li>
              <li>最近24時間の失敗: ${stats.recentFailures || 'N/A'}件</li>
            ` : '<li>統計データなし</li>'}
          </ul>
        </div>
      </div>

      <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; border-left: 4px solid #f59e0b; margin-bottom: 20px;">
        <h3 style="color: #92400e; margin-top: 0;">推奨アクション</h3>
        <p style="color: #78350f; margin: 0; font-size: 14px;">
          ${getRecommendedAction(alertType)}
        </p>
      </div>

      <div style="text-align: center;">
        <a href="https://analytics.keiba.link/admin-newsletter-simple"
           style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
          管理画面で確認 →
        </a>
      </div>

      <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="color: #6b7280; font-size: 12px; margin: 0;">
          ${new Date().toLocaleString('ja-JP')} - NANKANアナリティクス ドメイン保護システム
        </p>
      </div>
    </div>
  `;
}

// 推奨アクション取得
function getRecommendedAction(alertType) {
  const actions = {
    high_failure_rate: '即座に配信を停止し、リストを徹底的にクリーニングしてください。',
    elevated_failure_rate: '新規配信を制限し、リストの見直しを行ってください。',
    many_hard_bounces: 'ハードバウンスの原因を分析し、無効なアドレスを除去してください。',
    spam_complaints: '配信内容とタイミングを見直し、スパム認定を避ける対策を講じてください。',
    recent_failures: '送信タイミングと内容を見直し、一時的な問題がないか確認してください。'
  };

  return actions[alertType] || '管理画面で詳細を確認し、適切な対策を講じてください。';
}

// アラート履歴保存
async function saveAlertHistory({ alertType, message, riskLevel, stats, emailSent }) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.log('⚠️ Airtable環境変数未設定のためアラート履歴保存をスキップ');
    return;
  }

  try {
    // AlertHistoryテーブルに保存（テーブルが存在する場合）
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/AlertHistory`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          AlertType: alertType,
          Message: message,
          RiskLevel: riskLevel,
          Timestamp: new Date().toISOString(),
          EmailSent: emailSent,
          Stats: JSON.stringify(stats)
        }
      })
    });

    console.log('✅ アラート履歴保存完了');

  } catch (error) {
    console.error('アラート履歴保存エラー:', error);
    // エラーでもアラート送信は継続
  }
}