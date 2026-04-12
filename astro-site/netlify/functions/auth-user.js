// ユーザー認証関数（メールアドレスでシンプル認証）
const Airtable = require('airtable');

// 🚨 一時的にログイン試行回数制限を無効化（Netlifyデプロイ問題対応）
// const {
//   checkBlacklist,
//   checkLoginAttempt,
//   resetLoginAttempts,
//   recordLoginFailure
// } = require('./login-rate-limiter');

exports.handler = async (event, context) => {
  // IPアドレス抽出
  const ipAddress = event.headers['x-forwarded-for']?.split(',')[0].trim() ||
                    event.headers['x-real-ip'] ||
                    event.requestContext?.identity?.sourceIp ||
                    'unknown';
  const request = {
    method: event.httpMethod,
    json: () => JSON.parse(event.body || '{}')
  };
  // CORSヘッダー
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // OPTIONS対応
  if (request.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // POSTメソッドのみ許可
  if (request.method !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    console.log('🔍 Event received:', JSON.stringify(event, null, 2));
  console.log('🔍 Force rebuild - current SITE_URL:', process.env.SITE_URL);
    console.log('🔍 Event body:', event.body);
    console.log('🔍 Event httpMethod:', event.httpMethod);
    
    // リクエストボディ取得
    const { email, allowRegistration } = JSON.parse(event.body || '{}');
    console.log('🔍 Parsed email:', email);
    console.log('🔍 IP Address:', ipAddress);
    console.log('🔍 Allow Registration:', allowRegistration);

    if (!email) {
      return {
        statusCode: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Email is required' })
      };
    }

    // 🚨 一時的にログイン試行回数制限を無効化（Netlifyデプロイ問題対応）
    // // 🔒 ブラックリストチェック（IPアドレスベース）
    // const isBlacklisted = await checkBlacklist(ipAddress);
    // if (isBlacklisted) {
    //   console.log(`🚨 ブラックリスト登録済みIP: ${ipAddress}`);
    //   return {
    //     statusCode: 403,
    //     headers: { ...headers, 'Content-Type': 'application/json' },
    //     body: JSON.stringify({
    //       error: '複数回のログイン失敗により、このIPアドレスはブロックされています。',
    //       message: 'お問い合わせください: nankan.analytics@gmail.com'
    //     })
    //   };
    // }

    // // 🔒 ログイン試行回数チェック（認証前）
    // const attemptCheck = checkLoginAttempt(ipAddress);
    // if (!attemptCheck.allowed) {
    //   console.log(`🚨 ログイン試行制限: ${ipAddress} - 残り${attemptCheck.remainingMinutes}分`);
    //   return {
    //     statusCode: 429,
    //     headers: { ...headers, 'Content-Type': 'application/json' },
    //     body: JSON.stringify({
    //       error: 'ログイン試行回数が上限に達しました。',
    //       message: `15分後に再度お試しください。（残り${attemptCheck.remainingMinutes}分）`,
    //       remainingMinutes: attemptCheck.remainingMinutes
    //     })
    //   };
    // }

    // Airtable設定
    console.log('🔍 Environment check - AIRTABLE_API_KEY exists:', !!process.env.AIRTABLE_API_KEY);
    console.log('🔍 Environment check - AIRTABLE_BASE_ID exists:', !!process.env.AIRTABLE_BASE_ID);

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    // ユーザー検索（WithdrawalRequestedフィールドも取得）
    // 🚨 重要: Sourceフィールドでフィルタリング（nankan-analytics登録者のみ）
    const records = await base('Customers')
      .select({
        filterByFormula: `AND({Email} = '${email}', OR({Source} = 'nankan-analytics', {Source} = BLANK()))`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length === 0) {
      // 🚨 2026-03-02修正: 新規ユーザーの自動登録を条件付きで許可
      // allowRegistration=true の場合のみ新規登録可能（/free-signup/ からのみ）
      // allowRegistration=false または未指定の場合はエラー（/dashboard/ からの自動登録を防止）

      if (!allowRegistration) {
        console.log(`❌ ログイン失敗: ユーザーが見つかりません（登録不可） - ${email}`);
        return {
          statusCode: 401,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: 'このメールアドレスは登録されていません。',
            message: '新規登録は /free-signup/ ページから行ってください。',
            redirectTo: '/free-signup/'
          })
        };
      }

      // allowRegistration=true の場合、新規ユーザーとして登録
      console.log(`✅ 新規ユーザー登録許可: ${email}`);

      const newRecord = await base('Customers').create({
        'Email': email,
        'プラン': 'Free',
        'ポイント': 1,
        '最終ポイント付与日': new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).toISOString().split('T')[0],
        'Source': 'nankan-analytics'
      });

      // BlastMail読者登録（無料会員）
      try {
        await registerToBlastMail(email, 'nankan-analytics');
      } catch (blastMailError) {
        console.error('⚠️ BlastMail登録エラー（処理は継続）:', blastMailError.message);
      }

      // 新規ユーザー通知
      try {
        const notificationResponse = await fetch(`${context.NETLIFY_DEV ? 'http://localhost:8888' : 'https://nankan-analytics.netlify.app'}/.netlify/functions/user-notification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email,
            isNewUser: true
          })
        });

        if (notificationResponse.ok) {
          console.log('✅ 新規ユーザー通知送信成功');
        } else {
          console.error('⚠️ 新規ユーザー通知送信失敗（処理は継続）:', notificationResponse.status);
        }
      } catch (notificationError) {
        console.error('⚠️ 新規ユーザー通知エラー（処理は継続）:', notificationError.message);
      }

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          isNewUser: true,
          user: {
            email,
            plan: 'free',
            points: 1,
            pointsAdded: 1,
            lastLogin: new Date().toISOString().split('T')[0]
          },
          message: '新規ユーザー登録完了！初回ログインポイント1pt付与'
        }, null, 2)
      };
    }

    // 既存ユーザーの情報取得
    const user = records[0];
    const currentPoints = user.get('ポイント') || 0;
    let currentPlan = user.get('プラン') || 'free';
    const lastLogin = user.get('最終ポイント付与日');
    // 日本時間（JST）で日付を取得
    const jstDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const today = jstDate.toISOString().split('T')[0];

    // 🔍 強制ログアウトチェック（2026-02-28追加）
    const forceLogout = user.get('ForceLogout') === true || user.get('ForceLogout') === 1;
    if (forceLogout) {
      console.log(`🚨 強制ログアウトフラグ検出: ${email}`);

      // フラグをリセット
      await base('Customers').update(user.id, {
        'ForceLogout': false
      });

      return {
        statusCode: 401,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          forceLogout: true,
          message: 'セッションが無効化されました。再度ログインしてください。'
        })
      };
    }

    // 🔍 退会申請チェック（2025-11-26追加）
    // 🔧 2025-11-27修正: let に変更（自動リセット時に再代入が必要）
    let withdrawalRequested = user.get('WithdrawalRequested') === 1 || user.get('WithdrawalRequested') === true;

    // 🔍 有効期限チェック（PremiumまたはStandardで期限切れならFreeに自動降格）
    let isExpired = false;
    let wasDowngraded = false;

    // 有効期限フィールド取得（日本語フィールド「有効期限」優先、互換性のためValidUntil/ExpiryDateも確認）
    const validUntil = user.get('有効期限') || user.get('ValidUntil') || user.get('ExpiryDate');

    if (validUntil) {
      const expiry = new Date(validUntil);
      const now = new Date();

      if (expiry < now) {
        isExpired = true;
        console.log(`⚠️ ユーザー ${email} は期限切れです（${validUntil}）`);
        // 🔧 2025-11-10修正: Free自動降格を削除
        // 理由: 退会者メルマガ配信のため、プラン名を維持する必要がある
        // 有効期限切れでもプランは変更せず、クライアントサイドで制御
      }
    }

    // 🔧 プラン値正規化: 大文字小文字混在問題解決
    const normalizedPlan = normalizePlan(currentPlan);

    // 🚨 2026-03-02削除: 退会フラグ自動リセットロジックを削除
    // 削除理由: 退会後のログインで有効期限が30日延長されるバグが発生
    // 正しい対処: プラン購入時にWebhook側で退会フラグをリセット（Stripe/PayPal Webhook）
    //
    // バグシナリオ:
    // 1. Premium購入（有効期限: 2026-04-01）
    // 2. 退会申請（WithdrawalRequested=true, 有効期限: 2026-04-01のまま）
    // 3. 退会後ログイン → 有効期限が自動的に30日延長される（2026-04-01 → 2026-05-01）
    //
    // if (withdrawalRequested && !isExpired && (normalizedPlan !== 'Free' && normalizedPlan !== 'free')) {
    //   // 削除されたロジック: 有効期限を30日延長していた
    // }

    if (withdrawalRequested) {
      console.log(`🚫 ユーザー ${email} は退会申請済みです`);
    }

    // ログインポイント付与チェック + プラン変更ボーナス（期限切れでない場合のみ）
    let pointsAdded = 0;
    let newPoints = currentPoints;
    let updateData = {};

    const POINTS_BY_PLAN = {
      'free': 1,
      'Free': 1,
      'standard': 10,
      'Standard': 10,
      'premium': 30,
      'Premium': 30,
      'Premium Combo': 30,
      'premium combo': 30,
      'Premium Sanrenpuku': 30,
      'premium sanrenpuku': 30,
      'Premium Plus': 30,
      'premium plus': 30
    };

    // 🚨 2025-11-26修正: 退会申請済み or 有効期限切れの場合はポイント付与なし
    // 通常のログインポイント（1日1回）
    if (lastLogin !== today) {
      if (withdrawalRequested || isExpired) {
        // 退会申請済み or 有効期限切れ → ポイント付与なし
        console.log(`🚫 ポイント付与停止: withdrawalRequested=${withdrawalRequested}, isExpired=${isExpired}`);
        pointsAdded = 0;
      } else {
        // 通常ユーザー → プラン別ポイント付与
        pointsAdded += POINTS_BY_PLAN[currentPlan] || 1;
      }
      updateData['最終ポイント付与日'] = today;
    }

    // プラン変更ボーナス（現在は無効化 - Airtableフィールド不足のため）
    // TODO: 最終プランチェック日フィールドをAirtableに追加後に有効化
    console.log('📝 プラン変更ボーナス機能は一時無効化中（Airtableフィールド準備中）');

    if (pointsAdded > 0) {
      newPoints = currentPoints + pointsAdded;
      updateData['ポイント'] = newPoints;

      // Airtable更新
      await base('Customers').update(user.id, updateData);
    }

    // 🚨 一時的に無効化
    // // ✅ ログイン成功 → ログイン試行カウンターリセット
    // resetLoginAttempts(ipAddress);

    // 通常ユーザーのレスポンス
    let message = '';
    if (withdrawalRequested) {
      message = '退会申請済みです。新規ポイント付与・プレミアム機能のご利用はできません。';
    } else if (isExpired) {
      message = '有効期限が切れています。無料会員としてご利用いただけます。';
    } else if (pointsAdded > 0) {
      message = `ログイン成功！本日のポイント${pointsAdded}pt付与`;
    } else {
      message = 'ログイン成功！';
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        isNewUser: false,
        isExpired: isExpired,  // 🔧 有効期限切れフラグを正確に返す
        isWithdrawalRequested: withdrawalRequested,  // 🔧 2025-11-26追加: 退会申請フラグ
        user: {
          email,
          plan: normalizedPlan,  // プランはそのまま（Premiumなど）
          points: newPoints,
          pointsAdded,
          lastLogin: today,
          validUntil: validUntil || null,  // 🔧 有効期限をレスポンスに含める
          registeredAt: user.get('登録日')
        },
        message: message
      }, null, 2)
    };

  } catch (error) {
    console.error('🚨 Auth error:', error);
    console.error('🚨 Error stack:', error.stack);
    console.error('🚨 Event details:', JSON.stringify(event));
    
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message,
        stack: error.stack
      })
    };
  }
}

// 🔧 プラン値正規化関数: Airtableの大文字小文字混在問題解決
function normalizePlan(planValue) {
  if (!planValue) return 'free';

  const planLower = planValue.toString().toLowerCase();

  // 正規化マッピング
  switch (planLower) {
    case 'premium':
    case 'premium predictions':
    case 'プレミアム':
      return 'Premium';
    case 'premium combo':
    case 'premiumcombo':
    case 'プレミアムコンボ':
      return 'Premium Combo';
    case 'premium sanrenpuku':
    case 'premiumsanrenpuku':
    case 'プレミアム三連複':
      return 'Premium Sanrenpuku';
    case 'premium plus':
    case 'premiumplus':
    case 'プレミアムプラス':
      return 'Premium Plus';
    case 'standard':
    case 'スタンダード':
      return 'Standard';
    case 'free':
    case 'フリー':
    case '無料':
      return 'Free';
    default:
      console.warn(`⚠️ 未知のプラン値: "${planValue}" -> デフォルト 'Free'`);
      return 'Free';
  }
}

// BlastMail読者登録関数
async function registerToBlastMail(email, registrationSource = 'nankan-analytics') {
  const BLASTMAIL_USERNAME = process.env.BLASTMAIL_USERNAME;
  const BLASTMAIL_PASSWORD = process.env.BLASTMAIL_PASSWORD;
  const BLASTMAIL_API_KEY = process.env.BLASTMAIL_API_KEY;

  if (!BLASTMAIL_USERNAME || !BLASTMAIL_PASSWORD || !BLASTMAIL_API_KEY) {
    console.warn('⚠️ BlastMail credentials not configured, skipping reader registration');
    return null;
  }

  try {
    // Step 1: ログイン（access_token取得）
    const loginUrl = 'https://api.bme.jp/rest/1.0/authenticate/login';
    const loginParams = new URLSearchParams({
      username: BLASTMAIL_USERNAME,
      password: BLASTMAIL_PASSWORD,
      api_key: BLASTMAIL_API_KEY,
      format: 'json'
    });

    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: loginParams.toString()
    });

    if (!loginResponse.ok) {
      throw new Error(`BlastMail login failed: ${loginResponse.status}`);
    }

    const loginData = await loginResponse.json();
    const accessToken = loginData.accessToken;

    if (!accessToken) {
      throw new Error('BlastMail access token not returned');
    }

    console.log('✅ BlastMail login successful, access_token obtained');

    // Step 2: 新規ユーザー登録（検索・更新機能は削除）
    // BlastMail REST API v1.0 の検索機能は利用不可（404エラー）
    // 常に新規登録を試み、既存ユーザーの場合は400エラーを無視する
    const registerUrl = 'https://api.bme.jp/rest/1.0/contact/detail/create';
    const registerParams = new URLSearchParams({
      access_token: accessToken,
      format: 'json',
      c15: email,                           // E-Mail（必須フィールド）
      recipient_group_no: '2'               // リスト: analytics（グループ番号2）
    });

    const registerResponse = await fetch(registerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: registerParams.toString()
    });

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      // 400エラー（既に登録済み）は無視
      if (registerResponse.status === 400 && errorText.includes('already been registered')) {
        console.log('ℹ️ BlastMail already registered:', email, '（スキップ）');
        return null;
      }
      // その他のエラーは例外を投げる
      throw new Error(`BlastMail registration failed: ${registerResponse.status} - ${errorText}`);
    }

    const registerData = await registerResponse.json();
    console.log('✅ BlastMail reader registered:', email, 'ContactID:', registerData.contactID, 'List: analytics');
    return registerData;

  } catch (error) {
    console.error('❌ BlastMail registration error:', error);
    // BlastMailエラーでも処理は続行（登録は継続）
    return null;
  }
}

// 🚫 ウェルカムメール機能は完全削除済み・復活禁止（2025-09-24）
// 削除理由: 8912keibalink.keiba.link不正ドメイン問題解決
// ⚠️ 絶対に復活させてはいけない機能:
//   - sendWelcomeEmail関数・sendWelcomeEmailDirect関数
//   - 90行以上のHTMLメールテンプレート
//   - 環境変数SITE_URLに依存するURL生成
//   - NANKANアナリティクスへようこそメール
//   - マイページログインリンク付きメール
//
// 📧 新規ユーザー通知が必要な場合は、独立したuser-notification.jsを使用
// 復活防止ガイド: WELCOME_EMAIL_REVIVAL_PREVENTION.md参照