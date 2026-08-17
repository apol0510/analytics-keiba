/**
 * salePauseGuard.js — 会員単位の販売 一時停止を **障害でも迂回されない**形で判定する
 *
 * ## なぜ Airtable 1 本では足りないのか
 *
 * 停止の正本は Airtable `PremiumPlusSalePaused` だが、判定経路に 2 つの穴がある。
 *
 * 1. **10 分キャッシュ**（`purchaseAnchorLookup.js` の `ANCHOR_CACHE_TTL_MS`）。
 *    停止する直前にレコードが読まれていると、その会員は最大 10 分間
 *    「停止していない」ままの fields で判定され、**CTA も購入も通ってしまう**。
 * 2. **一時障害**。Airtable が読めないときに「読めないから通す」と倒すと、
 *    停止済み会員は障害の窓で購入を迂回できる。
 *
 * かといって「読めない＝全員停止」にすると、**Airtable 障害だけで通常会員の購入まで
 * 一律に止まる**。これも不可。
 *
 * ## 解き方: 独立した 2 系統を持ち、片方が生きていれば正しく答える
 *
 * 停止中の会員だけを **Redis の deny-marker** にも書く（Upstash は本計測で既に使用中）。
 * marker は**キャッシュしない**ので、停止した瞬間から効く（穴 1 が閉じる）。
 *
 * | Airtable | marker | 結果 |
 * |---|---|---|
 * | paused | 何でも | **停止**（正本が停止と言っている） |
 * | 何でも | paused | **停止**（marker が停止と言っている） |
 * | clear | clear | 販売中 |
 * | clear | unknown | 販売中（Airtable が答えられている） |
 * | unknown | clear | 販売中（marker が答えられている＝**通常会員は Airtable 障害でも買える**） |
 * | unknown | unknown | **停止**（どちらも答えられない＝停止を否定できない / fail closed） |
 *
 * 「片方でも paused なら停止」「両方 unknown なら停止」。
 * **一方が答えられる限り通常会員は影響を受けない**のが要点。
 *
 * ## marker を「無い＝販売中」と読んでよい理由
 *
 * deny-list が**完全**であることを書き込み側で保証するため:
 *   - marker ストアが使えないときは **停止操作そのものを受け付けない**（503）
 *   - 停止は **marker → Airtable** の順（marker が入らなければ Airtable も書かない）
 *   - 再開は **Airtable → marker 削除** の順（途中で失敗したら止まったまま＝安全側）
 *
 * ⚠️ **停止は必ず管理画面から行うこと。** Airtable の画面でチェックボックスを直接
 *    操作すると marker が作られず、Airtable が読めない窓でだけ迂回され得る
 *    （Airtable が読める間は正本が効くので停止は効く）。
 *
 * ## 申込 API から引くための鍵
 *
 * `/bank-transfer-application` は **email しか持たない**（recordId は Airtable を引いて
 * 初めて分かる）。Airtable が落ちている最中は recordId を解決できないので、
 * marker は **recordId と email 由来の鍵の両方**に書く。
 * email そのものは保存せず、`SESSION_SIGNING_SECRET` を鍵にした HMAC-SHA256 を使う。
 */

import { createHmac } from 'node:crypto';

import { PP_SALE_PAUSE_FIELDS, normalizeSalePaused } from './premiumPlusRelease.js';

/** deny-marker の置き場（HASH）。版を上げると別集合になる。 */
export const SALE_PAUSE_KEY = 'ak:pp:sale_paused:v1';

/** marker 読み取りの打ち切り（ms）。会員ページを待たせない。 */
export const PAUSE_LOOKUP_TIMEOUT_MS = 700;

/** 3 値。**「分からない」を「販売中」に丸めない**ための型。 */
export const PAUSE_STATE = Object.freeze({
  PAUSED: 'paused',
  CLEAR: 'clear',
  UNKNOWN: 'unknown',
});

/**
 * Airtable の fields から停止状態を読む。
 * `fields` が null（＝読めなかった / レコード無し）は **unknown**。
 * ⚠️ ここで false に倒さない。倒すと障害時に停止が消える。
 */
