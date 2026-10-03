/**
 * cron-premium-plus-delivery — Premium Plus の当日提供と購入お礼メール（5 分毎）
 *
 * 1. **当日の提供レースを自動生成**（未生成なら 1 回だけ）。予想 JSON → `planDelivery` →
 *    Redis `ak:pp:delivery:v1` へ HSETNX。生成済みの日は二度と書かない。
 * 2. **入金確認済みの注文へサンクスメール**（1 注文 1 通）。管理画面で「入金確認」を押すと
 *    次の実行（最大 5 分後）で自動送信される。対象日が今日以降の注文だけ（過去分へは送らない）。
 * 3. **枠確保（10鞍確保枠・年間枠・単品）の入金確認後のお礼**（1 枠 1 通）。
 *
 * ⚠️ ログに買い目・メールアドレス・recordId を出さない。
 */
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import { createOrderStore } from '../../src/lib/premiumPlus/premiumPlusOrderService.js';
import {
  createDeliveryStore, fetchPredictionFiles,
} from '../../src/lib/premiumPlus/premiumPlusDeliveryStore.js';
import {
  jstDate, normalizePredictionFile, planDelivery, selectThanksTargets, buildThanksEmail, PP_RACES_PER_DAY,
} from '../../src/lib/premiumPlus/premiumPlusDelivery.js';
import { fetchCustomerFields, sendPlusMail } from '../../src/lib/premiumPlus/premiumPlusMail.js';
import { createPassStore } from '../../src/lib/premiumPlus/premiumPlusPassStore.js';
import { buildPassThanksEmail, PASS_STATUS } from '../../src/lib/premiumPlus/premiumPlusPass.js';

const TAG = '[pp-delivery]';
/** これより早い時刻（JST）は生成しない（前夜の取込が終わってから） */
const GENERATE_FROM_JST_HOUR = 6;

async function ensureTodayDelivery({ deliveries, nowMs }) {
  const saleDate = jstDate(nowMs);
  if (await deliveries.get(saleDate)) return { saleDate, outcome: 'exists' };
  const jstHour = new Date(nowMs + 9 * 3600000).getUTCHours();
  if (jstHour < GENERATE_FROM_JST_HOUR) return { saleDate, outcome: 'too_early' };
  const files = await fetchPredictionFiles(saleDate);
  const racesByCircuit = {
    jra: files.jra.flatMap((j) => normalizePredictionFile(j, { date: saleDate, circuit: 'jra' })),
    nankan: files.nankan.flatMap((j) => normalizePredictionFile(j, { date: saleDate, circuit: 'nankan' })),
  };
  const plan = planDelivery({ saleDate, racesByCircuit, nowMs });
  if (!plan.ok) return { saleDate, outcome: plan.reason };
  const created = await deliveries.createIfAbsent(plan.delivery);
  return {
    saleDate,
    outcome: created ? 'created' : 'exists',
    races: plan.delivery.races.map((r) => `${r.venue}${r.raceNumber}R ${r.startTime}`),
  };
}

async function sendPendingThanks({ orders, deliveries, nowMs }) {
  const targets = selectThanksTargets(await orders.list(), { nowMs });
  const summary = { targets: targets.length, sent: 0, skipped: 0, failed: 0, unknown: 0 };
  for (const o of targets) {
    if (await deliveries.thanksState(o.orderId)) { summary.skipped += 1; continue; }
    if (!(await deliveries.reserveThanks(o.orderId, nowMs))) { summary.skipped += 1; continue; }
    const fields = await fetchCustomerFields(o.recordId);
    const to = String(fields?.Email || '').trim();
    if (!to) { await deliveries.releaseThanks(o.orderId); summary.failed += 1; continue; }
    const delivery = await deliveries.get(o.saleDate);
    const mail = buildThanksEmail({
      fullName: fields['氏名'],
      saleDate: o.saleDate,
      raceCount: delivery?.races?.length || PP_RACES_PER_DAY,
      siteBase: process.env.MAGIC_LINK_BASE_URL,
    });
    const r = await sendPlusMail({ to, ...mail, customArgs: { record_id: o.recordId, idempotency_key: `pp-thanks:${o.orderId}`, purpose: 'premium_plus_thanks' } });
    if (r === 'sent') { await deliveries.markThanksSent(o.orderId, nowMs); summary.sent += 1; }
    else if (r === 'failed') { await deliveries.releaseThanks(o.orderId); summary.failed += 1; }
    else summary.unknown += 1; // sending のまま残す（自動再送しない）
  }
  return summary;
}

/** 枠確保の入金確認後のお礼（1 枠 1 通）。送信記録は `pass:{passId}` で注文と分ける */
async function sendPendingPassThanks({ passes, deliveries, nowMs }) {
  const targets = (await passes.list()).filter((p) => p.status === PASS_STATUS.ACTIVE);
  const summary = { targets: targets.length, sent: 0, skipped: 0, failed: 0, unknown: 0 };
  for (const p of targets) {
    const key = `pass:${p.passId}`;
    if (await deliveries.thanksState(key)) { summary.skipped += 1; continue; }
    if (!(await deliveries.reserveThanks(key, nowMs))) { summary.skipped += 1; continue; }
    const fields = await fetchCustomerFields(p.recordId);
    const to = String(fields?.Email || '').trim();
    if (!to) { await deliveries.releaseThanks(key); summary.failed += 1; continue; }
    const mail = buildPassThanksEmail({ pass: p, fullName: fields['氏名'], siteBase: process.env.MAGIC_LINK_BASE_URL });
    const r = await sendPlusMail({ to, ...mail, customArgs: { record_id: p.recordId, idempotency_key: `pp-pass-thanks:${p.passId}`, purpose: 'premium_plus_pass_thanks' } });
    if (r === 'sent') { await deliveries.markThanksSent(key, nowMs); summary.sent += 1; }
    else if (r === 'failed') { await deliveries.releaseThanks(key); summary.failed += 1; }
    else summary.unknown += 1;
  }
  return summary;
}

export async function runDeliveryTick({ nowMs = Date.now() } = {}) {
  const cmd = makeRedisCmd(process.env);
  if (!cmd) return { ok: false, reason: 'store_unavailable' };
  const deliveries = createDeliveryStore({ redisCmd: cmd });
  const orders = createOrderStore({ redisCmd: cmd });
  let delivery;
  try { delivery = await ensureTodayDelivery({ deliveries, nowMs }); } catch (e) { delivery = { outcome: `error:${String(e?.message || e).slice(0, 80)}` }; }
  let thanks;
  try { thanks = await sendPendingThanks({ orders, deliveries, nowMs }); } catch (e) { thanks = { error: String(e?.message || e).slice(0, 80) }; }
  let passThanks;
  try { passThanks = await sendPendingPassThanks({ passes: createPassStore({ redisCmd: cmd }), deliveries, nowMs }); } catch (e) { passThanks = { error: String(e?.message || e).slice(0, 80) }; }
  return { ok: true, delivery, thanks, passThanks };
}

export default async function handler() {
  const out = await runDeliveryTick();
  console.log(TAG, JSON.stringify(out));
  return new Response(JSON.stringify({ ok: out.ok }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export const config = { schedule: '*/5 * * * *' };
