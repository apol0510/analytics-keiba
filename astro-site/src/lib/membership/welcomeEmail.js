// 新規無料会員へのウェルカムメール（登録完了のお知らせ）
//
// 2026-11-20: 公開 Function user-notification から本体を移した。
//   旧構成では auth-user が公開 URL へ { email, isNewUser: true } を POST しており、
//   同じ POST を誰でも送れたため、任意のアドレスへ KEIBA Analytics 名義のメールを送れた。
//   今は auth-user がこの関数を直接呼ぶ（HTTP を通らない）。公開 Function は送信しない。
//   文面・送信元・追跡設定は移動前と同じ。

const SAFE_DOMAIN = 'https://analytics.keiba.link';
const EMAIL_RE = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/;

export function isValidWelcomeEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

export function buildWelcomeEmail({ email, env = process.env, now = new Date() }) {
  const FROM_EMAIL = env.SENDGRID_FROM_EMAIL || 'noreply@keiba.link';
  const FROM_NAME = env.SENDGRID_FROM_NAME || 'KEIBA Analytics';
  const emailData = {
    personalizations: [
      {
        to: [{ email: email }],
        subject: '🎉 KEIBA Analytics 登録完了！'
      }
    ],
    from: {
      name: FROM_NAME,
      email: FROM_EMAIL
    },
    content: [
      {
        type: 'text/html',
        value: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px;">
            <div style="background-color: #1e293b; background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 30px; text-align: center; border-radius: 12px; margin-bottom: 20px;">
              <h1 style="color: #ffffff; margin: 0; font-size: 28px;">🏇 KEIBA Analytics</h1>
              <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 16px;">南関・JRA統合AI予想プラットフォーム</p>
            </div>

            <div style="background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
              <h2 style="color: #1e293b; margin-top: 0;">🎉 登録完了！</h2>
              <p style="color: #475569; line-height: 1.6;">
                この度は KEIBA Analytics にご登録いただき、誠にありがとうございます！
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
                <strong>KEIBA Analytics</strong><br>
                📧 support@keiba.link
              </p>
              <hr style="margin: 20px 0; border: none; border-top: 1px solid #e2e8f0;">
              <p style="font-size: 12px; color: #94a3b8; line-height: 1.6;">
                このメールは自動配信されています<br>
                配信時刻: ${now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
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


  return emailData;
}

/**
 * ウェルカムメールを 1 通送る。例外は投げず、結果だけを返す（呼び出し側の登録処理を壊さない）。
 * ログにメールアドレスを出さない。
 */
export async function sendWelcomeEmail({ email, env = process.env, fetchImpl = fetch, now = new Date() }) {
  if (!isValidWelcomeEmail(email)) return { sent: false, reason: 'invalid_email' };
  const apiKey = env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.error('🚨 [welcome-email] SENDGRID_API_KEY not set');
    return { sent: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWelcomeEmail({ email, env, now })),
    });
    if (!res.ok) {
      console.error(`🚨 [welcome-email] SendGrid status=${res.status}`);
      return { sent: false, reason: 'sendgrid_error', status: res.status };
    }
    console.log('✅ [welcome-email] sent');
    return { sent: true };
  } catch (e) {
    console.error('🚨 [welcome-email] send failed:', e?.name || 'Error');
    return { sent: false, reason: 'exception' };
  }
}
