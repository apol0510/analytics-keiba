/**
 * canaryAuth.js — admin-canary の認可判定（純粋関数・IO なし・単一源）。
 *
 * secret 照合 / allowlist の exactly-one 強制 / recordId の完全一致 をここに集約する。
 * 拒否理由の文字列には **recordId・secret・Base/Table を一切含めない**ため、
 * 呼び出し側はそのまま応答本文・ログに使ってよい（識別子の露出が起きない）。
 *
 * 認証（secret + allowlist）と recordId 照合を **2 段に分割**する。これにより Function 側は
 * 「認証・allowlist 検証を body parse より先」に行え、**未認証リクエストの body は parse しない**
 * （secret-first fail closed）。未認証の構文エラーを外部へ区別して返さない設計を可能にする。
 */

/** カンマ区切り allowlist を trim + 空要素除去して配列化。 */
export function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 第 1 段: secret 認証 + allowlist exactly-one 検証（**body parse より先に呼ぶ**）。
 *
 * 評価順（fail closed・secret-first）:
 *  1. secret 未設定 → 503
 *  2. secret 不一致 → 403
 *  3. allowlist が「ちょうど 1 件」でない（0 件・2 件以上）→ 403
 *
 * @returns {{ok:true, allowedRecordId:string} | {ok:false, status:number, error:string}}
 */
export function authorizeCanaryAccess({ configuredSecret, providedSecret, allowlistRaw }) {
  if (!configuredSecret) return { ok: false, status: 503, error: 'canary secret not configured' };
  if (providedSecret !== configuredSecret) return { ok: false, status: 403, error: 'Forbidden' };

  const allowlist = parseAllowlist(allowlistRaw);
  if (allowlist.length !== 1) {
    return { ok: false, status: 403, error: 'canary allowlist must contain exactly one record id' };
  }

  return { ok: true, allowedRecordId: allowlist[0] };
}

/**
 * 第 2 段: recordId 照合（**認証成功後・body parse 後に呼ぶ**）。
 *
 *  4. recordId 未指定 → 400
 *  5. recordId が唯一の許可 ID と完全一致しない → 403（recordId をエコーしない）
 *
 * @returns {{ok:true, recordId:string} | {ok:false, status:number, error:string}}
 */
export function matchCanaryRecordId(allowedRecordId, recordId) {
  if (!recordId) return { ok: false, status: 400, error: 'recordId required' };
  // 唯一の許可 ID と完全一致のみ通す。拒否理由に recordId をエコーしない。
  if (recordId !== allowedRecordId) return { ok: false, status: 403, error: 'recordId not allowed' };
  return { ok: true, recordId };
}

/**
 * 2 段をまとめた便宜ラッパー（body を既に持っている呼び出し・テスト用）。
 * Function 本体では使わない（本体は access → body parse → match の順で 2 段を直接呼ぶ）。
 *
 * @returns {{ok:true, recordId:string} | {ok:false, status:number, error:string}}
 */
export function authorizeCanaryRequest({ configuredSecret, providedSecret, allowlistRaw, recordId }) {
  const access = authorizeCanaryAccess({ configuredSecret, providedSecret, allowlistRaw });
  if (!access.ok) return access;
  return matchCanaryRecordId(access.allowedRecordId, recordId);
}
