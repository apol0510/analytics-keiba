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
  resolveNextMessage, summarizeNextMessages, containsEmailLike,
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

const env = process.env;
const REDIS_URL = env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
const AIRTABLE_KEY = env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = env.AIRTABLE_BASE_ID;
const SENDGRID_KEY = env.SENDGRID_API_KEY;

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が要ります（read-only）');
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

  // ── 1) prospect プール（索引と件数）────────────────────────────
  log('[1/5] prospect 索引を読みます…');
  const [activeHashes, engagedHashes, blockedHashes] = await Promise.all([
    redis(['SMEMBERS', ACTIVE_INDEX]),
    redis(['SMEMBERS', ENGAGED_INDEX]),
    redis(['SMEMBERS', BLOCKED_INDEX]),
  ]);
  const active = [...new Set((activeHashes || []).map(String))].sort();
  const engaged = new Set((engagedHashes || []).map(String));
  const blocked = new Set((blockedHashes || []).map(String));

  // ── 2) レコードを読む（アドレスはメモリ内だけ）───────────────
  log(`[2/5] prospect レコード ${active.length} 件を読みます…`);
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

  // ── 3) 既送信の鍵を台帳へ照会（10 通ぶん）─────────────────────
  log(`[3/5] 既送信の鍵を照会します（${records.length} 名 × ${TOTAL_MESSAGES} 通）…`);
  const keysByEmail = new Map();
  for (const rec of records) {
    const email = String(rec.email || '').trim().toLowerCase();
    if (!email || keysByEmail.has(email)) continue;
    keysByEmail.set(email, buildMessageKeys({ plan, email, brand: BRAND, fromEmail }));
  }
  const delivered = new Set();
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
    let done = 0;
    for (const part of chunk(wanted, 200)) {
      // eslint-disable-next-line no-await-in-loop -- 1 コマンドの上限に合わせる
      const res = await redis(['SMISMEMBER', setKey, ...part]);
      res.forEach((v, i) => { if (Number(v) === 1) delivered.add(part[i]); });
      done += part.length;
      if (done % 20000 === 0) log(`   …${g.campaignId}: ${done}/${wanted.length}`);
    }
  }

  // ── 4) 1 人ずつ「次に送る番号」を決める ──────────────────────
  const results = [];
  const deliveredHistogram = {};
  let withOpens = 0;
  for (const rec of records) {
    const email = String(rec.email || '').trim().toLowerCase();
    const keys = email ? keysByEmail.get(email) : null;
    let sent = null;
    if (keys) {
      sent = new Set();
      for (const [n, k] of keys) if (delivered.has(k)) sent.add(n);
    }
    const r = resolveNextMessage({ prospect: rec, deliveredMessageNumbers: sent });
    results.push(r);
    const d = Number(rec.delivered) || 0;
    deliveredHistogram[d] = (deliveredHistogram[d] || 0) + 1;
    if (Number(rec.opens) > 0) withOpens += 1;
  }
  const summary = summarizeNextMessages(results);

  // ── 5) Customers 側（Airtable の配信台帳）─────────────────────
  let customersSide = { 実行: false, 理由: 'airtable_credentials_missing' };
  if (AIRTABLE_KEY && AIRTABLE_BASE) {
    log('[4/5] Airtable の配信台帳を読みます…');
    const byCampaign = {};
    const uniqueHashes = new Set();
    const keyHits = new Map();          // DeliveryKey → true（Airtable 側に存在）
    for (const campaignId of CUSTOMERS_CAMPAIGNS) {
      const entry = plan.find((p) => p.campaignId === campaignId)
        || { version: 1 };
      const campaignType = `${campaignId}:v${entry.version}`;
      const counts = { 行: 0, sent: 0, queued: 0, cancelled: 0, その他: 0, ユニーク宛先: 0 };
      const seen = new Set();
      let offset;
      do {
        // eslint-disable-next-line no-await-in-loop -- ページ送り
        const page = await airtableGet(DELIVERIES_TABLE, {
          pageSize: 100,
          filterByFormula: `AND({EmailType}='campaign',{CampaignType}='${campaignType}')`,
          'fields[]': ['DeliveryKey', 'RecipientEmail', 'Status'],
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
          if (email) {
            const h = emailHash(email);
            if (!seen.has(h)) { seen.add(h); uniqueHashes.add(h); }
            // step 別の内訳は鍵で判定する（鍵の作り方は変えない）
            if (!keysByEmail.has(email)) {
              keysByEmail.set(email, buildMessageKeys({ plan, email, brand: BRAND, fromEmail }));
            }
          }
          if (f.DeliveryKey) keyHits.set(String(f.DeliveryKey), true);
        }
        offset = page.offset;
      } while (offset);
      counts['ユニーク宛先'] = seen.size;
      byCampaign[campaignId] = counts;
    }

    // 15,509 の展開: ユニーク宛先が「いまどこに居るか」
    const place = { prospect送信候補: 0, prospect反応済み: 0, 永久除外: 0, prospect以外: 0 };
    const activeSet = new Set(active);
    for (const h of uniqueHashes) {
      if (activeSet.has(h)) place['prospect送信候補'] += 1;
      else if (engaged.has(h)) place['prospect反応済み'] += 1;
      else if (blocked.has(h)) place['永久除外'] += 1;
      else place['prospect以外'] += 1;
    }

    // Customers 側の step 別（台帳にある鍵で数える）
    const stepCounts = {};
    for (let n = 1; n <= TOTAL_MESSAGES; n += 1) stepCounts[n] = 0;
    for (const [, keys] of keysByEmail) {
      if (!keys) continue;
      for (const [n, k] of keys) if (keyHits.has(k)) stepCounts[n] += 1;
    }

    customersSide = {
      実行: true,
      campaign別: byCampaign,
      ユニーク宛先合計: uniqueHashes.size,
      いまの居場所: place,
      台帳の鍵で数えた通し番号別: stepCounts,
    };
  } else {
    log('[4/5] Airtable の資格情報が無いので Customers 側は飛ばします');
  }

  // ── 6) SendGrid 側の前提（read-only）──────────────────────────
  let sendgridSide = { 実行: false, 理由: 'sendgrid_api_key_missing' };
  if (SENDGRID_KEY) {
    log('[5/5] SendGrid の現況を読みます…');
    const [fields, lists, count, groupsAsm] = await Promise.all([
      sendgridGet('/v3/marketing/field_definitions'),
      sendgridGet('/v3/marketing/lists?page_size=100'),
      sendgridGet('/v3/marketing/contacts/count'),
      sendgridGet('/v3/asm/groups'),
    ]);
    const names = new Set(((fields && fields.custom_fields) || []).map((f) => String(f.name)));
    sendgridSide = {
      実行: true,
      contacts: { 総数: Number(count.contact_count) || 0, 課金対象: Number(count.billable_count) || 0 },
      customField: {
        必須: CONTACT_FIELD_NAMES_REQUIRED,
        そろっている: CONTACT_FIELD_NAMES_REQUIRED.every((n) => names.has(n)),
        既存数: names.size,
      },
      list: {
        既存数: ((lists && lists.result) || []).length,
        移行用: ((lists && lists.result) || [])
          .map((l) => String(l.name))
          .filter((n) => n.startsWith(listNameFor(''))),
      },
      unsubscribeGroup: (Array.isArray(groupsAsm) ? groupsAsm : [])
        .map((g) => ({ id: Number(g.id), name: String(g.name || '') })),
    };
  } else {
    log('[5/5] SENDGRID_API_KEY が無いので SendGrid 側は飛ばします');
  }

  // ── 7) 出力（**アドレスを含めない**）──────────────────────────
  const selection = estimateSelectionVolume({ countsByNextMessage: summary['次に送る番号別'] });
  const steady = estimateSteadyVolume({ contacts: selection.contacts });
  const out = {
    実行時刻: new Date().toISOString(),
    副作用: 'none（read-only）',
    prospect: {
      送信候補: active.length,
      反応済み未登録: engaged.size,
      永久除外: blocked.size,
      読めた件数: records.length,
      値なし: missing,
      delivered分布: deliveredHistogram,
      開封あり: withOpens,
    },
    通し番号: {
      ...summary,
      /** ⚠️ `値なし` が 0 のときだけ「確定」と呼べる */
      確定: missing === 0,
    },
    Customers側: customersSide,
    SendGrid側: sendgridSide,
    見積り: {
      選別中: selection,
      選別後: steady,
      プラン: describePlanTimeline({ selection, steady }),
      最小プラン: recommendPlan({
        contacts: selection.contacts, monthlyEmails: selection.peakMonthlyEmails,
      }),
    },
  };

  // ⚠️ アドレスが 1 つでも混ざっていたら**出力しない**
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
