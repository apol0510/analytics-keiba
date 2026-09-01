/**
 * emailChangeStore.js — メールアドレス変更の確認トークンの保存先（I/O。判定は持たない）。
 *
 * ## 形
 *
 * ```
 * STRING  ak:email-change:v1:<token>        値 = {recordId,currentEmail,newEmail,createdAtIso}  TTL=60分
 * STRING  ak:email-change:v1:cooldown:<rec> 値 = 1                                              TTL=60秒
 * ```
 *
 * ## なぜ Airtable の AuthTokens を使わないか（**使ってはいけない**）
 *
 * `AuthTokens` は `verify-magic-link.js` が「その Token の Email でログインさせる」ために
 * 引くテーブル。変更用トークンをそこへ入れると、**まだ本人のものと確認できていない
 * 新アドレスでログインできてしまう**。用途の違うトークンを同じ入れ物に混ぜない。
 *
 * Redis を使うのは本番 schema を増やさないため（`premiumPlusReopenStartStore.js` と同じ判断）。
 * TTL で自然に消えるので後片付けも要らない。
 *
 * ## 単回使用
 *
 * 取り出しは `GETDEL`（取得と削除が 1 コマンド）。二重クリックで 2 回確定されない。
 * `GETDEL` が使えない場合だけ `GET` → `DEL` に落ちる。
 *
 * ## 読めないときは「無効」と言わない
 *
 * Redis 障害は `reason:'unavailable'` として返す。**「トークンが無効」に丸めない**
 * （利用者に「リンクが切れた」と誤解させ、何度も再発行させることになる）。
 */

import { makeRedisCmd } from '../premiumPlus/premiumPlusFunnelServer.js';

export const EMAIL_CHANGE_NAMESPACE = 'ak:email-change:v1';

/** 確認トークンの有効時間（秒）。`emailChange.js` の EMAIL_CHANGE_TTL_MIN と揃える。 */
export const EMAIL_CHANGE_TTL_SEC = 60 * 60;

/** 同じ会員が連続で確認メールを送れない間隔（秒）。第三者のアドレスへの連投を防ぐ。 */
export const EMAIL_CHANGE_COOLDOWN_SEC = 60;

export const EMAIL_CHANGE_STORE = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'unavailable',
  COOLDOWN: 'cooldown',
  NOT_FOUND: 'not_found',
});

export const tokenKey = (token) => `${EMAIL_CHANGE_NAMESPACE}:${String(token || '')}`;
export const cooldownKey = (recordId) => `${EMAIL_CHANGE_NAMESPACE}:cooldown:${String(recordId || '')}`;

/**
 * 連投チェック。**取れたら送ってよい**（SET NX）。
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export async function claimCooldown(env, recordId) {
  const cmd = makeRedisCmd(env);
  if (!cmd) return { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE };
  try {
    const res = await cmd(['SET', cooldownKey(recordId), '1', 'NX', 'EX', String(EMAIL_CHANGE_COOLDOWN_SEC)]);
    return res === 'OK'
      ? { ok: true, reason: EMAIL_CHANGE_STORE.OK }
      : { ok: false, reason: EMAIL_CHANGE_STORE.COOLDOWN };
  } catch (_) {
    return { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE };
  }
}

/**
 * 確認トークンを保存する。
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export async function putRequest(env, { token, recordId, currentEmail, newEmail, nowIso }) {
  const cmd = makeRedisCmd(env);
  if (!cmd) return { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE };
  const value = JSON.stringify({
    recordId: String(recordId || ''),
    currentEmail: String(currentEmail || ''),
    newEmail: String(newEmail || ''),
    createdAtIso: String(nowIso || new Date().toISOString()),
  });
  try {
    const res = await cmd(['SET', tokenKey(token), value, 'EX', String(EMAIL_CHANGE_TTL_SEC)]);
    return res === 'OK' ? { ok: true, reason: EMAIL_CHANGE_STORE.OK } : { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE };
  } catch (_) {
    return { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE };
  }
}

/**
 * 確認トークンを**取り出して消す**（単回使用）。
 * @returns {Promise<{ok:boolean, reason:string, data:(object|null)}>}
 */
export async function takeRequest(env, token) {
  const cmd = makeRedisCmd(env);
  if (!cmd) return { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE, data: null };
  const key = tokenKey(token);
  let raw = null;
  try {
    raw = await cmd(['GETDEL', key]);
  } catch (_) {
    try {
      raw = await cmd(['GET', key]);
      if (raw) await cmd(['DEL', key]);
    } catch (_e) {
      return { ok: false, reason: EMAIL_CHANGE_STORE.UNAVAILABLE, data: null };
    }
  }
  if (!raw) return { ok: false, reason: EMAIL_CHANGE_STORE.NOT_FOUND, data: null };
  try {
    return { ok: true, reason: EMAIL_CHANGE_STORE.OK, data: JSON.parse(raw) };
  } catch (_) {
    return { ok: false, reason: EMAIL_CHANGE_STORE.NOT_FOUND, data: null };
  }
}
