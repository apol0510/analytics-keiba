/**
 * sendgridSignature.js — SendGrid Event Webhook 署名検証の**単一源**（純粋関数・env 非依存）。
 *
 * 背景（2026-07-21）:
 * `netlify/functions/sendgrid-webhook.js` は署名検証・認証を一切持たないまま公開 URL として
 * 稼働しており、任意の第三者が `[{"event":"bounce","email":"<任意>"}]` を POST するだけで
 * `EmailBlacklist` に HARD_BOUNCE を登録できた（= 任意顧客をメルマガ配信対象から恒久除外できる）。
 * `EmailBlacklist` は `newsletter-preview.js` が配信除外に使う実運用の suppression list である。
 *
 * 恒久ルール:
 * - **検証鍵が未設定なら fail closed**（403・Airtable へ 1 バイトも書かない）。「鍵が無いので素通り」は禁止。
 * - **検証に成功したリクエストの body だけを parse する**（未検証入力を構文解析・処理しない）。
 * - 判定結果に **鍵・署名・timestamp・メールアドレスの値そのものを含めない**（reason コードのみ）。
 * - 検証不能（例外・不正な鍵）は **ok=false**。例外を上位へ投げて 500 にしない（情報を漏らさない）。
 *
 * 署名仕様（SendGrid Event Webhook / Signed Event Webhook）:
 * - 署名対象は **`timestamp + rawBody` の連結文字列**（rawBody は**受信したままのバイト列**。
 *   JSON.parse → JSON.stringify した再直列化では**一致しない**）。
 * - `X-Twilio-Email-Event-Webhook-Signature`: base64 の **DER ECDSA** 署名
 * - `X-Twilio-Email-Event-Webhook-Timestamp`: UNIX 秒
 * - 検証鍵: base64 の **SPKI(DER) 公開鍵**（ECDSA P-256）
 */

import crypto from 'node:crypto';

/** 署名ヘッダ名（小文字。Netlify の Request Headers は小文字で引く）。 */
export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/** timestamp の許容ずれ（秒）。リプレイ窓を絞る。 */
export const DEFAULT_MAX_SKEW_SEC = 600;

/** fail closed の理由コード（**値そのものは絶対に含めない**）。 */
export const SIGNATURE_REASON = Object.freeze({
  KEY_MISSING: 'verification_key_missing',     // env 未設定 → 403（素通りさせない）
  KEY_INVALID: 'verification_key_invalid',     // 鍵が base64/SPKI として解釈できない
  SIGNATURE_MISSING: 'signature_missing',
  TIMESTAMP_MISSING: 'timestamp_missing',
  TIMESTAMP_INVALID: 'timestamp_invalid',      // 数値でない
  TIMESTAMP_SKEW: 'timestamp_skew',            // 許容窓の外（リプレイ）
  BODY_MISSING: 'body_missing',
  SIGNATURE_MISMATCH: 'signature_mismatch',    // 署名不一致（改竄 / spoof）
  VERIFY_ERROR: 'verify_error',                // 検証中の例外（判定不能 → fail closed）
});

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * base64 SPKI(DER) の検証鍵を KeyObject へ変換する。
 * @returns {{ok: true, key: crypto.KeyObject} | {ok: false, reason: string}}
 */
export function parseVerificationKey(publicKeyBase64) {
  if (!isNonEmptyString(publicKeyBase64)) return { ok: false, reason: SIGNATURE_REASON.KEY_MISSING };
  try {
    const der = Buffer.from(publicKeyBase64.trim(), 'base64');
    if (der.length === 0) return { ok: false, reason: SIGNATURE_REASON.KEY_INVALID };
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return { ok: true, key };
  } catch {
    // 例外メッセージは外へ出さない（鍵の内容が漏れうるため）
    return { ok: false, reason: SIGNATURE_REASON.KEY_INVALID };
  }
}

/**
 * timestamp の妥当性（数値であること・許容窓内であること）を検証する。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyTimestamp({ timestamp, nowMs = Date.now(), maxSkewSec = DEFAULT_MAX_SKEW_SEC }) {
  if (!isNonEmptyString(timestamp)) return { ok: false, reason: SIGNATURE_REASON.TIMESTAMP_MISSING };
  const ts = Number(timestamp.trim());
  if (!Number.isFinite(ts)) return { ok: false, reason: SIGNATURE_REASON.TIMESTAMP_INVALID };
  const skewSec = Math.abs(nowMs / 1000 - ts);
  if (skewSec > maxSkewSec) return { ok: false, reason: SIGNATURE_REASON.TIMESTAMP_SKEW };
  return { ok: true };
}

/**
 * SendGrid Event Webhook の署名を検証する（**この関数だけが真偽を決める**）。
 *
 * @param {object} input
 * @param {string} input.publicKeyBase64 検証鍵（base64 SPKI DER）
 * @param {string} input.signatureBase64 `X-Twilio-Email-Event-Webhook-Signature`
 * @param {string} input.timestamp       `X-Twilio-Email-Event-Webhook-Timestamp`
 * @param {string} input.rawBody         **受信したままの** body 文字列
 * @param {number} [input.nowMs]
 * @param {number} [input.maxSkewSec]
 * @returns {{ok: true} | {ok: false, reason: string}} 失敗時は **reason コードのみ**
 */
export function verifySendgridEventWebhookSignature({
  publicKeyBase64,
  signatureBase64,
  timestamp,
  rawBody,
  nowMs = Date.now(),
  maxSkewSec = DEFAULT_MAX_SKEW_SEC,
}) {
  // 鍵未設定は「検証省略」ではなく **拒否**（素通りさせない）
  const parsed = parseVerificationKey(publicKeyBase64);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  if (!isNonEmptyString(signatureBase64)) return { ok: false, reason: SIGNATURE_REASON.SIGNATURE_MISSING };
  if (typeof rawBody !== 'string') return { ok: false, reason: SIGNATURE_REASON.BODY_MISSING };

  const ts = verifyTimestamp({ timestamp, nowMs, maxSkewSec });
  if (!ts.ok) return { ok: false, reason: ts.reason };

  try {
    const verifier = crypto.createVerify('SHA256');
    // 署名対象は timestamp + rawBody（再直列化した JSON では一致しない）
    verifier.update(timestamp.trim() + rawBody);
    verifier.end();

    const signature = Buffer.from(signatureBase64.trim(), 'base64');
    if (signature.length === 0) return { ok: false, reason: SIGNATURE_REASON.SIGNATURE_MISMATCH };

    const valid = verifier.verify(parsed.key, signature);
    return valid ? { ok: true } : { ok: false, reason: SIGNATURE_REASON.SIGNATURE_MISMATCH };
  } catch {
    // 不正な DER 署名等で verify が throw することがある。判定不能は fail closed。
    return { ok: false, reason: SIGNATURE_REASON.VERIFY_ERROR };
  }
}

/**
 * 検証結果 → HTTP ステータス。
 * **鍵未設定も含めてすべて 403**（設定不備を 500 にして「一時障害だから後で届く」と誤解させない）。
 */
export function signatureFailureStatus() {
  return 403;
}
