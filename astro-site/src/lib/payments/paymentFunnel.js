/**
 * paymentFunnel.js — 決済ファネルのサーバー側計測（全プラン・Redis・件数だけ）
 *
 * ## なぜ要るか（2026-09-29 棚卸し）
 *
 * GA4 の `application_submitted` は広告ブロック・gtag 未読込で欠ける（8/31〜9/28 で 1 件、
 * 同期間の入金確認は Airtable 実測 4 件）。Airtable は 1 人 1 行で申込を上書きし、
 * 申込日時の列も無く、入金確認で `Requested*` が消えるため、
 *   - 申込（振込完了の報告）の件数（商品別・日別）
 *   - 申込 → 入金確認までの日数
 *   - 報告されたが入金確認されていない件数（放置）
 * がどこにも残っていなかった。Airtable の列は増やさず、Redis に件数だけを残す。
 *
 * ## 記録するもの（識別子は recordId だけ・PII なし）
 *
 * | キー | 型 | 中身 |
 * |---|---|---|
 * | `ak:pay:funnel:v1:daily` | HASH | `YYYYMMDD|event|plan|planType` → 件数（JST の日付）|
 * | `ak:pay:funnel:v1:open` | HASH | recordId → `{plan, planType, atMs}`（報告済み・入金確認待ち）|
 * | `ak:pay:funnel:v1:seen` | HASH | `YYYYMMDD|event|recordId|plan` → 1（同じ日の同じ申込を二重に数えない）|
 *
 * event: `application_received`（報告を受理）/ `payment_confirmed`（入金確認で昇格）/
 *        `confirm_lead`（報告→入金確認の日数。planType の位置に日数の区分）
 *
 * ⚠️ 計測の失敗で申込・昇格を止めない（呼び出し側で握りつぶす）。
 * ⚠️ Premium Plus の既存ファネル（`ak:pp:funnel:v1`）とは別の名前空間。あちらの集計を変えない。
 */
import { normalizePlan } from '../auth/planNormalization.js';

export const PAYMENT_FUNNEL_ROOT = 'ak:pay:funnel:v1';
export const PAYMENT_FUNNEL_KEY = Object.freeze({
  DAILY: `${PAYMENT_FUNNEL_ROOT}:daily`,
  OPEN: `${PAYMENT_FUNNEL_ROOT}:open`,
  SEEN: `${PAYMENT_FUNNEL_ROOT}:seen`,
});
export const PAYMENT_FUNNEL_EVENT = Object.freeze({
  RECEIVED: 'application_received',
  CONFIRMED: 'payment_confirmed',
  LEAD: 'confirm_lead',
});

/** 閉じた語彙（これ以外は other に畳む。PII・自由文字列を入れない） */
export const FUNNEL_PLANS = Object.freeze(['light', 'premium', 'premium-sanrenpuku', 'premium-plus', 'other']);
export const FUNNEL_PLAN_TYPES = Object.freeze(['Monthly', 'Annual', 'Lifetime', 'other']);
export const LEAD_BUCKETS = Object.freeze(['d0', 'd1', 'd2-3', 'd4-7', 'd8plus']);

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DAY_MS = 86400000;