export function airtablePauseState(fields) {
  if (!fields || typeof fields !== 'object') return PAUSE_STATE.UNKNOWN;
  return normalizeSalePaused(fields[PP_SALE_PAUSE_FIELDS.PAUSED])
    ? PAUSE_STATE.PAUSED
    : PAUSE_STATE.CLEAR;
}

/**
 * 2 系統の答えから最終判定を出す（純粋）。
 * @returns {boolean} true = 販売を止める
 */
export function decideSalePaused(airtable, marker) {
  if (airtable === PAUSE_STATE.PAUSED || marker === PAUSE_STATE.PAUSED) return true;
  // 片方でも「停止していない」と答えられていれば通す（通常会員を障害で止めない）
  if (airtable === PAUSE_STATE.CLEAR || marker === PAUSE_STATE.CLEAR) return false;
  // 双方 unknown = 停止を否定できない → 止める（fail closed）
  return true;
}

/** 判定の根拠を短く言語化する（ログ・管理画面用。顧客には出さない） */
export function describePauseDecision(airtable, marker) {
  if (airtable === PAUSE_STATE.PAUSED) return 'Airtable が停止中';
  if (marker === PAUSE_STATE.PAUSED) return 'deny-marker が停止中';
  if (airtable === PAUSE_STATE.CLEAR || marker === PAUSE_STATE.CLEAR) return '停止していない';
  return '停止状態を確認できないため停止扱い（fail closed）';
}

/**
 * email から marker の鍵を作る。**アドレスそのものは保存しない。**
 * 秘密が無ければ null（＝ email 経路では引けない）。
 */
export function emailPauseKey(email, secret) {
  const addr = String(email ?? '').trim().toLowerCase();
  const key = String(secret ?? '');
  if (!addr || !key) return null;
  return `em:${createHmac('sha256', key).update(addr).digest('hex').slice(0, 32)}`;
}

/** recordId 側の鍵 */
export function recordPauseKey(recordId) {
  const id = String(recordId ?? '').trim();
  return id ? `id:${id}` : null;
}

