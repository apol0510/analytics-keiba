/**
 * sharedFetch.mjs — keiba-data-shared 認証付き取得 helper（CLI/server 専用）
 *
 * ⚠️ ブラウザ／クライアントバンドルへ import しないこと。
 *    process.env のトークンを参照する server-only モジュールです。
 *
 * keiba-data-shared の private 化に備え、匿名 raw.githubusercontent.com 取得を廃し
 * GitHub Contents API（raw media type）+ Authorization 経由へ統一する。
 *
 * 公開 API:
 *   - SharedFetchError
 *   - resolveSharedToken(options?)
 *   - createSharedClient(options?) → { fetchJson, fetchText, listDirectory, resolveToken, owner, repo }
 *   - fetchSharedJson(path, options?)        // 既定クライアント（process.env / global fetch）
 *   - fetchSharedText(path, options?)
 *   - listSharedDirectory(path, options?)
 *   - fetchSharedFileFromEntry(entry, options?)   // listing entry から本文取得（1MB超は blobs API）
 *   - fetchSharedJsonFromEntry(entry, options?)
 *
 * 設計方針:
 *   - token 未設定は即時 TOKEN_MISSING（匿名 fallback 禁止）
 *   - 401/403 を 404 と混同しない
 *   - required=true の 404 は throw、required=false の 404 のみ null
 *   - retry は 5xx / timeout / rate-limit のみ。token/401/403/404/JSON破損/too-large は retry しない
 *   - token・Authorization・token 付き URL・秘密値を message/log へ含めない
 *   - 1MB 超ファイルは listing entry の size/sha を見て git blobs API（base64）へ切替（PR-AK-4）。
 *     encoding!==base64・content 欠落は INVALID_RESPONSE、本文破損は INVALID_JSON。
 */

/** エラー分類コード（taxonomy） */
export const SHARED_FETCH_CODES = Object.freeze({
  TOKEN_MISSING: 'TOKEN_MISSING',
  AUTH_FAILED: 'AUTH_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
});

export class SharedFetchError extends Error {
  /**
   * @param {string} code  SHARED_FETCH_CODES のいずれか
   * @param {string} message  ※token・秘密値を含めないこと
   * @param {{status?: number|null, path?: string|null, ref?: string|null}} [meta]
   */
  constructor(code, message, { status = null, path = null, ref = null } = {}) {
    super(message);
    this.name = 'SharedFetchError';
    this.code = code;
    this.status = status;
    this.path = path; // shared 内の path のみ（token を含まない）
    this.ref = ref;
  }
}

/** token 解決順（private 化後の正式運用は KEIBA_DATA_SHARED_TOKEN） */
export const TOKEN_ENV_NAMES = Object.freeze([
  'KEIBA_DATA_SHARED_TOKEN',
  'GITHUB_TOKEN_KEIBA_DATA_SHARED',
  'GITHUB_TOKEN',
]);

/**
 * 環境変数からトークンを解決する。未設定なら TOKEN_MISSING を throw（匿名 fallback 禁止）。
 * @param {{env?: Record<string,string|undefined>}} [options]
 * @returns {{token: string, source: string}}
 */
export function resolveSharedToken({ env = process.env } = {}) {
  for (const name of TOKEN_ENV_NAMES) {
    const raw = env?.[name];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return { token: raw.trim(), source: name };
    }
  }
  throw new SharedFetchError(
    SHARED_FETCH_CODES.TOKEN_MISSING,
    `No shared-repo token in environment. Set one of: ${TOKEN_ENV_NAMES.join(', ')} (KEIBA_DATA_SHARED_TOKEN recommended).`,
  );
}

const DEFAULTS = Object.freeze({
  owner: 'apol0510',
  repo: 'keiba-data-shared',
  ref: 'main',
  timeoutMs: 15000,
  retries: 2,
});

const RETRYABLE_CODES = new Set([
  SHARED_FETCH_CODES.SERVER_ERROR,
  SHARED_FETCH_CODES.TIMEOUT,
  SHARED_FETCH_CODES.RATE_LIMITED,
]);

const RAW_ACCEPT = 'application/vnd.github.raw+json';
const JSON_ACCEPT = 'application/vnd.github+json';

