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
    // 2026-05-22: 実行エンジンを Background Function 化（execute-scheduled-emails-background）。
    // Background Function は 202 Accepted を即返しし body を返さない（非同期で最大15分実行）。
    // そのため response.json() は行わず、起動の成否のみ status で判定する。
    const baseUrl = process.env.URL || 'https://analytics.keiba.link';
    const executorUrl = `${baseUrl}/.netlify/functions/execute-scheduled-emails-background`;

    console.log('📧 スケジューラー起動URL(background):', executorUrl);

    const response = await fetch(executorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Background Function は 202 即返し。2xx 以外のみ失敗扱い。
    if (!response.ok && response.status !== 202) {
      throw new Error(`スケジューラー起動失敗: ${response.status}`);
    }

    console.log(`✅ Cron: background executor 起動 (status=${response.status})`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Background executor triggered',
        executorStatus: response.status,
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