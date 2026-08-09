/**
 * マジックリンク検証API（analytics-keiba / PR-B: 有料セッション Cookie 発行）
 *
 * GET /.netlify/functions/verify-magic-link?token=...
 *
 * オーケストレーションは純粋モジュール runVerifyMagicLink（src/lib/auth）に集約し、
 * 本ハンドラは Airtable / env / 時計を注入してHTTP応答へマッピングするだけ。
 *
 * 手順（runVerifyMagicLink）:
 *   1. SESSION_SIGNING_SECRET を検証（未設定/短い → 503。token に触れない）
 *   2. token 存在 → 未使用 → 期限 を確認
 *   3. token の Email で Customers 再取得 → resolveMembership（クライアント plan は使わない）
 *   4. paid のみ createSession(20分) + serializeSessionCookie(ak_session)
 *   5. Cookie 準備が成功してから token を再確認して使用済みに更新
 *   6. 使用済み更新が成功した場合だけ Set-Cookie を返す（更新失敗時は Cookie を出さない）
 *
 * Airtable に原子的 compare-and-set は無いため、更新直前の再読込で単回性を最大限守る
 * （残る同時実行リスクは最小化にとどまる。全端末失効は SessionVersion 導入の PR-C 以降）。
 *
 * 環境変数: AIRTABLE_API_KEY / AIRTABLE_BASE_ID / SESSION_SIGNING_SECRET
 */

const Airtable = require('airtable');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const ALLOWED_ORIGINS = [
  'https://analytics.keiba.link',
  'https://analytics-keiba.netlify.app',
  'http://localhost:4321',
  'http://localhost:3000',
];

function corsHeaders(event) {
  const origin = event.headers?.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
  };
}

// 正規プラン → AccessControl 互換の表示プラン名（localStorage UI 用・非権威）
function displayPlanName(canonical) {
  switch (canonical) {
    case 'light': return 'Light';
    case 'premium': return 'Premium';
    case 'premium-predictions': return 'Premium';
    case 'premium-sanrenpuku': return 'Premium Sanrenpuku';
    case 'premium-sanrentan': return 'Premium Plus';
    case 'premium-combo': return 'Premium Combo';
    case 'premium-plus': return 'Premium Plus';
    default: return 'Premium';
  }
}

function venueString(venues) {
  if (Array.isArray(venues) && venues.length === 1) return venues[0];
  return 'all';
}

/**
 * 最終ログインを記録する（**既存列 `最終ログイン` 1 列だけ**・best-effort）。
 *
 * ログイン経路が Customers を書き換えない原則の唯一の例外。
 * 判定・throttle・失敗の握りつぶしは単一源 `lastLoginRecord.js` に集約している。
 * **検証成功（VERIFY_FLOW.OK）のときだけ**呼ぶこと。
 * 記録は付随情報であり認可ではないので、失敗してもログインは成立させる。
 */
