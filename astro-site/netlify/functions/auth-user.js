// ユーザー認証関数（無料会員のログイン経路 / PR-B で有料と分離）
//
// 役割（PR-B）:
//   - email のみで Customers を検索し、**明確な無料会員だけ**を即時ログインさせる。
//   - 有料会員は即時ログインさせず `requiresMagicLink: true` を返す（マジックリンク必須）。
//   - 退会 / 強制ログアウト / 停止 / 期限切れ / 判定不能は `denied`（即時ログイン不可）。
//   - 未登録 email は /free-signup/ へ（allowRegistration=true のときだけ新規無料作成）。
//
// 会員判定は src/lib/auth の resolveMembership に一本化（クライアント plan は使わない）。
// email 入力だけで既存レコードを更新しない（日次ポイント付与は廃止・書き込みゼロ）。
const Airtable = require('airtable');

// ESM 共通ライブラリを CommonJS から読む（auth-user は元々 dynamic import を使用）。
async function loadAuthLib() {
  return import('../../src/lib/auth/index.js');
}

/**
 * 最終ログインを記録する（**`LastLoginAt` 1 列だけ**・best-effort）。
 *
 * この Function が Customers を書き換えない原則の唯一の例外。
 * 契約・課金・権限（プラン / 有効期限 / PaymentConfirmed など）には触れない。
 * 失敗（列が未作成 = 422 / 権限 / 通信）は握りつぶし、**ログインの成否に影響させない**。
 */
async function recordLastLogin({ base, recordId, fields }) {
  try {
    if (!base || !recordId) return;
    const { planLastLoginUpdate, assertOnlyLastLoginField } =
      await import('../../src/lib/auth/lastLoginRecord.js');
    const plan = planLastLoginUpdate({ fields: fields || {}, nowMs: Date.now() });
    if (!plan.update) return;
    if (!assertOnlyLastLoginField(plan.fields)) return; // 想定外の列が混ざったら書かない
    await base('Customers').update([{ id: recordId, fields: plan.fields }]);
  } catch (e) {
    console.warn('⚠️ [last-login] 記録スキップ:', e?.message || 'unknown');
  }
}

