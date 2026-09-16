/**
 * unsubscribeSignature.js — 配信停止 URL の改ざん防止（純粋・IO なし）
 *
 * ## なぜ要るか（2026-09-16 / MK 指摘）
 *
 * 配信停止 URL は `?email=…&brand=…` だけで署名が無く、`parseUnsubscribeRequest` は
 * **URL の email をそのまま停止対象として信頼**していた。つまり第三者が URL の email を
 * 別アドレスへ書き換えて RFC 8058 形式の POST を投げるだけで、**他人を配信停止できた**。
 * 完成条件「不正リクエストで他人を unsubscribe できない」を満たしていなかった。
 *
 * ## 方式
 *
 *     sig = HMAC-SHA256(signingKey, `${brand}\n${normalizedEmail}`) の先頭 32 hex
 *
 * `brand` も署名対象に入れる。入れないと片方のブランドの URL を使い回して
 * もう片方を止められる。
 *
 * ## 鍵（新しい production env を増やさない）
 *
 * | 優先 | 由来 | 用途 |
 * |---|---|---|
 * | 1 | `UNSUBSCRIBE_LINK_SECRET` | 専用鍵。将来 MK が完全分離したくなったとき用（任意）|
 * | 2 | `PROMO_OFFER_SECRET` から**派生** | 既定。production に設定済み |
 *
 * 派生は `HMAC-SHA256(PROMO_OFFER_SECRET, 'ak:unsubscribe-link:v1')`。
 * **一方向なので、この鍵が漏れても offer トークンは偽造できない**（用途分離）。
 * `PROMO_OFFER_SECRET` は「受信者ごとのメールリンクに署名する」という同じ用途の鍵なので、
 * 派生して再利用するのが妥当と判断した（admin secret のような bearer 資格情報は使わない）。
 *
 * ## 鍵の入れ替え（リンクを壊さない）
 *
 * **署名は優先鍵 1 本、検証は設定されている全鍵**で行う。専用鍵を後から足しても、
 * 既に配ったリンク（派生鍵で署名）は検証を通り続ける。
 *
 * ## 署名の無いリンク（既に送信済みのメール）
 *
 * 既定は **strict**（署名必須）。`UNSUBSCRIBE_ALLOW_UNSIGNED=1` を立てている間だけ、
 * 署名の無いリクエストを受理する。既送信メールの救済が必要なときに **MK が明示的に開ける**
 * ためのもので、開いている間は改ざんも通る（＝完成条件を満たさない状態）。
 *
 * ⚠️ 鍵・署名・生アドレスを**ログにも例外にも載せない**。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 派生鍵のラベル。**変えると既存リンクが全部無効になる**（変えないこと）。 */
export const DERIVED_KEY_LABEL = 'ak:unsubscribe-link:v1';

/** 署名の長さ（hex）。URL を短く保ちつつ総当たりには十分。 */
export const SIGNATURE_HEX_LENGTH = 32;

/** 鍵として短すぎる値は使わない。 */
const MIN_SECRET_LENGTH = 16;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 署名対象の正規化。**検証側と生成側で必ず同じ**規則を使う。 */
export function canonicalUnsubscribePayload({ email, brand } = {}) {
  const e = String(email ?? '').trim().toLowerCase();
  const b = String(brand ?? '').trim().toLowerCase();
  return `${b}\n${e}`;
}

/**
 * env から鍵を解決する。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{signing: string|null, accept: string[]}}
 *   `signing` … 新しい URL に使う鍵（無ければ null＝署名を付けられない）
 *   `accept`  … 検証で受理する鍵（入れ替え中も既存リンクを壊さない）
 */
export function resolveUnsubscribeSigningKeys(env = {}) {
  const accept = [];

  const dedicated = str(env.UNSUBSCRIBE_LINK_SECRET);
  if (dedicated.length >= MIN_SECRET_LENGTH) accept.push(dedicated);

  const promo = str(env.PROMO_OFFER_SECRET);
  if (promo.length >= MIN_SECRET_LENGTH) {
    // 用途分離した派生鍵。一方向なので offer トークンの偽造には使えない
    accept.push(createHmac('sha256', promo).update(DERIVED_KEY_LABEL, 'utf8').digest('hex'));
  }

  return { signing: accept.length > 0 ? accept[0] : null, accept };
}

/**
 * 署名を作る。鍵が無ければ `null`（呼び出し側は署名なしの URL を出す）。
 *
 * @param {{email: string, brand: string, key: string|null}} input
 * @returns {string|null}
 */
export function signUnsubscribe({ email, brand, key } = {}) {
  const k = str(key);
  if (!k) return null;
  return createHmac('sha256', k)
    .update(canonicalUnsubscribePayload({ email, brand }), 'utf8')
    .digest('hex')
    .slice(0, SIGNATURE_HEX_LENGTH);
}

/** 長さを揃えて定数時間比較する（早期 return で長さを漏らさない）。 */
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) {
    // 長さが違っても同じだけ比較する
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

/** 検証結果。 */
export const SIGNATURE_CHECK = Object.freeze({
  /** 署名が一致した */
  VALID: 'valid',
  /** 署名が無い（既送信メール由来の可能性）*/
  MISSING: 'missing',
  /** 署名があるが一致しない（改ざん）*/
  INVALID: 'invalid',
  /** 鍵が 1 本も無い（検証できない）*/
  NO_KEY: 'no-key',
});

/**
 * 署名を検証する。**Airtable / Redis へ触る前に**呼ぶこと。
 *
 * @param {{email: string, brand: string, sig: string|null, keys: string[]}} input
 * @returns {string} SIGNATURE_CHECK のいずれか
 */
export function verifyUnsubscribeSignature({ email, brand, sig, keys } = {}) {
  const provided = str(sig);
  const list = Array.isArray(keys) ? keys.filter((k) => str(k)) : [];
  if (list.length === 0) return SIGNATURE_CHECK.NO_KEY;
  if (!provided) return SIGNATURE_CHECK.MISSING;
  for (const k of list) {
    const expected = signUnsubscribe({ email, brand, key: k });
    if (expected && safeEqualHex(expected, provided)) return SIGNATURE_CHECK.VALID;
  }
  return SIGNATURE_CHECK.INVALID;
}

/**
 * 署名の無いリクエストを受理してよいか。**既定は false（strict）**。
 *
 * ⚠️ `UNSUBSCRIBE_ALLOW_UNSIGNED=1` の間は改ざんも通る。
 *    既に送信済みのメール（署名なしリンク）を救済したいときだけ、期間を決めて開ける。
 */
export function isLegacyUnsignedAllowed(env = {}) {
  return String((env && env.UNSUBSCRIBE_ALLOW_UNSIGNED) || '') === '1';
}

/**
 * 検証結果 → 受理してよいか（**書き込みに到達してよいか**）。
 *
 * @param {{check: string, allowUnsigned: boolean}} input
 * @returns {{ok: boolean, reason: string|null}}
 */
export function decideSignatureAcceptance({ check, allowUnsigned } = {}) {
  if (check === SIGNATURE_CHECK.VALID) return { ok: true, reason: null };
  // 鍵が無い＝こちらの設定不備。**改ざんを通すより止める**（直す機会を失わない）
  if (check === SIGNATURE_CHECK.NO_KEY) return { ok: false, reason: 'signature-key-missing' };
  if (check === SIGNATURE_CHECK.MISSING) {
    return allowUnsigned ? { ok: true, reason: null } : { ok: false, reason: 'signature-required' };
  }
  // 改ざんは**どんな設定でも**通さない
  return { ok: false, reason: 'signature-invalid' };
}
