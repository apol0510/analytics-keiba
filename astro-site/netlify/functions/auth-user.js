// ─────────────────────────────────────────────
// auth-user.js — 役割を限定した会員ユーティリティ（2026-07-07 セキュリティ改修）
//
// 🔒 重要: この Function は「認証 API」ではない。
//   メールアドレスのみを根拠に、既存会員の plan やログイン済み状態を返してはいけない。
//   （メール入力だけで他人の有料 plan を取得できる重大な裏経路を廃止するため）
//
// 許可される役割:
//   1. 新規無料登録（allowRegistration=true かつ未登録メール）→ Free として作成し plan:'free' を返す
//   2. 既存会員のポイント表示用の読み取り（plan・認証状態は返さない / isExistingMember フラグのみ）
//
// 既存会員のログイン（認証済み状態の確立）は send-magic-link → verify-magic-link の
// 正規マジックリンク経路に一本化する。auth-user は plan を返さないため、
// この応答を localStorage に保存しても有料アクセスは得られない。
// ─────────────────────────────────────────────
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
    const { email: rawEmail, allowRegistration } = JSON.parse(event.body || '{}');
    if (!rawEmail) {
      return {
        statusCode: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Email is required' })
      };
    }

    // 📧 Email 正規化（trim + lowercase）。Customers 検索・新規作成すべてこの値で行う
    const email = String(rawEmail).trim().toLowerCase();
    console.log('🔍 Parsed email (normalized):', email);
    console.log('🔍 IP Address:', ipAddress);
    console.log('🔍 Allow Registration:', allowRegistration);

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

    // ─────────────────────────────────────────────
    // 🔧 2026-05-12 修正: Email 完全一致のみで検索
    // 旧条件は `AND({Email}=..., OR({Source}='nankan-analytics', {Source}=BLANK()))`
    // だったが、Source が他の値（旧データや移行行）の既存会員を見逃して重複作成する原因になっていた。
    // ここでは Source 条件を外し、Email のみで会員を一意に検出する。
    // 大小違い・前後空白の差で重複検出ミスを起こさないため LOWER(TRIM()) で比較。
    // ─────────────────────────────────────────────
    const escapedEmail = email.replace(/'/g, "\\'");
    const emailFilter = `LOWER(TRIM({Email})) = '${escapedEmail}'`;

    const records = await base('Customers')
      .select({
        filterByFormula: emailFilter,
        maxRecords: 5  // 重複検出のため複数取得
      })
      .firstPage();

    console.log(`🔍 Email 検索結果: ${records.length}件 ヒット（email=${email}）`);
    if (records.length > 1) {
      console.warn(`⚠️ 同一 Email で複数レコード検出: ${email} / recordIds=${records.map(r => r.id).join(',')}`);
    }

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

      // 🔁 2026-05-12 修正: 同時リクエストでの重複作成防止
      // create 直前に Email 完全一致で再検索して、別のリクエストが
      // 直前に作成したレコードがないか確認する（チェック&クリエイトの race condition 対策）。
      console.log(`🔁 新規作成前の再検索（race-safe check）: ${email}`);
      const reCheckRecords = await base('Customers')
        .select({ filterByFormula: emailFilter, maxRecords: 1 })
        .firstPage();

      if (reCheckRecords.length > 0) {
        console.log(`✅ 再検索で既存レコード検出 → 新規作成スキップ: ${email} / recordId=${reCheckRecords[0].id}`);
        // 既存ユーザーとして処理するためフォールスルー
        records.push(reCheckRecords[0]);
      } else {
        // allowRegistration=true かつ既存レコードなし → 新規ユーザーとして登録
        console.log(`✅ 新規ユーザー登録許可: ${email}`);

        const newRecord = await base('Customers').create({
          'Email': email,
          'プラン': 'Free',
          'ポイント': 1,
          '最終ポイント付与日': new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).toISOString().split('T')[0],
          'Source': 'nankan-analytics'
        });
        console.log(`📝 新規ユーザー作成完了: ${email} / recordId=${newRecord.id}`);

        // BlastMail読者登録（無料会員）
        try {
          await registerToBlastMail(email, 'nankan-analytics');
        } catch (blastMailError) {
          console.error('⚠️ BlastMail登録エラー（処理は継続）:', blastMailError.message);
        }

        // ステップメール enroll（signup-onboarding）。新規 free 登録時のみ enroll 行を作成。
        // ベストエフォート: enroll 失敗は free 登録本体を壊さない（throw しない）。
        // step-enroll.js は ESM のため CommonJS から dynamic import で読み込む。
        // ※ enroll 行作成のみ。送信・enqueue・他テーブル書込みは一切しない。
        try {
          const { enrollSignupOnboarding } = await import('../../src/lib/newsletter/step-enroll.js');
          const enrollResult = await enrollSignupOnboarding({
            apiKey: process.env.AIRTABLE_API_KEY,
            baseId: process.env.AIRTABLE_BASE_ID,
            email,
            customerRecordId: newRecord.id,
            source: 'auth-user-free-signup',
          });
          console.log(`📩 step enroll: created=${enrollResult.created} reason=${enrollResult.reason}`);
        } catch (enrollError) {
          console.error('⚠️ step enroll 失敗（登録は継続）:', enrollError.message);
        }

        // 新規ユーザー通知（= 実態はウェルカムメール送信。user-notification.js が SendGrid 経由で送る）
        try {
          const notificationUrl = `${process.env.NETLIFY_DEV ? 'http://localhost:8888' : 'https://analytics.keiba.link'}/.netlify/functions/user-notification`;
          console.log(`📨 ウェルカムメール送信リクエスト: ${email} → ${notificationUrl}`);

          const notificationResponse = await fetch(notificationUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email,
              isNewUser: true
            })
          });

          if (notificationResponse.ok) {
            console.log(`✅ ウェルカムメール送信成功: ${email}`);
          } else {
            // 失敗時はレスポンス本文を読み出してログに残す
            const notifyErrorText = await notificationResponse.text().catch(() => '(no body)');
            console.error(`⚠️ ウェルカムメール送信失敗（処理は継続）: status=${notificationResponse.status}, email=${email}, response=${notifyErrorText}`);
          }
        } catch (notificationError) {
          console.error(`⚠️ ウェルカムメール送信エラー（処理は継続）: email=${email}, error=${notificationError.message}`);
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
    }

    // ─────────────────────────────────────────────
    // 既存ユーザーの処理（records.length > 0 または race-safe 再検索でヒット）
    // 重要: 既存の Plan / Status / PaymentEmailSent / CustomerType などを
    //       ここで上書きしてはいけない。読み取りと最小限の更新（ポイント・退会フラグ）のみ。
    // ─────────────────────────────────────────────
    console.log(`👤 既存ユーザー処理: ${email} / recordId=${records[0].id}`);
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
    let normalizedPlan = normalizePlan(currentPlan);

    // ─────────────────────────────────────────────
    // 🚨 2026-05-13 重大バグ修正: 入金待ち（Status='pending'）は Free 扱い
    //
    // 旧バグ:
    //   bank-transfer-application.js がフォーム送信時点で 'プラン' を申込プラン
    //   （例: 'Light'）に書き込むため、admin が Status を 'active' にしていなくても
    //   auth-user.js が 'プラン' を読んでログイン時に有料プラン扱いしてしまっていた。
    //   → 振込前のユーザーが Light/Premium 機能にアクセスできる重大なセキュリティ問題。
    //
    // 修正:
    //   Status === 'pending' のユーザーは、'プラン' フィールドの値に関わらず Free として扱う。
    //   admin が Status を 'active' に切り替えた後に正規のプランが反映される。
    //
    // 互換性:
    //   - Status が未設定（旧データ）の場合は従来通り 'プラン' を返す（既存有料会員を壊さない）
    //   - Status === 'active' の場合は従来通り 'プラン' を返す
    // ─────────────────────────────────────────────
    const currentStatus = user.get('Status') || null;
    const isPendingPayment = String(currentStatus || '').toLowerCase() === 'pending';
    if (isPendingPayment && normalizedPlan !== 'Free' && normalizedPlan !== 'free') {
      console.log(`🚫 入金待ち（Status=pending）のため Free 扱い: ${email} / 申込プラン=${normalizedPlan} → Free`);
      normalizedPlan = 'Free';
    }

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
      // Light が現行表記。旧 Standard / ライト も同階層
      'Light': 10,
      'light': 10,
      'ライト': 10,
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
    // 🔧 2026-05-13修正: Status=pending（入金待ち）も Free 扱いでポイント付与
    // 通常のログインポイント（1日1回）
    if (lastLogin !== today) {
      if (withdrawalRequested || isExpired) {
        // 退会申請済み or 有効期限切れ → ポイント付与なし
        console.log(`🚫 ポイント付与停止: withdrawalRequested=${withdrawalRequested}, isExpired=${isExpired}`);
        pointsAdded = 0;
      } else {
        // 通常ユーザー → プラン別ポイント付与
        // Status=pending の場合は normalizedPlan が既に 'Free' に置き換わっているため、
        // それを参照して 1pt 付与（旧バグ: 申込直後の 'プラン'='Light' を読んで 10pt 付与していた）
        const planForPoints = isPendingPayment ? 'Free' : currentPlan;
        pointsAdded += POINTS_BY_PLAN[planForPoints] || 1;
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

    // ─────────────────────────────────────────────
    // 🔒 既存会員の応答: plan・認証済み状態を返さない
    //   - plan を含めない（メールだけで有料 plan を取得させない）
    //   - isExistingMember / requiresMagicLink で「これはログインではない」ことを明示
    //   - ポイント表示用に points のみ返す（plan 判定には使われない値）
    //   ログインは send-magic-link → verify-magic-link の正規経路で行うこと。
    // ─────────────────────────────────────────────
    let message = '';
    if (withdrawalRequested) {
      message = '退会申請済みです。新規ポイント付与・プレミアム機能のご利用はできません。';
    } else if (pointsAdded > 0) {
      message = `本日のポイント${pointsAdded}pt付与`;
    } else {
      message = 'アカウントを確認しました。';
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        isNewUser: false,
        isExistingMember: true,      // 🔒 既存会員（このメールは登録済み）
        requiresMagicLink: true,     // 🔒 認証済みアクセスにはマジックリンクが必要
        isWithdrawalRequested: withdrawalRequested,  // 🔧 2025-11-26追加: 退会申請フラグ
        user: {
          email,
          // 🔒 plan は返さない（メールのみでの有料 plan 取得を防止）
          points: newPoints,         // ポイント表示用のみ
          pointsAdded,
          lastLogin: today
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
    case 'light':
    case 'ライト':
    case 'standard':
    case 'スタンダード':
      return 'Light';
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
//   - KEIBA Analyticsへようこそメール
//   - マイページログインリンク付きメール
//
// 📧 新規ユーザー通知が必要な場合は、独立したuser-notification.jsを使用
// 復活防止ガイド: WELCOME_EMAIL_REVIVAL_PREVENTION.md参照