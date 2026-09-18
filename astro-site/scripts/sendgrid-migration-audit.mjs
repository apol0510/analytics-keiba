#!/usr/bin/env node
/**
 * sendgrid-migration-audit.mjs — SendGrid 移行の **read-only 突合**（手元で 1 コマンド）
 *
 * ## なぜ「手元のスクリプト」なのか
 *
 * 突合に要るのは 11,000 件超 × 10 通ぶんの照会で、**同期 Function の実行時間に収まらない**
 * （窓で分割する管理 API はあるが、全窓を人が順番に叩くのは運用にならない）。
 * 手元から read-only で一気に読めば 1 回で終わる。**新しい配信基盤は作らない**。
 *
 * ## 絶対に守ること
 *
 * - **読むだけ。** Redis は `SMEMBERS / SCARD / MGET / SMISMEMBER / GET / SISMEMBER` のみ、
 *   Airtable と SendGrid は **GET のみ**。書き込み系のコマンド・メソッドは**構造的に拒否**する
 * - **メールアドレスを出力しない。** 出るのは件数と分布だけ（出力に `@` が混ざったら中止）
 * - **判定は既存の単一源を使う**（`sendgridMessagePlan` / `sendgridNextMessage` /
 *   `prospectStore` の鍵の作り方）。ここで再実装しない
 *
 * ## 使い方
 *
 * ```bash
 * cd astro-site
 * UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 * AIRTABLE_API_KEY=... AIRTABLE_BASE_ID=... \
 * node scripts/sendgrid-migration-audit.mjs > /tmp/ak-migration-audit.json
 * ```
 *
 * ## Upstash の値が読めないとき（**本番の既定経路**）
 *
 * production の `UPSTASH_*` は Netlify 側で **secret 指定**のため、CLI からも
 * `netlify dev:exec` からも**値を取り出せない**（`****` が入る）。
 * そのときは `--via-admin` を付けると、**すでに本番へ出ている read-only の管理 API**
 * （`admin-marketing` の `prospectSequenceCheck` / `prospectIndexAudit`）から同じ数字を出す。
 * 秘密は `x-admin-secret`（`MARKETING_ADMIN_SECRET` か `PREMIUM_PLUS_ADMIN_SECRET`）を
 * **子プロセスの env から読むだけ**で、画面にもログにも出さない。
 *
 * ```bash
 * cd /Users/user/Projects/analytics-keiba
 * netlify dev:exec --context production node astro-site/scripts/sendgrid-migration-audit.mjs --via-admin
 * ```
 *
 * - Airtable の 2 つは省略できる（省略すると Customers 側の突合をとばす）
 * - `SENDGRID_API_KEY` があれば SendGrid 側の前提（custom field / list / contact 数 /
 *   unsubscribe group）も読む。**契約変更も書き込みもしない**
 * - `--out <path>` で JSON をファイルへも書く（**repo の中へ書かないこと**）
 */

import { writeFileSync } from 'node:fs';

import {
  buildMessagePlan, buildMessageKeys, groupPlanByCampaign, TOTAL_MESSAGES,
} from '../src/lib/marketing/sendgridMessagePlan.js';
import {
  resolveNextMessage, summarizeNextMessages, containsEmailLike, nextMessageFromCurrentSteps,
} from '../src/lib/marketing/sendgridNextMessage.js';
import {
  ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX, prospectKey, emailHash,
} from '../src/lib/marketing/prospectStore.js';
import { buildDeliveredSetKey } from '../src/lib/marketing/deliveryKeyStore.js';
import { getBrandConfig } from '../src/lib/newsletter/brand-config.js';
import {
  estimateSelectionVolume, estimateSteadyVolume, recommendPlan, describePlanTimeline,
} from '../src/lib/marketing/sendgridPlanSizing.js';
import { listNameFor } from '../src/lib/marketing/sendgridAutomationPlan.js';
import { CONTACT_FIELD_NAMES_REQUIRED } from '../src/lib/marketing/sendgridContactExport.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_CAMPAIGNS = ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium'];
const DELIVERIES_TABLE = 'CampaignDeliveries';

