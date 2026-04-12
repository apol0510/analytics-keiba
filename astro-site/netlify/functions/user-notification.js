// 新規ユーザー通知システム（2025-09-24新規作成）
// ⚠️ 重要：削除されたウェルカムメール機能とは完全に独立したシステム

export default async function handler(request, context) {
  // CORSヘッダー
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // OPTIONS対応
  if (request.method === 'OPTIONS') {
    return new Response('', {
      status: 200,
      headers
    });
  }

  // POSTメソッドのみ許可
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: `Method ${request.method} not allowed` }),
      {
        status: 405,
        headers
      }
    );
  }

  try {
    const requestBody = await request.text();
    const { email, isNewUser } = JSON.parse(requestBody || '{}');

    // 新規ユーザーのみ通知送信
    if (!email || !isNewUser) {
      return new Response(
        JSON.stringify({ message: 'No notification needed' }),
        {
          status: 200,
          headers
        }
      );
    }

    // 環境変数の確認（Netlify Functions用）
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || context.SENDGRID_API_KEY;

    if (!SENDGRID_API_KEY) {
      console.error('🚨 SENDGRID_API_KEY not found in environment');
      console.error('🔍 Available env vars:', Object.keys(process.env).filter(key => key.includes('SENDGRID')));
      // 本番環境では動作するが、開発環境では環境変数の問題があるため一時的にスキップ
      return new Response(
        JSON.stringify({
          success: false,
          message: 'SendGrid API key not available',
          email: email,
          debug: {
            processEnvKeys: Object.keys(process.env).length,
            contextKeys: Object.keys(context || {})
          }
        }),
        {
          status: 500,  // API キーがない場合は500エラーで明確に失敗させる
          headers
        }
      );
    }

    // 🔒 安全なドメイン（ハードコーディング）- 不正ドメイン防止
    const SAFE_DOMAIN = 'https://nankan-analytics.keiba.link';

    console.log('🔗 使用予定ドメイン確認:', SAFE_DOMAIN);
    console.log('🚫 8912/8219ドメインは使用禁止');

    // ドメイン安全性チェック
    if (SAFE_DOMAIN.includes('8912') || SAFE_DOMAIN.includes('8219')) {
      throw new Error('🚨 不正ドメイン検出: SAFE_DOMAINに8912/8219が含まれています');
    }

    // 🎯 SendGrid API直接呼び出し（execute-scheduled-emails.jsと同様）
    const emailData = {
      personalizations: [
        {
          to: [{ email: email }],
          subject: '🎉 NANKANアナリティクス登録完了！'
        }
      ],
      from: {
        name: 'NANKANアナリティクス',
        email: 'nankan-analytics@keiba.link'
      },
      content: [
        {
          type: 'text/html',
          value: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px;">
              <div style="background-color: #1e293b; background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 30px; text-align: center; border-radius: 12px; margin-bottom: 20px;">
                <h1 style="color: #ffffff; margin: 0; font-size: 28px;">🏇 NANKANアナリティクス</h1>
                <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 16px;">南関競馬AI予想プラットフォーム</p>
              </div>

              <div style="background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                <h2 style="color: #1e293b; margin-top: 0;">🎉 登録完了！</h2>
                <p style="color: #475569; line-height: 1.6;">
                  この度はNANKANアナリティクスにご登録いただき、誠にありがとうございます！
                </p>

                <div style="background: #f1f5f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="color: #1e293b; margin-top: 0;">🎁 無料会員特典</h3>
                  <ul style="color: #475569; padding-left: 20px; line-height: 1.8;">
                    <li><strong>全レース（1R〜12R）詳細予想</strong></li>
                    <li>AI分析による予想データ</li>
                  </ul>
                </div>

                <div style="text-align: center; margin: 30px 0;">
                  <a href="${SAFE_DOMAIN}/dashboard"
                     style="display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
                    📊 マイページにログイン
                  </a>
                </div>

                <div style="background-color: #d1fae5; padding: 18px; border-radius: 8px; border-left: 4px solid #059669; margin-bottom: 15px;">
                  <p style="color: #047857; margin: 0; font-size: 14px; line-height: 1.6;">
                    <strong style="color: #065f46;">📧 ログイン方法：</strong> メールアドレス「<strong>${email}</strong>」でログイン
                  </p>
                </div>

                <div style="background-color: #fef08a; padding: 18px; border-radius: 8px; border-left: 4px solid #f59e0b;">
                  <p style="color: #854d0e; margin: 0; font-size: 14px; line-height: 1.6;">
                    <strong style="color: #78350f;">⚠️ 重要：有料プラン会員の方へ</strong><br>
                    予想データが正しく表示されない場合は、<strong>一度ログアウトしていただき、再度ログインしてください</strong>。これにより最新のプラン情報が反映されます。
                  </p>
                </div>
              </div>

              <div style="text-align: center; margin-top: 20px; color: #64748b; font-size: 14px;">
                <p>ご不明な点がございましたら、お気軽にお問い合わせください</p>
                <p style="margin: 5px 0 0 0;">
                  <strong>NANKANアナリティクス</strong><br>
                  📧 support@keiba.link
                </p>
                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e2e8f0;">
                <p style="font-size: 12px; color: #94a3b8; line-height: 1.6;">
                  このメールは自動配信されています<br>
                  配信時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                </p>
              </div>
            </div>
          `
        }
      ]
    };

    // 🚨 重要：SendGridリンク追跡を完全無効化（復活防止対策 2025-09-29）
    // SendGrid V3 API仕様に準拠した正しい形式
    // https://docs.sendgrid.com/api-reference/mail-send/mail-send
    emailData.tracking_settings = {
      click_tracking: {
        enable: false,  // クリック追跡無効化
        enable_text: false  // テキストメールでも無効化
      },
      open_tracking: {
        enable: false,  // 開封追跡無効化
        substitution_tag: null
      },
      subscription_tracking: {
        enable: false  // 購読解除追跡無効化
      },
      ganalytics: {
        enable: false  // Google Analytics追跡無効化
      }
    };

    // 🔒 復活防止：mail_settingsも追加でセキュリティ強化
    emailData.mail_settings = {
      bypass_list_management: {
        enable: false  // リスト管理をバイパスしない
      },
      footer: {
        enable: false  // フッター追加しない
      },
      sandbox_mode: {
        enable: false  // サンドボックスモード無効（本番送信）
      }
    };

    const sendgridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailData)
    });

    if (!sendgridResponse.ok) {
      const errorText = await sendgridResponse.text();
      console.error('🚨 SendGrid API error:', errorText);
      throw new Error(`SendGrid API error: ${sendgridResponse.status}`);
    }

    console.log(`✅ 新規ユーザー通知送信成功: ${email}`);
    console.log(`🔗 使用されたドメイン: ${SAFE_DOMAIN}`);
    console.log(`📧 送信されたリンク: ${SAFE_DOMAIN}/dashboard`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'User notification sent successfully',
        email: email,
        domain_used: SAFE_DOMAIN,
        login_link: `${SAFE_DOMAIN}/dashboard`
      }),
      {
        status: 200,
        headers
      }
    );

  } catch (error) {
    console.error('🚨 User notification error:', error);

    return new Response(
      JSON.stringify({
        error: 'Failed to send user notification',
        details: error.message
      }),
      {
        status: 500,
        headers
      }
    );
  }
};

// ✅ 新規実装の安全性確認（2025-09-29更新）
// 1. 完全に新しいファイル名・関数名
// 2. ハードコーディングされた安全ドメイン使用
// 3. 環境変数SITE_URLに依存しない設計
// 4. 削除されたsendWelcomeEmail機能の再利用なし
// 5. 最小限で確実なHTMLテンプレート
//
// 🚨 復活防止対策（2025-09-29追加）
// - SendGridトラッキング完全無効化実装済み
// - click_tracking.enable_text: false 追加
// - mail_settings セクション追加でセキュリティ強化
// - 8912keibalink.keiba.link トラッキングURL問題解決
//
// ⚠️ 絶対に復活させてはいけない設定:
// - tracking_settings.click_tracking.enable: true
// - tracking_settings配下のenable: true設定
// - SITE_URL環境変数の使用（8912ドメイン混入リスク）