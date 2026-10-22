/**
 * drmStep2Automation.test.mjs — DRM の **step2 以降が共有シーケンスの通常経路で進む**
 *   node --test src/lib/drm/drmStep2Automation.test.mjs
 *
 * ── 何を固定するか ────────────────────────────────────────────
 * 期限到来 → 反応の判定 → route 選択 → 次 step 選択 までを、
 * **実 campaign 定義（catalog）と実モジュール**で通す。偽の campaign は使わない。
 *
 * ⚠️ step1 の安全 gate は弱めない。`allowFirstStep: false`（= 入口ゲートが閉じている状態）
 *    のままでも step2 以降は進み、step1 だけが残っているときは従来どおり止まる。
 * ⚠️ `unknown`（計測が無い）を未開封扱いしない。**線形のまま**進む。
 * ⚠️ `sent` / `delivered` / `opened` を混同しない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign } from '../marketing/campaignCatalog.js';
import {
  resolveSequenceStep, resolveMaxSends, resolveAudienceSource, getSequenceSteps,
} from '../marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { buildSequenceProgress } from '../marketing/sequenceProgress.js';
import { planSequenceTick, TICK_ABORT } from '../marketing/sequenceAutomation.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { resolveResponseState, RESPONSE } from './drmResponseState.js';

const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 16, 3, 0);
const OPEN_GATES = { allOpen: true, missing: [] };

const DRM = ['free-signup-onboarding', 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence'];

const campaignOf = (id) => {
  const c = getCampaign(id, { includeDisabled: true });
  assert.ok(c, `${id} が catalog にありません`);
  return c;
};

/** その campaign の宛先条件を満たす会員（実 SSOT で marketing を作る） */
function member(campaign, email, over = {}) {
  const plans = (campaign.audienceRule || {}).plans || [];
  const base = { Email: email, Status: 'active' };
  if (plans.includes('light')) { base['プラン'] = 'Light'; base.有効期限 = new Date(NOW + 90 * DAY).toISOString(); }
  if (plans.includes('premium')) { base['プラン'] = 'Premium'; base.有効期限 = new Date(NOW + 90 * DAY).toISOString(); }
  // ⚠️ 上書きは**最後**に当てる（テストが変えたい値を既定で潰さない）
  Object.assign(base, over);
  return {
    recordId: `rec-${email}`,
    fields: base,
    marketing: resolveCustomerMarketing({ fields: base, nowMs: NOW }),
  };
}

const keyFor = (campaign, step, email) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(campaign, step), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** 送信済みの配信行（`sent`） */
const sentRow = (campaign, step, email, atMs) => ({
  fields: {
    EmailType: 'campaign', DeliveryKey: keyFor(campaign, step, email),
    RecipientEmail: email, Status: 'sent', SentAt: new Date(atMs).toISOString(),
  },
});

/**
 * 反応の状態を**実モジュール**で作る。
 * `delivered` / `opened` は `null` なら**未計測**（推測しない）。
 */
function responseFor(campaign, email, touches, extra = {}) {
  return resolveResponseState({
    marketing: member(campaign, email).marketing,
    touches, campaign,
    measured: extra.measured ?? { open: true, click: false },
    providerSuppressed: extra.providerSuppressed ?? null,
    softBounced: extra.softBounced ?? null,
  });
}

const touch = (campaign, step, email, atMs, o = {}) => ({
  step, deliveryKey: keyFor(campaign, step, email), sentAtMs: atMs,
  delivered: o.delivered ?? null, opened: o.opened ?? null, clicked: o.clicked ?? null,
});

/** 2 通受け取った人の進行を作る（最後の送信は十分前 = 期限到来） */
function progressAfterTwo(campaignId, email, responseOpts = {}, memberOver = {}) {
  const campaign = campaignOf(campaignId);
  const t1 = NOW - 40 * DAY;
  const t2 = NOW - 30 * DAY;
  const touches = [
    touch(campaign, 1, email, t1, responseOpts.t1 || {}),
    touch(campaign, 2, email, t2, responseOpts.t2 || {}),
  ];
  const response = responseOpts.noResponse
    ? null
    : responseFor(campaign, email, touches, responseOpts);
  const progress = buildSequenceProgress({
    campaign,
    selected: [member(campaign, email, memberOver)],
    deliveries: [sentRow(campaign, 1, email, t1), sentRow(campaign, 2, email, t2)],
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: responseOpts.providerSuppressed || new Set(),
    softBounced: responseOpts.softBounced || new Set(),
    responseByEmail: response ? new Map([[email, response]]) : undefined,
  });
  return { campaign, progress, row: progress.rows[0], response };
}

