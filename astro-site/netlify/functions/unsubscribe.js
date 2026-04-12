// メール配信停止処理Function
// お客様がメルマガ配信を停止する機能

export default async function handler(request, context) {
  // CORSヘッダー
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  // OPTIONS対応
  if (request.method === 'OPTIONS') {
    return new Response('', {
      status: 200,
      headers
    });
  }

  try {
    const url = new URL(request.url);
    const email = url.searchParams.get('email');

    // GETリクエスト: 配信停止確認画面
    if (request.method === 'GET') {
      if (!email) {
        return new Response(
          JSON.stringify({ error: 'Email parameter is required' }),
          { status: 400, headers }
        );
      }

      // 簡単な確認ページHTMLを返す
      const confirmationHTML = `
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>配信停止 - NANKANアナリティクス</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f8fafc;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 12px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .header {
              background-color: #1e293b;
              background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
              color: white;
              padding: 20px;
              text-align: center;
              border-radius: 8px;
              margin-bottom: 20px;
            }
            button {
              background-color: #dc2626;
              background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 16px;
              margin: 10px;
            }
            .cancel-btn {
              background-color: #6b7280;
              background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🏇 NANKANアナリティクス</h1>
              <p>メール配信停止</p>
            </div>

            <h2>配信停止の確認</h2>
            <p><strong>${email}</strong> 宛のメール配信を停止しますか？</p>

            <p style="color: #dc2626;">
              ⚠️ 配信を停止すると、以下のメールが届かなくなります：
            </p>
            <ul style="color: #4b5563;">
              <li>メルマガ（予想結果・攻略情報）</li>
              <li>重要なお知らせ</li>
              <li>キャンペーン情報</li>
            </ul>

            <div style="text-align: center; margin-top: 30px;">
              <button onclick="unsubscribe()" id="unsubscribe-btn">
                🚫 配信停止する
              </button>
              <button class="cancel-btn" onclick="window.close()">
                ← キャンセル
              </button>
            </div>

            <div id="result" style="margin-top: 20px; text-align: center;"></div>
          </div>

          <script>
            async function unsubscribe() {
              const btn = document.getElementById('unsubscribe-btn');
              const result = document.getElementById('result');

              btn.disabled = true;
              btn.textContent = '処理中...';

              try {
                const response = await fetch('/api/unsubscribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email: '${email}' })
                });

                const data = await response.json();

                if (data.success) {
                  result.innerHTML = '<div style="color: #10b981; font-weight: bold;">✅ 配信停止が完了しました</div>';
                  btn.style.display = 'none';
                } else {
                  result.innerHTML = '<div style="color: #dc2626;">❌ エラーが発生しました: ' + data.error + '</div>';
                }
              } catch (error) {
                result.innerHTML = '<div style="color: #dc2626;">❌ エラーが発生しました</div>';
              } finally {
                btn.disabled = false;
                btn.textContent = '🚫 配信停止する';
              }
            }
          </script>
        </body>
        </html>
      `;

      return new Response(confirmationHTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      });
    }

    // POSTリクエスト: 実際の配信停止処理
    if (request.method === 'POST') {
      const requestBody = await request.text();
      const { email } = JSON.parse(requestBody);

      if (!email) {
        return new Response(
          JSON.stringify({ error: 'Email is required' }),
          { status: 400, headers }
        );
      }

      // Airtableで配信停止フィールドを更新
      const success = await updateUnsubscribeStatus(email);

      if (success) {
        console.log(`✅ 配信停止処理完了: ${email}`);
        return new Response(
          JSON.stringify({
            success: true,
            message: '配信停止が完了しました',
            email: email
          }),
          { status: 200, headers }
        );
      } else {
        return new Response(
          JSON.stringify({
            success: false,
            error: '配信停止処理に失敗しました'
          }),
          { status: 500, headers }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers }
    );

  } catch (error) {
    console.error('🚨 配信停止処理エラー:', error);
    return new Response(
      JSON.stringify({
        error: '配信停止処理中にエラーが発生しました',
        details: error.message
      }),
      { status: 500, headers }
    );
  }
}

// Airtableで配信停止ステータスを更新
async function updateUnsubscribeStatus(email) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.error('Airtable設定が見つかりません');
    return false;
  }

  try {
    // まずユーザーを検索
    const searchResponse = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers?filterByFormula=${encodeURIComponent(`{Email} = '${email}'`)}`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!searchResponse.ok) {
      throw new Error(`Airtable検索エラー: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();

    if (searchData.records.length === 0) {
      console.log(`⚠️ ユーザーが見つかりません: ${email}`);
      return false;
    }

    const userId = searchData.records[0].id;

    // 配信停止フィールドを更新
    const updateResponse = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers/${userId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'メール配信': 'OFF',  // 配信停止フィールド
            '配信停止日': new Date().toISOString().split('T')[0]
          }
        })
      }
    );

    if (!updateResponse.ok) {
      throw new Error(`Airtable更新エラー: ${updateResponse.status}`);
    }

    return true;

  } catch (error) {
    console.error('配信停止ステータス更新エラー:', error);
    return false;
  }
}