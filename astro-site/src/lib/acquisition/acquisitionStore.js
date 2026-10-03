/**
 * acquisitionStore.js — 取得履歴と本文スナップショット（Upstash Redis）
 *
 * キー（docs/PREDICTION_ACQUISITION.md §4）:
 *   ak:acq:v1:u:{recordId}                 HASH  field=予想キー → 取得記録 JSON（HSETNX＝最初の取得だけ）
 *   ak:acq:v1:c:{予想キー}:{内容ハッシュ}  STRING 本文スナップショット JSON（SET NX・同じ内容は全会員で 1 つ）
 *
 * - 本文を先に保存し、その後で取得記録を付ける（記録が本文の無い参照を指さない）。
 * - recordId は ak_session から解決したものだけを渡す（クライアントの値は使わない）。
 * - Redis の失敗は例外のまま上へ返す（呼び出し側は本文を出さない＝fail closed）。
 */
import { createHash } from 'node:crypto';
import { parsePredictionKey } from './predictionKey.js';

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
export const userKey = (recordId) => `ak:acq:v1:u:${recordId}`;
export const contentKey = (key, ref) => `ak:acq:v1:c:${key}:${ref}`;

export function contentRef(content) {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

function assertArgs(recordId, key) {
  if (!RECORD_ID.test(String(recordId || ''))) throw new Error('invalid_record_id');
  const p = parsePredictionKey(key);
  if (!p) throw new Error('invalid_prediction_key');
  return p;
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * @returns {Promise<{ created: boolean, entry: object }>}
 */
export async function acquirePrediction({ redis, recordId, key, content, now = new Date() }) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const p = assertArgs(recordId, key);
  if (!content || content.product !== p.product || content.cat !== p.cat || content.date !== p.date
    || Number(content.raceNumber) !== p.raceNumber) throw new Error('content_mismatch');
  const ref = contentRef(content);
  await redis(['SET', contentKey(p.key, ref), JSON.stringify(content), 'NX']);
  const entry = {
    key: p.key, product: p.product, cat: p.cat, date: p.date, venue: p.venue, venueName: p.venueName,
    raceNumber: p.raceNumber, raceName: String(content.raceName || ''), startTime: String(content.startTime || ''),
    at: now.toISOString(), ref,
  };
  const created = Number(await redis(['HSETNX', userKey(recordId), p.key, JSON.stringify(entry)])) === 1;
  if (created) return { created: true, entry };
  const existing = parse(await redis(['HGET', userKey(recordId), p.key]));
  if (!existing) throw new Error('acquisition_unreadable');
  return { created: false, entry: existing };
}

/** この会員の取得記録（全件・新しい順） */
export async function listAcquisitions({ redis, recordId }) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  if (!RECORD_ID.test(String(recordId || ''))) throw new Error('invalid_record_id');
  const flat = await redis(['HGETALL', userKey(recordId)]);
  const out = [];
  if (Array.isArray(flat)) {
    for (let i = 1; i < flat.length; i += 2) { const e = parse(flat[i]); if (e && e.key) out.push(e); }
  } else if (flat && typeof flat === 'object') {
    for (const v of Object.values(flat)) { const e = parse(v); if (e && e.key) out.push(e); }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** 取得済みなら { entry, content }、未取得なら null（本文は取得済みのときだけ返す） */
export async function readAcquired({ redis, recordId, key }) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const p = assertArgs(recordId, key);
  const entry = parse(await redis(['HGET', userKey(recordId), p.key]));
  if (!entry || entry.key !== p.key || !/^[0-9a-f]{16}$/.test(String(entry.ref))) return null;
  const content = parse(await redis(['GET', contentKey(p.key, entry.ref)]));
  if (!content) throw new Error('content_missing');
  return { entry, content };
}
