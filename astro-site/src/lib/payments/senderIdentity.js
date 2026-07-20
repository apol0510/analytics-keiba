/**
 * senderIdentity.js — 入金確認メール（v2）の**送信元契約の単一源**（純粋関数・env 非依存の判定）。
 *
 * analytics-keiba (AK) の正式送信元は `support@keiba.link`。
 * カナリア (`admin-canary-payment-email`) と通常 worker (`payment-email-worker`) は
 * **同一の契約**をここから取得する（別実装・別定数を持たない）。
 *
 * 恒久ルール:
 * - 送信元は **env `SENDGRID_FROM_EMAIL` が正式値と一致するときだけ**確定する。
 * - **未設定 / 空 / 不一致は送信前に fail closed**（SendGrid へ POST しない）。
 * - `noreply@keiba.link` を含む**いかなる fallback も禁止**（email-config.js の
 *   `FROM_EMAIL` はニュースレター等の別経路用であり、決済メール経路では参照しない）。
 * - 判定結果に **env の値そのものを含めない**（reason コードのみ返す）。
 *
 * 正規化は repo 既存方針に合わせる: `String(v).trim().toLowerCase()`
 * （bank-transfer-application.js / auth-user.js / send-magic-link.js と同一）。
 */

/** AK の正式送信元（唯一の許可値）。 */
export const OFFICIAL_FROM_EMAIL = 'support@keiba.link';

/** 送信元として表示する名前。 */
export const OFFICIAL_FROM_NAME = 'KEIBA Analytics';

/** fail closed の理由コード（値そのものは絶対に含めない）。 */
export const SENDER_REASON = Object.freeze({
  MISSING: 'sender_env_missing',   // env が未設定（undefined / null）
  EMPTY: 'sender_env_empty',       // 空文字 / 空白のみ
  MISMATCH: 'sender_env_mismatch', // 正式値と一致しない
});

/** repo 既存方針の正規化（前後空白除去 + 小文字化）。 */
function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 送信元を確定する。正式値と一致するときだけ ok。
 *
 * @param {Record<string, unknown>} [env] 既定は process.env
 * @returns {{ok: true, email: string, name: string} | {ok: false, reason: string}}
 *   ok=false のとき **reason コードのみ**（env の値は含めない）。
 */
export function resolveVerifiedSender(env = process.env) {
  const raw = env ? env.SENDGRID_FROM_EMAIL : undefined;
  if (raw === undefined || raw === null) return { ok: false, reason: SENDER_REASON.MISSING };

  const normalized = normalize(raw);
  if (normalized === '') return { ok: false, reason: SENDER_REASON.EMPTY };
  if (normalized !== OFFICIAL_FROM_EMAIL) return { ok: false, reason: SENDER_REASON.MISMATCH };

  // 正規化済みの正式値を返す（env の綴りをそのまま使わない＝表記ゆれを持ち込まない）。
  return { ok: true, email: OFFICIAL_FROM_EMAIL, name: OFFICIAL_FROM_NAME };
}

/** 送信可能な送信元が構成されているか（worker の送信前ガード用）。 */
export function hasVerifiedSender(env = process.env) {
  return resolveVerifiedSender(env).ok === true;
}
