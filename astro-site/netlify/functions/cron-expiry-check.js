// 期限切れチェックcron（毎日午前9時UTC = 日本時間18時実行）
// Netlify Scheduled Functions

export default async function handler(request, context) {
  const headers = {
    'Content-Type': 'application/json'
  };

  console.log('⏰ 期限切れチェックcron開始:', new Date().toISOString());

  try {
    const baseUrl = process.env.URL || 'https://nankan-analytics.netlify.app';
    const results = {};

    // ========================================
    // 1. 1週間前通知を実行
    // ========================================
    const warningUrl = `${baseUrl}/.netlify/functions/expiry-warning-notification`;
    console.log('⚠️ 1週間前通知URL:', warningUrl);

    try {
      const warningResponse = await fetch(warningUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (warningResponse.ok) {
        results.warningNotification = await warningResponse.json();
        console.log('✅ 1週間前通知完了:', results.warningNotification);
      } else {
        console.error('❌ 1週間前通知失敗:', warningResponse.status);
        results.warningNotification = { error: `Failed: ${warningResponse.status}` };
      }
    } catch (warningError) {
      console.error('❌ 1週間前通知エラー:', warningError);
      results.warningNotification = { error: warningError.message };
    }

    // ========================================
    // 2. 期限切れ通知を実行
    // ========================================
    const expiryUrl = `${baseUrl}/.netlify/functions/expiry-notification`;
    console.log('📧 期限切れ通知URL:', expiryUrl);

    try {
      const expiryResponse = await fetch(expiryUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (expiryResponse.ok) {
        results.expiryNotification = await expiryResponse.json();
        console.log('✅ 期限切れ通知完了:', results.expiryNotification);
      } else {
        console.error('❌ 期限切れ通知失敗:', expiryResponse.status);
        results.expiryNotification = { error: `Failed: ${expiryResponse.status}` };
      }
    } catch (expiryError) {
      console.error('❌ 期限切れ通知エラー:', expiryError);
      results.expiryNotification = { error: expiryError.message };
    }

    console.log('✅ 期限チェック完了:', results);

    return new Response(
      JSON.stringify({
        success: true,
        message: '期限チェック完了（1週間前 + 期限切れ）',
        results: results,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ 期限切れチェックエラー:', error);

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
  schedule: "0 9 * * *" // 毎日午前9時UTC（日本時間18時）
};
