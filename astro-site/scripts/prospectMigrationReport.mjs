/**
 * prospectMigrationReport.mjs — 移行前の**最終下見と全件 parity**（read-only）
 *
 * Airtable も Redis も**1 バイトも書かない**。本番の Customers と CampaignDeliveries を
 * 読み、開封の集計（hash）を当てて、
 *
 *   1. 移行の判定（本人の反応 / 運営付与 / 保留 / 移行対象）
 *   2. Customers 経路と prospect 経路の**全件 parity**
 *      （対象 / 次 step / DeliveryKey / 停止理由 / delivered 回数）
 *   3. **8/31 の 2 通目の対象が両経路で完全一致するか**
 *   4. Redis へ投入する内容（件数と鍵の数。**アドレスはファイルにしか書かない**）
 *
 * を出す。
 *
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… \
 *   node scripts/prospectMigrationReport.mjs --open-hashes <digest.json> [--at 2026-08-31T00:00:00+09:00]
 *
 * ⚠️ `--open-hashes` は `admin-marketing?action=engagementDigest` の応答 JSON。
 *    **渡さない / `available:false` なら parity も投入計画も出さない**（fail closed）。
 *    開封者を落とすと、本来 Customers へ残す人まで prospect へ移してしまう。
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  buildMigrationPlan, decideForRecord, DECISION_LABEL, MIGRATION_DECISION,
  buildSuppressionHandoff, assertRollbackComplete,
} from '../src/lib/marketing/prospectMigrationPlan.js';
import { emailHash } from '../src/lib/marketing/prospectStore.js';
import { hashEmailForSignal } from '../src/lib/marketing/engagementSignalStore.js';
import { getCampaign } from '../src/lib/marketing/campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep, resolveMaxSends } from '../src/lib/marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../src/lib/marketing/campaignSend.js';
import { resolveCustomerMarketing } from '../src/lib/marketing/customerMarketingAudience.js';
import { buildSequenceProgress, SEQ_STATUS } from '../src/lib/marketing/sequenceProgress.js';
import { compareSequenceParity, assertParityBeforeMigration } from '../src/lib/marketing/sequenceParity.js';
import { buildProspectSequenceRows } from '../src/lib/marketing/prospectSequenceAdapter.js';
import { hydrateProspectSequenceInputs } from '../src/lib/marketing/prospectSequenceHydration.js';
import { buildProspect } from '../src/lib/marketing/prospectPolicy.js';
import { projectAirtableLedgerGrowth, RECIPIENT_SOURCE } from '../src/lib/marketing/deliveryKeySource.js';
import { importBatchId } from '../src/lib/marketing/importCohort.js';
import { getBrandConfig } from '../src/lib/newsletter/brand-config.js';

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;
if (!KEY || !BASE) { console.error('✖ AIRTABLE_API_KEY / AIRTABLE_BASE_ID が要る'); process.exit(1); }

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const OUT = arg('--out') || `${process.env.HOME}/.analytics-keiba-ops/prospect-migration`;
const CAMPAIGN_ID = arg('--campaign') || 'campaign-discount-free';
const BRAND = arg('--brand') || 'analytics-keiba';
/**
 * ⚠️ 送信元は **`DeliveryKey` の材料**。実送信が使うのと同じ値でなければ鍵が変わり、
 *    既送信を 1 件も照合できずに「全員が未送信」と誤判定する（実際に一度そうなった）。
 *    したがって `SENDGRID_FROM_EMAIL` ではなく、実送信と同じ
 *    `getBrandConfig(BRAND).defaultFromEmail` を既定にする。
 */
const FROM = arg('--from') || getBrandConfig(BRAND).defaultFromEmail;
/** 2 通目の判定時刻。既定は 8/31 の JST 09:00（cron が回っている時間帯） */
const AT = Date.parse(arg('--at') || '2026-08-31T09:00:00+09:00');
const NOW = Date.now();

mkdirSync(OUT, { recursive: true });