/** Redis で使ってよいコマンド（**書き込みは構造的に拒否**） */
const READ_ONLY_REDIS = new Set(['SMEMBERS', 'SCARD', 'MGET', 'SMISMEMBER', 'GET', 'SISMEMBER']);

const args = process.argv.slice(2);
const outPath = (() => {
  const i = args.indexOf('--out');
  return i >= 0 ? args[i + 1] : null;
})();
/** 本番の既定経路。Upstash が secret で読めないときはこちら */
const viaAdmin = args.includes('--via-admin');
/** 本番の read-only 管理 API（**すでにデプロイ済みのもの以外は使わない**） */
const ADMIN_FN = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';

const env = process.env;
const REDIS_URL = env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
const AIRTABLE_KEY = env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = env.AIRTABLE_BASE_ID;
const SENDGRID_KEY = env.SENDGRID_API_KEY;
/** ⚠️ 値はここから出さない（ヘッダへ載せるだけ） */
const ADMIN_SECRET = env.MARKETING_ADMIN_SECRET || env.PREMIUM_PLUS_ADMIN_SECRET;

if (viaAdmin) {
  if (!ADMIN_SECRET) {
    console.error('--via-admin には MARKETING_ADMIN_SECRET か PREMIUM_PLUS_ADMIN_SECRET が要ります');
    process.exit(2);
  }
} else if (!REDIS_URL || !REDIS_TOKEN || /^\*{4,}/.test(String(REDIS_TOKEN))) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が読めません。'
    + ' production では secret 指定のため値を取り出せないので `--via-admin` を使ってください');
  process.exit(2);
}

const log = (...a) => console.error(...a);   // 進捗は stderr（stdout は JSON だけ）

async function redis(cmdArgs) {
  const op = String(cmdArgs[0] || '').toUpperCase();
  if (!READ_ONLY_REDIS.has(op)) throw new Error(`read_only_violation:${op}`);
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmdArgs),
  });
  if (!res.ok) throw new Error(`upstash_http_${res.status}`);
  return (await res.json()).result;
}

/**
 * 本番の read-only 管理 API を叩く（**POST だが副作用なし**の action だけ）。
 * ⚠️ 使ってよい action は下の許可リストだけ。書き込み系の action 名は構造的に拒否する。
 */
const READ_ONLY_ADMIN_ACTIONS = new Set(['prospectSequenceCheck', 'prospectIndexAudit']);
async function adminAction(payload, tries = 4) {
  if (!READ_ONLY_ADMIN_ACTIONS.has(String(payload && payload.action))) {
    throw new Error(`read_only_violation:${payload && payload.action}`);
  }
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 直列に投げる（本番へ押し寄せない）
    const res = await fetch(ADMIN_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (res && res.status === 200) return res.json();
    if (res && res.status === 409) return { __indexChanged: true };
    // eslint-disable-next-line no-await-in-loop -- 実行時間切れは間を置いて再試行する
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('admin_api_unavailable');
}

/**
 * 管理 API 経由で「通し番号別の人数」を出す。
 *
 * `prospectSequenceCheck` は campaign ごとに `byCurrentStep`（= その人が最後に受け取った step）を
 * 返すので、**第 1 期の currentStep + 1** が次の通し番号になる。第 1 期を配り終えた人は
 * **第 2 期の currentStep** を見て `4 + s` にする（第 2 期は第 1 期完了者しか入らない）。
 */
async function scanViaAdmin(campaignId, limit = 1000) {
  const agg = {
    sentByStep: {}, byCurrentStep: {}, dueByStep: {}, windows: 0, missing: 0,
    indexSize: null, digest: null, pool: null, delivered: {}, withOpens: 0,
  };
  let offset = 0; let digest;
  for (let guard = 0; guard < 200; guard += 1) {
    // eslint-disable-next-line no-await-in-loop -- 窓を順に読む
    const body = await adminAction({
      action: 'prospectSequenceCheck', campaignId, limit, offset, ...(digest ? { digest } : {}),
    });
    if (body.__indexChanged) return { ok: false, reason: 'index_changed', agg };
    if (body.ok === false) return { ok: false, reason: body.reason || 'unknown', agg };
    const w = body.window || {};
    const sum = body.now || {};
    agg.windows += 1;
    agg.missing += Number(w.missing) || 0;
    agg.indexSize = w.indexSize; agg.digest = w.digest; digest = w.digest;
    agg.pool = body.pool || agg.pool;
    for (const [k, v] of Object.entries(sum.sentByStep || {})) agg.sentByStep[k] = (agg.sentByStep[k] || 0) + v;
    for (const [k, v] of Object.entries(sum.byCurrentStep || {})) agg.byCurrentStep[k] = (agg.byCurrentStep[k] || 0) + v;
    for (const [k, v] of Object.entries(sum.dueByStep || {})) agg.dueByStep[k] = (agg.dueByStep[k] || 0) + v;
    for (const [k, v] of Object.entries((body.delivered || {}).histogram || {})) {
      agg.delivered[k] = (agg.delivered[k] || 0) + v;
    }
    agg.withOpens += Number((body.delivered || {}).withOpens) || 0;
    if (w.nextOffset === null || w.nextOffset === undefined) return { ok: true, agg };
    offset = w.nextOffset;
    if (agg.windows % 5 === 0) log(`   ${campaignId}: ${offset}/${w.indexSize}`);
  }
  return { ok: false, reason: 'too_many_windows', agg };
}

async function airtableGet(path, params) {
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(path)}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` } });
  if (!res.ok) throw new Error(`airtable_http_${res.status}`);
  return res.json();
}

async function sendgridGet(path) {
  const res = await fetch(`https://api.sendgrid.com${path}`, {
    headers: { Authorization: `Bearer ${SENDGRID_KEY}` },
  });
  if (!res.ok) throw new Error(`sendgrid_http_${res.status}`);
  return res.json();
}

