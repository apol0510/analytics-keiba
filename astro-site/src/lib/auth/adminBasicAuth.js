/**
 * adminBasicAuth.js — 管理画面 Basic 認証の判定（純粋・依存ゼロ）
 *
 * ── なぜ切り出すか ────────────────────────────────────────────────
 * `netlify/edge-functions/admin-auth.ts` は認証情報を **ソースへ平文で持っていた**。
 * git に追跡され、履歴にも残り、本番で有効なまま約 3 ヶ月運用されていた。
 * repo を読める者は誰でも管理画面へ入れる状態だったため、値を env へ移す。
 *
 * このモジュールは **Deno（Edge Runtime）と Node の両方で動く**ようにするため、
 * import を 1 つも持たない。`atob` / `TextEncoder` のような環境依存 API も使わない
 * （base64 の復号は呼び出し側が行い、ここへは復号済み文字列を渡す）。
 *
 * ── 設計上の絶対条件 ──────────────────────────────────────────────
 * - **fail closed**: 認証情報が env に無ければ「誰も通さない」。
 *   未設定を「認証不要」と解釈してはいけない（管理画面が全世界へ開く）。
 * - **認証情報を戻り値・ログ・レスポンス本文へ絶対に載せない。**
 * - 比較は**長さで早期 return しない定数時間**にする（総当たりの手掛かりを与えない）。
 */

/** 判定結果のコード。呼び出し側は理由に関わらず本文を出し分けない方が安全。 */
export const ADMIN_AUTH = Object.freeze({
  /** 通す */
  OK: 'ok',
  /** 認証ヘッダが無い → 401 + WWW-Authenticate */
  NO_HEADER: 'no_header',
  /** ヘッダが壊れている（Basic でない / base64 でない / 区切りが無い） */
  MALFORMED: 'malformed',
  /** 認証情報が一致しない */
  MISMATCH: 'mismatch',
  /** env 未設定 → **誰も通さない**（設定ミスを公開状態にしない） */
  NOT_CONFIGURED: 'not_configured',
});

/**
 * 定数時間の文字列比較。
 *
 * 長さが違う場合でも即 return せず、必ず同じ回数だけ回す。
 * 早期 return すると応答時間の差から正解の長さが漏れる。
 */
export function safeEqual(a, b) {
  const s = typeof a === 'string' ? a : '';
  const t = typeof b === 'string' ? b : '';
  const len = Math.max(s.length, t.length);
  // 長さの不一致自体も差分として畳み込む
  let diff = s.length ^ t.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (s.charCodeAt(i) || 0) ^ (t.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * env から期待する認証情報を読む。**どちらか一方でも欠けたら未設定扱い**。
 *
 * @param {{ ADMIN_BASIC_AUTH_USER?: string, ADMIN_BASIC_AUTH_PASSWORD?: string }} env
 * @returns {{ configured: boolean, user: string, password: string }}
 */
export function readAdminCredentials(env) {
  const e = env && typeof env === 'object' ? env : {};
  const user = typeof e.ADMIN_BASIC_AUTH_USER === 'string' ? e.ADMIN_BASIC_AUTH_USER.trim() : '';
  const password = typeof e.ADMIN_BASIC_AUTH_PASSWORD === 'string' ? e.ADMIN_BASIC_AUTH_PASSWORD : '';
  return { configured: user !== '' && password !== '', user, password };
}

/**
 * `Authorization` ヘッダを分解する。**壊れていても例外を投げない**。
 *
 * ⚠️ 旧実装は `atob(header.split(' ')[1])` を素で呼んでいたため、
 *    `Authorization: Basic` のように値が欠けたヘッダや base64 でない値で
 *    **例外 → edge function invocation failed（502）** になった。
 *    502 は「認証が壊れている」ことを外部へ知らせる情報でもあるため、握って 401 にする。
 *
 * @param {string|null} header
 * @param {(b64: string) => string} decodeBase64  環境の base64 復号（Deno/Node どちらでも注入可）
 * @returns {{ ok: true, user: string, password: string } | { ok: false, reason: string }}
 */
export function parseBasicAuthHeader(header, decodeBase64) {
  const raw = typeof header === 'string' ? header.trim() : '';
  if (raw === '') return { ok: false, reason: ADMIN_AUTH.NO_HEADER };

  const sp = raw.indexOf(' ');
  if (sp < 0) return { ok: false, reason: ADMIN_AUTH.MALFORMED };
  const scheme = raw.slice(0, sp).toLowerCase();
  const value = raw.slice(sp + 1).trim();
  if (scheme !== 'basic' || value === '') return { ok: false, reason: ADMIN_AUTH.MALFORMED };

  let decoded;
  try {
    decoded = decodeBase64(value);
  } catch {
    return { ok: false, reason: ADMIN_AUTH.MALFORMED };
  }
  if (typeof decoded !== 'string') return { ok: false, reason: ADMIN_AUTH.MALFORMED };

  // パスワードに ':' が含まれてよい（最初の ':' だけで分ける）
  const colon = decoded.indexOf(':');
  if (colon < 0) return { ok: false, reason: ADMIN_AUTH.MALFORMED };
  return { ok: true, user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * 管理画面へ通してよいかを決める。**この関数だけが判定の正本**。
 *
 * @param {{
 *   header?: string|null,
 *   env?: object,
 *   decodeBase64: (b64: string) => string,
 * }} input
 * @returns {{ allow: boolean, reason: string }}  reason は固定コード（認証情報は含まない）
 */
export function decideAdminAccess({ header, env, decodeBase64 } = {}) {
  const creds = readAdminCredentials(env);
  // ⚠️ 未設定は **通さない**。ここを allow に倒すと管理画面が誰でも開ける。
  if (!creds.configured) return { allow: false, reason: ADMIN_AUTH.NOT_CONFIGURED };

  const parsed = parseBasicAuthHeader(header, decodeBase64);
  if (!parsed.ok) return { allow: false, reason: parsed.reason };

  // どちらも必ず評価する（&& の短絡で user 側だけの比較時間にしない）
  const userOk = safeEqual(parsed.user, creds.user);
  const passOk = safeEqual(parsed.password, creds.password);
  return userOk && passOk
    ? { allow: true, reason: ADMIN_AUTH.OK }
    : { allow: false, reason: ADMIN_AUTH.MISMATCH };
}

export default decideAdminAccess;
