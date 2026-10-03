/**
 * acquisitionServer.js — 取得 API・閲覧ページが共有する手順（サーバー専用）
 *
 * 認可は gatePaidPage（ak_session + resolveEntitlements）。本人は gate.subject（recordId）だけ。
 * どの商品を取得できるかは acquisitionPolicy.canAcquire。本文は取得済みのときだけ返す。
 */
import { gatePaidPage } from '../auth/paidPageGate.js';
import { makeRedisCmd } from '../premiumPlus/premiumPlusFunnelServer.js';
import { parsePredictionKey } from './predictionKey.js';
import { canAcquire } from './acquisitionPolicy.js';
import { findRace } from './raceSource.js';
import { buildPredictionContent } from './predictionContent.js';
import { acquirePrediction, readAcquired, listAcquisitions } from './acquisitionStore.js';

/** 取得・閲覧の入口に通す権利（どれか 1 つ）。商品ごとの可否は canAcquire で絞る */
// 会場別 Premium（Stripe の中央版・南関版 = premium-jra / premium-nankan）も入口を通す。会場ごとの可否は canAcquire
export const ACQUISITION_DOOR_PLANS = Object.freeze(['premium', 'premium-jra', 'premium-nankan', 'Premium Sanrenpuku']);

export function viewUrlFor(key) {
  return `/predictions/view/?key=${encodeURIComponent(key)}`;
}

/** 同一オリジンからの送信だけを受け付ける（CSRF 対策。ak_session は SameSite=Lax だが二重に守る） */
export function isSameOriginPost(request) {
  const origin = request.headers.get('origin');
  let self;
  try { self = new URL(request.url).origin; } catch { return false; }
  if (origin) return origin === self;
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try { return new URL(referer).origin === self; } catch { return false; }
}

/**
 * @returns {Promise<{ status: 'ok'|'denied'|'forbidden'|'invalid'|'not_found'|'unavailable', response?, key?, created? }>}
 */
export async function handleAcquire({ request, rawKey, env, now = new Date(), deps = {} }) {
  const p = parsePredictionKey(rawKey);
  if (!p) return { status: 'invalid' };
  const gate = await (deps.gate || gatePaidPage)({ request, requiredPlan: ACQUISITION_DOOR_PLANS, env, now: now.getTime() });
  if (gate.response) return { status: 'denied', response: gate.response };
  if (!canAcquire(gate.entitlements, p)) return { status: 'forbidden' };
  const redis = deps.redis || makeRedisCmd(env);
  if (!redis) return { status: 'unavailable' };
  try {
    const already = await readAcquired({ redis, recordId: gate.subject, key: p.key }).catch((e) => {
      if (e.message === 'content_missing') return null;
      throw e;
    });
    if (already) return { status: 'ok', key: p.key, created: false };
    const found = (deps.findRace || findRace)(p.cat, p.date, p.venue, p.raceNumber);
    if (!found) return { status: 'not_found' };
    const content = buildPredictionContent({
      product: p.product, cat: p.cat, venueName: p.venueName, race: found.race, venueTotalRaces: found.venue.totalRaces,
    });
    const r = await acquirePrediction({ redis, recordId: gate.subject, key: p.key, content, now });
    return { status: 'ok', key: p.key, created: r.created };
  } catch (e) {
    console.error('[acquisition] acquire failed:', e?.message || 'unknown');
    return { status: 'unavailable' };
  }
}

/** 閲覧: 取得済みなら本文、未取得なら content=null（本文を作らない） */
export async function loadAcquiredView({ gate, rawKey, env, deps = {} }) {
  // gate はページ側で gatePaidPage(ACQUISITION_DOOR_PLANS) を通した結果を渡す（認可をページに見える形で置く）
  if (!gate || gate.response || !gate.subject) return { status: 'denied', response: gate?.response || null };
  const p = parsePredictionKey(rawKey);
  if (!p) return { status: 'invalid', gate };
  const redis = deps.redis || makeRedisCmd(env);
  if (!redis) return { status: 'unavailable', gate };
  try {
    const got = await readAcquired({ redis, recordId: gate.subject, key: p.key });
    if (!got) return { status: 'not_acquired', gate, parsed: p, canAcquire: canAcquire(gate.entitlements, p) };
    return { status: 'ok', gate, parsed: p, entry: got.entry, content: got.content };
  } catch (e) {
    console.error('[acquisition] view failed:', e?.message || 'unknown');
    return { status: 'unavailable', gate };
  }
}

/** 一覧・利用状況用: この会員の取得記録（失敗時は null＝「読めない」を 0 件と区別する） */
export async function loadMemberAcquisitions({ recordId, env, deps = {} }) {
  const redis = deps.redis || makeRedisCmd(env);
  if (!redis || !recordId) return null;
  try { return await listAcquisitions({ redis, recordId }); } catch (e) {
    console.error('[acquisition] list failed:', e?.message || 'unknown');
    return null;
  }
}
