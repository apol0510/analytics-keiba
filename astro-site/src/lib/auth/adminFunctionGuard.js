/**
 * adminFunctionGuard.js — 管理者専用 Netlify Function の入口で Basic 認証を確認する
 *
 * 判定の正本は adminBasicAuth.js の decideAdminAccess。/admin/* を守る Edge と同じ認証情報を使う。
 * /.netlify/functions/* は Edge の対象外なので、関数ごとに最初の 1 行で呼ぶ。
 *
 * - fail closed: env が無ければ誰も通さない。
 * - OPTIONS も通さない。管理画面は同一オリジンなので preflight が要らず、
 *   OPTIONS を処理しない関数が本体を実行するのを防ぐ。
 * - 認証情報と判定理由を本文へ出さない。
 */
import { decideAdminAccess } from './adminBasicAuth.js';

const REALM = 'Basic realm="KEIBA Admin Panel"';
const BODY = JSON.stringify({ error: 'Authentication required' });
const HEADERS = Object.freeze({
  'WWW-Authenticate': REALM,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
});

const decodeBase64 = (b64) => Buffer.from(b64, 'base64').toString('utf8');

function isAllowed(header, env) {
  return decideAdminAccess({ header: header ?? null, env, decodeBase64 }).allow === true;
}

/** Request 形式の関数用。通すなら null、拒否なら Response を返す。 */
export function adminDenialResponse(request, env = process.env) {
  if (isAllowed(request?.headers?.get?.('authorization'), env)) return null;
  return new Response(BODY, { status: 401, headers: HEADERS });
}

/** event 形式の関数用。通すなら null、拒否なら { statusCode, headers, body } を返す。 */
export function adminDenialResult(event, env = process.env) {
  const h = event?.headers ?? {};
  if (isAllowed(h.authorization ?? h.Authorization, env)) return null;
  return { statusCode: 401, headers: { ...HEADERS }, body: BODY };
}