const lower = (v) => String(v ?? '').trim().toLowerCase();

/* ── 1. Airtable を読む（ローカルなので 4,000 行の打ち切りは無い）────────── */

async function fetchAll(table, fields, filter) {
  const out = []; let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize', '100');
    fields.forEach((f, i) => u.searchParams.set(`fields[${i}]`, f));
    if (filter) u.searchParams.set('filterByFormula', filter);
    if (offset) u.searchParams.set('offset', offset);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) { console.error(`✖ ${table} 取得失敗 ${res.status}`); process.exit(1); }
    const j = await res.json();
    out.push(...j.records.map((r) => ({ id: r.id, fields: r.fields })));
    offset = j.offset;
  } while (offset);
  return out;
}

const CUSTOMER_FIELDS = ['Email', 'Source', 'プラン', 'PlanType', 'Status', 'AccountStatus', 'PaidAt',
  'PaymentConfirmed', 'RequestedPlan', 'RequestedAmount', 'LifetimeSanrenpuku',
  'LightGrantLifetime', 'LightGrantUntil', 'PremiumGrantLifetime', 'PremiumGrantUntil',
  'PremiumPlusEligibility', 'ポイント', '最終ログイン', '有効期限',
  'UnsubscribedAnalyticsKeiba', 'WithdrawalRequested', 'ForceLogout'];

const DELIVERY_FIELDS = ['DeliveryKey', 'RecipientEmail', 'Status', 'SentAt', 'QueuedAt', 'EmailType', 'CampaignType'];

/**
 * 実在する列だけを要求する。**存在しない列名を混ぜると 422 で全件取得が落ちる**ので、
 * 先にスキーマを読んで交差を取る（列名を推測で決め打ちしない）。
 */
async function availableFields(table) {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) { console.error(`✖ スキーマ取得失敗 ${res.status}`); process.exit(1); }
  const j = await res.json();
  const t = (j.tables || []).find((x) => x.name === table);
  if (!t) { console.error(`✖ table が無い: ${table}`); process.exit(1); }
  return new Set((t.fields || []).map((f) => f.name));
}

console.log('Airtable を読み込み中…（read-only）');
const haveCustomerFields = await availableFields('Customers');
const missingFields = CUSTOMER_FIELDS.filter((f) => !haveCustomerFields.has(f));
if (missingFields.length > 0) console.log(`  （Customers に無い列は要求しない: ${missingFields.join(' / ')}）`);
const customers = await fetchAll('Customers', CUSTOMER_FIELDS.filter((f) => haveCustomerFields.has(f)));
const deliveries = await fetchAll('CampaignDeliveries', DELIVERY_FIELDS, `{EmailType}='campaign'`);
console.log(`  Customers ${customers.length} 件 / CampaignDeliveries(campaign) ${deliveries.length} 件`);

/* ── 2. 開封の集計（hash）を当てる ──────────────────────────────── */

const digestPath = arg('--open-hashes');
let digest = null;
if (digestPath) digest = JSON.parse(readFileSync(digestPath, 'utf8'));
const engagementUsable = Boolean(digest && digest.available === true);
const openHashes = new Set(engagementUsable ? (digest.openHashes || []) : []);
const clickHashes = new Set(engagementUsable ? (digest.clickHashes || []) : []);

const engagedEmails = new Set();
if (engagementUsable) {
  for (const c of customers) {
    const e = lower(c.fields.Email);
    if (!e) continue;
    const h = hashEmailForSignal(e);
    if (openHashes.has(h) || clickHashes.has(h)) engagedEmails.add(e);
  }
}
console.log(`  開封の集計: ${engagementUsable ? `適用（open ${openHashes.size} / click ${clickHashes.size} → 該当 ${engagedEmails.size} 名）` : '⚠️ 未適用'}`);

/* ── 3. 移行の判定 ────────────────────────────────────────────── */

