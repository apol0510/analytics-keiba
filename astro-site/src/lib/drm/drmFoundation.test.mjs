/**
 * drmFoundation.test.mjs — Direct Response Marketing 基盤の重要仕様
 *
 * ここで固定するのは「送る仕組み」ではなく **反応で次を変える仕組み**の安全性:
 *   - 測っていないものを 0 にしない（`click` は構造的に未計測）
 *   - 推測で分岐しない（`unknown` のまま反応前提の枝へ入れない）
 *   - 購入・停止は行き先を作らない（二重の停止）
 *   - 帰属は確からしさを落として持つ（`unattributed` を丸めない）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveResponseState, hasPurchased, resolveSuppression, RESPONSE, SUPPRESS_REASON,
} from './drmResponseState.js';
import {
  routeNextTouch, normalizeRoutes, summarizeSegments, ROUTE_WHEN, DEFAULT_ROUTE_ID,
} from './drmRouting.js';
import {
  attributePurchase, summarizeAttribution, ATTRIBUTION, DEFAULT_WINDOW_DAYS,
} from './drmAttribution.js';
import { buildDrmFunnel, rate, measured } from './drmMetrics.js';
import { MEASURE } from '../crm/deliveryMeasurement.js';
import { readFileSync } from 'node:fs';

const DAY = 86400_000;
const T0 = Date.UTC(2026, 7, 1);
const touch = (step, over = {}) => ({
  step, deliveryKey: `k${step}`, campaignId: 'c', version: 1,
  sentAtMs: T0 + step * DAY, delivered: null, opened: null, clicked: null, ...over,
});

// ══════════════════════════════════════════════════════════════════
//  1. response state
// ══════════════════════════════════════════════════════════════════

test('【重要】購入は課金契約だけ（無料特典を購入に数えない）', () => {
  assert.equal(hasPurchased({ premiumActive: true }), true);
  assert.equal(hasPurchased({ lightActive: true }), true);
  // 無料特典は購入ではない（`customerMarketingAudience` の注記どおり）
  assert.equal(hasPurchased({ promoPremiumActive: true, promoLightActive: true }), false);
  assert.equal(hasPurchased({}), false);
});

test('【重要】購入が最優先（開封・クリックより強い）', () => {
  const s = resolveResponseState({
    marketing: { premiumActive: true, sendable: true },
    touches: [touch(1, { delivered: true, opened: true, clicked: true })],
    measured: { open: true, click: true },
  });
  assert.equal(s.state, RESPONSE.PURCHASED);
});

test('【重要】停止・退会・バウンスは購入の次に強い（送信対象外）', () => {
  const cases = [
    [{ sendable: false, suppressionReasons: ['unsubscribed'] }, SUPPRESS_REASON.UNSUBSCRIBED],
    [{ sendable: false, suppressionReasons: ['blacklist'] }, SUPPRESS_REASON.HARD_BOUNCE],
    [{ sendable: false, suppressionReasons: [] }, SUPPRESS_REASON.NOT_SENDABLE],
  ];
  for (const [mk, reason] of cases) {
    const s = resolveResponseState({ marketing: mk, touches: [touch(1)] });
    assert.equal(s.state, RESPONSE.SUPPRESSED, JSON.stringify(mk));
    assert.equal(s.suppressReason, reason);
  }
});

test('【重要】provider 停止リスト / soft bounce も送信対象外', () => {
  const mk = { sendable: true, email: 'u@example.com' };
  assert.equal(
    resolveResponseState({ marketing: mk, touches: [], providerSuppressed: new Set(['u@example.com']) }).suppressReason,
    SUPPRESS_REASON.PROVIDER_SUPPRESSED,
  );
  assert.equal(
    resolveResponseState({ marketing: mk, touches: [], softBounced: new Set(['u@example.com']) }).suppressReason,
    SUPPRESS_REASON.SOFT_BOUNCE,
  );
});

test('【重要】click は構造的に未計測 → clicked は null（false にしない）', () => {
  const s = resolveResponseState({
    marketing: { sendable: true },
    touches: [touch(1, { delivered: true, opened: true })],
    measured: { open: true, click: false },
  });
  assert.equal(s.clickedCount, null, 'click を 0 と書いている');
  assert.equal(s.clickMeasured, false);
  assert.equal(s.state, RESPONSE.OPENED);
});

test('【重要】open 未計測なら「未開封」と断定せず unknown', () => {
  const s = resolveResponseState({
    marketing: { sendable: true },
    touches: [touch(1, { delivered: true })],
    measured: { open: false, click: false },
  });
  assert.equal(s.state, RESPONSE.UNKNOWN, '未計測を delivered/未開封と断定している');
  assert.equal(s.openedCount, null, 'open を 0 と書いている');
});

test('open 計測が有効なら到達・未開封を delivered として区別する', () => {
  const s = resolveResponseState({
    marketing: { sendable: true },
    touches: [touch(1, { delivered: true })],
    measured: { open: true, click: false },
  });
  assert.equal(s.state, RESPONSE.DELIVERED);
  assert.equal(s.openedCount, 0, '計測できているのに null にしている');
});

test('未送信は not_sent（0 通を unknown にしない）', () => {
  const s = resolveResponseState({ marketing: { sendable: true }, touches: [], measured: { open: true, click: false } });
  assert.equal(s.state, RESPONSE.NOT_SENT);
  assert.equal(s.sentCount, 0);
});

test('最後に送った touch を持ち回る（次の判断に使う）', () => {
  const s = resolveResponseState({
    marketing: { sendable: true },
    touches: [touch(1, { delivered: true }), touch(3, { delivered: true })],
    measured: { open: true, click: false },
  });
  assert.equal(s.sentCount, 2);
  assert.equal(s.lastTouchStep, 3);
});

// ══════════════════════════════════════════════════════════════════
//  2. response-driven routing
// ══════════════════════════════════════════════════════════════════

const ROUTES = [
  { when: 'clicked', step: 9, variant: 'close-a', angle: 'urgency' },
  { when: 'opened', step: 7, angle: 'social-proof' },
  { when: 'delivered', step: 5, angle: 'benefit' },
];

test('【重要】反応層ごとに違う訴求を選ぶ（線形でない）', () => {
  const at = (state) => routeNextTouch({ routes: ROUTES, state: { state, sentCount: 3 }, maxSends: 24 });
  assert.equal(at(RESPONSE.CLICKED).step, 9);
  assert.equal(at(RESPONSE.CLICKED).variant, 'close-a');
  assert.equal(at(RESPONSE.OPENED).step, 7);
  assert.equal(at(RESPONSE.DELIVERED).step, 5);
});

test('【重要】未計測（unknown）で反応前提の枝へ入れない', () => {
  const r = routeNextTouch({ routes: ROUTES, state: { state: RESPONSE.UNKNOWN, sentCount: 3 }, maxSends: 24 });
  assert.equal(r.matched, false);
  assert.equal(r.reason, 'response_unknown');
  assert.equal(r.step, 4, '既定の線形へ落ちていない');
  assert.equal(r.routeId, DEFAULT_ROUTE_ID);
});

test('unknown 用の route を宣言していれば、それだけは使う', () => {
  const r = routeNextTouch({
    routes: [...ROUTES, { when: 'unknown', step: 2, angle: 'restart' }],
    state: { state: RESPONSE.UNKNOWN, sentCount: 1 }, maxSends: 24,
  });
  assert.equal(r.matched, true);
  assert.equal(r.step, 2);
  assert.equal(r.angle, 'restart');
});

test('【重要】購入・送信対象外には行き先を作らない（宣言があっても無視）', () => {
  for (const state of [RESPONSE.PURCHASED, RESPONSE.SUPPRESSED]) {
    const r = routeNextTouch({
      routes: [{ when: state, step: 9 }], state: { state, sentCount: 3 }, maxSends: 24,
    });
    assert.equal(r.step, null, `${state} に送り先を作っている`);
    assert.equal(r.reason, 'terminal_state');
  }
});

test('【重要】上限を超える step は提案しない', () => {
  const r = routeNextTouch({
    routes: [{ when: 'opened', step: 30 }], state: { state: RESPONSE.OPENED, sentCount: 3 }, maxSends: 24,
  });
  assert.equal(r.step, null);
  assert.equal(r.reason, 'max_sends_reached');
});

test('【重要】知らない条件の route は採用しない（勝手な条件を増やさない）', () => {
  const routes = normalizeRoutes([
    { when: 'opened', step: 7 },
    { when: 'weather_is_nice', step: 2 },
    { when: '', step: 3 },
  ]);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].when, 'opened');
});

test('宣言順が強さ（先に書いたものが勝つ）', () => {
  const r = routeNextTouch({
    routes: [{ when: 'opened', step: 7 }, { when: 'opened', step: 8 }],
    state: { state: RESPONSE.OPENED, sentCount: 1 }, maxSends: 24,
  });
  assert.equal(r.step, 7);
});

test('minSent / maxSent で段階を絞れる', () => {
  const routes = [
    { when: 'opened', step: 12, minSent: 5 },
    { when: 'opened', step: 7 },
  ];
  assert.equal(routeNextTouch({ routes, state: { state: RESPONSE.OPENED, sentCount: 2 }, maxSends: 24 }).step, 7);
  assert.equal(routeNextTouch({ routes, state: { state: RESPONSE.OPENED, sentCount: 6 }, maxSends: 24 }).step, 12);
});

test('【重要】反応層ごとの人数を数える（unknown を他へ混ぜない）', () => {
  const states = [
    { state: RESPONSE.OPENED }, { state: RESPONSE.OPENED }, { state: RESPONSE.UNKNOWN },
    { state: RESPONSE.PURCHASED }, { state: RESPONSE.SUPPRESSED },
  ];
  const seg = summarizeSegments(states);
  assert.equal(seg.total, 5);
  assert.equal(seg.counts.opened, 2);
  assert.equal(seg.counts.unknown, 1, 'unknown を他の層へ混ぜている');
  assert.equal(seg.counts.purchased, 1);
  // すべての層が枠として存在する（画面が層を落とさない）
  for (const w of ROUTE_WHEN) assert.ok(w in seg.counts);
});

// ══════════════════════════════════════════════════════════════════
//  3. conversion attribution
// ══════════════════════════════════════════════════════════════════

test('【重要】クリックが確認できるときだけ direct（click 計測が前提）', () => {
  const touches = [touch(2, { clicked: true, sentAtMs: T0 })];
  const withClick = attributePurchase({ purchasedAtMs: T0 + DAY, touches, clickMeasured: true });
  assert.equal(withClick.attribution, ATTRIBUTION.DIRECT);
  assert.equal(withClick.step, 2);
  // click 未計測なら direct にしない（相関へ落ちる）
  const noClick = attributePurchase({ purchasedAtMs: T0 + DAY, touches, clickMeasured: false });
  assert.equal(noClick.attribution, ATTRIBUTION.CORRELATED);
});

test('【重要】窓の中の直近 1 通へ相関で結ぶ（campaign/version/step/DeliveryKey まで）', () => {
  const r = attributePurchase({
    purchasedAtMs: T0 + 5 * DAY,
    touches: [touch(1, { sentAtMs: T0 }), touch(2, { sentAtMs: T0 + 3 * DAY, openedAtMs: T0 + 3 * DAY })],
  });
  assert.equal(r.attribution, ATTRIBUTION.CORRELATED);
  assert.equal(r.campaignId, 'c');
  assert.equal(r.version, 1);
  assert.equal(r.step, 2);
  assert.equal(r.deliveryKey, 'k2');
});

test('【重要】窓の外・時刻不明・touch 無しは unattributed（推測しない）', () => {
  const t = [touch(1, { sentAtMs: T0, openedAtMs: T0 })];
  assert.equal(attributePurchase({ purchasedAtMs: T0 + 90 * DAY, touches: t }).reason, 'outside_window');
  assert.equal(attributePurchase({ purchasedAtMs: null, touches: t }).reason, 'no_purchase_time');
  assert.equal(attributePurchase({ purchasedAtMs: T0, touches: [] }).reason, 'no_touch');
  for (const bad of [{ purchasedAtMs: T0, touches: [] }, {}]) {
    assert.equal(attributePurchase(bad).attribution, ATTRIBUTION.UNATTRIBUTED);
  }
});

test('【重要】購入より後に送った通へは結ばない', () => {
  const r = attributePurchase({
    purchasedAtMs: T0 + DAY,
    touches: [touch(5, { sentAtMs: T0 + 10 * DAY, openedAtMs: T0 + 10 * DAY })],
  });
  assert.equal(r.attribution, ATTRIBUTION.UNATTRIBUTED);
});

test('【重要】unattributed を集計から落とさない', () => {
  const rows = [
    { attribution: ATTRIBUTION.DIRECT, step: 2 },
    { attribution: ATTRIBUTION.CORRELATED, step: 3 },
    { attribution: ATTRIBUTION.UNATTRIBUTED, step: null },
    { attribution: ATTRIBUTION.UNATTRIBUTED, step: null },
  ];
  const s = summarizeAttribution(rows);
  assert.equal(s.total, 4);
  assert.equal(s.unattributed, 2, 'unattributed を丸めている');
  assert.deepEqual(s.byTouch, { 2: 1, 3: 1 });
  assert.equal(s.clickMeasured, false, 'click 未計測の事実を持ち回っていない');
});

test('既定の帰属窓は 30 日（既存 campaignOutcome の d30 に合わせる）', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 30);
});

// ══════════════════════════════════════════════════════════════════
//  4. DRM metrics
// ══════════════════════════════════════════════════════════════════

test('【重要】未計測は 0 でなく null（open / click）', () => {
  const f = buildDrmFunnel({
    sent: 100, delivered: 95, opened: 10, clicked: 3, purchased: 2,
    openState: MEASURE.DISABLED, clickState: MEASURE.UNKNOWN, deliveredState: MEASURE.ENABLED,
  });
  assert.equal(f.opened, null, 'open 未計測を 0 にしている');
  assert.equal(f.clicked, null, 'click 未計測を 0 にしている');
  assert.equal(f.openRate, null);
  assert.equal(f.clickRate, null);
  assert.equal(f.measurement.openCountable, false);
  assert.equal(f.measurement.clickCountable, false);
  // 送信・購入は常に数えられる
  assert.equal(f.sent, 100);
  assert.equal(f.purchased, 2);
});

test('【重要】CVR の母数は送信済み（受理数と混同しない）', () => {
  const f = buildDrmFunnel({ sent: 200, delivered: 180, purchased: 10, deliveredState: MEASURE.ENABLED });
  assert.equal(f.cvr, 10 / 200);
  assert.equal(f.cvrOnDelivered, 10 / 180, '到達基準の CVR を分けていない');
});

test('【重要】母数 0 なら率を作らない', () => {
  const f = buildDrmFunnel({ sent: 0, purchased: 0 });
  assert.equal(f.cvr, null);
  assert.equal(f.openRate, null);
  assert.equal(rate(1, 0), null);
  assert.equal(rate(null, 10), null);
});

test('【重要】touch 別 conversion を出す', () => {
  const f = buildDrmFunnel({
    sent: 300, purchased: 9, deliveredState: MEASURE.ENABLED, delivered: 290,
    openState: MEASURE.ENABLED, opened: 60, clickState: MEASURE.DISABLED, clicked: 0,
    byTouch: {
      1: { sent: 100, delivered: 98, opened: 30, clicked: 0, purchased: 2 },
      2: { sent: 100, delivered: 96, opened: 20, clicked: 0, purchased: 4 },
      3: { sent: 100, delivered: 96, opened: 10, clicked: 0, purchased: 3 },
    },
    unattributed: 5,
  });
  assert.equal(f.byTouch.length, 3);
  assert.deepEqual(f.byTouch.map((t) => t.step), [1, 2, 3], 'step 順に並んでいない');
  assert.equal(f.byTouch[1].conversionRate, 4 / 100);
  assert.equal(f.byTouch[0].clicked, null, 'touch 別でも click 未計測を 0 にしている');
  assert.equal(f.unattributed, 5);
});

test('measured() は計測が有効なときだけ数える', () => {
  assert.equal(measured(MEASURE.ENABLED, 7), 7);
  assert.equal(measured(MEASURE.DISABLED, 7), null);
  assert.equal(measured(MEASURE.UNKNOWN, 7), null);
  assert.equal(measured(MEASURE.ENABLED, null), 0);
});

// ══════════════════════════════════════════════════════════════════
//  6. safety（既存契約を壊さない）
// ══════════════════════════════════════════════════════════════════

/** コメントを除いた実コードだけを見る（既存 guard テストと同じ作法） */
function codeOf(file) {
  const fs = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  return fs.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
}

