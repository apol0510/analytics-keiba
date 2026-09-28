/**
 * gscClient.js — Google Search Console API を読むだけのクライアント（依存なし・fetch 注入可）
 *
 * 認証はサービスアカウントの JSON 鍵（GitHub secret `GSC_SERVICE_ACCOUNT_JSON`）。
 * スコープは **読み取り専用**（webmasters.readonly）。書き込み系 API は呼ばない。
 * ⚠️ 鍵の値はログ・例外メッセージに出さない。
 */
import { createSign } from 'node:crypto';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GscError extends Error {
  constructor(code, detail) { super(`gsc:${code}`); this.name = 'GscError'; this.code = code; this.detail = detail || null; }
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** サービスアカウント鍵の JSON を検査して必要な 2 項目だけ返す */
export function parseServiceAccount(raw) {
  if (!raw || !String(raw).trim()) throw new GscError('credentials_missing');
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new GscError('credentials_invalid_json'); }
  if (!j.client_email || !j.private_key) throw new GscError('credentials_incomplete');
  return { clientEmail: String(j.client_email), privateKey: String(j.private_key) };
}

/** JWT（RS256）を作る */
export function buildJwt({ clientEmail, privateKey }, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claim = b64url({ iss: clientEmail, scope: GSC_SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claim}`);
  return `${head}.${claim}.${signer.sign(privateKey, 'base64url')}`;
}

export function createGscClient({ credentials, fetchImpl = fetch, siteUrl }) {
  const sa = parseServiceAccount(credentials);
  let token = null;

  const getToken = async () => {
    if (token) return token;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(sa) }).toString(),
    });
    if (!res.ok) throw new GscError('auth_failed', `HTTP ${res.status}`);
    const j = await res.json();
    if (!j.access_token) throw new GscError('auth_failed', 'no_token');
    token = j.access_token;
    return token;
  };

  const post = async (url, body) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 403) throw new GscError('no_property_access', `${sa.clientEmail} に ${siteUrl} の権限が無い`);
    if (!res.ok) throw new GscError('api_error', `HTTP ${res.status}`);
    return res.json();
  };

  return {
    clientEmail: sa.clientEmail,
    /** 検索パフォーマンス（searchAnalytics.query）*/
    async searchAnalytics(body) {
      const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
      return post(url, { rowLimit: 25000, dataState: 'final', ...body });
    },
    /** URL 検査（インデックス登録の状態）*/
    async inspect(inspectionUrl) {
      return post('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl, siteUrl });
    },
  };
}