export function funnelPlan(raw) {
  const c = normalizePlan(raw);
  if (c === 'premium-combo') return 'premium-sanrenpuku';
  return FUNNEL_PLANS.includes(c) ? c : 'other';
}
export function funnelPlanType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === 'monthly') return 'Monthly';
  if (t === 'annual') return 'Annual';
  if (t === 'lifetime') return 'Lifetime';
  return 'other';
}
export function jstDay(nowMs) {
  return new Date(Number(nowMs) + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}
export function leadBucket(ms) {
  const d = Math.floor(Math.max(0, Number(ms) || 0) / DAY_MS);
  if (d <= 0) return 'd0';
  if (d === 1) return 'd1';
  if (d <= 3) return 'd2-3';
  if (d <= 7) return 'd4-7';
  return 'd8plus';
}
export const dailyField = (day, event, plan, planType) => `${day}|${event}|${plan}|${planType}`;

/**
 * @param {{redisCmd: (args: string[]) => Promise<any>}} deps Upstash REST 相当（読み書きの両方）
 */
export function createPaymentFunnelStore({ redisCmd } = {}) {
  if (typeof redisCmd !== 'function') throw new Error('paymentFunnel: redisCmd が必要です');
  const cmd = (args) => redisCmd(args.map(String));

  /** 同じ日・同じ種別・同じ相手・同じプランは 1 回だけ（再送・二重送信で水増ししない） */
  const firstTimeToday = async (day, event, recordId, plan) => {
    if (!RECORD_ID_RE.test(String(recordId || ''))) return true; // 相手不明は重複判定できないので数える
    const r = await cmd(['HSETNX', PAYMENT_FUNNEL_KEY.SEEN, `${day}|${event}|${recordId}|${plan}`, '1']);
    return Number(r) === 1;
  };

  return {
    /** 振込完了の報告を受理した */
    async recordApplication({ recordId, planName, planType, nowMs = Date.now() }) {
      const plan = funnelPlan(planName);
      const type = funnelPlanType(planType);
      const day = jstDay(nowMs);
      if (!(await firstTimeToday(day, PAYMENT_FUNNEL_EVENT.RECEIVED, recordId, plan))) {
        return { counted: false, reason: 'duplicate_today' };
      }
      await cmd(['HINCRBY', PAYMENT_FUNNEL_KEY.DAILY, dailyField(day, PAYMENT_FUNNEL_EVENT.RECEIVED, plan, type), '1']);
      if (RECORD_ID_RE.test(String(recordId || ''))) {
        await cmd(['HSET', PAYMENT_FUNNEL_KEY.OPEN, recordId, JSON.stringify({ plan, planType: type, atMs: Number(nowMs) })]);
      }
      return { counted: true, plan, planType: type };
    },

    /** 入金確認で昇格した（報告からの日数も記録し、確認待ちから外す） */
    async recordConfirmation({ recordId, planName, planType, nowMs = Date.now() }) {
      const plan = funnelPlan(planName);
      const type = funnelPlanType(planType);
      const day = jstDay(nowMs);
      if (!(await firstTimeToday(day, PAYMENT_FUNNEL_EVENT.CONFIRMED, recordId, plan))) {
        return { counted: false, reason: 'duplicate_today' };
      }
      await cmd(['HINCRBY', PAYMENT_FUNNEL_KEY.DAILY, dailyField(day, PAYMENT_FUNNEL_EVENT.CONFIRMED, plan, type), '1']);
      let lead = null;
      if (RECORD_ID_RE.test(String(recordId || ''))) {
        const raw = await cmd(['HGET', PAYMENT_FUNNEL_KEY.OPEN, recordId]);
        if (raw) {
          try {
            const o = JSON.parse(raw);
            if (Number.isFinite(o.atMs)) {
              lead = leadBucket(Number(nowMs) - o.atMs);
              await cmd(['HINCRBY', PAYMENT_FUNNEL_KEY.DAILY, dailyField(day, PAYMENT_FUNNEL_EVENT.LEAD, plan, lead), '1']);
            }
          } catch { /* 壊れた値は日数を数えないだけ */ }
          await cmd(['HDEL', PAYMENT_FUNNEL_KEY.OPEN, recordId]);
        }
      }
      return { counted: true, plan, planType: type, lead };
    },

    /** 集計を読む（読み取りのみ）。days 日分（JST）の件数と、確認待ちの経過日数分布 */
    async summary({ days = 30, nowMs = Date.now() } = {}) {
      const daily = (await cmd(['HGETALL', PAYMENT_FUNNEL_KEY.DAILY])) || [];
      const open = (await cmd(['HGETALL', PAYMENT_FUNNEL_KEY.OPEN])) || [];
      return summarize({ daily, open, days, nowMs });
    },
  };
}

/** HGETALL の配列（[k, v, k, v...]）を集計する（純粋） */
export function summarize({ daily, open, days = 30, nowMs = Date.now() }) {
  const since = jstDay(Number(nowMs) - (days - 1) * DAY_MS);
  const totals = { [PAYMENT_FUNNEL_EVENT.RECEIVED]: {}, [PAYMENT_FUNNEL_EVENT.CONFIRMED]: {}, [PAYMENT_FUNNEL_EVENT.LEAD]: {} };
  const byDay = {};
  for (let i = 0; i + 1 < daily.length; i += 2) {
    const [day, event, plan, second] = String(daily[i]).split('|');
    const n = Number(daily[i + 1]) || 0;
    if (day < since || !totals[event]) continue;
    const key = event === PAYMENT_FUNNEL_EVENT.LEAD ? second : `${plan}/${second}`;
    totals[event][key] = (totals[event][key] || 0) + n;
    if (event !== PAYMENT_FUNNEL_EVENT.LEAD) {
      byDay[day] = byDay[day] || { received: 0, confirmed: 0 };
      byDay[day][event === PAYMENT_FUNNEL_EVENT.RECEIVED ? 'received' : 'confirmed'] += n;
    }
  }
  const openAges = { d0: 0, d1: 0, 'd2-3': 0, 'd4-7': 0, d8plus: 0 };
  let openCount = 0;
  for (let i = 0; i + 1 < open.length; i += 2) {
    try {
      const o = JSON.parse(open[i + 1]);
      if (!Number.isFinite(o.atMs)) continue;
      openAges[leadBucket(Number(nowMs) - o.atMs)] += 1;
      openCount += 1;
    } catch { /* 壊れた値は数えない */ }
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    days,
    since,
    received: sum(totals[PAYMENT_FUNNEL_EVENT.RECEIVED]),
    confirmed: sum(totals[PAYMENT_FUNNEL_EVENT.CONFIRMED]),
    receivedByPlan: totals[PAYMENT_FUNNEL_EVENT.RECEIVED],
    confirmedByPlan: totals[PAYMENT_FUNNEL_EVENT.CONFIRMED],
    confirmLead: totals[PAYMENT_FUNNEL_EVENT.LEAD],
    /** 報告済みで入金確認待ち（期間に関係なく今の数。d8plus は放置の疑い）*/
    open: { count: openCount, byAge: openAges },
    byDay,
  };
}