// ══════════════════════════════════════════════════════════════════
//  ① 宣言（母集団・route）が 3 本ぶん揃っている
// ══════════════════════════════════════════════════════════════════

test('【最重要】DRM 3 本は Customers 限定を宣言している（prospect を混ぜない）', () => {
  for (const id of DRM) {
    assert.equal(resolveAudienceSource(campaignOf(id)), 'customer', `${id} の宣言が customer でない`);
  }
});

test('【重要】宣言していない campaign は従来どおり all（挙動不変）', () => {
  /**
   * ⚠️ ここで守りたいのは「**宣言が無ければ all に倒れる**」という既定の挙動。
   *    例に使う campaign が宣言を持つと、この test の前提そのものが崩れる。
   *
   *    `campaign-discount-light` / `campaign-discount-premium` は 2026-09-17 に
   *    `audienceSource: 'customer'` を宣言した（prospect に構造的に当たらないのに
   *    毎 tick 索引を読んで 31 秒使い、送る相手が居る campaign を deferred させていたため）。
   *    よって例から外し、**宣言を持たない campaign だけ**で確かめる。
   */
  for (const id of ['campaign-discount-free',
    'light-trial-to-premium-sequence', 'light-trial-post-expiry-sequence']) {
    assert.equal(resolveAudienceSource(campaignOf(id)), 'all', `${id} の宣言が変わっている`);
  }
  // 宣言した 2 本は customer（狭める方向。選ばれる相手は変わらない）
  for (const id of ['campaign-discount-light', 'campaign-discount-premium']) {
    assert.equal(resolveAudienceSource(campaignOf(id)), 'customer', `${id} の宣言が外れている`);
  }
});

