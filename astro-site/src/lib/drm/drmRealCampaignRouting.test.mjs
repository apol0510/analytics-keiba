/**
 * drmRealCampaignRouting.test.mjs — **実 campaign の実 sequence** で反応別 routing が動く
 *   node --test src/lib/drm/drmRealCampaignRouting.test.mjs
 *
 * ── なぜこのテストが要るか ────────────────────────────────────
 * DRM の純粋関数・管理画面・テスト専用の `withRoutes` オーバーレイだけが揃っていても、
 * **実 campaign に `responseRoutes` が 1 つも無ければ実配信は線形のまま**で、
 * 「反応を見て次の訴求を変える」という事業目的は 1 ミリも達成されない。
 * ここは `campaignCatalog` の**本物の定義**と、`drmResponseInputs` の**本物の組み立て**と、
 * `sequenceProgress` の**本物の進行**を通しで固定する。
 *
 * ⚠️ オーバーレイ（`{...campaign, sequence:{...}}`）を作らない。
 *    このファイルで campaign を合成したら、このテストの意味が無くなる。
 * ⚠️ 合成データのみ（`example.com`）。実顧客・実 Redis は使わない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign, CAMPAIGNS } from '../marketing/campaignCatalog.js';
import { buildSequenceProgress, indexDeliveries } from '../marketing/sequenceProgress.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep, getSequenceSteps } from '../marketing/campaignSequence.js';
import { validateResponseRoutes, ROUTE_WHEN } from './drmRouting.js';
import {
  campaignDeclaresRoutes, planResponseKeyReads, buildResponseByEmail,
} from './drmResponseInputs.js';
import { loadResponseByEmail, LOADER_FAIL } from './drmResponseLoader.js';

const BRAND = 'analytics-keiba';
const FROM = 'sender@example.com';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 8, 14);
const EMAIL = 'routed@example.com';

/** 反応別 routing を実際に宣言している **本物の** campaign */
const ROUTED_ID = 'light-trial-post-expiry-sequence';
const CAMPAIGN = getCampaign(ROUTED_ID, { includeDisabled: true });

// ══════════════════════════════════════════════════════════════════
//  ① 実カタログに宣言があること（「テスト用オーバーレイだけ」に戻らせない）
// ══════════════════════════════════════════════════════════════════

test('【重要】実 campaign が responseRoutes を宣言している（DRM が宣言だけで終わっていない）', () => {
  const declared = CAMPAIGNS.filter(campaignDeclaresRoutes).map((c) => c.campaignId);
  assert.ok(declared.length > 0,
    '実カタログの responseRoutes が 0 件。実配信は線形のままで DRM の目的は未達');
  assert.ok(declared.includes(ROUTED_ID), `${ROUTED_ID} の responseRoutes が消えている`);
});

test('【重要】宣言は検証を通る（書き間違いが静かに無効化されない）', () => {
  for (const c of CAMPAIGNS) {
    const steps = getSequenceSteps(c);
    const r = validateResponseRoutes(c, {
      maxSends: c.sequence && c.sequence.maxSends,
      stepNumbers: steps.map((s) => s.stepNumber),
    });
    assert.equal(r.ok, true, `${c.campaignId}: ${r.errors.join(' / ')}`);
  }
});