/** marker ストアが使えるか（＝停止操作を受け付けてよいか） */
export function isPauseMarkerAvailable(redisCmd) {
  return typeof redisCmd === 'function';
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * deny-marker を読む。**キャッシュしない**（停止した瞬間から効かせるため）。
 *
 * recordId 鍵と email 鍵の**どちらかに marker があれば停止**。
 * 読めない / 例外 / タイムアウトは `unknown`（呼び出し側が fail closed に倒す）。
 *
 * @returns {Promise<'paused'|'clear'|'unknown'>}
 */
export async function readSalePauseMarker({ redisCmd, recordId, emailKey } = {}) {
  if (!isPauseMarkerAvailable(redisCmd)) return PAUSE_STATE.UNKNOWN;
  const keys = [recordPauseKey(recordId), emailKey].filter(Boolean);
  if (keys.length === 0) return PAUSE_STATE.UNKNOWN;
  try {
    const out = await withTimeout(redisCmd(['HMGET', SALE_PAUSE_KEY, ...keys]), PAUSE_LOOKUP_TIMEOUT_MS);
    // タイムアウトは undefined。**空配列や null 応答を「無い＝clear」と読まない**
    if (out === undefined || out === null) return PAUSE_STATE.UNKNOWN;
    const values = Array.isArray(out) ? out : [out];
    if (values.length < keys.length) return PAUSE_STATE.UNKNOWN;
    return values.some((v) => v !== null && v !== undefined && String(v) !== '')
      ? PAUSE_STATE.PAUSED
      : PAUSE_STATE.CLEAR;
  } catch {
    return PAUSE_STATE.UNKNOWN;
  }
}

/**
 * deny-marker を書く / 消す。**成否を正直に返す**（呼び出し側が中断できるように）。
 *
 * @returns {Promise<{ok:boolean}>}
 */
export async function writeSalePauseMarker({ redisCmd, recordId, emailKey, paused } = {}) {
  if (!isPauseMarkerAvailable(redisCmd)) return { ok: false };
  const keys = [recordPauseKey(recordId), emailKey].filter(Boolean);
  if (keys.length === 0) return { ok: false };
  try {
    if (paused) {
      const args = ['HSET', SALE_PAUSE_KEY];
      for (const k of keys) args.push(k, '1');
      await redisCmd(args);
    } else {
      await redisCmd(['HDEL', SALE_PAUSE_KEY, ...keys]);
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 販売を止めるべきかを 2 系統から決める（I/O あり・例外を投げない）。
 *
 * @param {{
 *   fields: object|null,        既に取得済みの Airtable fields（キャッシュ済みでも可）
 *   recordId?: string|null,
 *   email?: string|null,
 *   env?: object,
 *   redisCmd?: Function|null,   テスト用の差し替え
 * }} input
 * @returns {Promise<{paused:boolean, airtable:string, marker:string, why:string}>}
 */
export async function resolveSalePauseGate({
  fields, recordId, email, env = {}, redisCmd,
} = {}) {
  const airtable = airtablePauseState(fields);
  // Airtable が「停止中」と答えているなら marker を読む必要はない（往復を増やさない）
  if (airtable === PAUSE_STATE.PAUSED) {
    return {
      paused: true, airtable, marker: PAUSE_STATE.UNKNOWN, why: describePauseDecision(airtable, PAUSE_STATE.UNKNOWN),
    };
  }
  const cmd = redisCmd !== undefined ? redisCmd : makeMarkerCmd(env);
  const marker = await readSalePauseMarker({
    redisCmd: cmd,
    recordId,
    emailKey: emailPauseKey(email, env.SESSION_SIGNING_SECRET),
  });
  return {
    paused: decideSalePaused(airtable, marker),
    airtable,
    marker,
    why: describePauseDecision(airtable, marker),
  };
}

/**
 * marker 用の Redis 呼び出し。計測と同じ接続情報を使う（接続の単一源は funnelServer）。
 * 循環 import を避けるため関数内で遅延 import する。
 */
function makeMarkerCmd(env) {
  const e = env || {};
  if (!e.UPSTASH_REDIS_REST_URL || !e.UPSTASH_REDIS_REST_TOKEN) return null;
  const doFetch = typeof fetch === 'function' ? fetch : null;
  if (!doFetch) return null;
  return async (args) => {
    const res = await doFetch(e.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${e.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis_${res.status}`);
    const data = await res.json();
    return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
  };
}

export { makeMarkerCmd };

/** 停止時に顧客へ返す文言（理由は明かさない・再開があり得ることだけ伝える） */
export const SALE_PAUSED_MESSAGE = '現在お申し込みを受け付けていません。再開までしばらくお待ちください。';

/**
 * 表示側で使う: 販売導線を閉じた view を返す。
 * `resolveUpsellForCustomer` の結果を **後段で**閉じるだけで、判定そのものは書き換えない。
 */
export function closePlusChannel(view) {
  if (!view) return view;
  return {
    ...view,
    channel: 'none',
    reason: 'plus_sale_paused',
    reasonLabel: 'Plus の販売を一時停止中（この会員のみ・資格は保持）',
    plus: {
      allowed: false,
      showTeaser: false,
      showProductPage: false,
      showPurchaseCta: false,
      purchaseEnabled: false,
      phase: 0,
      intake: null,
    },
    plusRelease: { ...(view.plusRelease || {}), ...CLOSED_RELEASE },
  };
}

/**
 * **表示系の唯一の実施点。** `resolveUpsellForCustomer()` の結果を受け取り、
 * 停止中なら販売導線を閉じて返す。
 *
 * ⚠️ marker を読むのは **channel が plus のときだけ**。
 *    そもそも Plus を出さない相手（大多数）には Redis 往復を発生させない。
 *    fields が読めなかった相手は channel が none なので、ここへ来る前に閉じている。
 *
 * @param {{ view: object, fields: object|null, recordId?: string|null,
 *           env?: object, redisCmd?: Function|null }} input
 * @returns {Promise<object>} 閉じた（あるいはそのままの）view
 */
export async function enforceSalePause({ view, fields, recordId, env = {}, redisCmd } = {}) {
  if (!view || view.channel !== 'plus') return view;
  const gate = await resolveSalePauseGate({ fields, recordId, env, redisCmd });
  return gate.paused ? closePlusChannel(view) : view;
}

const CLOSED_RELEASE = Object.freeze({
  allowed: false,
  showTeaser: false,
  showProductPage: false,
  showPurchaseCta: false,
  purchaseEnabled: false,
  intake: null,
  salePaused: true,
});
