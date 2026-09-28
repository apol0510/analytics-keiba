/**
 * lightRenewalRunner.js — Light 月払い 期限前・失効後リマインドの実行（I/O は fetch / Redis）
 *
 * 流れ（live）:
 *   1. Customers を formula で絞って読む（対象候補だけ・打ち切りは fail closed）
 *   2. `evaluateCandidate` で今日送る人と段（PRE / POST）を決める
 *   3. provider suppression・EmailBlacklist・配信履歴（24 時間の横断上限）を読む
 *      → どれか読めなければ **1 通も送らない**（fail closed）
 *   4. 1 人ずつ: `verifyBeforeSend` → レコードを読み直して `stillSendable`（更新・乗り換え後は送らない）
 *      → Redis で予約（SET NX。予約できない＝既に送った／送信中）→ 配信行を upsert（DeliveryKey）
 *      → SendGrid 送信 → 配信行を sent に。送信に失敗したら配信行を failed にして**予約を外す**（翌日再試行）
 *
 * ⚠️ Customers へは一切書かない。書くのは CampaignDeliveries と Redis の予約キーだけ。
 * ⚠️ ログ・戻り値にアドレスを載せない（件数と理由だけ）。
 */
import {
  LIGHT_RENEWAL_CAMPAIGN_ID, LIGHT_RENEWAL_VERSION, LIGHT_RENEWAL_CAMPAIGN_TYPE, STEP_NUMBER,
  evaluateCandidate, stillSendable, deliveryKeyFor, claimKeyFor, jstDate,
} from './lightRenewalPolicy.js';
import { renderLightRenewalEmail } from './lightRenewalEmail.js';
import { verifyBeforeSend, isMarketingClickTrackingEnabled } from '../marketingDispatchGate.js';
import { fetchProviderSuppression } from '../providerSuppression.js';
import { buildBlacklistEmailSet } from '../../newsletter/airtable-fetch.js';
import { applyUnsubscribeUrl } from '../marketingEmailShell.js';
import { buildCampaignCustomArgs } from '../campaignCustomArgs.js';
import { buildListUnsubscribeHeaders, buildUnsubscribeUrl } from '../../unsubscribe/listUnsubscribeHeaders.js';
import { getBrandConfig } from '../../newsletter/brand-config.js';

export const MODE = Object.freeze({ OFF: 'off', DRY_RUN: 'dry-run', LIVE: 'live' });
export const MAX_SENDS_PER_RUN = 20;
const MAX_PAGES = 10;
const DELIVERIES_TABLE = 'CampaignDeliveries';
const BLACKLIST_TABLE = 'EmailBlacklist';
const CUSTOMER_FIELDS = [
  'Email', '氏名', 'プラン', 'PlanType', '有効期限', 'PaidAt', 'Status', 'ForceLogout',
  'WithdrawalRequested', 'UnsubscribedAnalyticsKeiba', 'PremiumConvertedAt',
];

export class LightRenewalError extends Error {
  constructor(code) { super(`light_renewal:${code}`); this.code = code; }
}

/** env → 実行モード（既定は off。未知の値も off） */
export function resolveMode(env = {}) {
  const v = String(env.LIGHT_RENEWAL_REMINDER_MODE || '').trim().toLowerCase();
  return v === MODE.LIVE || v === MODE.DRY_RUN ? v : MODE.OFF;
}

/**
 * 候補を読む formula。Airtable の TODAY は UTC なので窓より**広め**に取り、
 * 最終判定は `evaluateCandidate`（JST 暦日）が行う。
 */