/**
 * テスト容易性のため fetch / env / sleep を依存注入できる。既定値としてのみ
 * process.env / globalThis.fetch を使用する（グローバルへ固定しない）。
 */
export function createSharedClient(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    env = process.env,
    owner = DEFAULTS.owner,
    repo = DEFAULTS.repo,
    defaultRef = DEFAULTS.ref,
    timeoutMs = DEFAULTS.timeoutMs,
    retries = DEFAULTS.retries,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'fetchImpl is not a function');
  }

  function buildContentsUrl(path, ref) {
    const cleanPath = String(path).replace(/^\/+/, '');
    const usedRef = ref || defaultRef;
    const url =
      `https://api.github.com/repos/${owner}/${repo}/contents/` +
      cleanPath.split('/').map(encodeURIComponent).join('/') +
      `?ref=${encodeURIComponent(usedRef)}`;
    return { url, path: cleanPath, ref: usedRef };
  }

  function backoffMs(attempt) {
    return Math.min(2000, 250 * 2 ** attempt);
  }

  function classify(status, headers, bodyText, path, ref) {
    if (status === 401) {
      return new SharedFetchError(SHARED_FETCH_CODES.AUTH_FAILED, 'Authentication failed (401).', { status, path, ref });
    }
    if (status === 403) {
      if (/too large/i.test(bodyText || '')) {
        return new SharedFetchError(SHARED_FETCH_CODES.FILE_TOO_LARGE, 'File too large for Contents API (use blobs API).', { status, path, ref });
      }
      const remaining = headers?.get?.('x-ratelimit-remaining');
      const retryAfter = headers?.get?.('retry-after');
      if (retryAfter != null || remaining === '0') {
        return new SharedFetchError(SHARED_FETCH_CODES.RATE_LIMITED, 'Rate limited (403).', { status, path, ref });
      }
      return new SharedFetchError(SHARED_FETCH_CODES.FORBIDDEN, 'Forbidden (403).', { status, path, ref });
    }
    if (status === 429) {
      return new SharedFetchError(SHARED_FETCH_CODES.RATE_LIMITED, 'Rate limited (429).', { status, path, ref });
    }
    if (status === 404) {
      return new SharedFetchError(SHARED_FETCH_CODES.NOT_FOUND, 'Not found (404).', { status, path, ref });
    }
    if (status >= 500) {
      return new SharedFetchError(SHARED_FETCH_CODES.SERVER_ERROR, `Server error (${status}).`, { status, path, ref });
    }
    return new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, `Unexpected status (${status}).`, { status, path, ref });
  }

  async function singleAttempt(url, accept, path, ref, token) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept, 'User-Agent': 'ak-shared-fetch' },
        signal: ac ? ac.signal : undefined,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new SharedFetchError(SHARED_FETCH_CODES.TIMEOUT, `Request timed out after ${timeoutMs}ms.`, { path, ref });
      }
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'Network request failed.', { path, ref });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || typeof res.status !== 'number') {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'fetch returned an invalid response.', { path, ref });
    }
    if (res.status >= 200 && res.status < 300) return res;
    let bodyText = '';
    if (res.status === 403 && typeof res.text === 'function') {
      try { bodyText = await res.text(); } catch { /* best-effort */ }
    }
    throw classify(res.status, res.headers, bodyText, path, ref);
  }

  async function requestWithRetry(url, accept, path, ref) {
    const { token } = resolveSharedToken({ env }); // TOKEN_MISSING は retry しない
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await singleAttempt(url, accept, path, ref, token);
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof SharedFetchError && RETRYABLE_CODES.has(e.code);
        if (retryable && attempt < retries) {
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async function fetchText(path, { ref, required = true } = {}) {
    const { url, path: p, ref: r } = buildContentsUrl(path, ref);
    let res;
    try {
      res = await requestWithRetry(url, RAW_ACCEPT, p, r);
    } catch (e) {
      if (required === false && e instanceof SharedFetchError && e.code === SHARED_FETCH_CODES.NOT_FOUND) {
        return null;
      }
      throw e;
    }
    return res.text();
  }

  async function fetchJson(path, { ref, required = true } = {}) {
    const { path: p, ref: r } = buildContentsUrl(path, ref);
    const text = await fetchText(path, { ref, required });
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_JSON, 'Response body is not valid JSON.', { path: p, ref: r });
    }
  }

  async function listDirectory(path, { ref, required = true } = {}) {
    const { url, path: p, ref: r } = buildContentsUrl(path, ref);
    let res;
    try {
      res = await requestWithRetry(url, JSON_ACCEPT, p, r);
    } catch (e) {
      if (required === false && e instanceof SharedFetchError && e.code === SHARED_FETCH_CODES.NOT_FOUND) {
        return null;
      }
      throw e;
    }
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_JSON, 'Directory listing is not valid JSON.', { path: p, ref: r });
    }
    if (!Array.isArray(body)) {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'Directory listing is not an array.', { path: p, ref: r });
    }
    return body.map((e) => ({ name: e.name, path: e.path, sha: e.sha, size: e.size, type: e.type }));
  }

  // GitHub Contents API は ~1MB 上限。超過ファイルは git blobs API（base64）で取得する。
  const CONTENTS_MAX_BYTES = 1024 * 1024;

  function buildBlobUrl(sha) {
    return `https://api.github.com/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(String(sha))}`;
  }

  async function fetchBlobBySha(sha, path, ref) {
    const res = await requestWithRetry(buildBlobUrl(sha), JSON_ACCEPT, path, ref);
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_JSON, 'Blob response is not valid JSON.', { path, ref });
    }
    if (!body || body.encoding !== 'base64') {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'Blob encoding is not base64.', { path, ref });
    }
    if (typeof body.content !== 'string') {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'Blob content is missing.', { path, ref });
    }
    return Buffer.from(body.content, 'base64').toString('utf-8'); // base64 本文はログに出さない
  }

  /**
   * listing entry（listDirectory の要素）から本文を取得する。
   * size が 1MB を超える場合のみ git blobs API（sha 経由）へ切り替える。
   * 既定 required=true（一覧済みファイルの 404 は fatal）。
   */
  async function fetchFileFromEntry(entry, { ref, required = true } = {}) {
    if (!entry || typeof entry.path !== 'string' || entry.path === '') {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'Invalid directory entry (path missing).', {});
    }
    const usedRef = ref || defaultRef;
    if (typeof entry.size === 'number' && entry.size > CONTENTS_MAX_BYTES) {
      if (typeof entry.sha !== 'string' || entry.sha === '') {
        throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_RESPONSE, 'Large entry missing sha for blobs API.', { path: entry.path, ref: usedRef });
      }
      try {
        return await fetchBlobBySha(entry.sha, entry.path, usedRef);
      } catch (e) {
        if (required === false && e instanceof SharedFetchError && e.code === SHARED_FETCH_CODES.NOT_FOUND) return null;
        throw e;
      }
    }
    return fetchText(entry.path, { ref: usedRef, required });
  }

  async function fetchJsonFromEntry(entry, options = {}) {
    const text = await fetchFileFromEntry(entry, options);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new SharedFetchError(SHARED_FETCH_CODES.INVALID_JSON, 'Entry body is not valid JSON.', { path: entry?.path ?? null, ref: options?.ref ?? null });
    }
  }

  return {
    fetchJson,
    fetchText,
    listDirectory,
    fetchFileFromEntry,
    fetchJsonFromEntry,
    resolveToken: () => resolveSharedToken({ env }),
    owner,
    repo,
  };
}

// 既定クライアント（process.env / global fetch）。import 時点では token を解決しない。
const defaultClient = createSharedClient();

export function fetchSharedJson(path, options) {
  return defaultClient.fetchJson(path, options);
}
export function fetchSharedText(path, options) {
  return defaultClient.fetchText(path, options);
}
export function listSharedDirectory(path, options) {
  return defaultClient.listDirectory(path, options);
}
export function fetchSharedFileFromEntry(entry, options) {
  return defaultClient.fetchFileFromEntry(entry, options);
}
export function fetchSharedJsonFromEntry(entry, options) {
  return defaultClient.fetchJsonFromEntry(entry, options);
}