exports.handler = async (event) => {
  const request = { method: event.httpMethod };
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  if (request.method === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (request.method !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { email: rawEmail, allowRegistration } = JSON.parse(event.body || '{}');
    if (!rawEmail) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Email is required' }) };
    }

    // 📧 Email 正規化（trim + lowercase）
    const email = String(rawEmail).trim().toLowerCase();

    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Airtable env not configured' }) };
    }

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

    const authLib = await loadAuthLib();
    const {
      resolveMembership, decideFreeLogin, FREE_LOGIN_OUTCOME, MEMBER_REASON,
      classifyCustomerMatches, CUSTOMER_LOOKUP,
    } = authLib;

    // Email 完全一致（LOWER(TRIM()) で大小・空白差を吸収）
    const escapedEmail = email.replace(/'/g, "\\'");
    const emailFilter = `LOWER(TRIM({Email})) = '${escapedEmail}'`;
    const records = await base('Customers').select({ filterByFormula: emailFilter, maxRecords: 5 }).firstPage();

    console.log(`🔍 [auth-user] Email hits: ${records.length} (email=${email})`);

    // 0件 / 1件 / 複数件を明確に区別。複数件は fail closed（判定も書き込みもしない）。
    const lookup = classifyCustomerMatches(records);

    // ── 複数件 → 会員情報を列挙せず拒否（token/Cookie/書き込みなし） ──
    if (lookup.kind === CUSTOMER_LOOKUP.CONFLICT) {
      console.error(`⛔ [auth-user] 同一 Email で複数 Customers → fail closed (件数=${records.length})`);
      return {
        statusCode: 403,
        headers: jsonHeaders,
        body: JSON.stringify({
          success: false,
          denied: true,
          message: 'このアカウントではログインできません。お心当たりがない場合はサポートへお問い合わせください。',
        }),
      };
    }

    // ── 未登録 ─────────────────────────────────────────────
    if (lookup.kind === CUSTOMER_LOOKUP.NONE) {
      if (!allowRegistration) {
        // 未登録は新規無料登録経路へ分離
        return {
          statusCode: 401,
          headers: jsonHeaders,
          body: JSON.stringify({
            success: false,
            error: 'このメールアドレスは登録されていません。',
            message: '新規登録は /free-signup/ ページから行ってください。',
            redirectTo: '/free-signup/',
          }),
        };
      }
      return await handleNewFreeRegistration(base, email, jsonHeaders, authLib);
    }

    // ── 既存レコード（一意）: 会員判定（サーバー側・書き込みなし） ──
    const record = lookup.record;
    const membership = resolveMembership({ fields: record.fields, recordId: record.id, now: Date.now() });
    const decision = decideFreeLogin(membership);
    console.log(`👤 [auth-user] decision=${decision.outcome} reason=${membership.reason} (email=${email})`);

    if (decision.outcome === FREE_LOGIN_OUTCOME.FREE) {
      // 無料会員 → 即時無料状態（固定 plan:'free' のみ・内部状態/ポイント/期限は返さない）。
      // 期限切れ・退会申請の元有料会員もここに来る（2026-08-01）。**プラン名は返さない**ので、
      // クライアントが元の Premium / Light を権限判定に使うことはできない。
      // 「契約が終わっている」ことだけを真偽値で伝え、再契約導線を案内できるようにする
      // （プラン名・有効期限・金額は伏せる。列挙対策として詳細は出さない）。
      const previousPlanEnded = membership.reason === MEMBER_REASON.EXPIRED
        || membership.reason === MEMBER_REASON.WITHDRAWAL_REQUESTED;
      // 最終ログインの記録（**LastLoginAt 1 列だけ**・best-effort）。
      // 契約・課金・権限の列には触れない。失敗してもログインは成立させる。
      await recordLastLogin({ base, recordId: record.id, fields: record.fields });
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          success: true,
          isNewUser: false,
          memberType: 'free',
          user: { email, plan: 'free' },
          previousPlanEnded,
          message: previousPlanEnded
            ? '以前のご契約は終了しています。無料会員としてログインしました。'
            : 'ログインしました。',
        }),
      };
    }

    if (decision.outcome === FREE_LOGIN_OUTCOME.REQUIRES_MAGIC_LINK) {
      // 有料会員 → 即時ログインさせない。plan 名・内部状態は返さない。
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          success: false,
          requiresMagicLink: true,
          message: '有料会員のログインには、メールでお送りするログインリンクが必要です。',
        }),
      };
    }

    // denied（退会 / 強制ログアウト / 停止 / 期限切れ / 判定不能）→ 会員情報を列挙しない
    return {
      statusCode: 403,
      headers: jsonHeaders,
      body: JSON.stringify({
        success: false,
        denied: true,
        message: 'このアカウントではログインできません。お心当たりがない場合はサポートへお問い合わせください。',
      }),
    };
  } catch (error) {
    console.error('🚨 [auth-user] error:', error.message);
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

// 新規無料登録（allowRegistration=true / /free-signup/ からのみ）
// 初回作成時に 1pt 付与するのは **作成時 1 回だけ**（既存レコードの email 入力更新はしない）。
async function handleNewFreeRegistration(base, email, jsonHeaders, authLib) {
  const { resolveMembership, decideFreeLogin, FREE_LOGIN_OUTCOME, classifyCustomerMatches, CUSTOMER_LOOKUP } = authLib;

  // race-safe: create 直前に再検索（複数件検出のため maxRecords>=2）
  const escaped = email.replace(/'/g, "\\'");
  const reCheck = await base('Customers')
    .select({ filterByFormula: `LOWER(TRIM({Email})) = '${escaped}'`, maxRecords: 5 })
    .firstPage();

  const lookup = classifyCustomerMatches(reCheck);

  // 複数件 → fail closed（作成も更新もせず拒否）
  if (lookup.kind === CUSTOMER_LOOKUP.CONFLICT) {
    console.error(`⛔ [auth-user] 新規登録 race再検索で複数 Customers → fail closed (件数=${reCheck.length})`);
    return {
      statusCode: 403,
      headers: jsonHeaders,
      body: JSON.stringify({
        success: false,
        denied: true,
        message: 'このアカウントではログインできません。お心当たりがない場合はサポートへお問い合わせください。',
      }),
    };
  }

  // 既に一意で存在 → resolveMembership で再判定（固定 Free 化しない・既存レコードは更新しない）
  if (lookup.kind === CUSTOMER_LOOKUP.SINGLE) {
    const membership = resolveMembership({ fields: lookup.record.fields, recordId: lookup.record.id, now: Date.now() });
    const decision = decideFreeLogin(membership);
    if (decision.outcome === FREE_LOGIN_OUTCOME.FREE) {
      // 明確な無料会員だけ即時ログイン（新規作成なし・ポイント付与なし・最終ログイン更新なし）
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          success: true,
          isNewUser: false,
          memberType: 'free',
          user: { email, plan: 'free' },
          message: 'ログインしました。',
        }),
      };
    }
    if (decision.outcome === FREE_LOGIN_OUTCOME.REQUIRES_MAGIC_LINK) {
      // 有料会員 → 即時ログインさせない。plan 名・内部状態は返さない。
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          success: false,
          requiresMagicLink: true,
          message: '有料会員のログインには、メールでお送りするログインリンクが必要です。',
        }),
      };
    }
    // denied（退会/停止/期限切れ/判定不能）
    return {
      statusCode: 403,
      headers: jsonHeaders,
      body: JSON.stringify({
        success: false,
        denied: true,
        message: 'このアカウントではログインできません。お心当たりがない場合はサポートへお問い合わせください。',
      }),
    };
  }

  // ── 0件のときだけ新規 Free 作成 ──
  const todayJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
    .toISOString()
    .split('T')[0];
  const newRecord = await base('Customers').create({
    Email: email,
    'プラン': 'Free',
    'ポイント': 1, // 初回オンボーディングの 1pt（作成時 1 回のみ）
    '最終ポイント付与日': todayJst,
    Source: 'nankan-analytics',
  });
  console.log(`📝 [auth-user] 新規無料作成: ${email} / id=${newRecord.id}`);

  // 付随処理はベストエフォート（本体を壊さない）
  try {
    await registerToBlastMail(email, 'nankan-analytics');
  } catch (e) {
    console.error('⚠️ [auth-user] BlastMail 登録失敗（継続）:', e.message);
  }
  try {
    const { enrollSignupOnboarding } = await import('../../src/lib/newsletter/step-enroll.js');
    await enrollSignupOnboarding({
      apiKey: process.env.AIRTABLE_API_KEY,
      baseId: process.env.AIRTABLE_BASE_ID,
      email,
      customerRecordId: newRecord.id,
      source: 'auth-user-free-signup',
    });
  } catch (e) {
    console.error('⚠️ [auth-user] step enroll 失敗（継続）:', e.message);
  }
  try {
    const notificationUrl = `${process.env.NETLIFY_DEV ? 'http://localhost:8888' : 'https://analytics.keiba.link'}/.netlify/functions/user-notification`;
    await fetch(notificationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, isNewUser: true }),
    });
  } catch (e) {
    console.error('⚠️ [auth-user] ウェルカム通知失敗（継続）:', e.message);
  }

  return {
    statusCode: 200,
    headers: jsonHeaders,
    body: JSON.stringify({
      success: true,
      isNewUser: true,
      memberType: 'free',
      user: { email, plan: 'free' },
      message: '新規無料登録が完了しました。',
    }),
  };
}

