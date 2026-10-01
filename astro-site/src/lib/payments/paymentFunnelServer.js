/**
 * paymentFunnelServer.js — 決済ファネル計測の Function 用ラッパー
 *
 * **例外を投げない・待たせない**（RECORD_TIMEOUT_MS で諦める）。
 * 計測の失敗・Redis 未設定で申込受理／入金確認の昇格を止めてはいけない。
 * Redis 未設定は「0 件」ではなく measurement_unavailable として返す。
 */
import { createPaymentFunnelStore } from './paymentFunnel.js';
import { makeRedisCmd, RECORD_TIMEOUT_MS } from '../premiumPlus/premiumPlusFunnelServer.js';

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ counted: false, reason: 'timeout' }), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(method, { env, redisCmd, timeoutMs, ...input } = {}) {
  const cmd = redisCmd !== undefined ? redisCmd : makeRedisCmd(env);
  if (!cmd) return { counted: false, reason: 'measurement_unavailable', lead: null };
  try {
    const store = createPaymentFunnelStore({ redisCmd: cmd });
    const out = await withTimeout(store[method](input), typeof timeoutMs === 'number' ? timeoutMs : RECORD_TIMEOUT_MS);
    return { counted: out.counted === true, reason: out.reason || null, lead: out.lead ?? null };
  } catch {
    return { counted: false, reason: 'record_failed', lead: null };
  }
}

/** 振込完了の報告を受理した（bank-transfer-application の受理直後） */
export const recordPaymentApplication = (input) => run('recordApplication', input);

/** 入金確認で昇格した（confirm-bank-payment の PATCH 成功後だけ） */
export const recordPaymentConfirmation = (input) => run('recordConfirmation', input);

/** 集計を読む（読み取りのみ）。Redis 未設定なら null */
export async function readPaymentFunnelSummary({ env, redisCmd, days, nowMs } = {}) {
  const cmd = redisCmd !== undefined ? redisCmd : makeRedisCmd(env);
  if (!cmd) return null;
  return createPaymentFunnelStore({ redisCmd: cmd }).summary({ days, nowMs });
}

/** 月（JST）の入金確認の件数と金額（読み取りのみ）。Redis 未設定なら null */
export async function readPaymentFunnelMonth({ env, redisCmd, month } = {}) {
  const cmd = redisCmd !== undefined ? redisCmd : makeRedisCmd(env);
  if (!cmd) return null;
  return createPaymentFunnelStore({ redisCmd: cmd }).monthSummary({ month });
}
