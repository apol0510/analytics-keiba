/**
 * largeCampaign.test.mjs — snapshot / 分割配信 / 段階配信 / 計測状態 / 成果
 *   node --test src/lib/crm/largeCampaign.test.mjs
 *
 * 大規模配信で取り返しがつかないのは「多く送ってしまう」ことと
 * 「二重に送ってしまう」こと。減る方向は許し、増える方向は構造的に禁じる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SNAPSHOT_STATUS, SNAPSHOT_REJECT, SNAPSHOT_TTL_MS,
  buildAudienceSnapshot, canUseSnapshot, applyPreSendExclusions,
  consumeSnapshot, computeSnapshotIntegrity, describeSnapshot,
} from './audienceSnapshot.js';
import {
  JOB_STATE, BATCH_STATE, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, DEFAULT_ABNORMAL_THRESHOLDS,
  planBatches, summarizeProgress, canPause, canResume, cancelPendingBatches,
  nextBatch, detectAbnormal, nextStage, DEFAULT_STAGES,
} from './batchPlan.js';
import {
  MEASURE, resolveMeasurementState, summarizeDelivery, canShowCount,
  compareLedgerWithProvider, NOT_MEASURED_TEXT, UNKNOWN_TEXT,
  measuredCount, ALWAYS_MEASURED_METRICS,
} from './deliveryMeasurement.js';
import { buildOutcomeReport, ATTRIBUTION, canCompare } from './campaignOutcome.js';

const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);

const snapInput = (over = {}) => ({
  snapshotId: 'snap-1', campaignId: 'c1', campaignVersion: 2, contentHash: 'ch1',
  segmentId: 'free-all', segmentVersion: 1, conditionHash: 'cond1',
  targetCount: 13000, excludedCount: 240, excludedByReason: { unsubscribed: 40 },
  createdBy: 'admin', nowMs: NOW, ...over,
});
const useInput = (over = {}) => ({
  campaignId: 'c1', campaignVersion: 2, contentHash: 'ch1', conditionHash: 'cond1',
  nowMs: NOW, ...over,
});

// ══ audience snapshot ══════════════════════════════════════════

test('snapshot に個人情報を入れない', () => {
  const s = buildAudienceSnapshot(snapInput());
  const json = JSON.stringify(s);
  for (const b of ['@', '氏名', 'rec', 'Email']) {
    assert.equal(json.includes(b), false, `${b} が snapshot に入っている`);
  }
  assert.equal(s.targetCount, 13000);
  assert.equal(s.status, SNAPSHOT_STATUS.READY);
});

test('正しい snapshot は使える', () => {
  const s = buildAudienceSnapshot(snapInput());
  assert.equal(canUseSnapshot({ ...useInput(), snapshot: s }).ok, true);
});

test('改ざんした snapshot は拒否する', () => {
  const s = buildAudienceSnapshot(snapInput());
  const tampered = { ...s, targetCount: 99999 };
  const r = canUseSnapshot({ ...useInput(), snapshot: tampered });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SNAPSHOT_REJECT.INTEGRITY);
  // 整合性ハッシュは中身から作られるので、作り直せば一致してしまう点も明示
  const { integrity, ...rest } = tampered;
  assert.notEqual(integrity, computeSnapshotIntegrity(rest));
});

test('期限切れ snapshot は拒否する', () => {
  const s = buildAudienceSnapshot(snapInput());
  const r = canUseSnapshot({ ...useInput({ nowMs: NOW + SNAPSHOT_TTL_MS + 1 }), snapshot: s });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SNAPSHOT_REJECT.EXPIRED);
});

test('別キャンペーン・別 version・別内容・別条件では使えない', () => {
  const s = buildAudienceSnapshot(snapInput());
  const cases = [
    [{ campaignId: 'other' }, SNAPSHOT_REJECT.CAMPAIGN_MISMATCH],
    [{ campaignVersion: 3 }, SNAPSHOT_REJECT.CAMPAIGN_MISMATCH],
    [{ contentHash: 'other' }, SNAPSHOT_REJECT.CONTENT_CHANGED],
    [{ conditionHash: 'other' }, SNAPSHOT_REJECT.CONDITION_CHANGED],
  ];
  for (const [over, reason] of cases) {
    const r = canUseSnapshot({ ...useInput(over), snapshot: s });
    assert.equal(r.ok, false, `${JSON.stringify(over)} が通ってしまう`);
    assert.equal(r.reason, reason);
  }
});

test('使い切った snapshot は二度と使えない（二重キュー登録の防止）', () => {
  const s = buildAudienceSnapshot(snapInput());
  const used = consumeSnapshot(s);
  assert.equal(used.status, SNAPSHOT_STATUS.CONSUMED);
  const r = canUseSnapshot({ ...useInput(), snapshot: used });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SNAPSHOT_REJECT.CONSUMED);
});

test('対象 0 名の snapshot は使えない', () => {
  const s = buildAudienceSnapshot(snapInput({ targetCount: 0 }));
  assert.equal(canUseSnapshot({ ...useInput(), snapshot: s }).reason, SNAPSHOT_REJECT.EMPTY);
});

test('送信直前に減るのは正常、増えるのは異常', () => {
  const s = buildAudienceSnapshot(snapInput({ targetCount: 100 }));
  const shrink = applyPreSendExclusions({ snapshot: s, currentEligibleCount: 95 });
  assert.equal(shrink.ok, true);
  assert.equal(shrink.willSend, 95);
  assert.equal(shrink.shrunkBy, 5);

  const grow = applyPreSendExclusions({ snapshot: s, currentEligibleCount: 120 });
  assert.equal(grow.ok, false, '対象が増えたのに送ろうとしている');
  assert.equal(grow.reason, SNAPSHOT_REJECT.GREW);
  assert.equal(grow.willSend, 0);
});

test('送る数は snapshot を超えない', () => {
  const s = buildAudienceSnapshot(snapInput({ targetCount: 10 }));
  const r = applyPreSendExclusions({ snapshot: s, currentEligibleCount: 10 });
  assert.equal(r.willSend, 10);
  assert.ok(r.willSend <= s.targetCount);
});

test('画面表示に snapshotId・条件ハッシュを出さない', () => {
  const s = buildAudienceSnapshot(snapInput());
  const text = describeSnapshot(s, NOW);
  assert.equal(text.includes('snap-1'), false);
  assert.equal(text.includes('cond1'), false);
  assert.match(text, /13000 名/);
});

// ══ 分割配信 ═══════════════════════════════════════════════════

test('13,000 件を既定サイズのバッチへ割る', () => {
  const p = planBatches({ targetCount: 13000 });
  assert.equal(p.ok, true);
  assert.equal(p.batchSize, DEFAULT_BATCH_SIZE);
  assert.equal(p.batchCount, Math.ceil(13000 / DEFAULT_BATCH_SIZE));
  assert.equal(p.batches.reduce((a, b) => a + b.size, 0), 13000, '合計が対象数と合わない');
  assert.ok(p.batches.every((b) => b.state === BATCH_STATE.PENDING));
});

test('バッチサイズは上下限に丸める', () => {
  assert.equal(planBatches({ targetCount: 5000, batchSize: 99999 }).batchSize, MAX_BATCH_SIZE);
  assert.equal(planBatches({ targetCount: 5000, batchSize: 1 }).batchSize, 100);
});

test('対象 0 ならバッチを作らない', () => {
  assert.equal(planBatches({ targetCount: 0 }).ok, false);
});

test('同時に 2 バッチ走らせない / 送信済みは二度返さない', () => {
  const batches = [
    { index: 1, state: BATCH_STATE.SENT }, { index: 2, state: BATCH_STATE.PENDING },
  ];
  const job = { state: JOB_STATE.RUNNING, batches };
  assert.equal(nextBatch(job).batch.index, 2, '送信済みを再実行しようとしている');

  const inFlight = { state: JOB_STATE.RUNNING, batches: [{ index: 1, state: BATCH_STATE.SENDING }] };
  assert.equal(nextBatch(inFlight).ok, false);
  assert.equal(nextBatch(inFlight).reason, 'batch_in_flight');
});

test('停止中は次のバッチを返さない', () => {
  for (const st of [JOB_STATE.PAUSED, JOB_STATE.STOPPED_ABNORMAL, JOB_STATE.CANCELLED]) {
    assert.equal(nextBatch({ state: st, batches: [{ index: 1, state: BATCH_STATE.PENDING }] }).ok, false);
  }
});

test('未送信は取り消せる。送信済みは取り消せない', () => {
  const job = { batches: [
    { index: 1, state: BATCH_STATE.SENT, size: 500 },
    { index: 2, state: BATCH_STATE.PENDING, size: 500 },
    { index: 3, state: BATCH_STATE.PENDING, size: 500 },
  ] };
  const r = cancelPendingBatches(job);
  assert.equal(r.cancelledBatches, 2);
  assert.equal(r.batches[0].state, BATCH_STATE.SENT, '送信済みを取り消している');
  assert.equal(r.keptSent, 1);
});

test('一時停止は動いているときだけ / 異常停止からの再開は確認が要る', () => {
  assert.equal(canPause({ state: JOB_STATE.RUNNING }).allowed, true);
  assert.equal(canPause({ state: JOB_STATE.PAUSED }).allowed, false);
  assert.equal(canResume({ state: JOB_STATE.PAUSED }).allowed, true);
  assert.equal(canResume({ state: JOB_STATE.STOPPED_ABNORMAL }).allowed, false);
  assert.equal(canResume({ state: JOB_STATE.STOPPED_ABNORMAL }, { abnormalAcknowledged: true }).allowed, true);
});

test('進捗に個人情報を含めない', () => {
  const job = {
    state: JOB_STATE.RUNNING, targetCount: 1000, delivered: 480, excludedCount: 20,
    updatedAtMs: NOW,
    batches: [
      { index: 1, state: BATCH_STATE.SENT, size: 500, sent: 500, failed: 0 },
      { index: 2, state: BATCH_STATE.SENDING, size: 500, sent: 0, failed: 0 },
    ],
  };
  const p = summarizeProgress(job);
  assert.equal(p.送信済み, 500);
  assert.equal(p.現在のバッチ, 2);
  assert.equal(p.進捗率, 50);
  assert.equal(JSON.stringify(p).includes('@'), false);
});

// ══ 異常停止 ═══════════════════════════════════════════════════

test('閾値は引数で受ける（コードに直書きしない）', () => {
  const metrics = { sent: 1000, delivered: 500, bounce: 0 };
  assert.equal(detectAbnormal({ metrics }).stop, true, '配信率低下を検知していない');
  // 閾値を緩めれば止まらない＝閾値が外から与えられている証拠
  assert.equal(detectAbnormal({ metrics, thresholds: { minDeliveredRate: 0.1 } }).stop, false);
  assert.ok(DEFAULT_ABNORMAL_THRESHOLDS.minDeliveredRate > 0);
});

test('少数の母数では率で止めない（誤検知を避ける）', () => {
  const metrics = { sent: 10, delivered: 5 };
  assert.equal(detectAbnormal({ metrics }).stop, false);
});

test('率とは無関係に即停止する種類がある', () => {
  const cases = [
    { ledgerMismatch: true }, { contentHashMismatch: true },
    { audienceDrift: true }, { duplicateDeliveryKeys: 1 },
  ];
  for (const extra of cases) {
    const r = detectAbnormal({ metrics: { sent: 10, delivered: 10, ...extra } });
    assert.equal(r.stop, true, `${JSON.stringify(extra)} で止まらない`);
    assert.ok(r.reasons.length > 0);
  }
});

test('バウンス・迷惑報告・配信基盤エラーで止まる', () => {
  const base = { sent: 1000, delivered: 1000 };
  assert.equal(detectAbnormal({ metrics: { ...base, bounce: 100 } }).stop, true);
  assert.equal(detectAbnormal({ metrics: { ...base, spamReport: 10 } }).stop, true);
  assert.equal(detectAbnormal({ metrics: { ...base, providerErrors: 100 } }).stop, true);
  assert.equal(detectAbnormal({ metrics: base }).stop, false);
});

// ══ 段階配信 ═══════════════════════════════════════════════════

test('いきなり全件送らせない（段階の順に解放する）', () => {
  assert.equal(nextStage({ sentSoFar: 0, nowMs: NOW }).stage.id, 'admin-test');
  assert.equal(nextStage({ sentSoFar: 1, nowMs: NOW }).allow, 500);
  assert.ok(DEFAULT_STAGES[0].size < DEFAULT_STAGES[1].size);
});

test('観測時間を待たないと次の段階へ進めない', () => {
  const r = nextStage({ sentSoFar: 501, lastStageFinishedAtMs: NOW - 3600000, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'observing');
  const ok = nextStage({ sentSoFar: 501, lastStageFinishedAtMs: NOW - 25 * 3600000, nowMs: NOW });
  assert.equal(ok.ok, true);
});

// ══ 計測状態 ═══════════════════════════════════════════════════

test('tracking と webhook の両方そろって初めて「計測中」', () => {
  const on = { openTracking: { enabled: true }, clickTracking: { enabled: true },
    eventWebhook: { enabled: true, open: true, click: true } };
  const m = resolveMeasurementState(on);
  assert.equal(m.open, MEASURE.ENABLED);
  assert.equal(m.click, MEASURE.ENABLED);
});

test('2026-08-04 の実設定を「計測していない」と判定する', () => {
  // 実測: open tracking は有効だが webhook が open を送らない / click は tracking 自体が無効
  const m = resolveMeasurementState({
    openTracking: { enabled: true },
    clickTracking: { enabled: false },
    eventWebhook: { enabled: true, open: false, click: false },
  });
  assert.equal(m.open, MEASURE.DISABLED, '開封を計測中と誤判定している');
  assert.equal(m.click, MEASURE.DISABLED);
  assert.ok(m.reasons.some((x) => /open を送らない/.test(x)));
  assert.equal(m.providerOnly, true);
});

test('設定を読めなければ「不明」（有効とも無効とも決めつけない）', () => {
  const m = resolveMeasurementState({});
  assert.equal(m.open, MEASURE.UNKNOWN);
  assert.equal(m.click, MEASURE.UNKNOWN);
  assert.equal(canShowCount(MEASURE.UNKNOWN), false);
});

test('計測無効のとき「0」を出さない', () => {
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: false },
    eventWebhook: { enabled: true, open: false, click: false },
  });
  const d = summarizeDelivery({
    targeted: 28, queued: 28, sent: 28, delivered: 28,
    openUnique: 0, openEvents: 0, clickUnique: 0, clickEvents: 0,
    measurement: m, providerObserved: { openUnique: 9, openEvents: 14 },
  });
  assert.equal(d.openedUnique.value, null, '未計測なのに 0 を返している');
  assert.equal(d.openedUnique.text, NOT_MEASURED_TEXT);
  assert.equal(d.clickedUnique.value, null);
  // provider 側の実測値は「参考値」として別に持つ
  assert.equal(d.openedUnique.providerValue, 9);
  assert.match(d.openedUnique.providerNote, /参考値/);
  assert.match(d.warning.text, /未開封ではなく/);
});

test('計測有効なら 0 を 0 として出す', () => {
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: true },
    eventWebhook: { enabled: true, open: true, click: true },
  });
  const d = summarizeDelivery({ sent: 10, delivered: 10, openUnique: 0, openEvents: 0, measurement: m });
  assert.equal(d.openedUnique.value, 0);
  assert.equal(d.openedUnique.text, '0');
});

test('unique 人数と event 件数を混同しない', () => {
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: true },
    eventWebhook: { enabled: true, open: true, click: true },
  });
  const d = summarizeDelivery({ sent: 28, delivered: 28, openUnique: 9, openEvents: 14, measurement: m });
  assert.equal(d.openedUnique.value, 9);
  assert.equal(d.openEvents.value, 14);
  assert.notEqual(d.openedUnique.value, d.openEvents.value);
});

test('provider 受理と delivered を分ける', () => {
  const d = summarizeDelivery({ sent: 30, delivered: 28, measurement: resolveMeasurementState({}) });
  assert.equal(d.sentAccepted, 30);
  assert.equal(d.delivered, 28);
});

// ── 1 件ずつの内訳（顧客カルテ）でも同じ規則を使う ────────────────
// 2026-08-04: キャンペーン集計は「—」を出せるのに、顧客カルテだけ
// `le.opens ?? 0` で「開封 0 回」と断定していた。同じ規則を単一源から使わせる。

test('カルテの 1 件表示: 計測無効なら数値を出さない', () => {
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: false },
    eventWebhook: { enabled: true, open: false, click: false },
  });
  const opens = measuredCount(m.open, 0, '回');
  assert.equal(opens.value, null, '未計測なのに 0 を数値で返している');
  assert.equal(opens.text, NOT_MEASURED_TEXT);
  assert.equal(opens.measured, false);
  // 台帳に行があっても同じ（値があること自体が計測の証明にはならない）
  assert.equal(measuredCount(m.click, 3, '回').value, null);
});

test('カルテの 1 件表示: 計測有効なら 0 を 0 として出す', () => {
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: true },
    eventWebhook: { enabled: true, open: true, click: true },
  });
  assert.deepEqual(
    { v: measuredCount(m.open, 0, '回').value, t: measuredCount(m.open, 0, '回').text },
    { v: 0, t: '0 回' },
  );
  assert.equal(measuredCount(m.open, 2, '回').text, '2 回');
});

test('カルテの 1 件表示: 不明は「無効」と別の文言にする', () => {
  const m = resolveMeasurementState({});
  assert.equal(measuredCount(m.open, 0, '回').text, UNKNOWN_TEXT);
  assert.notEqual(UNKNOWN_TEXT, NOT_MEASURED_TEXT);
});

test('delivered / bounce は開封計測の状態に左右されない', () => {
  // Webhook が届けている種別は確定した事実。開封が未計測でも隠さない
  for (const k of ['delivered', 'bounced', 'unsubscribed', 'spamReported']) {
    assert.ok(ALWAYS_MEASURED_METRICS.includes(k), `${k} を常時計測から外している`);
  }
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: false },
    eventWebhook: { enabled: true, open: false, click: false },
  });
  const d = summarizeDelivery({ sent: 36, delivered: 36, bounce: 0, measurement: m });
  assert.equal(d.delivered, 36, '確定している delivered まで隠している');
  assert.equal(d.openedUnique.value, null);
});

test('台帳と provider の食い違いを検知する', () => {
  const same = compareLedgerWithProvider({ ledger: { delivered: 28 }, provider: { delivered: 28 } });
  assert.equal(same.consistent, true);
  const diff = compareLedgerWithProvider({ ledger: { delivered: 20 }, provider: { delivered: 28 } });
  assert.equal(diff.consistent, false);
  assert.equal(diff.diffs.delivered.diff, 8);
});

// ══ 成果 ═══════════════════════════════════════════════════════

test('成果は確からしさを分けて出す', () => {
  const m = resolveMeasurementState({
    openTracking: { enabled: true }, clickTracking: { enabled: false },
    eventWebhook: { enabled: true, open: false, click: false },
  });
  const d = summarizeDelivery({ sent: 28, delivered: 28, measurement: m });
  const r = buildOutcomeReport({
    delivery: d, audienceSize: 28,
    observed: { loggedIn: 5, premiumPurchased: 1, revenueYen: 49800 },
  });
  const direct = r.outcomes.find((o) => o.attribution === ATTRIBUTION.DIRECT);
  assert.equal(direct.value, null, 'click 未計測なのに direct 成果を出している');
  assert.match(direct.unavailableReason, /クリック計測が無効/);
  const login = r.outcomes.find((o) => o.key === 'loggedIn');
  assert.equal(login.attribution, ATTRIBUTION.CORRELATED, 'ログインを因果と断定している');
  assert.ok(r.notes.some((n) => /効果の証明ではありません/.test(n)));
});

test('母数が極端に違うキャンペーンを率で比べさせない', () => {
  const a = { audienceSize: 28, delivery: {} };
  const b = { audienceSize: 13000, delivery: {} };
  assert.equal(canCompare(a, b).ok, false);
  assert.equal(canCompare(a, b).reason, 'audience_size_too_different');
  assert.equal(canCompare({ audienceSize: 1000, delivery: {} }, { audienceSize: 1200, delivery: {} }).ok, true);
});