test('【安全】成立しない条件・終端層を宣言していない', () => {
  for (const c of CAMPAIGNS.filter(campaignDeclaresRoutes)) {
    for (const r of c.sequence.responseRoutes) {
      assert.ok(ROUTE_WHEN.includes(r.when), `${c.campaignId}: 未知の when`);
      assert.ok(!['purchased', 'suppressed'].includes(r.when),
        `${c.campaignId}: 停止層へ行き先を宣言している`);
      assert.ok(r.when !== 'clicked', `${c.campaignId}: click は未計測なので成立しない`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② 実 sequence の通し（配信の事実 → 反応 → 次の訴求）
// ══════════════════════════════════════════════════════════════════

/** 体験が終わっている・取り込みコホートの会員（このシーケンスの対象） */
function customer(over = {}) {
  const fields = {
    Email: EMAIL,
    LightGrantedAt: new Date(NOW - 60 * DAY).toISOString(),
    LightGrantUntil: new Date(NOW - 30 * DAY).toISOString(),
    ComebackGrantSource: 'light-trial-autogrant',
    Source: 'customer-import:test',
    ...over,
  };
  return { recordId: 'rec1', fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}

const keyFor = (step, email = EMAIL) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(CAMPAIGN, step), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** step 1..n を送信済みにする配信行 */
function sent(upTo, email = EMAIL) {
  const rows = [];
  for (let i = 1; i <= upTo; i += 1) {
    rows.push({
      fields: {
        DeliveryKey: keyFor(i, email),
        CampaignType: `${CAMPAIGN.campaignId}:v${CAMPAIGN.version}`,
        Status: 'sent',
        SentAt: new Date(NOW - (upTo - i + 1) * 7 * DAY).toISOString(),
        EmailType: 'campaign',
      },
    });
  }
  return rows;
}

/** delivered / opened を記録した索引（`deliveryEventIndex.read()` の戻りと同じ形） */
function events(upTo, { opened = false, email = EMAIL } = {}) {
  const m = new Map();
  for (let i = 1; i <= upTo; i += 1) {
    m.set(keyFor(i, email), {
      deliveredAtMs: NOW - (upTo - i + 1) * 7 * DAY + 60_000,
      firstOpenAtMs: opened ? NOW - (upTo - i + 1) * 7 * DAY + 120_000 : null,
      lastOpenAtMs: null,
      openCount: opened ? 1 : 0,
    });
  }
  return m;
}

/** 実経路と同じ組み立て（`drmResponseInputs` → `sequenceProgress`） */
function run({ upTo, eventByKey, cust = customer() }) {
  const deliveries = sent(upTo);
  const deliveredIndex = indexDeliveries(deliveries);
  const built = eventByKey === null ? { ok: false, byEmail: null } : buildResponseByEmail({
    campaign: CAMPAIGN, recipients: [{ email: EMAIL, marketing: cust.marketing }],
    deliveredIndex, eventByKey, brand: BRAND, fromEmail: FROM,
    providerSuppressed: new Set(), softBounced: new Set(),
  });
  const progress = buildSequenceProgress({
    campaign: CAMPAIGN, selected: [cust], deliveries,
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
    responseByEmail: built.ok ? built.byEmail : undefined,
  });
  return { row: progress.rows[0], response: built };
}

test('【重要】開封している人は線形の次ではなく宣言された step へ進む', () => {
  // 3 通送信・全部開封 → 線形なら step4。宣言は opened(minSent 3) → step9
  const { row, response } = run({ upTo: 3, eventByKey: events(3, { opened: true }) });
  assert.equal(response.ok, true, '反応を組み立てられていない');
  assert.equal(response.byEmail.get(EMAIL).state, 'opened');
  assert.equal(row.nextStep, 9, '開封層の行き先が線形のまま（DRM が効いていない）');
  assert.equal(row.routedBy, 'opened:9');
});

test('【重要】到達しているが未開封の人は別の step へ進む（層で訴求が変わる）', () => {
  // 5 通送信・1 通も開封なし → 線形なら step6。宣言は delivered(minSent 5) → step16
  const { row, response } = run({ upTo: 5, eventByKey: events(5, { opened: false }) });
  assert.equal(response.byEmail.get(EMAIL).state, 'delivered');
  assert.equal(row.nextStep, 16, '未開封層が開封層と同じ扱いになっている');
  assert.equal(row.routedBy, 'delivered:16');
});

test('【重要】同じ配信実績でも反応が違えば行き先が違う（線形ではない）', () => {
  const openedRow = run({ upTo: 5, eventByKey: events(5, { opened: true }) }).row;
  const deliveredRow = run({ upTo: 5, eventByKey: events(5, { opened: false }) }).row;
  assert.notEqual(openedRow.nextStep, deliveredRow.nextStep,
    '反応が違うのに同じ 1 通が行く＝ DRM になっていない');
  assert.equal(openedRow.nextStep, 9);
  assert.equal(deliveredRow.nextStep, 16);
});

test('【重要】窓の外（minSent 未満）はまだ分岐しない', () => {
  // 2 通目までは全員同じ導入（opened の minSent は 3）
  const { row } = run({ upTo: 2, eventByKey: events(2, { opened: true }) });
  assert.equal(row.nextStep, 3, '早すぎる分岐が起きている');
  assert.equal(row.routedBy, null);
});

test('【安全】索引が読めなければ線形（開封 0 件として分岐しない）', () => {
  const { row, response } = run({ upTo: 3, eventByKey: null });
  assert.equal(response.ok, false);
  assert.equal(row.nextStep, 4, '未計測なのに反応前提の枝へ入っている');
  assert.equal(row.routedBy, null);
});

test('【安全】索引は読めたがその鍵の記録が無ければ unknown → 線形', () => {
  const { row, response } = run({ upTo: 3, eventByKey: new Map() });
  assert.equal(response.byEmail.get(EMAIL).state, 'unknown');
  assert.equal(row.nextStep, 4);
  assert.equal(row.routedBy, null);
});

test('【安全】routing は既に送った step を選ばない（二重送信・逆戻りなし）', () => {
  // step9 まで送信済み・開封あり → route の step9 は既送なので線形 10 へ
  const { row } = run({ upTo: 9, eventByKey: events(9, { opened: true }) });
  assert.equal(row.nextStep, 10);
  assert.ok(!row.sentSteps.includes(row.nextStep));
});

test('【安全】購入した人には行き先を作らない（停止が最優先）', () => {
  const cust = customer({
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
    有効期限: new Date(NOW + 200 * DAY).toISOString(),
  });
  const { row } = run({ upTo: 3, eventByKey: events(3, { opened: true }), cust });
  assert.equal(row.nextStep, null);
  assert.equal(row.stopReason, 'purchased');
});

test('【安全】配信停止の人には行き先を作らない', () => {
  const cust = customer({
    MarketingUnsubscribedAnalyticsKeiba: true, UnsubscribedAnalyticsKeiba: true,
  });
  const { row } = run({ upTo: 3, eventByKey: events(3, { opened: true }), cust });
  assert.equal(row.nextStep, null);
  assert.equal(row.stopReason, 'not_sendable');
});

// ══════════════════════════════════════════════════════════════════
//  ③ 読み取りは bounded（実経路が索引を無制限に読まない）
// ══════════════════════════════════════════════════════════════════

test('【安全】予算を超える相手は読まずに線形へ落とす（半端な読みで誤判定しない）', () => {
  const emails = ['a@example.com', 'b@example.com', 'c@example.com'];
  const deliveries = emails.flatMap((e) => sent(3, e));
  const deliveredIndex = indexDeliveries(deliveries);
  // 1 人ぶん 3 鍵。予算 4 なら 1 人しか入らない（**半分だけ読まない**）
  const plan = planResponseKeyReads({
    campaign: CAMPAIGN, emails, deliveredIndex, brand: BRAND, fromEmail: FROM, budget: 4,
  });
  assert.equal(plan.keys.length, 3);
  assert.equal(plan.covered.length, 1);
  assert.equal(plan.skipped.length, 2);
});

test('【安全】宣言の無い campaign では索引を 1 鍵も読まない', async () => {
  const plain = getCampaign('light-trial-to-premium-sequence', { includeDisabled: true });
  assert.equal(campaignDeclaresRoutes(plain), false);
  let called = 0;
  const r = await loadResponseByEmail({
    campaign: plain, recipients: [{ email: EMAIL, marketing: customer().marketing }],
    deliveries: [], brand: BRAND, fromEmail: FROM,
    makeIndex: () => { called += 1; return { read: async () => ({ ok: true, byKey: new Map() }) }; },
  });
  assert.equal(called, 0, '宣言が無いのに索引を読んでいる');
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOADER_FAIL.NO_ROUTES);
});

test('【安全】索引が例外を投げても落ちず、理由を返して線形へ', async () => {
  const r = await loadResponseByEmail({
    campaign: CAMPAIGN, recipients: [{ email: EMAIL, marketing: customer().marketing }],
    deliveries: sent(3), brand: BRAND, fromEmail: FROM,
    makeIndex: () => ({ read: async () => { throw new Error('redis down'); } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOADER_FAIL.INDEX_UNREADABLE);
  assert.equal(r.byEmail, null);
});

test('【重要】loader は実経路と同じ Map を返す（画面と cron がズレない）', async () => {
  const r = await loadResponseByEmail({
    campaign: CAMPAIGN, recipients: [{ email: EMAIL, marketing: customer().marketing }],
    deliveries: sent(3), brand: BRAND, fromEmail: FROM,
    providerSuppressed: new Set(), softBounced: new Set(),
    makeIndex: () => ({ read: async (keys) => ({ ok: true, byKey: events(3) && keys.reduce((m, k) => {
      const src = events(3, { opened: true });
      if (src.has(k)) m.set(k, src.get(k));
      return m;
    }, new Map()) }) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.measured.open, true);
  assert.equal(r.measured.click, false, 'click を計測済みにしている');
  assert.equal(r.byEmail.get(EMAIL).state, 'opened');
});
