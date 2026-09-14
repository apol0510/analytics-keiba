/**
 * campaignStepMeasurement.test.mjs — 接点番号を使わずに campaign × step で数える
 *   node --test src/lib/marketing/campaignStepMeasurement.test.mjs
 *
 * ── 何を守るテストか ──────────────────────────────────────────
 * 2026-09-14、`free-signup-onboarding` の配信行 13 行が**読めているのに**
 * `touchMeasurement` は `touches: []` / `totals.sent: 0` を返していた。
 * 原因は `journeyModel.js` への依存で、そこは **Light 無料体験（6 通 ＋ 終了後 18 通
 * = 24 接点）の専用 SSOT**。載っていない campaign は `toTouch()` が `null` を返す。
 *
 * `journeyModel.js` へ他の campaign を**登録しない**まま数えられるようにしたので、
 *   ① 事故の 13 行が step1 として 13 件に見えること
 *   ② journey へ他 campaign が紛れ込んでいないこと
 * を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeByTouch, summarizeByCampaignStep } from './touchMeasurement.js';
import {
  mergeStepPage, emptyStepScan, finalizeStepScan, buildInlineStepResult,
} from './touchMeasurementScan.js';
import { JOURNEY_PHASES, isJourneyCampaign, toTouch } from './journeyModel.js';
import { CAMPAIGNS, getCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep, isSequenceCampaign } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';

const BRAND = 'analytics-keiba';
/** 事故時の実データと同じ送信元（本番の 13 行から確認済み） */
const FROM = 'noreply@keiba.link';
const INCIDENT = 'free-signup-onboarding';
const SENT_AT = '2026-09-14T14:57:00.000Z';

/** 台帳 1 行（PII は使わない。アドレスはテスト用の合成） */
const row = (key, campaignId, status = 'sent', extra = {}) => ({
  fields: {
    DeliveryKey: key,
    CampaignType: `${campaignId}:v1`,
    EmailType: 'campaign',
    Status: status,
    SentAt: status === 'sent' ? SENT_AT : null,
    RecipientEmail: extra.email || 'x@example.com',
  },
});

/** 索引の戻り（読めた＝ok:true） */
const idx = (pairs) => ({ ok: true, byKey: new Map(pairs) });

/**
 * 実 campaign の step1 の `DeliveryKey` を**本物の計算**で作る。
 * 偽の鍵で通してしまうと「完全一致で結ぶ」契約が守られているか確かめられない。
 */
function realStepKeys(campaignId, stepNumber, emails) {
  const base = getCampaign(campaignId, { includeDisabled: true });
  assert.ok(base, `${campaignId} が catalog にありません`);
  const stepCampaign = resolveSequenceStep(base, stepNumber);
  assert.ok(stepCampaign, `${campaignId} の step${stepNumber} が解決できません`);
  return emails.map((email) => computeCampaignDeliveryKey({
    campaign: stepCampaign, recipientEmail: email, brand: BRAND, fromEmail: FROM,
  }));
}

// ───────────────────────────────────────────────────────────────
// ① 事故の 13 行
// ───────────────────────────────────────────────────────────────

test('【最重要】事故の 13 行が free-signup-onboarding step1 として 13 件数えられる', () => {
  const emails = Array.from({ length: 13 }, (_, i) => `member${i + 1}@example.com`);
  const keys = realStepKeys(INCIDENT, 1, emails);
  assert.equal(new Set(keys).size, 13, '13 人ぶんの鍵が重複なく作れること');

  const deliveries = keys.map((k, i) => row(k, INCIDENT, 'sent', { email: emails[i] }));
  const stepByDeliveryKey = new Map(keys.map((k) => [k, 1]));

  const out = summarizeByCampaignStep({
    deliveries, stepByDeliveryKey, index: { ok: false, byKey: new Map() },
  });

  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].campaignId, INCIDENT);
  assert.equal(out.steps[0].step, 1);
  assert.equal(out.steps[0].sent, 13);
  assert.equal(out.totals.sent, 13);
});

test('【最重要】同じ 13 行を接点番号で数えると 0 件になる（事故の再現）', () => {
  const emails = Array.from({ length: 13 }, (_, i) => `member${i + 1}@example.com`);
  const keys = realStepKeys(INCIDENT, 1, emails);
  const deliveries = keys.map((k, i) => row(k, INCIDENT, 'sent', { email: emails[i] }));
  const stepByDeliveryKey = new Map(keys.map((k) => [k, 1]));

  const old = summarizeByTouch({
    deliveries, stepByDeliveryKey, index: { ok: false, byKey: new Map() },
  });
  assert.deepEqual(old.touches, [], 'journey に載っていないので接点番号が付かない');
  assert.equal(old.totals.sent, 0);
  assert.equal(toTouch(INCIDENT, 1), null);
});