export const CANDIDATE_FORMULA = "AND(OR(LOWER({プラン})='light',LOWER({プラン})='standard',{プラン}='ライト'),"
  + "LOWER({PlanType})='monthly',NOT({PaidAt}=''),NOT({有効期限}=''),"
  + "IS_AFTER({有効期限},DATEADD(TODAY(),-33,'days')),IS_BEFORE({有効期限},DATEADD(TODAY(),10,'days')))";

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function airtable({ KEY, BASE, fetchImpl }) {
  const h = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const base = `https://api.airtable.com/v0/${BASE}`;
  return {
    async list(table, { formula, fields }) {
      const out = [];
      let offset;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PAGES) throw new LightRenewalError(`too_many_pages:${table}`); // 打ち切らない
        const u = new URL(`${base}/${encodeURIComponent(table)}`);
        if (formula) u.searchParams.set('filterByFormula', formula);
        (fields || []).forEach((f) => u.searchParams.append('fields[]', f));
        if (offset) u.searchParams.set('offset', offset);
        // eslint-disable-next-line no-await-in-loop -- ページ送り
        const res = await fetchImpl(u, { headers: h });
        if (!res.ok) throw new LightRenewalError(`airtable_http_${res.status}:${table}`);
        // eslint-disable-next-line no-await-in-loop
        const j = await res.json();
        out.push(...(j.records || []));
        offset = j.offset;
        if (!offset) return out;
      }
    },
    async get(table, id) {
      const res = await fetchImpl(`${base}/${encodeURIComponent(table)}/${id}`, { headers: h });
      if (res.status === 404) return null;
      if (!res.ok) throw new LightRenewalError(`airtable_http_${res.status}:${table}`);
      return res.json();
    },
    async upsertDelivery(fields) {
      const res = await fetchImpl(`${base}/${DELIVERIES_TABLE}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['DeliveryKey'] }, records: [{ fields }], typecast: true }),
      });
      if (!res.ok) throw new LightRenewalError(`delivery_upsert_http_${res.status}`);
      const j = await res.json();
      const rec = (j.records || [])[0];
      if (!rec || !rec.id) throw new LightRenewalError('delivery_upsert_no_id');
      return rec;
    },
    async patchDelivery(id, fields) {
      const res = await fetchImpl(`${base}/${DELIVERIES_TABLE}/${id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ fields, typecast: true }),
      });
      return res.ok;
    },
  };
}

/** 配信履歴を宛先ぶんだけ読む（EmailType='campaign'）*/
async function loadDeliveries(at, emails) {
  const rows = [];
  for (let i = 0; i < emails.length; i += 20) {
    const part = emails.slice(i, i + 20);
    const formula = `AND({EmailType}='campaign',OR(${part.map((e) => `LOWER({RecipientEmail})='${esc(e)}'`).join(',')}))`;
    // eslint-disable-next-line no-await-in-loop -- 20 件ずつ
    rows.push(...await at.list(DELIVERIES_TABLE, {
      formula, fields: ['RecipientEmail', 'DeliveryKey', 'Status', 'SentAt', 'QueuedAt', 'CampaignType', 'EmailType'],
    }));
  }
  return rows;
}

/** 受信者 → 他キャンペーンの最終送信日時（このリマインドの同じ 1 通は含めない）*/
export function buildRecentContact(rows, ownKeys) {
  const map = new Map();
  for (const r of rows || []) {
    const f = r.fields || {};
    if (f.EmailType !== 'campaign') continue;
    if (ownKeys.has(String(f.DeliveryKey || ''))) continue;
    const st = String(f.Status || '');
    if (st !== 'sent' && st !== 'queued') continue;
    const e = String(f.RecipientEmail || '').trim().toLowerCase();
    const t = Date.parse(f.SentAt || f.QueuedAt || '');
    if (!e || !Number.isFinite(t)) continue;
    if (!map.has(e) || t > map.get(e)) map.set(e, t);
  }
  return map;
}

function bump(obj, k) { obj[k] = (obj[k] || 0) + 1; }

/**
 * 実行する。
 * @param {{mode: string, env: object, nowMs?: number, fetchImpl?: Function, redisCmd?: Function|null,
 *          maxSends?: number}} input
 */
