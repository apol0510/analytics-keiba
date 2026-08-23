/**
 * premiumPlusCouponReservationStore.js — 利用予約台帳（`PromotionalOffers`）への I/O
 *
 * 判定は `premiumPlusCouponReservation.js`（純粋）にある。ここは**読む・書くだけ**。
 *
 * ## なぜこのモジュールが要るか（2026-08-23）
 *
 * 予約を作る関数（`buildReservationFields`）と使用済みにする関数
 * （`buildReservationRedeemFields`）は実装済みだったが、**どこからも呼ばれていなかった**。
 * そのため申込・入金確認をしてもクーポンは「所持中」のまま残り、
 * **同じクーポンで何度でも 58,000円 の申込ができる**状態だった。
 * 呼び出し側（振込完了報告 / 入金確認）が共通で使える I/O をここに置く。
 *
 * ## 全件走査をしない
 *
 * `PromotionalOffers` は販促オファーと同じ台帳で行数が多い。**全件取得は打ち切りが起き**、
 * 「読めた結果 0 件」と「打ち切りで見えていない」を取り違える。
 * ここでは必ず **`CustomerRecordId` で絞って**取得する。
 *
 * ## fail closed
 *
 *   - 読めなければ**作らない**（重複を検出できないまま行を増やさない）
 *   - env gate が閉じていれば**何もしない**（未作成テーブルへ書かない）
 *   - どの関数も**例外を投げない**。結果を `outcome` で返し、呼び出し側は決済を巻き戻さない
 */

import { OFFERS_TABLE, isOfferTableEnabled } from '../promotions/promotionalOffer.js';

const TIMEOUT_MS = 8000;

/** Airtable の filterByFormula 用に文字列を安全化する（式に値を持ち込まない） */
function safeRecordId(raw) {
  return /^rec[A-Za-z0-9]{14}$/.test(String(raw || '')) ? String(raw) : null;
}

async function airtable(url, init = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    return await fetch(url, { ...init, signal: controller ? controller.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * その会員ぶんの予約行だけを読む。
 *
 * @returns {{ available: true, records: object[] } | { available: false, reason: string }}
 *   ⚠️ `available:false` を「0 件」として扱わないこと。
 */
export async function listReservationsFor({ env = process.env, customerRecordId } = {}) {
  if (!isOfferTableEnabled(env)) return { available: false, reason: 'gate_closed' };
  const rec = safeRecordId(customerRecordId);
  if (!rec) return { available: false, reason: 'invalid_record_id' };
  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { available: false, reason: 'credentials_missing' };

  try {
    const formula = `{CustomerRecordId}='${rec}'`;
    const url = `https://api.airtable.com/v0/${encodeURIComponent(BASE)}/${encodeURIComponent(OFFERS_TABLE)}`
      + `?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
    const res = await airtable(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res || !res.ok) return { available: false, reason: `http_${res ? res.status : 'error'}` };
    const data = await res.json();
    return { available: true, records: Array.isArray(data.records) ? data.records : [] };
  } catch {
    return { available: false, reason: 'read_failed' };
  }
}

/**
 * 予約行を 1 行だけ作る（**振込完了報告が正常受理された時点でだけ呼ぶ**）。
 *
 * @param {{ fields: object }} built `buildReservationFields()` の戻り値
 * @returns {{ outcome: 'created'|string, recordId?: string }}
 */
export async function createReservation({ env = process.env, built } = {}) {
  if (!isOfferTableEnabled(env)) return { outcome: 'gate_closed' };
  if (!built || !built.fields) return { outcome: 'nothing_to_write' };
  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { outcome: 'credentials_missing' };

  try {
    const res = await airtable(
      `https://api.airtable.com/v0/${encodeURIComponent(BASE)}/${encodeURIComponent(OFFERS_TABLE)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: built.fields }], typecast: true }),
      },
    );
    if (!res || !res.ok) return { outcome: `failed_http_${res ? res.status : 'error'}` };
    const data = await res.json();
    return { outcome: 'created', recordId: (data.records && data.records[0] && data.records[0].id) || '' };
  } catch {
    return { outcome: 'failed_error' };
  }
}

/**
 * 予約行を使用済みにする（**入金確認が正常完了した時点でだけ呼ぶ**）。
 *
 * @param {{ recordId: string, fields: object }} input
 * @returns {{ outcome: 'redeemed'|string }}
 */
export async function patchReservation({ env = process.env, recordId, fields } = {}) {
  if (!isOfferTableEnabled(env)) return { outcome: 'gate_closed' };
  if (!recordId || !fields) return { outcome: 'nothing_to_write' };
  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { outcome: 'credentials_missing' };

  try {
    const res = await airtable(
      `https://api.airtable.com/v0/${encodeURIComponent(BASE)}/${encodeURIComponent(OFFERS_TABLE)}`
        + `/${encodeURIComponent(recordId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, typecast: true }),
      },
    );
    if (!res || !res.ok) return { outcome: `failed_http_${res ? res.status : 'error'}` };
    return { outcome: 'redeemed' };
  } catch {
    return { outcome: 'failed_error' };
  }
}
