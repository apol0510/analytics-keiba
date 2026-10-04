/**
 * premiumPlusPassStore.js — 枠確保（購入済み会員向けプラン）の台帳 I/O と操作（Redis・依存は注入）
 *
 * | キー | 型 | 中身 |
 * |---|---|---|
 * | `ak:pp:passes:v1` | HASH | passId（`recordId:作成時刻36進`）→ 枠 JSON |
 * | `ak:pp:passes:v1:lock:{id}` | STRING（NX・EX 30）| 申込・予約・入金確認の同時実行防止（会員単位 / 年間枠の残数）|
 *
 * 判定は `premiumPlusPass.js`（純粋）。ここは読む・書く・ロックの順番を守るだけ。
 */
import {
  planApply, planConfirmPass, planCancelPass, planReserve, PASS_PLANS,
} from './premiumPlusPass.js';

export const PP_PASSES_KEY = 'ak:pp:passes:v1';
const LOCK_PREFIX = `${PP_PASSES_KEY}:lock:`;
const LOCK_TTL_SEC = 30;

function parse(v) {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(typeof v === 'string' ? v : String(v)); } catch { return null; }
}

export function createPassStore({ redisCmd }) {
  if (typeof redisCmd !== 'function') throw new Error('premiumPlusPassStore: redisCmd が必要です');
  const cmd = (args) => redisCmd(args.map(String));
  return {
    async get(passId) { return parse(await cmd(['HGET', PP_PASSES_KEY, passId])); },
    async save(pass) { await cmd(['HSET', PP_PASSES_KEY, pass.passId, JSON.stringify(pass)]); },
    async list() {
      const raw = (await cmd(['HGETALL', PP_PASSES_KEY])) || [];
      const out = [];
      if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2) { const p = parse(raw[i + 1]); if (p) out.push(p); }
      } else if (raw && typeof raw === 'object') {
        for (const v of Object.values(raw)) { const p = parse(v); if (p) out.push(p); }
      }
      return out;
    },
    async lock(id, nowMs) {
      const r = await cmd(['SET', `${LOCK_PREFIX}${id}`, String(nowMs), 'NX', 'EX', String(LOCK_TTL_SEC)]);
      return r === 'OK' || r === true;
    },
    async unlock(id) { await cmd(['DEL', `${LOCK_PREFIX}${id}`]); },
  };
}

async function withLocks(store, ids, nowMs, fn) {
  const got = [];
  try {
    for (const id of ids) {
      if (!(await store.lock(id, nowMs))) return { ok: false, status: 409, code: 'in_progress' };
      got.push(id);
    }
    return await fn();
  } catch {
    return { ok: false, status: 503, code: 'store_unavailable' };
  } finally {
    for (const id of got) { try { await store.unlock(id); } catch { /* TTL で外れる */ } }
  }
}

const STATUS = {
  invalid_member: 400, unknown_plan: 400, weekday_required: 400, invalid_date: 400,
  not_repeat_member: 404, pass_not_found: 404,
  already_awaiting: 409, sold_out: 409, not_active: 409, weekly_pass: 409, too_late: 409,
  after_expiry: 409, no_credits: 409, already_reserved: 409, not_awaiting: 409,
  missing_actor: 400, missing_reason: 400,
};
const reject = (plan) => ({ ok: false, status: plan.idempotent ? 200 : (STATUS[plan.code] || 409), code: plan.code, idempotent: plan.idempotent === true });

/** 申込（会員ロック＋年間枠は残数ロック。ロック内で台帳を読み直して判定） */
export async function applyPass({ store, orders, recordId, planId, weekday, installments, nowMs }) {
  const ids = [`member:${recordId}`];
  if (PASS_PLANS[planId]?.capacity) ids.push('annual-capacity');
  return withLocks(store, ids, nowMs, async () => {
    const passes = await store.list();
    const plan = planApply({ orders, passes, recordId, planId, weekday, installments, nowMs });
    if (!plan.ok) return reject(plan);
    await store.save(plan.pass);
    return { ok: true, status: 200, code: 'applied', pass: plan.pass };
  });
}

export async function confirmPass({ store, passId, actor, nowMs }) {
  return withLocks(store, [`pass:${passId}`], nowMs, async () => {
    const plan = planConfirmPass(await store.get(passId), { actor, nowMs });
    if (!plan.ok) return reject(plan);
    await store.save(plan.pass);
    return { ok: true, status: 200, code: 'confirmed', pass: plan.pass };
  });
}

export async function cancelPass({ store, passId, actor, reason, nowMs }) {
  return withLocks(store, [`pass:${passId}`], nowMs, async () => {
    const plan = planCancelPass(await store.get(passId), { actor, reason, nowMs });
    if (!plan.ok) return reject(plan);
    await store.save(plan.pass);
    return { ok: true, status: 200, code: 'cancelled', pass: plan.pass };
  });
}

export async function reservePass({ store, orders, recordId, passId, saleDate, nowMs }) {
  return withLocks(store, [`member:${recordId}`, `pass:${passId}`], nowMs, async () => {
    const passes = await store.list();
    const pass = passes.find((p) => p.passId === passId) || null;
    const plan = planReserve({ pass, passes, orders, recordId, saleDate, nowMs });
    if (!plan.ok) return reject(plan);
    await store.save(plan.pass);
    return { ok: true, status: 200, code: 'reserved', pass: plan.pass };
  });
}
