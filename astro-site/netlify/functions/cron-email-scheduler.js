// 自作メールスケジューラー - Cron実行トリガー
// Netlify Scheduled Functionsで定期実行される

export default async function handler(request, context) {
  const headers = {
    'Content-Type': 'application/json'
  };

  console.log('🕐 Cron実行開始:', new Date().toISOString());

  // 🛡️ 止血ガード（2026-05-14 追加）
  // 過去にテスト時の重複配信が発生したため、Scheduled Function による自動配信は
  // NEWSLETTER_AUTOMATION_ENABLED === 'true' でない限り完全に無効化する。
  // ここで早期 return することで、execute-scheduled-emails / SendGrid に一切到達しない。
  // 本番配信を再開する際は、設計・dry-run・test を整備してから明示的にフラグを立てる。
  if (process.env.NEWSLETTER_AUTOMATION_ENABLED !== 'true') {
    console.log('🛡️ newsletter automation disabled (NEWSLETTER_AUTOMATION_ENABLED !== "true") - cron is a no-op');
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
    // スケジュールされたメールを実行
    const baseUrl = process.env.URL || 'https://analytics.keiba.link';
    const executorUrl = `${baseUrl}/.netlify/functions/execute-scheduled-emails`;

    console.log('📧 スケジューラー実行URL:', executorUrl);

    const response = await fetch(executorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`スケジューラー実行失敗: ${response.status}`);
    }

    const result = await response.json();
    
    console.log('✅ Cron実行結果:', result);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Cron execution completed',
        executorResult: result,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ Cron実行エラー:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }),
      { status: 500, headers }
    );
  }
}

// Netlify Scheduled Functions設定
export const config = {
  schedule: "*/15 * * * *" // 15分毎に実行（送信数削減のため5分→15分に変更 2025-11-09）
};