const plan = buildMigrationPlan({ records: customers, engagedEmails: engagementUsable ? engagedEmails : undefined });
const rollback = assertRollbackComplete({ records: customers, migrateIds: plan.migrateIds });
const handoff = buildSuppressionHandoff({
  records: customers, hashFn: emailHash, nowIso: new Date(NOW).toISOString(),
  engagedEmails: engagementUsable ? engagedEmails : undefined,
});

console.log('\n判定ごとの件数');
for (const [k, v] of Object.entries(plan.counts)) console.log(`  ${String(DECISION_LABEL[k]).padEnd(36)} ${v}`);
console.log(`  母数と判定の合計が一致: ${plan.balanced ? 'はい' : '⚠️ いいえ'}`);

/* ── 4. 両経路の進行を作る ─────────────────────────────────────── */

const campaign = getCampaign(CAMPAIGN_ID, { includeDisabled: true });
if (!campaign) { console.error(`✖ 未知のキャンペーン: ${CAMPAIGN_ID}`); process.exit(1); }

const migrateIds = new Set(plan.migrateIds);
const migrateRecords = customers.filter((c) => migrateIds.has(c.id));

/** 台帳を email 別に畳む（delivered 回数と最終送信時刻） */
const byEmail = new Map();
for (const d of deliveries) {
  const f = d.fields || {};
  const e = lower(f.RecipientEmail);
  if (!e) continue;
  const st = lower(f.Status);
  if (st !== 'sent' && st !== 'queued') continue;
  const at = Date.parse(String(f.SentAt || f.QueuedAt || ''));
  const cur = byEmail.get(e) || { keys: new Set(), delivered: 0, lastSentAtMs: null };
  cur.keys.add(String(f.DeliveryKey || ''));
  // ⚠️ delivered は「送信成功」の代理として **status=sent の行数**で数える。
  //    queued はまだ届いていないので数えない（打ち切りの分母を水増ししない）。
  if (st === 'sent') cur.delivered += 1;
  if (Number.isFinite(at) && (cur.lastSentAtMs === null || at > cur.lastSentAtMs)) cur.lastSentAtMs = at;
  byEmail.set(e, cur);
}

/**
 * 打ち切り（delivered 10 / 開封 0）が**そもそも誰かに当たりうるか**を先に確かめる。
 *
 * 当たる人が 0 なら、開封の集計を当てられなくても **parity は影響を受けない**
 * （どちらの経路でも engagement では 1 人も止まらない）。
 */
const deliveredCounts = [];
for (const rec of customers) {
  const e = lower(rec.fields.Email);
  deliveredCounts.push((byEmail.get(e) || { delivered: 0 }).delivered);
}
const atOrOver = (n) => deliveredCounts.filter((d) => d >= n).length;
console.log('\ndelivered 回数の分布（全 Customers / status=sent の行数）');
console.log(`  最大 ${Math.max(0, ...deliveredCounts)} 通 / 5 通以上 ${atOrOver(5)} 名 / **10 通以上 ${atOrOver(10)} 名** / 20 通以上 ${atOrOver(20)} 名`);
const cutoffCandidates = atOrOver(10);

/** この campaign の step 別 DeliveryKey */
const stepKeys = (email) => {
  const m = new Map();
  for (const s of getSequenceSteps(campaign)) {
    const eff = resolveSequenceStep(campaign, s.stepNumber);
    if (!eff) continue;
    const k = computeCampaignDeliveryKey({ campaign: eff, recipientEmail: email, brand: BRAND, fromEmail: FROM });
    if (k) m.set(s.stepNumber, k);
  }
  return m;
};

/** Redis へ移す DeliveryKey の集合（＝いま Airtable にある既送信のうち、この campaign のもの）*/
const ledgerKeys = new Set();
for (const rec of migrateRecords) {
  const e = lower(rec.fields.Email);
  const have = byEmail.get(e);
  if (!have) continue;
  for (const [, k] of stepKeys(e)) if (have.keys.has(k)) ledgerKeys.add(k);
}

