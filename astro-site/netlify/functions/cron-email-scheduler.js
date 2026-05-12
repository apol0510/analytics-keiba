// 自作メールスケジューラー - Cron実行トリガー
// Netlify Scheduled Functionsで定期実行される

export default async function handler(request, context) {
  const headers = {
    'Content-Type': 'application/json'
  };

  console.log('🕐 Cron実行開始:', new Date().toISOString());

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