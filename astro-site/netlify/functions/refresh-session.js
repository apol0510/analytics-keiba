/**
 * セッション refresh API（analytics-keiba / PR-B2）
 *
 * POST /.netlify/functions/refresh-session
 *
 * 有効な ak_session Cookie を持つ有料会員に対し、Airtable の最新状態を再確認したうえで
 * ak_session を再発行（idle TTL を延長）する。絶対 TTL（初回ログインから 12 時間）を超えた
 * セッションは延長せず、再度マジックリンク認証を要求する。
 *
 * 認可の真実源は HttpOnly Cookie のみ。plan / sub / sessionVersion / sessionStart を
 * リクエスト body から受け取らない（クライアント入力を一切信用しない）。
 *
 * 手順:
 *   1. POST 以外 → 405 / Origin 検証（本番は欠落・不一致・複数とも 403・fail closed）
 *   2. SESSION_SIGNING_SECRET 未設定 → 503（fail closed）
 *   3. Cookie 無し → 401
 *   4. verifySession（署名・スキーマ・idle 期限・v2 絶対 TTL）→ NG は 401 + Cookie 削除
 *   5. payload.sub（Airtable recordId）で Customers を再取得 → resolveMembership
 *   6. decideRefresh（PAID / sessionVersion 一致 / 絶対 TTL 内 かを判定）
 *        - reject → 401 + Cookie 削除
 *        - keep   → 204（Set-Cookie しない）
 *        - reissue→ 200 + Set-Cookie（sessionStart は引き継ぐ・plan は Airtable 最新）
 *   Airtable 障害時は延長も削除もしない（503）。
 *
 * 秘密鍵・Cookie 値・署名値はログに出さない。
 *
 * 環境変数: AIRTABLE_API_KEY / AIRTABLE_BASE_ID / SESSION_SIGNING_SECRET
 */

const Airtable = require('airtable');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

// 本番オリジン。Deploy Preview の netlify.app も許可（既存 verify-magic-link と揃える）。
const ALLOWED_ORIGINS = [
  'https://analytics.keiba.link',
  'https://analytics-keiba.netlify.app',
  'http://localhost:4321',
  'http://localhost:3000',
];

function baseHeaders(event) {
  const origin = event.headers?.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
    // 会員別レスポンス。CDN/ブラウザにキャッシュさせない。
    'Cache-Control': 'private, no-store',
  };
}

// Airtable recordId で 1 件取得。
//   { ok:true, record:{id,fields} }  … 取得成功
//   { ok:true, record:null }         … 明確に存在しない（退会後の削除等）→ 認可拒否
//   { ok:false }                     … 障害（延長も削除もしない）
async function findCustomerById(base, recordId) {
  try {
    const rec = await base('Customers').find(recordId);
    return { ok: true, record: { id: rec.id, fields: rec.fields || {} } };
  } catch (err) {
    const notFound =
      err && (err.statusCode === 404 || err.error === 'NOT_FOUND' || err.error === 'MODEL_ID_NOT_FOUND');
    if (notFound) return { ok: true, record: null };
    return { ok: false };
  }
}

exports.handler = async (event) => {
  const headers = baseHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const {
      checkSigningSecret,
      readSessionCookie,
      verifySession,
      resolveMembership,
      decideRefresh,
      REFRESH_DECISION,
      issuePaidSessionCookie,
      buildLogoutCookie,
      decideRefreshOrigin,
      ORIGIN_DECISION,
    } = await import('../../src/lib/auth/index.js');

    // CSRF 対策: Origin を検証する。
    //   - 本番（CONTEXT!=非本番）: 欠落・不一致・複数はすべて 403（fail closed）
    //   - 非本番のみ: Origin 欠落を許容（ツール / 同一オリジン fetch 用）
    // context 未設定は本番相当。Cookie は SameSite=Lax + HttpOnly なので他サイト POST では送られない。
    // ここで拒否した場合、Airtable 照会も Set-Cookie も一切行わない。
    const origin = event.headers?.origin ?? event.headers?.Origin;
    if (decideRefreshOrigin({ origin, context: process.env.CONTEXT }) !== ORIGIN_DECISION.ALLOW) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
    }

    const secret = process.env.SESSION_SIGNING_SECRET;
    if (!checkSigningSecret(secret).ok) {
      // 鍵未設定/不正 → fail closed。Cookie には触れない。
      console.error('❌ [refresh-session] SESSION_SIGNING_SECRET 未設定/不正 → 503');
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
    }

    const token = readSessionCookie(event.headers?.cookie || event.headers?.Cookie || '');
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const now = Date.now();
    const verified = await verifySession({ token, secret, now });
    if (!verified.ok) {
      // 署名不正・期限切れ・スキーマ不正・絶対 TTL 超過 → 認可拒否 + Cookie 削除
      console.warn(`⛔ [refresh-session] verify 失敗: reason=${verified.reason}`);
      return {
        statusCode: 401,
        headers: { ...headers, 'Set-Cookie': buildLogoutCookie() },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // 会員状態を Airtable で再確認（plan / sessionVersion / 退会 / 停止 / 期限）
    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const lookup = await findCustomerById(base, verified.payload.sub);
    if (!lookup.ok) {
      // Airtable 障害: 勝手に延長しない・削除もしない
      console.error('❌ [refresh-session] Airtable lookup 失敗 → 503（延長せず）');
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
    }
    if (!lookup.record) {
      // 会員レコードが存在しない → 拒否 + Cookie 削除
      return {
        statusCode: 401,
        headers: { ...headers, 'Set-Cookie': buildLogoutCookie() },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const membership = resolveMembership({ fields: lookup.record.fields, recordId: lookup.record.id, now });
    const decision = decideRefresh({ payload: verified.payload, membership, now });

    if (decision.decision === REFRESH_DECISION.REJECT) {
      console.warn(`⛔ [refresh-session] refresh 拒否: reason=${decision.reason}`);
      return {
        statusCode: 401,
        headers: { ...headers, 'Set-Cookie': buildLogoutCookie() },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    if (decision.decision === REFRESH_DECISION.KEEP) {
      // 残 TTL 十分 → 再発行しない
      return { statusCode: 204, headers, body: '' };
    }

    // reissue: plan / venue / sessionVersion は Airtable 最新（membership）を採用。
    // sessionStart は decideRefresh が引き継いだ値をそのまま渡す（延命防止）。
    const issued = await issuePaidSessionCookie({
      membership,
      secret,
      now,
      ttlMs: decision.ttlMs,
      sessionStart: decision.sessionStart,
    });
    if (!issued.ok) {
      // 発行失敗時は既存 Cookie を延長も削除もしない
      console.error(`❌ [refresh-session] 再発行失敗: reason=${issued.reason}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Set-Cookie': issued.cookie },
      body: JSON.stringify({ refreshed: true }),
    };
  } catch (error) {
    console.error('❌ [refresh-session] error:', error && error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