/** 移行後の prospect レコード（**これがそのまま Redis へ入る**）*/
const prospects = migrateRecords.map((rec) => {
  const e = lower(rec.fields.Email);
  const have = byEmail.get(e) || { delivered: 0, lastSentAtMs: null, keys: new Set() };
  const sentCount = [...stepKeys(e).values()].filter((k) => have.keys.has(k)).length;
  const p = buildProspect({
    email: e, nowMs: NOW, batchId: importBatchId(rec.fields.Source), source: 'csv',
  });
  p.hash = emailHash(e);
  p.sends = sentCount;
  p.delivered = have.delivered;
  p.opens = engagementUsable && openHashes.has(hashEmailForSignal(e)) ? 1 : 0;
  p.clicks = engagementUsable && clickHashes.has(hashEmailForSignal(e)) ? 1 : 0;
  p.lastSentAt = have.lastSentAtMs ? new Date(have.lastSentAtMs).toISOString() : null;
  p.state = sentCount > 0 ? 'SENDING' : 'NEW';
  return p;
});

/** Customers 経路の行（**移行対象と同じ人だけ**を比較する）*/
const customerRows = migrateRecords.map((rec) => {
  const fields = rec.fields;
  return {
    recordId: rec.id, fields,
    marketing: resolveCustomerMarketing({ fields, nowMs: AT }),
  };
});
const migrateEmails = new Set(customerRows.map((r) => lower(r.fields.Email)));
const migrateDeliveries = deliveries.filter((d) => migrateEmails.has(lower((d.fields || {}).RecipientEmail)));

function runBoth(nowMs) {
  const A = buildSequenceProgress({
    campaign, selected: customerRows, deliveries: migrateDeliveries,
    brand: BRAND, fromEmail: FROM, nowMs,
    providerSuppressed: new Set(), softBounced: new Set(),
  });
  const rows = buildProspectSequenceRows({ prospects, nowMs });
  const h = hydrateProspectSequenceInputs({
    prospects, campaign, brand: BRAND, fromEmail: FROM, deliveredKeys: ledgerKeys,
  });
  if (!h.ok) { console.error(`✖ prospect の復元に失敗: ${h.reason}`); process.exit(1); }
  const B = buildSequenceProgress({
    campaign, selected: rows.rows, deliveries: h.deliveries,
    brand: BRAND, fromEmail: FROM, nowMs,
    providerSuppressed: h.providerSuppressed, softBounced: new Set(),
  });
  const km = (pr) => {
    const m = new Map();
    for (const r of pr.rows) {
      if (!r.email || !Number.isInteger(r.nextStep)) continue;
      m.set(r.email, stepKeys(r.email).get(r.nextStep) || null);
    }
    return m;
  };
  const dA = new Map(customerRows.map((r) => {
    const e = lower(r.fields.Email);
    return [e, (byEmail.get(e) || { delivered: 0 }).delivered];
  }));
  const dB = new Map(prospects.map((p) => [p.email, p.delivered]));
  const parity = compareSequenceParity({
    customers: A, prospects: B, customerKeys: km(A), prospectKeys: km(B),
    customerDelivered: dA, prospectDelivered: dB,
  });
  return { A, B, parity, skipped: rows.skipped };
}

console.log(`\n全件 parity（対象 ${customerRows.length} 名 / 判定時刻 = いま）`);
const nowRun = runBoth(NOW);
console.log('  ', JSON.stringify(nowRun.parity.diff));
console.log(`   合格: ${nowRun.parity.ok ? 'はい' : '⚠️ いいえ'} / 移行可: ${assertParityBeforeMigration(nowRun.parity).migrateAllowed}`);