test('【重要】DRM 3 本は反応別の行き先を宣言している', () => {
  for (const id of DRM) {
    const routes = campaignOf(id).sequence.responseRoutes;
    assert.ok(Array.isArray(routes) && routes.length >= 2, `${id} に responseRoutes が無い`);
    const when = routes.map((r) => r.when);
    assert.ok(when.includes('opened') && when.includes('delivered'), `${id} の層が足りない`);
    // 行き先は必ず実在の step で、上限を超えない
    const max = resolveMaxSends(campaignOf(id));
    const steps = getSequenceSteps(campaignOf(id)).map((s) => s.stepNumber);
    for (const r of routes) {
      assert.ok(steps.includes(r.step), `${id}: 存在しない step ${r.step} へ送ろうとしている`);
      assert.ok(r.step <= max, `${id}: maxSends を超える step`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② 反応別の分岐（3 本すべてで固定）
// ══════════════════════════════════════════════════════════════════

test('【最重要】opened → 開封層の step へ前倒しされる', () => {
  for (const id of DRM) {
    const email = `open-${id}@example.com`;
    const { campaign, row } = progressAfterTwo(id, email, {
      t1: { delivered: true, opened: true }, t2: { delivered: true, opened: true },
    });
    const want = campaign.sequence.responseRoutes.find((r) => r.when === 'opened').step;
    assert.equal(row.status, 'due', `${id}: 期限が来ていない`);
    assert.equal(row.nextStep, want, `${id}: 開封層の行き先が違う`);
    assert.equal(row.routedBy, `opened:${want}`, `${id}: routedBy が付いていない`);
  }
});

test('【最重要】delivered（未開封）→ 到達層の step へ行く', () => {
  for (const id of DRM) {
    const email = `deliv-${id}@example.com`;
    const { campaign, row } = progressAfterTwo(id, email, {
      t1: { delivered: true, opened: false }, t2: { delivered: true, opened: false },
    });
    const want = campaign.sequence.responseRoutes.find((r) => r.when === 'delivered').step;
    assert.equal(row.nextStep, want, `${id}: 到達層の行き先が違う`);
    assert.equal(row.routedBy, `delivered:${want}`);
  }
});

test('【最重要】unknown（未計測）を未開封扱いしない — 線形のまま', () => {
  for (const id of DRM) {
    const email = `unk-${id}@example.com`;
    // 計測そのものが無効 = delivered も opened も分からない
    const { row, response } = progressAfterTwo(id, email, {
      t1: {}, t2: {}, measured: { open: false, click: false },
    });
    assert.equal(response.state, RESPONSE.UNKNOWN, `${id}: unknown になっていない`);
    assert.equal(row.nextStep, 3, `${id}: 線形（2 通済み → 3 通目）になっていない`);
    assert.equal(row.routedBy, null, `${id}: 反応で振り分けている`);
  }
});

test('【重要】sent / delivered / opened を混同しない', () => {
  const id = 'free-signup-onboarding';
  const email = `mix-${id}@example.com`;
  // 送った証拠はあるが、届いた証拠が無い → delivered 層へ入れない
  const { response, row } = progressAfterTwo(id, email, { t1: {}, t2: {} });
  assert.equal(response.sentCount, 2);
  assert.equal(response.state, RESPONSE.UNKNOWN, '送った＝届いたにしている');
  assert.equal(row.routedBy, null, '未計測を到達層へ入れている');
});

// ══════════════════════════════════════════════════════════════════
//  ③ 停止（購入・停止リスト・退会・バウンス）
// ══════════════════════════════════════════════════════════════════

test('【最重要】purchased → 停止（次の行き先を作らない）', () => {
  // Light 会員が Premium を買った → Light→Premium の育成は止まる
  const id = 'light-to-premium-sequence';
  const email = `paid-${id}@example.com`;
  const { row } = progressAfterTwo(id, email, {
    t1: { delivered: true, opened: true }, t2: { delivered: true, opened: true },
  }, { 'プラン': 'Premium' });
  assert.notEqual(row.status, 'due', '購入後も送ろうとしている');
  assert.ok(String(row.stopReason || '').length > 0, '停止理由が無い');
});

test('【最重要】suppressed（配信停止リスト）→ 停止', () => {
  const id = 'free-signup-onboarding';
  const email = `sup-${id}@example.com`;
  const { row } = progressAfterTwo(id, email, {
    t1: { delivered: true, opened: true }, t2: { delivered: true, opened: true },
    providerSuppressed: new Set([email]),
  });
  assert.notEqual(row.status, 'due', '停止リストの相手へ送ろうとしている');
});

test('【最重要】unsubscribe → 停止', () => {
  const id = 'free-signup-onboarding';
  const email = `unsub-${id}@example.com`;
  const { row } = progressAfterTwo(id, email, {
    t1: { delivered: true, opened: true }, t2: { delivered: true, opened: true },
  }, { UnsubscribedAnalyticsKeiba: true });
  assert.notEqual(row.status, 'due', '配信停止の相手へ送ろうとしている');
});

test('【最重要】bounce（soft bounce）→ 停止', () => {
  const id = 'free-signup-onboarding';
  const email = `bnc-${id}@example.com`;
  const { row } = progressAfterTwo(id, email, {
    t1: { delivered: true, opened: true }, t2: { delivered: true, opened: true },
    softBounced: new Set([email]),
  });
  assert.notEqual(row.status, 'due', 'バウンス相手へ送ろうとしている');
});

// ══════════════════════════════════════════════════════════════════
//  ④ 二重送信・上限・時刻境界
// ══════════════════════════════════════════════════════════════════

test('【最重要】duplicate — すでに送った step は選ばれない', () => {
  const id = 'free-signup-onboarding';
  const campaign = campaignOf(id);
  const email = `dup-${id}@example.com`;
  const want = campaign.sequence.responseRoutes.find((r) => r.when === 'opened').step;   // 5
  const t1 = NOW - 40 * DAY;
  const t2 = NOW - 30 * DAY;
  const t5 = NOW - 20 * DAY;
  const touches = [
    touch(campaign, 1, email, t1, { delivered: true, opened: true }),
    touch(campaign, 2, email, t2, { delivered: true, opened: true }),
    touch(campaign, want, email, t5, { delivered: true, opened: true }),
  ];
  const progress = buildSequenceProgress({
    campaign, selected: [member(campaign, email)],
    deliveries: [
      sentRow(campaign, 1, email, t1), sentRow(campaign, 2, email, t2), sentRow(campaign, want, email, t5),
    ],
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
    responseByEmail: new Map([[email, responseFor(campaign, email, touches)]]),
  });
  const row = progress.rows[0];
  assert.notEqual(row.nextStep, want, 'すでに送った step をもう一度選んでいる');
  assert.ok(!row.sentSteps.includes(row.nextStep), '送信済みの step を次に選んでいる');
});

test('【最重要】maxSends に達したら completed（それ以上送らない）', () => {
  const id = 'light-to-premium-sequence';
  const campaign = campaignOf(id);
  const email = `max-${id}@example.com`;
  const max = resolveMaxSends(campaign);
  const deliveries = [];
  const touches = [];
  for (let n = 1; n <= max; n += 1) {
    const at = NOW - (max - n + 2) * 10 * DAY;
    deliveries.push(sentRow(campaign, n, email, at));
    touches.push(touch(campaign, n, email, at, { delivered: true, opened: true }));
  }
  const progress = buildSequenceProgress({
    campaign, selected: [member(campaign, email)], deliveries,
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
    responseByEmail: new Map([[email, responseFor(campaign, email, touches)]]),
  });
  const row = progress.rows[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.stopReason, 'max_sends_reached');
});

test('【最重要】時刻境界 — 待機日数を満たすまで due にならない', () => {
  const id = 'light-to-premium-sequence';   // step2 以降は 7 日
  const campaign = campaignOf(id);
  const email = `time-${id}@example.com`;
  const delay = getSequenceSteps(campaign).find((s) => s.stepNumber === 3).delayDays;

  const build = (lastSentAtMs, nowMs) => buildSequenceProgress({
    campaign, selected: [member(campaign, email)],
    deliveries: [
      sentRow(campaign, 1, email, lastSentAtMs - 30 * DAY),
      sentRow(campaign, 2, email, lastSentAtMs),
    ],
    brand: BRAND, fromEmail: FROM, nowMs,
    providerSuppressed: new Set(), softBounced: new Set(),
  }).rows[0];

  const last = NOW - delay * DAY;
  // ちょうど境界 → due
  assert.equal(build(last, NOW).status, 'due', '境界で送れていない');
  // 1 ミリ秒手前 → まだ待機
  assert.equal(build(last + 1, NOW).status, 'waiting', '待機日数を満たす前に送ろうとしている');
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ step1 の gate は弱めない / step2 以降は進む
// ══════════════════════════════════════════════════════════════════

test('【最重要】入口ゲートが閉じていても step2 以降は進む', () => {
  const id = 'free-signup-onboarding';
  const email = `go-${id}@example.com`;
  const { progress } = progressAfterTwo(id, email, {
    t1: { delivered: true, opened: true }, t2: { delivered: true, opened: true },
  });
  // allowFirstStep: false = `MARKETING_DRM_AUTOSTART_ENABLED` が閉じている状態
  const plan = planSequenceTick({
    progress, gates: OPEN_GATES, maxRecipients: 50, allowFirstStep: false,
  });
  assert.equal(plan.ok, true, 'step2 以降が進まない');
  assert.ok(plan.step >= 2, `step1 を撃とうとしている（step ${plan.step}）`);
});

test('【最重要】step1 しか居なければ従来どおり止まる（入口 gate を弱めない）', () => {
  const id = 'free-signup-onboarding';
  const campaign = campaignOf(id);
  const progress = buildSequenceProgress({
    campaign,
    selected: [member(campaign, 'new1@example.com'), member(campaign, 'new2@example.com')],
    deliveries: [], brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
  });
  const plan = planSequenceTick({
    progress, gates: OPEN_GATES, maxRecipients: 50, allowFirstStep: false,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.FIRST_STEP_MANUAL);
});

test('【重要】step1 待ちと step2 以降が混ざっても、選ばれるのは step2 以降だけ', () => {
  const id = 'free-signup-onboarding';
  const campaign = campaignOf(id);
  const older = 'mix-old@example.com';
  const t1 = NOW - 40 * DAY;
  const t2 = NOW - 30 * DAY;
  const progress = buildSequenceProgress({
    campaign,
    selected: [member(campaign, older), member(campaign, 'mix-new@example.com')],
    deliveries: [sentRow(campaign, 1, older, t1), sentRow(campaign, 2, older, t2)],
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
  });
  const plan = planSequenceTick({
    progress, gates: OPEN_GATES, maxRecipients: 50, allowFirstStep: false,
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.step >= 2, 'step1 が選ばれている');
  assert.equal(plan.recordIds.length, 1, 'step1 の人まで対象にしている');
  assert.equal(plan.recordIds[0], `rec-${older}`);
});