test('DRM 3 本すべてを campaign × step で数えられる', () => {
  for (const id of [INCIDENT, 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence']) {
    const base = getCampaign(id, { includeDisabled: true });
    assert.ok(base && isSequenceCampaign(base), `${id} が連続配信として引けること`);
    const email = 'member@example.com';
    const keys = getSequenceSteps(base).map((s) => realStepKeys(id, s.stepNumber, [email])[0]);
    const deliveries = keys.map((k) => row(k, id, 'sent', { email }));
    const stepByDeliveryKey = new Map(keys.map((k, i) => [k, i + 1]));
    const out = summarizeByCampaignStep({
      deliveries, stepByDeliveryKey, index: { ok: false, byKey: new Map() },
    });
    assert.equal(out.steps.length, keys.length, `${id}: step ぶんの行が出る`);
    assert.deepEqual(out.steps.map((x) => x.step), keys.map((_, i) => i + 1));
    assert.ok(out.steps.every((x) => x.campaignId === id));
  }
});

// ───────────────────────────────────────────────────────────────
// ② journey へ他 campaign を紛れ込ませない
// ───────────────────────────────────────────────────────────────

test('【重要】journeyModel は Light 無料体験の 2 本だけ（24 接点）', () => {
  assert.deepEqual(
    JOURNEY_PHASES.map((p) => p.campaignId),
    ['light-trial-to-premium-sequence', 'light-trial-post-expiry-sequence'],
  );
  assert.deepEqual(JOURNEY_PHASES.map((p) => p.steps), [6, 18]);
  assert.equal(JOURNEY_PHASES.reduce((a, p) => a + p.steps, 0), 24);
});

test('【重要】DRM の 3 本は journey へ登録されていない', () => {
  for (const id of [INCIDENT, 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence']) {
    assert.equal(isJourneyCampaign(id), false, `${id} を journey へ入れてはいけない`);
    assert.equal(toTouch(id, 1), null);
  }
});

test('【重要】Light 無料体験 2 本以外の連続配信を journey に入れない', () => {
  const journeyIds = new Set(JOURNEY_PHASES.map((p) => p.campaignId));
  const others = CAMPAIGNS
    .filter((c) => isSequenceCampaign(c))
    .map((c) => c.campaignId)
    .filter((id) => !journeyIds.has(id));
  assert.ok(others.length > 0, '比較対象の連続配信が存在すること');
  for (const id of others) {
    assert.equal(isJourneyCampaign(id), false, `${id} が journey に紛れている`);
  }
});

// ───────────────────────────────────────────────────────────────
// ③ 数えかたの約束（unknown / sent / delivered / opened）
// ───────────────────────────────────────────────────────────────

test('【重要】届いた証拠が無い行は unknown。未開封と決めつけない', () => {
  const [k] = realStepKeys(INCIDENT, 1, ['a@example.com']);
  const out = summarizeByCampaignStep({
    deliveries: [row(k, INCIDENT)],
    stepByDeliveryKey: new Map([[k, 1]]),
    index: idx([]),                       // 索引は読めたが、この鍵の記録が無い
  });
  const s = out.steps[0];
  assert.equal(s.sent, 1);
  assert.equal(s.delivered, 0);
  assert.equal(s.opened, 0);
  assert.equal(s.unknown, 1);
  assert.equal(s.measured, 0);
  assert.equal(s.openRate, null, '未開封 0% と書かない');
});

test('【重要】索引そのものが読めなければ measurementAvailable: false（0 件にしない）', () => {
  const [k] = realStepKeys(INCIDENT, 1, ['a@example.com']);
  const out = summarizeByCampaignStep({
    deliveries: [row(k, INCIDENT)],
    stepByDeliveryKey: new Map([[k, 1]]),
    index: { ok: false, byKey: new Map() },
  });
  assert.equal(out.measurementAvailable, false);
  assert.equal(out.steps[0].sent, 1);
  assert.equal(out.steps[0].unknown, 1);
  assert.equal(out.steps[0].delivered, 0);
});

test('【重要】sent / delivered / opened を混同しない', () => {
  const emails = ['a@example.com', 'b@example.com', 'c@example.com'];
  const [k1, k2, k3] = realStepKeys(INCIDENT, 1, emails);
  const out = summarizeByCampaignStep({
    deliveries: [
      row(k1, INCIDENT, 'sent', { email: emails[0] }),      // 届いて開封
      row(k2, INCIDENT, 'sent', { email: emails[1] }),      // 届いたが未開封
      row(k3, INCIDENT, 'queued', { email: emails[2] }),    // まだ送っていない
    ],
    stepByDeliveryKey: new Map([[k1, 1], [k2, 1], [k3, 1]]),
    index: idx([
      [k1, { deliveredAtMs: 1, firstOpenAtMs: 2 }],
      [k2, { deliveredAtMs: 1, firstOpenAtMs: null }],
    ]),
  });
  const s = out.steps[0];
  assert.equal(s.sent, 2, 'queued は送信に数えない');
  assert.equal(s.delivered, 2);
  assert.equal(s.opened, 1);
  assert.equal(s.unknown, 0);
  assert.equal(s.deliveryRate, 1);
  assert.equal(s.openRate, 0.5, 'open の分母は delivered');
});

test('【重要】DeliveryKey が一致しない行は数えない（step を推測しない）', () => {
  const [k] = realStepKeys(INCIDENT, 1, ['a@example.com']);
  const out = summarizeByCampaignStep({
    deliveries: [row('f'.repeat(64), INCIDENT)],   // 対応表に無い鍵
    stepByDeliveryKey: new Map([[k, 1]]),
    index: idx([]),
  });
  assert.deepEqual(out.steps, []);
  assert.equal(out.totals.sent, 0);
});

test('別 campaign の行は別の箱で数える（混ぜない）', () => {
  const [a] = realStepKeys(INCIDENT, 1, ['a@example.com']);
  const [b] = realStepKeys('light-to-premium-sequence', 1, ['a@example.com']);
  const out = summarizeByCampaignStep({
    deliveries: [row(a, INCIDENT), row(b, 'light-to-premium-sequence')],
    stepByDeliveryKey: new Map([[a, 1], [b, 1]]),
    index: idx([]),
  });
  assert.equal(out.steps.length, 2);
  assert.deepEqual(out.steps.map((x) => x.campaignId).sort(),
    [INCIDENT, 'light-to-premium-sequence'].sort());
});

// ───────────────────────────────────────────────────────────────
// ④ ページ合算（二重集計しない / 率は 1 回だけ）
// ───────────────────────────────────────────────────────────────

test('【重要】同じページを 2 回足しても増えない', () => {
  const page = {
    pageIndex: 0, rows: 13,
    steps: [{ campaignId: INCIDENT, step: 1, sent: 13, delivered: 0, opened: 0, measured: 0, unknown: 13 }],
  };
  let acc = emptyStepScan();
  acc = mergeStepPage(acc, page);
  const once = finalizeStepScan(acc);
  acc = mergeStepPage(acc, page);
  const twice = finalizeStepScan(acc);
  assert.deepEqual(once, twice);
  assert.equal(once.steps[0].sent, 13);
  assert.equal(once.scan.rows, 13);
});

test('率はページごとに平均せず、合算してから 1 回だけ出す', () => {
  let acc = emptyStepScan();
  acc = mergeStepPage(acc, {
    pageIndex: 0,
    rows: 1,
    steps: [{ campaignId: INCIDENT, step: 1, sent: 1, delivered: 1, opened: 1, measured: 1, unknown: 0 }],
  });
  acc = mergeStepPage(acc, {
    pageIndex: 1,
    rows: 3,
    steps: [{ campaignId: INCIDENT, step: 1, sent: 3, delivered: 3, opened: 0, measured: 3, unknown: 0 }],
  });
  const out = finalizeStepScan(acc);
  assert.equal(out.steps[0].sent, 4);
  assert.equal(out.steps[0].opened, 1);
  assert.equal(out.steps[0].openRate, 0.25, '(1/1 と 0/3) の平均 0.5 にしない');
});

test('数え切れていなければ steps も totals も返さない', () => {
  const partial = buildInlineStepResult({ scan: { complete: false, scan: { pages: 1, rows: 200 } } });
  assert.equal(partial.ok, false);
  assert.equal(partial.body.complete, false);
  assert.ok(!('steps' in partial.body));
  assert.ok(!('totals' in partial.body));
});

test('数え切れたときだけ steps を返す', () => {
  const done = buildInlineStepResult({
    scan: {
      complete: true, measurementAvailable: true, clickMeasured: false,
      steps: [{ campaignId: INCIDENT, step: 1, sent: 13 }],
      totals: { sent: 13 },
      scan: { pages: 1, rows: 13 },
    },
  });
  assert.equal(done.ok, true);
  assert.equal(done.body.steps[0].sent, 13);
  assert.equal(done.body.scannedRows, 13);
});