test('【重要】routing は送信可否・頻度を判定しない（責務を二重化しない）', () => {
  const code = codeOf('drmRouting.js');
  for (const f of ['frequencyCap', 'minIntervalDays', 'resolveStop', 'sendable']) {
    assert.equal(code.includes(f), false, `routing が ${f} を判定している`);
  }
});

test('【重要】DRM 基盤は送信経路も書き込みも呼ばない（read-only の判定だけ）', () => {
  for (const file of ['drmResponseState.js', 'drmRouting.js', 'drmAttribution.js', 'drmMetrics.js']) {
    const code = codeOf(file);
    for (const forbidden of ['sendgrid', 'fetch(', 'upsert', 'createRecord', 'patchRecord']) {
      assert.equal(code.includes(forbidden), false, `${file} が ${forbidden} を含む`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════
//  実 sequence への配線（E2E）
//  `responseRoutes` を宣言した campaign だけで効き、
//  未宣言なら既存の線形挙動を **1 ミリも変えない**。
// ══════════════════════════════════════════════════════════════════

import { getCampaign } from '../marketing/campaignCatalog.js';
import { buildSequenceProgress } from '../marketing/sequenceProgress.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';
import { resolveRoutedStep } from './drmRouting.js';

const SEQ_BRAND = 'analytics-keiba';
const SEQ_FROM = 'sender@example.com';
const SEQ_NOW = Date.UTC(2026, 7, 19);
const SEQ_BASE = getCampaign('light-trial-to-premium-sequence', { includeDisabled: true });

function seqCustomer(over = {}) {
  const fields = {
    Email: 'u1@example.com',
    LightGrantedAt: new Date(SEQ_NOW - DAY).toISOString(),
    LightGrantUntil: new Date(SEQ_NOW + 29 * DAY).toISOString(),
    ComebackGrantSource: 'light-trial-autogrant',
    Source: 'customer-import:test',
    ...over,
  };
  return { recordId: 'rec1', fields, marketing: resolveCustomerMarketing({ fields, nowMs: SEQ_NOW }) };
}

/** step1 を送信済みにする配信行 */
function sentStep1() {
  const k = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(SEQ_BASE, 1), recipientEmail: 'u1@example.com',
    brand: SEQ_BRAND, fromEmail: SEQ_FROM,
  });
  return [{
    fields: {
      DeliveryKey: k, CampaignType: `${SEQ_BASE.campaignId}:v${SEQ_BASE.version}`,
      Status: 'sent', SentAt: new Date(SEQ_NOW - 3600_000).toISOString(), EmailType: 'campaign',
    },
  }];
}

const withRoutes = (responseRoutes) => ({
  ...SEQ_BASE, sequence: { ...SEQ_BASE.sequence, responseRoutes },
});

function runSeq(campaign, responseByEmail, customer = seqCustomer()) {
  return buildSequenceProgress({
    campaign, selected: [customer], deliveries: sentStep1(),
    brand: SEQ_BRAND, fromEmail: SEQ_FROM, nowMs: SEQ_NOW,
    providerSuppressed: new Set(), softBounced: new Set(), responseByEmail,
  }).rows[0];
}

test('【重要】responseRoutes 未宣言なら既存の線形挙動を完全維持', () => {
  const plain = runSeq(SEQ_BASE, undefined);
  assert.equal(plain.nextStep, 2, '線形（送信済み 1 → 次 2）が変わっている');
  assert.equal(plain.routedBy, null);
  // 反応を渡しても、宣言が無ければ何も変わらない
  const withResp = runSeq(SEQ_BASE, new Map([['u1@example.com', { state: RESPONSE.OPENED, sentCount: 1 }]]));
  assert.equal(withResp.nextStep, 2, '宣言が無いのに反応で行き先が変わっている');
  assert.equal(withResp.routedBy, null);
});

test('【重要】opened の route があれば実際の次 touch が変わる', () => {
  const camp = withRoutes([{ when: 'opened', step: 5, angle: 'social-proof', variant: 'proof-a' }]);
  const r = runSeq(camp, new Map([['u1@example.com', { state: RESPONSE.OPENED, sentCount: 1 }]]));
  assert.equal(r.nextStep, 5, '反応で行き先が変わっていない');
  assert.equal(r.routedBy, 'opened:5');
  assert.equal(r.angle, 'social-proof');
  assert.equal(r.variant, 'proof-a');
});

test('【重要】unknown は反応前提の route へ入らず線形へ戻る', () => {
  const camp = withRoutes([{ when: 'opened', step: 5 }]);
  const r = runSeq(camp, new Map([['u1@example.com', { state: RESPONSE.UNKNOWN, sentCount: 1 }]]));
  assert.equal(r.nextStep, 2, 'unknown で反応前提の枝へ入っている');
  assert.equal(r.routedBy, null);
});

test('【重要】反応が渡されていなくても線形へ戻る（推測しない）', () => {
  const camp = withRoutes([{ when: 'opened', step: 5 }]);
  assert.equal(runSeq(camp, undefined).nextStep, 2);
  assert.equal(runSeq(camp, new Map()).nextStep, 2);
});

test('【重要】購入者には次 touch を作らない（停止が最優先）', () => {
  const camp = withRoutes([{ when: 'purchased', step: 6 }, { when: 'opened', step: 5 }]);
  const cust = seqCustomer({ 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', 有効期限: new Date(SEQ_NOW + 200 * DAY).toISOString() });
  const r = runSeq(camp, new Map([['u1@example.com', { state: RESPONSE.PURCHASED, sentCount: 1 }]]), cust);
  assert.equal(r.nextStep, null, '購入者に次の送り先を作っている');
  assert.equal(r.stopReason, 'purchased');
});

test('【重要】送信対象外には次 touch を作らない', () => {
  const camp = withRoutes([{ when: 'suppressed', step: 6 }, { when: 'opened', step: 5 }]);
  const cust = seqCustomer({ MarketingUnsubscribedAnalyticsKeiba: true, UnsubscribedAnalyticsKeiba: true });
  const r = runSeq(camp, new Map([['u1@example.com', { state: RESPONSE.SUPPRESSED, sentCount: 1 }]]), cust);
  assert.equal(r.nextStep, null, '送信対象外に送り先を作っている');
  assert.ok(r.stopReason, '停止理由が無い');
});

test('【重要】route が既送 step を指しても二重送信しない（線形へ戻る）', () => {
  const camp = withRoutes([{ when: 'opened', step: 1 }]);   // step1 は既に送信済み
  const r = runSeq(camp, new Map([['u1@example.com', { state: RESPONSE.OPENED, sentCount: 1 }]]));
  assert.equal(r.nextStep, 2, '既に送った step へ戻している');
  assert.equal(r.routedBy, null);
});

test('【重要】resolveRoutedStep は既送 step / 上限超過 / 反応なしで null（線形へ）', () => {
  const routes = [{ when: 'opened', step: 5 }];
  const resp = { state: RESPONSE.OPENED, sentCount: 1 };
  assert.equal(resolveRoutedStep({ routes, response: resp, sentSteps: [5], linearStep: 2, maxSends: 6 }), null);
  assert.equal(resolveRoutedStep({ routes, response: resp, sentSteps: [1], linearStep: 2, maxSends: 4 }), null);
  assert.equal(resolveRoutedStep({ routes, response: null, sentSteps: [1], linearStep: 2, maxSends: 6 }), null);
  assert.equal(resolveRoutedStep({ routes: [], response: resp, sentSteps: [1], linearStep: 2, maxSends: 6 }), null);
  const ok = resolveRoutedStep({ routes, response: resp, sentSteps: [1], linearStep: 2, maxSends: 6 });
  assert.equal(ok.step, 5);
});

test('【重要】DRM routing は停止条件も頻度 guard も上書きしない（責務の分離）', () => {
  const code = codeOf('drmRouting.js');
  for (const f of ['frequencyCap', 'minIntervalDays', 'sendable', 'providerSuppressed']) {
    assert.equal(code.includes(f), false, `routing が ${f} を判定している`);
  }
  // 実配線側でも、停止判定より後にだけ効いていること
  const seq = readFileSync(new URL('../marketing/sequenceProgress.js', import.meta.url), 'utf8');
  assert.ok(seq.indexOf('if (hasPurchased(mk)) return stop') < seq.indexOf('resolveRoutedStep('),
    '停止判定より前に routing を通している');
});

// ══════════════════════════════════════════════════════════════════
//  sent と delivered を混同しない（API 側の契約）
// ══════════════════════════════════════════════════════════════════

test('【重要】DRM の面が sent を delivered として代用していない', () => {
  const src = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function handleDrm({'), src.indexOf('async function handleRollout({'));
  assert.equal(/delivered: Number\(t\.sent\)/.test(fn), false, 'sent を delivered に写している');
  assert.equal(/delivered: Number\(row\.sent\)/.test(fn), false, 'touch 別で sent を delivered に写している');
  assert.ok(/delivered: null/.test(fn), 'delivered を未計測として返していない');
  assert.ok(/delivered: MEASURE\.UNKNOWN/.test(fn), 'delivered の計測状態を unknown にしていない');
});

test('【重要】未計測の delivered を sent で補完しない（funnel 側）', () => {
  const f = buildDrmFunnel({
    sent: 500, delivered: null, purchased: 5,
    deliveredState: MEASURE.UNKNOWN, openState: MEASURE.UNKNOWN, clickState: MEASURE.DISABLED,
  });
  assert.equal(f.sent, 500);
  assert.equal(f.delivered, null, 'delivered を sent で埋めている');
  assert.equal(f.cvrOnDelivered, null, '到達基準 CVR を作ってしまっている');
  assert.equal(f.cvr, 5 / 500, '送信基準の CVR は出せる');
});

test('【重要】排他的に数えられないときは segment を null にする（累積指標を層と呼ばない）', () => {
  const src = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function handleDrm({'), src.indexOf('async function handleRollout({'));
  assert.ok(/segmentCounts: null/.test(fn), '排他的でない人数を返している');
  assert.ok(/per_customer_unavailable/.test(fn), '理由を返していない');
  assert.ok(/count: null/.test(fn), 'segment ごとに人数を出してしまっている');
});

test('【重要】顧客単位で数えるときは 1 人 1 state（排他）', () => {
  const states = [
    { state: RESPONSE.OPENED }, { state: RESPONSE.OPENED },
    { state: RESPONSE.PURCHASED }, { state: RESPONSE.UNKNOWN },
  ];
  const seg = summarizeSegments(states);
  const sum = Object.values(seg.counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, seg.total, '合計が人数と一致しない（重複して数えている）');
  assert.equal(seg.total, 4);
});

test('【重要】click 未計測を direct 0 件として見せない', () => {
  const s = summarizeAttribution([
    { attribution: ATTRIBUTION.UNATTRIBUTED, step: null },
  ], { clickMeasured: false });
  assert.equal(s.byAttribution.direct, 0);
  assert.equal(s.clickMeasured, false, 'click を測っていない事実を持ち回っていない');
  // 画面は clickMeasured=false を見て「0 件」ではなく「測っていない」と出す
});

test('【重要】DRM の面が決済メール v2 のフィールドへ触れない（既存 guard を守る）', () => {
  const src = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  for (const banned of ['PaymentEmailSent', 'PaymentEmailStatus', 'PaymentConfirmed', 'PaidAt']) {
    assert.equal(src.includes(banned), false, `${banned} に触れている`);
  }
});

test('【重要】購入時刻が読めないときは推測せず unattributed（理由つき）', () => {
  const r = attributePurchase({
    purchasedAtMs: null,
    touches: [{ step: 2, deliveryKey: 'k2', campaignId: 'c', version: 1, sentAtMs: T0, openedAtMs: T0 }],
    clickMeasured: false,
  });
  assert.equal(r.attribution, ATTRIBUTION.UNATTRIBUTED);
  assert.equal(r.reason, 'no_purchase_time');
  assert.equal(r.step, null, '推測で step を埋めている');
});

test('【重要】帰属できない理由を返す（0 件＝効果なし、と読ませない）', () => {
  const src = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function handleDrmCohort({'), src.indexOf('async function handleDrm({'));
  assert.ok(/attributionLimits/.test(fn), '帰属の限界を返していない');
  assert.ok(/clickMeasured: false/.test(fn), 'click 未計測を明示していない');
  assert.ok(/purchaseTimeAvailable: false/.test(fn), '購入時刻を読めない事実を明示していない');
});

test('【重要】drmCohort は名指しのみ・全件走査しない・書き込まない', () => {
  const src = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function handleDrmCohort({'), src.indexOf('async function handleDrm({'));
  assert.ok(/recordIds/.test(fn), '宛先を名指ししていない');
  assert.ok(/DUPLICATE_CHECK_MAX/.test(fn), '件数上限が無い');
  assert.ok(/buildDeliveryKeyFormula/.test(fn), '名指し formula を使っていない');
  for (const banned of ['createRecord', 'upsertDeliveries', 'patchRecord', "method: 'PATCH'", 'sendgrid']) {
    assert.equal(fn.includes(banned), false, `書き込み/送信（${banned}）をしている`);
  }
});
