/**
 * cron-premium-plus-delivery — Premium Plus の当日提供と購入お礼メール（5 分毎）
 *
 * 1. **当日の提供レースを自動生成**（未生成なら 1 回だけ）。予想 JSON → `planDelivery` →
 *    Redis `ak:pp:delivery:v1` へ HSETNX。生成済みの日は二度と書かない。
 * 2. **入金確認済みの注文へサンクスメール**（1 注文 1 通）。管理画面で「入金確認」を押すと
 *    次の実行（最大 5 分後）で自動送信される。対象日が今日以降の注文だけ（過去分へは送らない）。
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
import { resolveVerifiedSender } from '../../src/lib/payments/senderIdentity.js';
import { SUPPORT_EMAIL } from './config/email-config.js';

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

async function getCustomer(recordId) {
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
  if (!key || !base) return null;
  const res = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.fields || null;
}

/** @returns {'sent'|'failed'|'unknown'} */
async function sendThanks({ to, recordId, orderId, mail }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const sender = resolveVerifiedSender(process.env);
  if (!apiKey || !sender.ok) return 'failed';
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: sender.email, name: sender.name },
        reply_to: { email: SUPPORT_EMAIL },
        subject: mail.subject,
        content: [{ type: 'text/plain', value: mail.text }, { type: 'text/html', value: mail.html }],
        custom_args: { record_id: recordId, idempotency_key: `pp-thanks:${orderId}`, purpose: 'premium_plus_thanks' },
      }),
    });
    return res.status >= 200 && res.status < 300 ? 'sent' : 'failed';
  } catch {
    return 'unknown'; // 届いたか分からない → 再送しない（二重送信を避ける）
  }
}

async function sendPendingThanks({ orders, deliveries, nowMs }) {
  const targets = selectThanksTargets(await orders.list(), { nowMs });
  const summary = { targets: targets.length, sent: 0, skipped: 0, failed: 0, unknown: 0 };
  for (const o of targets) {
    if (await deliveries.thanksState(o.orderId)) { summary.skipped += 1; continue; }
    if (!(await deliveries.reserveThanks(o.orderId, nowMs))) { summary.skipped += 1; continue; }
    const fields = await getCustomer(o.recordId);
    const to = String(fields?.Email || '').trim();
    if (!to) { await deliveries.releaseThanks(o.orderId); summary.failed += 1; continue; }
    const delivery = await deliveries.get(o.saleDate);
    const mail = buildThanksEmail({
      fullName: fields['氏名'],
      saleDate: o.saleDate,
      raceCount: delivery?.races?.length || PP_RACES_PER_DAY,
      siteBase: process.env.MAGIC_LINK_BASE_URL,
    });
    const r = await sendThanks({ to, recordId: o.recordId, orderId: o.orderId, mail });
    if (r === 'sent') { await deliveries.markThanksSent(o.orderId, nowMs); summary.sent += 1; }
    else if (r === 'failed') { await deliveries.releaseThanks(o.orderId); summary.failed += 1; }
    else summary.unknown += 1; // sending のまま残す（自動再送しない）
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
  return { ok: true, delivery, thanks };
}

export default async function handler() {
  const out = await runDeliveryTick();
  console.log(TAG, JSON.stringify(out));
  return new Response(JSON.stringify({ ok: out.ok }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export const config = { schedule: '*/5 * * * *' };