// BlastMail読者登録関数（無料会員）
async function registerToBlastMail(email, registrationSource = 'nankan-analytics') {
  const BLASTMAIL_USERNAME = process.env.BLASTMAIL_USERNAME;
  const BLASTMAIL_PASSWORD = process.env.BLASTMAIL_PASSWORD;
  const BLASTMAIL_API_KEY = process.env.BLASTMAIL_API_KEY;

  if (!BLASTMAIL_USERNAME || !BLASTMAIL_PASSWORD || !BLASTMAIL_API_KEY) {
    console.warn('⚠️ BlastMail credentials not configured, skipping reader registration');
    return null;
  }

  try {
    const loginUrl = 'https://api.bme.jp/rest/1.0/authenticate/login';
    const loginParams = new URLSearchParams({
      username: BLASTMAIL_USERNAME,
      password: BLASTMAIL_PASSWORD,
      api_key: BLASTMAIL_API_KEY,
      format: 'json',
    });
    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: loginParams.toString(),
    });
    if (!loginResponse.ok) throw new Error(`BlastMail login failed: ${loginResponse.status}`);
    const loginData = await loginResponse.json();
    const accessToken = loginData.accessToken;
    if (!accessToken) throw new Error('BlastMail access token not returned');

    const registerUrl = 'https://api.bme.jp/rest/1.0/contact/detail/create';
    const registerParams = new URLSearchParams({
      access_token: accessToken,
      format: 'json',
      c15: email,
      recipient_group_no: '2',
    });
    const registerResponse = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: registerParams.toString(),
    });
    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      if (registerResponse.status === 400 && errorText.includes('already been registered')) {
        return null;
      }
      throw new Error(`BlastMail registration failed: ${registerResponse.status} - ${errorText}`);
    }
    return await registerResponse.json();
  } catch (error) {
    console.error('❌ BlastMail registration error:', error.message);
    return null;
  }
}