async function markLastLogin({ table, recordId, fields }) {
  if (!table || !recordId) return { written: false, reason: 'no_target' };
  const { recordLastLogin } = await import('../../src/lib/auth/lastLoginRecord.js');
  const result = await recordLastLogin({
    // 書き込みは注入。ここでは recordId 以外の対象を触れないようにする
    update: (only) => table.update([{ id: recordId, fields: only }]),
    fields: fields || {},
    nowMs: Date.now(),
  });
  if (!result.written && result.reason === 'write_failed') {
    // 列が無い（UNKNOWN_FIELD_NAME）を含め、記録失敗はログインを壊さない
    console.warn('⚠️ [last-login] 記録スキップ:', result.error);
  }
  return result;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Airtable env not configured' }) };
  }

  try {
    const { runVerifyMagicLink, VERIFY_FLOW, classifyCustomerMatches, CUSTOMER_LOOKUP } =
      await import('../../src/lib/auth/index.js');

    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const authTokensTable = base('AuthTokens');
    const customersTable = base('Customers');
    const { token } = event.queryStringParameters || {};

    // Airtable を注入（純粋オーケストレータは I/O を持たない）
    const findToken = async (t) => {
      const rows = await authTokensTable
        .select({ filterByFormula: `{Token} = "${String(t).replace(/"/g, '\\"')}"`, maxRecords: 1 })
        .firstPage();
      return rows.length ? { id: rows[0].id, fields: rows[0].fields } : null;
    };
    // 最終ログイン記録のために、確定した 1 件の fields を保持する（判定には使わない）
    let lastCustomerFields = null;
    const findCustomer = async (email) => {
      const escaped = String(email).replace(/'/g, "\\'");
      const rows = await customersTable
        .select({ filterByFormula: `LOWER(TRIM({Email})) = '${escaped}'`, maxRecords: 5 })
        .firstPage();
      // 0件=null / 複数件={conflict:true}（fail closed）/ 1件={id,fields}
      const c = classifyCustomerMatches(rows);
      if (c.kind === CUSTOMER_LOOKUP.CONFLICT) {
        console.warn(`⚠️ [verify-magic-link] 同一 Email で複数 Customers → fail closed (件数=${rows.length})`);
        return { conflict: true };
      }
      lastCustomerFields = c.record ? c.record.fields : null;
      return c.record; // NONE→null / SINGLE→{ id, fields }
    };
    const markUsed = async (id) => {
      await authTokensTable.update([{ id, fields: { Used: true } }]);
    };

    const result = await runVerifyMagicLink({
      token,
      secret: process.env.SESSION_SIGNING_SECRET,
      now: Date.now(),
      findToken,
      findCustomer,
      markUsed,
    });

    switch (result.outcome) {
      case VERIFY_FLOW.SECRET_UNAVAILABLE:
        console.error('❌ [verify-magic-link] SESSION_SIGNING_SECRET 未設定/不正 → 503');
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Session service unavailable' }) };
      case VERIFY_FLOW.MISSING_TOKEN:
        // 2026-08-09 の障害では、この経路が**無言で return** していたため
        // 「呼ばれているのに成功も失敗も記録されない」状態になり、原因特定が遅れた。
        // token 値・メールアドレスは出さない。分類だけ残す。
        console.warn('⚠️ [verify-magic-link] token 欠落');
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token is required' }) };
      case VERIFY_FLOW.TOKEN_NOT_FOUND:
        // 2026-08-09 の障害では、この経路が**無言で return** していたため
        // 「呼ばれているのに成功も失敗も記録されない」状態になり、原因特定が遅れた。
        // token 値・メールアドレスは出さない。分類だけ残す。
        console.warn('⚠️ [verify-magic-link] token 不明');
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Token not found' }) };
      case VERIFY_FLOW.TOKEN_USED:
        // 2026-08-09 の障害では、この経路が**無言で return** していたため
        // 「呼ばれているのに成功も失敗も記録されない」状態になり、原因特定が遅れた。
        // token 値・メールアドレスは出さない。分類だけ残す。
        console.warn('⚠️ [verify-magic-link] token 使用済み');
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token already used' }) };
      case VERIFY_FLOW.TOKEN_EXPIRED:
        // 2026-08-09 の障害では、この経路が**無言で return** していたため
        // 「呼ばれているのに成功も失敗も記録されない」状態になり、原因特定が遅れた。
        // token 値・メールアドレスは出さない。分類だけ残す。
        console.warn('⚠️ [verify-magic-link] token 期限切れ');
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token expired' }) };
      case VERIFY_FLOW.CUSTOMER_NOT_FOUND:
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Customer not found' }) };
      case VERIFY_FLOW.CUSTOMER_CONFLICT:
        // 重複レコード → 会員情報を出さず fail closed（Cookie 発行・markUsed は行われていない）
        console.error('⛔ [verify-magic-link] Customers 重複 → Cookie 発行中止（fail closed）');
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Account verification unavailable' }) };
      case VERIFY_FLOW.NOT_PAID:
        console.warn(`⛔ [verify-magic-link] 現在 paid ではない: reason=${result.reason}`);
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not a paid member' }) };
      case VERIFY_FLOW.ISSUE_FAILED: {
        const code = result.reason === 'secret_invalid' ? 503 : 500;
        console.error(`❌ [verify-magic-link] Cookie 発行不可: reason=${result.reason}`);
        return { statusCode: code, headers, body: JSON.stringify({ error: 'Failed to issue session' }) };
      }
      case VERIFY_FLOW.CONSUME_FAILED:
        console.error('❌ [verify-magic-link] Used 更新失敗 → Cookie 発行中止');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to consume token' }) };
      case VERIFY_FLOW.OK: {
        const m = result.membership;
        const venue = venueString(m.venueAccess);
        // 最終ログインの記録（**既存列 `最終ログイン` 1 列だけ**・best-effort）。
        // 失敗してもログインは成立させる。
        await markLastLogin({ table: customersTable, recordId: m.recordId, fields: lastCustomerFields });
        // ログイン成功後はダッシュボード（マイページ）へ遷移する。
        // 予想ページへの導線はダッシュボード内から辿る。
        const redirectTo = '/dashboard/';
        // localStorage UI 互換用（非権威。認可の真実源は HttpOnly Cookie ak_session。
        // PR-C/PR-D で AccessControl を Cookie ベースへ移行後に削除予定）。
        const userPlan = {
          email: result.email,
          name: result.name,
          plan: displayPlanName(m.normalizedPlan),
          venueAccess: venue,
          lifetimeSanrenpuku: !!m.lifetimeSanrenpuku,
          // この権限の根拠（'paid_contract' | 'promotional_grant'）。
          // `plan` は閲覧権のティアなので、無料特典でも 'light' / 'premium' になる。
          // **会員向け価格の出し分けに `plan` を使わせない**ための区別。
          entitlementSource: m.entitlementSource,
          // 会員向け価格（/pricing/ の乗り換え特典価格）の出し分け tier。
          // **課金契約だけ**から算出する（無料特典では上がらない）。サーバーで決めて渡し、
          // クライアントに「無料特典 → 有料会員価格」の推測をさせない。
          pricingTier: result.pricingTier,
          nonAuthoritative: true,
          issuedAt: new Date(result.payload.issuedAt).toISOString(),
          expiresAt: new Date(result.payload.expiresAt).toISOString(),
        };
        console.log(`✅ [verify-magic-link] paid ログイン成功: plan=${m.normalizedPlan}`);
        return {
          statusCode: 200,
          headers: { ...headers, 'Set-Cookie': result.cookie },
          body: JSON.stringify({ success: true, redirectTo, userPlan }),
        };
      }
      default:
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
  } catch (error) {
    console.error('❌ [verify-magic-link] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