export async function runLightRenewal({
  mode, env, nowMs = Date.now(), fetchImpl = fetch, redisCmd = null, maxSends = MAX_SENDS_PER_RUN,
}) {
  const summary = {
    mode, today: jstDate(nowMs), candidates: 0, planned: { pre: 0, post: 0 }, excludedByReason: {},
    sent: 0, failed: 0, skippedByReason: {},
  };
  if (mode === MODE.OFF) return { ...summary, notice: 'off（LIGHT_RENEWAL_REMINDER_MODE 未設定）。何もしていません。' };

  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) throw new LightRenewalError('airtable_not_configured');
  const at = airtable({ KEY, BASE, fetchImpl });

  // 1-2) 候補と今日の段
  const rows = await at.list('Customers', { formula: CANDIDATE_FORMULA, fields: CUSTOMER_FIELDS });
  const planned = [];
  for (const r of rows) {
    summary.candidates += 1;
    const ev = evaluateCandidate(r.fields, nowMs);
    if (!ev.eligible) { bump(summary.excludedByReason, ev.reason); continue; }
    summary.planned[ev.stage] += 1;
    planned.push({
      recordId: r.id,
      email: String(r.fields.Email).trim().toLowerCase(),
      name: r.fields['氏名'] || '',
      cycle: ev.cycle,
      stage: ev.stage,
      deliveryKey: deliveryKeyFor({ recordId: r.id, cycle: ev.cycle, stage: ev.stage }),
    });
  }
  if (mode === MODE.DRY_RUN) return { ...summary, notice: 'dry-run。送信も書き込みもしていません。' };
  if (planned.length === 0) return { ...summary, notice: '今日送る相手はいません。' };

  // 3) 送信前の材料（読めなければ 1 通も送らない）
  const SG = env.SENDGRID_API_KEY;
  if (!SG) throw new LightRenewalError('sendgrid_not_configured');
  if (typeof redisCmd !== 'function') throw new LightRenewalError('redis_not_configured');
  const provider = await fetchProviderSuppression({ apiKey: SG, fetchImpl, now: nowMs });
  if (!provider.ok) throw new LightRenewalError('provider_suppression_unavailable');
  // EmailBlacklist は**宛先ぶんだけ**名指しで読む（全件は読まない）
  let blRecords = [];
  try {
    const emails = [...new Set(planned.map((p) => p.email))];
    for (let i = 0; i < emails.length; i += 20) {
      const part = emails.slice(i, i + 20);
      // eslint-disable-next-line no-await-in-loop -- 20 件ずつ
      blRecords.push(...await at.list(BLACKLIST_TABLE, {
        formula: `OR(${part.map((e) => `LOWER({Email})='${esc(e)}'`).join(',')})`, fields: ['Email', 'Status'],
      }));
    }
  } catch { blRecords = null; }
  if (!blRecords) throw new LightRenewalError('blacklist_unavailable');
  const blocked = new Set(buildBlacklistEmailSet(blRecords));
  for (const r of blRecords) {
    const e = String(r?.fields?.Email || '').trim().toLowerCase();
    if (e) blocked.add(e); // 販促メールは SOFT_BOUNCE も送らない（dispatch と同じ）
  }
  const deliveries = await loadDeliveries(at, [...new Set(planned.map((p) => p.email))]);
  const ownKeys = new Set(planned.map((p) => p.deliveryKey));
  const recentContactAtMs = buildRecentContact(deliveries, ownKeys);
  const sentKeys = new Set(deliveries
    .filter((r) => ownKeys.has(String(r.fields?.DeliveryKey || '')) && String(r.fields?.Status || '') === 'sent')
    .map((r) => String(r.fields.DeliveryKey)));

  const brand = getBrandConfig('analytics-keiba');
  const clickTracking = isMarketingClickTrackingEnabled(env);

  // 4) 1 人ずつ
  for (const p of planned) {
    if (summary.sent >= maxSends) { bump(summary.skippedByReason, 'run_limit'); continue; }
    if (sentKeys.has(p.deliveryKey)) { bump(summary.skippedByReason, 'already_sent'); continue; }

    // eslint-disable-next-line no-await-in-loop -- 送信直前に読み直す
    const fresh = await at.get('Customers', p.recordId);
    const f = (fresh && fresh.fields) || null;
    const again = stillSendable(p, f, nowMs);
    if (!again.ok) { bump(summary.skippedByReason, again.reason); continue; }
    const unsubscribed = new Set(f.UnsubscribedAnalyticsKeiba === true ? [p.email] : []);
    const suspended = new Set(['suspended', 'inactive', 'banned', 'disabled']
      .includes(String(f.Status || '').trim().toLowerCase()) ? [p.email] : []);
    const v = verifyBeforeSend({
      email: p.email, providerSuppressed: provider.emails, blocked, unsubscribed, suspended,
      recentContactAtMs, nowMs,
    });
    if (!v.send) { bump(summary.skippedByReason, v.reason); continue; }

    // 予約（SET NX）。結果が分からなければ送らない
    let claim;
    // eslint-disable-next-line no-await-in-loop
    try { claim = await redisCmd(['SET', claimKeyFor(p.deliveryKey), 'sending', 'NX']); } catch { claim = undefined; }
    if (claim === undefined) throw new LightRenewalError('redis_claim_unknown');
    if (claim !== 'OK') { bump(summary.skippedByReason, 'already_claimed'); continue; }
    const release = async () => { try { await redisCmd(['DEL', claimKeyFor(p.deliveryKey)]); } catch { /* 次回 NX で止まる側に倒れる */ } };

    let row;
    try {
      // eslint-disable-next-line no-await-in-loop
      row = await at.upsertDelivery({
        DeliveryKey: p.deliveryKey,
        CampaignType: LIGHT_RENEWAL_CAMPAIGN_TYPE,
        EmailType: 'campaign',
        StepNumber: STEP_NUMBER[p.stage],
        RecipientEmail: p.email,
        CustomerRecordId: p.recordId,
        ScheduledEmailJobId: `lr-${p.cycle}-${p.stage}`,
        Status: 'queued',
        QueuedAt: new Date(nowMs).toISOString(),
        Metadata: JSON.stringify({ cycle: p.cycle, stage: p.stage }),
      });
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await release();
      summary.failed += 1; bump(summary.skippedByReason, 'delivery_row_failed'); continue;
    }

    const args = buildCampaignCustomArgs({
      delivery: {
        recordId: row.id, deliveryKey: p.deliveryKey, customerRecordId: p.recordId,
        campaignType: LIGHT_RENEWAL_CAMPAIGN_TYPE, status: 'queued',
      },
      customerRecordId: p.recordId, campaignId: LIGHT_RENEWAL_CAMPAIGN_ID, campaignVersion: String(LIGHT_RENEWAL_VERSION),
    });
    if (!args.ok) {
      // eslint-disable-next-line no-await-in-loop
      await at.patchDelivery(row.id, { Status: 'failed', FailedAt: new Date(nowMs).toISOString(), ErrorMessage: `custom_args:${args.reason}` });
      // eslint-disable-next-line no-await-in-loop
      await release();
      summary.failed += 1; continue;
    }

    const mail = renderLightRenewalEmail({ stage: p.stage, cycle: p.cycle, name: p.name });
    const unsubscribeUrl = buildUnsubscribeUrl({ email: p.email, env });
    const html = applyUnsubscribeUrl(mail.html, unsubscribeUrl);
    const text = applyUnsubscribeUrl(mail.text, unsubscribeUrl);
    let ok = false;
    let messageId = '';
    if (html && text) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SG}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: p.email }] }],
            from: { email: brand.defaultFromEmail, name: brand.defaultFromName },
            reply_to: { email: brand.replyToEmail, name: brand.replyToName },
            subject: mail.subject,
            content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
            custom_args: args.customArgs,
            tracking_settings: {
              click_tracking: { enable: clickTracking === true, enable_text: clickTracking === true },
              open_tracking: { enable: true },
            },
            headers: { ...buildListUnsubscribeHeaders(unsubscribeUrl) },
          }),
        });
        ok = res.ok;
        messageId = (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-message-id')) || '';
      } catch { ok = false; }
    }
    const at2 = new Date(nowMs).toISOString();
    if (ok) {
      // eslint-disable-next-line no-await-in-loop
      await at.patchDelivery(row.id, { Status: 'sent', SentAt: at2, ...(messageId ? { ProviderMessageId: messageId } : {}) });
      // eslint-disable-next-line no-await-in-loop
      try { await redisCmd(['SET', claimKeyFor(p.deliveryKey), 'sent']); } catch { /* NX 予約は残っている */ }
      summary.sent += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await at.patchDelivery(row.id, { Status: 'failed', FailedAt: at2, ErrorMessage: 'send_failed' });
      // eslint-disable-next-line no-await-in-loop
      await release(); // 翌日の実行で再試行できるようにする
      summary.failed += 1;
    }
  }
  return { ...summary, notice: '送信直前に配信停止・バウンス・更新・乗り換えを再判定したうえで送信しました。' };
}