const chunk = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

async function main() {
  const planResult = buildMessagePlan();
  if (!planResult.ok) throw new Error(`message_plan_unavailable:${planResult.reason}`);
  const plan = planResult.plan;
  const groups = groupPlanByCampaign(plan);
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const phase1Id = groups[0].campaignId;
  const phase2Id = groups[1].campaignId;

  /** どちらの経路でも同じ形にそろえる（出力を 1 本にするため） */
  let prospectPart = null;
  let nextMessage = null;
  /** 台帳の宛先が「いまどこに居るか」を調べる関数（経路ごとに実装が違う）*/
  let placeHashes = null;

  if (viaAdmin) {
    // ── A) すでに本番へ出ている read-only 管理 API から数える ──────────
    log('[1/3] 本番の管理 API から prospect を全窓走査します（read-only）…');
    /**
     * ⚠️ **索引は走査中も動く**（配信が進むと出入りする）。`digest` が変わったら
     *    部分結果を混ぜずに**最初からやり直す**（fail closed の設計どおり）。
     *    本番は生きているので、数回のやり直しは異常ではない。
     */
    const scanWithRetry = async (campaignId, tries = 4) => {
      for (let i = 0; i < tries; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- やり直しは直列
        const r = await scanViaAdmin(campaignId);
        if (r.ok) return r;
        if (r.reason !== 'index_changed') return r;
        log(`   ${campaignId}: 索引が変わったのでやり直します（${i + 1}/${tries}）`);
      }
      return { ok: false, reason: 'index_changed_repeatedly', agg: {} };
    };
    const p1 = await scanWithRetry(phase1Id);
    if (!p1.ok) throw new Error(`phase1_scan_failed:${p1.reason}`);
    const p2 = await scanWithRetry(phase2Id);
    if (!p2.ok) throw new Error(`phase2_scan_failed:${p2.reason}`);
    const next = nextMessageFromCurrentSteps(p1.agg.byCurrentStep, p2.agg.byCurrentStep);
    const total = Object.values(next['分布']).reduce((a, b) => a + b, 0) + next['配り終えた'];
    prospectPart = {
      経路: 'admin-api',
      送信候補: (p1.agg.pool || {})['送信候補'] ?? null,
      反応済み未登録: (p1.agg.pool || {})['反応済み未登録'] ?? null,
      永久除外: (p1.agg.pool || {})['永久除外'] ?? null,
      値なし: p1.agg.missing + p2.agg.missing,
      delivered分布: p1.agg.delivered,
      開封あり: p1.agg.withOpens,
      第1期: { sentByStep: p1.agg.sentByStep, byCurrentStep: p1.agg.byCurrentStep, dueByStep: p1.agg.dueByStep },
      第2期: { sentByStep: p2.agg.sentByStep, byCurrentStep: p2.agg.byCurrentStep, dueByStep: p2.agg.dueByStep },
      索引digest: p1.agg.digest === p2.agg.digest ? p1.agg.digest : null,
    };
    nextMessage = {
      ...next,
      合計: total,
      確定: p1.agg.missing === 0 && p2.agg.missing === 0 && p1.agg.digest === p2.agg.digest,
    };
    placeHashes = async (hashes) => {
      const counts = {};
      for (const part of chunk(hashes, 2000)) {
        // eslint-disable-next-line no-await-in-loop -- 実行時間に収めるため直列
        const body = await adminAction({ action: 'prospectIndexAudit', hashes: part });
        for (const [k, v] of Object.entries(body.counts || {})) counts[k] = (counts[k] || 0) + v;
      }
      return counts;
    };
  } else {
    // ── B) Redis を直接読む（dev / 値が読める環境）─────────────────
    log('[1/3] prospect 索引を読みます…');
    const [activeHashes, engagedHashes, blockedHashes] = await Promise.all([
      redis(['SMEMBERS', ACTIVE_INDEX]),
      redis(['SMEMBERS', ENGAGED_INDEX]),
      redis(['SMEMBERS', BLOCKED_INDEX]),
    ]);
    const active = [...new Set((activeHashes || []).map(String))].sort();
    const engaged = new Set((engagedHashes || []).map(String));
    const blocked = new Set((blockedHashes || []).map(String));

    log(`[2/3] prospect レコード ${active.length} 件を読みます…`);
    const records = [];
    let missing = 0;
    for (const group of chunk(active, 500)) {
      // eslint-disable-next-line no-await-in-loop -- Redis の 1 コマンド上限に合わせる
      const raw = await redis(['MGET', ...group.map(prospectKey)]);
      raw.forEach((v, i) => {
        if (v === null || v === undefined) { missing += 1; return; }
        try {
          const rec = typeof v === 'object' ? v : JSON.parse(v);
          records.push({ ...rec, hash: group[i] });
        } catch { missing += 1; }
      });
    }

    log(`[3/3] 既送信の鍵を照会します（${records.length} 名 × ${TOTAL_MESSAGES} 通）…`);
    const keysByEmail = new Map();
    for (const rec of records) {
      const email = String(rec.email || '').trim().toLowerCase();
      if (!email || keysByEmail.has(email)) continue;
      keysByEmail.set(email, buildMessageKeys({ plan, email, brand: BRAND, fromEmail }));
    }
    const deliveredKeys = new Set();
    for (const g of groups) {
      const setKey = buildDeliveredSetKey({ brand: BRAND, campaignId: g.campaignId, version: g.version });
      const wanted = [];
      for (const [, keys] of keysByEmail) {
        if (!keys) continue;
        for (const e of g.entries) {
          const k = keys.get(e.messageNumber);
          if (k) wanted.push(k);
        }
      }
      for (const part of chunk(wanted, 200)) {
        // eslint-disable-next-line no-await-in-loop -- 1 コマンドの上限に合わせる
        const res = await redis(['SMISMEMBER', setKey, ...part]);
        res.forEach((v, i) => { if (Number(v) === 1) deliveredKeys.add(part[i]); });
      }
    }

    const results = [];
    const deliveredHistogram = {};
    let withOpens = 0;
    for (const rec of records) {
      const email = String(rec.email || '').trim().toLowerCase();
      const keys = email ? keysByEmail.get(email) : null;
      let sent = null;
      if (keys) {
        sent = new Set();
        for (const [n, k] of keys) if (deliveredKeys.has(k)) sent.add(n);
      }
      results.push(resolveNextMessage({ prospect: rec, deliveredMessageNumbers: sent }));
      const d = Number(rec.delivered) || 0;
      deliveredHistogram[d] = (deliveredHistogram[d] || 0) + 1;
      if (Number(rec.opens) > 0) withOpens += 1;
    }
    const summary = summarizeNextMessages(results);
    prospectPart = {
      経路: 'redis',
      送信候補: active.length,
      反応済み未登録: engaged.size,
      永久除外: blocked.size,
      値なし: missing,
      delivered分布: deliveredHistogram,
      開封あり: withOpens,
      除外の内訳: summary['除外の内訳'],
      判定不能の内訳: summary['判定不能の内訳'],
    };
    nextMessage = {
      分布: summary['次に送る番号別'],
      配り終えた: summary['配り終えた'],
      合計: summary['総数'],
      確定: missing === 0,
      穴あき: summary['穴あき'],
    };
    placeHashes = async (hashes) => {
      const activeSet = new Set(active);
      const counts = { active: 0, engaged: 0, blocked: 0, nowhere: 0 };
      for (const x of hashes) {
        if (activeSet.has(x)) counts.active += 1;
        else if (engaged.has(x)) counts.engaged += 1;
        else if (blocked.has(x)) counts.blocked += 1;
        else counts.nowhere += 1;
      }
      return counts;
    };
  }

  // ── Customers 側（Airtable の配信台帳）─────────────────────────
  let customersSide = { 実行: false, 理由: 'airtable_credentials_missing' };
  if (AIRTABLE_KEY && AIRTABLE_BASE) {
    log('Airtable の配信台帳を読みます…');
    const byCampaign = {};
    const uniqueHashes = new Set();
    for (const campaignId of CUSTOMERS_CAMPAIGNS) {
      const version = (plan.find((p) => p.campaignId === campaignId) || { version: 1 }).version;
      const counts = { 行: 0, sent: 0, queued: 0, cancelled: 0, その他: 0, ユニーク宛先: 0 };
      const seen = new Set();
      let offset;
      do {
        // eslint-disable-next-line no-await-in-loop -- ページ送り
        const page = await airtableGet(DELIVERIES_TABLE, {
          pageSize: 100,
          filterByFormula: `AND({EmailType}='campaign',{CampaignType}='${campaignId}:v${version}')`,
          'fields[]': ['RecipientEmail', 'Status'],
          ...(offset ? { offset } : {}),
        });
        for (const rec of page.records || []) {
          const f = rec.fields || {};
          counts['行'] += 1;
          const st = String(f.Status || '');
          if (st === 'sent') counts.sent += 1;
          else if (st === 'queued') counts.queued += 1;
          else if (st === 'cancelled') counts.cancelled += 1;
          else counts['その他'] += 1;
          const email = String(f.RecipientEmail || '').trim().toLowerCase();
          if (email) { const h = emailHash(email); seen.add(h); uniqueHashes.add(h); }
        }
        offset = page.offset;
      } while (offset);
      counts['ユニーク宛先'] = seen.size;
      byCampaign[campaignId] = counts;
    }
    let customersCount = null;
    try {
      const all = new Set();
      let offset;
      do {
        // eslint-disable-next-line no-await-in-loop -- ページ送り
        const page = await airtableGet('Customers', {
          pageSize: 100, 'fields[]': ['Email'], ...(offset ? { offset } : {}),
        });
        for (const rec of page.records || []) {
          const e = String((rec.fields || {}).Email || '').trim().toLowerCase();
          if (e) all.add(emailHash(e));
        }
        offset = page.offset;
      } while (offset);
      customersCount = all.size;
    } catch { customersCount = null; }

    log(`台帳のユニーク宛先 ${uniqueHashes.size} 件が「いまどこに居るか」を突合します…`);
    const place = await placeHashes([...uniqueHashes]);
    customersSide = {
      実行: true,
      campaign別: byCampaign,
      ユニーク宛先合計: uniqueHashes.size,
      Customers残存: customersCount,
      いまの居場所: place,
    };
  }

  // ── SendGrid 側の前提（read-only）──────────────────────────────
  let sendgridSide = { 実行: false, 理由: 'sendgrid_api_key_missing' };
  if (SENDGRID_KEY) {
    log('SendGrid の現況を読みます…');
    const safe = async (path) => {
      try { return await sendgridGet(path); } catch (e) { return { __error: String(e.message).slice(0, 40) }; }
    };
    const [fields, lists, count, asmGroups] = await Promise.all([
      safe('/v3/marketing/field_definitions'), safe('/v3/marketing/lists?page_size=100'),
      safe('/v3/marketing/contacts/count'), safe('/v3/asm/groups'),
    ]);
    const countSuppression = async (path) => {
      let n = 0; let offset = 0;
      for (let i = 0; i < 60; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- ページ送り
        const j = await safe(`${path}?limit=500&offset=${offset}`);
        if (j && j.__error) return { count: n, error: j.__error };
        const arr = Array.isArray(j) ? j : (j.result || []);
        n += arr.length;
        if (arr.length < 500) return { count: n, complete: true };
        offset += 500;
      }
      return { count: n, complete: false };
    };
    const [bounces, blocks, spam, globalUnsub] = await Promise.all([
      countSuppression('/v3/suppression/bounces'), countSuppression('/v3/suppression/blocks'),
      countSuppression('/v3/suppression/spam_reports'), countSuppression('/v3/asm/suppressions/global'),
    ]);
    sendgridSide = {
      実行: true,
      marketingCampaigns: count && count.__error
        ? { 読めない: count.__error, 意味: 'Marketing Campaigns 未契約 / API キーに marketing 権限が無い' }
        : { contacts: Number(count.contact_count) || 0, 課金対象: Number(count.billable_count) || 0 },
      customField: fields && fields.custom_fields
        ? fields.custom_fields.map((f) => String(f.name))
        : { 読めない: (fields || {}).__error || null },
      list: lists && lists.result
        ? lists.result.map((l) => String(l.name))
        : { 読めない: (lists || {}).__error || null },
      unsubscribeGroup: Array.isArray(asmGroups)
        ? asmGroups.map((g) => ({ id: Number(g.id), name: String(g.name || ''), unsubscribes: Number(g.unsubscribes) || 0 }))
        : { 読めない: (asmGroups || {}).__error || null },
      suppression: { bounces, blocks, spamReports: spam, globalUnsubscribes: globalUnsub },
    };
  }

  // ── 出力（**アドレスを含めない**）──────────────────────────────
  const selection = estimateSelectionVolume({ countsByNextMessage: nextMessage['分布'] });
  /**
   * ⚠️ 選別後に何名残るかは**まだ分からない**（反応した人だけが残る）。
   *    ここでは「**全員が残った場合の上限**」と「仮に 5,000 名残った場合」の 2 つを出し、
   *    どちらも**推定**であることが読み手に分かる形にする。
   */
  const steadyUpper = estimateSteadyVolume({ contacts: selection.contacts });
  const steadyIf5000 = estimateSteadyVolume({ contacts: 5000 });
  const steady = steadyIf5000;
  const out = {
    実行時刻: new Date().toISOString(),
    副作用: 'none（read-only）',
    経路: prospectPart['経路'],
    prospect: prospectPart,
    通し番号: nextMessage,
    Customers側: customersSide,
    SendGrid側: sendgridSide,
    見積り: {
      選別中: selection,
      '選別後（全員残った場合の上限・推定）': steadyUpper,
      '選別後（仮に5,000名残った場合・推定）': steadyIf5000,
      選別後: steady,
      プラン: describePlanTimeline({ selection, steady }),
      最小プラン: recommendPlan({
        contacts: selection.contacts, monthlyEmails: selection.peakMonthlyEmails,
      }),
    },
  };

  if (containsEmailLike(out)) {
    console.error('出力にアドレスらしき文字列が含まれています。中止します。');
    process.exit(3);
  }
  const json = JSON.stringify(out, null, 2);
  if (outPath) writeFileSync(outPath, json);
  console.log(json);
}

main().catch((e) => {
  // ⚠️ 例外本文に資格情報が混ざりうるので理由コードだけ出す
  console.error(`audit_failed: ${String((e && e.message) || 'unknown').slice(0, 80)}`);
  process.exit(1);
});