console.log(`\n8/31 の 2 通目（判定時刻 ${new Date(AT).toISOString()}）`);
const atRun = runBoth(AT);
const dueOf = (pr) => new Set(pr.rows.filter((r) => r.status === SEQ_STATUS.DUE).map((r) => r.email));
const dueA = dueOf(atRun.A); const dueB = dueOf(atRun.B);
const onlyA = [...dueA].filter((e) => !dueB.has(e));
const onlyB = [...dueB].filter((e) => !dueA.has(e));
const step2A = atRun.A.summary.dueByStep[2] || 0;
const step2B = atRun.B.summary.dueByStep[2] || 0;
console.log(`   Customers 経路 due ${dueA.size}（step2 ${step2A}） / prospect 経路 due ${dueB.size}（step2 ${step2B}）`);
console.log(`   片側だけ: Customers ${onlyA.length} / prospect ${onlyB.length}`);
console.log('  ', JSON.stringify(atRun.parity.diff));
console.log(`   完全一致: ${onlyA.length === 0 && onlyB.length === 0 && step2A === step2B ? 'はい' : '⚠️ いいえ'}`);

/* ── 5. 8/31 に Airtable が何行増えるか ─────────────────────────── */

const growthCustomer = projectAirtableLedgerGrowth({
  mode: 'dual', recipients: [...dueA].map(() => ({ 出所: RECIPIENT_SOURCE.CUSTOMER })), steps: 1,
});
const growthProspect = projectAirtableLedgerGrowth({
  mode: 'dual', recipients: [...dueB].map(() => ({ 出所: RECIPIENT_SOURCE.PROSPECT })), steps: 1,
});
console.log('\n8/31 の 2 通目で Airtable が増える行数');
console.log(`   いまのまま（Customers 経路）: +${growthCustomer.airtableRows} 行`);
console.log(`   移行後（prospect 経路）    : +${growthProspect.airtableRows} 行`);

/* ── 6. 投入計画を保存（アドレスはファイルにのみ）────────────────── */

const stamp = new Date(NOW).toISOString().slice(0, 10);
const report = {
  generatedAt: new Date(NOW).toISOString(),
  campaignId: CAMPAIGN_ID, brand: BRAND, fromEmail: FROM,
  customers: customers.length,
  engagement: {
    applied: engagementUsable,
    openHashes: openHashes.size, clickHashes: clickHashes.size,
    matchedCustomers: engagedEmails.size,
    digestMeta: digest ? digest.meta : null,
  },
  plan: { counts: plan.counts, byBatch: plan.byBatch, balanced: plan.balanced },
  deliveredDistribution: {
    max: Math.max(0, ...deliveredCounts),
    atLeast5: atOrOver(5), atLeast10: atOrOver(10), atLeast20: atOrOver(20),
    /** 10 通以上 = 打ち切りが当たりうる人。0 なら engagement は parity に影響しない */
    cutoffCandidates,
  },
  rollbackOk: rollback.ok,
  suppressionHandoff: { counts: handoff.counts, entries: handoff.entries },
  parityNow: { ok: nowRun.parity.ok, diff: nowRun.parity.diff, counts: nowRun.parity.counts },
  parityAt: {
    at: new Date(AT).toISOString(),
    ok: atRun.parity.ok, diff: atRun.parity.diff,
    dueCustomers: dueA.size, dueProspects: dueB.size,
    step2Customers: step2A, step2Prospects: step2B,
    onlyCustomers: onlyA.length, onlyProspects: onlyB.length,
  },
  ledger: { keysToSeed: ledgerKeys.size },
  airtableGrowthAt: { customerRoute: growthCustomer.airtableRows, prospectRoute: growthProspect.airtableRows },
  prospectsToWrite: prospects.length,
};
writeFileSync(`${OUT}/report-${stamp}.json`, JSON.stringify(report, null, 1));
// ⚠️ 投入内容はアドレスを含むので**別ファイル**にし、報告には出さない
writeFileSync(`${OUT}/seed-${stamp}.json`, JSON.stringify({
  campaignId: CAMPAIGN_ID, brand: BRAND, version: campaign.version,
  prospects, ledgerKeys: [...ledgerKeys],
}, null, 1));
console.log(`\n保存: ${OUT}/report-${stamp}.json（件数のみ） / seed-${stamp}.json（投入内容）`);
console.log('**Airtable にも Redis にも 1 バイトも書いていない。**');
