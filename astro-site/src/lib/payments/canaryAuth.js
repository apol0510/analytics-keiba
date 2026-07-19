/**
 * canaryAuth.js — admin-canary の認可判定（純粋関数・IO なし・単一源）。
 *
 * secret 照合 / allowlist の exactly-one 強制 / recordId の完全一致 をここに集約する。
 * 拒否理由の文字列には **recordId・secret・Base/Table を一切含めない**ため、
 * 呼び出し側はそのまま応答本文・ログに使ってよい（識別子の露出が起きない）。
 */

/** カンマ区切り allowlist を trim + 空要素除去して配列化。 */
export function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * カナリア呼び出しの認可判定。
 *
 * 評価順（fail closed）:
 *  1. secret 未設定 → 503
 *  2. secret 不一致 → 403
 *  3. allowlist が「ちょうど 1 件」でない（0 件・2 件以上）→ 403
 *  4. recordId 未指定 → 400
 *  5. recordId が唯一の許可 ID と完全一致しない → 403
 *
 * @returns {{ok:true, recordId:string} | {ok:false, status:number, error:string}}
 */
export function authorizeCanaryRequest({ configuredSecret, providedSecret, allowlistRaw, recordId }) {
  if (!configuredSecret) return { ok: false, status: 503, error: 'canary secret not configured' };
  if (providedSecret !== configuredSecret) return { ok: false, status: 403, error: 'Forbidden' };

  const allowlist = parseAllowlist(allowlistRaw);
  if (allowlist.length !== 1) {
    return { ok: false, status: 403, error: 'canary allowlist must contain exactly one record id' };
  }

  if (!recordId) return { ok: false, status: 400, error: 'recordId required' };
  // 唯一の許可 ID と完全一致のみ通す。拒否理由に recordId をエコーしない。
  if (recordId !== allowlist[0]) return { ok: false, status: 403, error: 'recordId not allowed' };

  return { ok: true, recordId };
}
