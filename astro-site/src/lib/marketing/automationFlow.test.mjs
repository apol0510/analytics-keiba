/**
 * automationFlow.test.mjs — 自動化の状態機械・冪等性・snapshot・除外を固定する
 *   node --test src/lib/marketing/automationFlow.test.mjs
 *
 * **1 通も送らない。1 レコードも書かない。** すべて純粋関数で検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOMATION_PRESETS, TRIGGER_KIND, DEFERRED_TRIGGERS,
  getAutomationPreset, listAutomationPresets, validateAutomationPresets,
} from './automationCatalog.js';
import {
  AUTOMATION_STATUS, RUN_STATE, RUN_REJECT, TERMINAL_STATUS,
  buildAutomationDefinition, buildAutomationRunId, buildOperationId, buildRecipientKey,
  canStartRun, canTransition, transition, buildRun, applyEnqueueResult, cancelRun,
  summarizeAutomation, isQuietHours, jstDateString,
} from './automationModel.js';
import {
  AUTO_SKIP, evaluateRecipient, buildAudience, matchesAudienceRule, isTriggerDue,
  computeAudienceFingerprint, compareSnapshots,
} from './automationEligibility.js';
import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const NOW = Date.parse('2026-08-06T03:00:00.000Z');      // JST 12:00
const ISO = new Date(NOW).toISOString();
const GATE_ON = { MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' };

const defOf = (id, over = {}) => ({
  ...buildAutomationDefinition({ preset: getAutomationPreset(id), overrides: {}, nowIso: ISO }),
  ...over,
});
const activeDef = (id, over = {}) => defOf(id, { status: AUTOMATION_STATUS.ACTIVE, enabled: true, ...over });

/** 期限まで d 日の会員レコード */
const customer = (email, { days = 7, plan = 'Premium', status = 'active', over = {} } = {}) => ({
  id: `rec_${email.replace(/\W/g, '')}`,
  fields: {
    Email: email,
    'プラン': plan,
    Status: status,
    '有効期限': new Date(NOW + days * 86400000).toISOString().slice(0, 10),
    ...over,
  },
});

// ── プリセット ────────────────────────────────────────────────

test('プリセットは 7 件で、すべて初期 OFF', () => {
  assert.equal(AUTOMATION_PRESETS.length, 7);
  for (const p of AUTOMATION_PRESETS) {
    assert.equal(p.enabled, false, `${p.automationId} が初期 ON になっている`);
  }
  assert.equal(validateAutomationPresets().ok, true, JSON.stringify(validateAutomationPresets().errors));
});

test('指定されたプリセットが揃っている', () => {
  const ids = AUTOMATION_PRESETS.map((p) => p.automationId);
  for (const id of ['expiry-d7', 'expiry-d0', 'comeback-d7', 'comeback-d30',
    'free-to-light', 'light-to-premium', 'manual-condition']) {
    assert.ok(ids.includes(id), `プリセット ${id} が無い`);
  }
});

test('schema に無いトリガー（誕生日）は実装せず設計候補として分離する', () => {
  const ids = AUTOMATION_PRESETS.map((p) => p.automationId);
  assert.equal(ids.includes('birthday'), false, '誕生日を実装している');
  const b = DEFERRED_TRIGGERS.find((d) => d.id === 'birthday');
  assert.ok(b, '誕生日が設計候補に無い');
  assert.equal(b.requiresSchemaChange, true);
});

test('作成直後の定義は DRAFT かつ無効', () => {
  const d = buildAutomationDefinition({ preset: getAutomationPreset('expiry-d7'), overrides: {}, nowIso: ISO });
  assert.equal(d.status, AUTOMATION_STATUS.DRAFT);
  assert.equal(d.enabled, false);
});

test('一覧は設定と影響が分かる形で返る', () => {
  const list = listAutomationPresets();
  assert.equal(list.length, 7);
  for (const k of ['automationId', 'name', 'trigger', 'campaignId', '既定']) assert.ok(k in list[0]);
});

// ── 状態機械 ──────────────────────────────────────────────────

test('許可された遷移だけを通す', () => {
  assert.equal(canTransition('DRAFT', 'ACTIVE'), true);
  assert.equal(canTransition('ACTIVE', 'PAUSED'), true);
  assert.equal(canTransition('PAUSED', 'ACTIVE'), true);
  assert.equal(canTransition('CANCELLED', 'ACTIVE'), false);
  assert.equal(canTransition('COMPLETED', 'ACTIVE'), false);
  assert.equal(canTransition('DRAFT', 'RUNNING'), false);
});

test('ACTIVE 以外へ遷移すると enabled が落ちる', () => {
  const a = transition({ definition: defOf('expiry-d7'), to: 'ACTIVE', nowIso: ISO });
  assert.equal(a.definition.enabled, true);
  const p = transition({ definition: a.definition, to: 'PAUSED', nowIso: ISO });
  assert.equal(p.definition.enabled, false);
});

test('終端状態は再実行できない', () => {
  for (const s of TERMINAL_STATUS) {
    const g = canStartRun({ env: GATE_ON, definition: activeDef('expiry-d7', { status: s }), nowMs: NOW, plannedCount: 1 });
    assert.equal(g.allowed, false, `${s} で実行できてしまう`);
  }
});

// ── 送信ゲート ────────────────────────────────────────────────

test('本番送信ゲートが閉じていれば実行しない（fail-closed）', () => {
  const g = canStartRun({ env: {}, definition: activeDef('expiry-d7'), nowMs: NOW, plannedCount: 1, dryRunSnapshot: 'x', currentSnapshot: 'x' });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, RUN_REJECT.SEND_GATE_CLOSED);
});

test('dry-run は送信ゲートに依存しない（1 通も送らないため）', () => {
  const g = canStartRun({ env: {}, definition: defOf('expiry-d7'), nowMs: NOW, dryRun: true });
  assert.equal(g.allowed, true);
});

test('DRAFT / PAUSED では本実行しない', () => {
  assert.equal(canStartRun({ env: GATE_ON, definition: defOf('expiry-d7'), nowMs: NOW, plannedCount: 1, dryRunSnapshot: 'x', currentSnapshot: 'x' }).reason, RUN_REJECT.NOT_ACTIVE);
  assert.equal(canStartRun({ env: GATE_ON, definition: defOf('expiry-d7', { status: 'PAUSED' }), nowMs: NOW, plannedCount: 1 }).reason, RUN_REJECT.PAUSED);
});

// ── 同時実行・二重実行 ────────────────────────────────────────

test('同一 run の二重開始を拒否する', () => {
  const g = canStartRun({
    env: GATE_ON, definition: activeDef('expiry-d7'), nowMs: NOW,
    runningRunId: 'auto:expiry-d7:2026-08-06', plannedCount: 1, dryRunSnapshot: 'x', currentSnapshot: 'x',
  });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, RUN_REJECT.ALREADY_RUNNING);
});

test('scheduler が重複起動しても runId は同じ（同一自動化・同一暦日）', () => {
  const a = buildAutomationRunId({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06' });
  const b = buildAutomationRunId({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06' });
  assert.equal(a, b);
  assert.notEqual(a, buildAutomationRunId({ automationId: 'expiry-d7', occurrenceDate: '2026-08-07' }));
  assert.notEqual(a, buildAutomationRunId({ automationId: 'expiry-d0', occurrenceDate: '2026-08-06' }));
  assert.equal(buildAutomationRunId({ automationId: 'x', occurrenceDate: 'bad' }), '');
});

test('同一 recipient の二重登録キーは配信回ごとに一意', () => {
  const r1 = 'auto:expiry-d7:2026-08-06';
  const k = buildRecipientKey({ automationRunId: r1, email: 'A@Example.invalid' });
  assert.equal(k, buildRecipientKey({ automationRunId: r1, email: '  a@example.invalid ' }), '大小・空白差で別キーになる');
  assert.notEqual(k, buildRecipientKey({ automationRunId: 'auto:expiry-d7:2026-08-07', email: 'a@example.invalid' }));
});

test('operationId は run と試行回数に紐づく', () => {
  const r = 'auto:expiry-d7:2026-08-06';
  assert.equal(buildOperationId({ automationRunId: r, attempt: 1 }), `${r}#001`);
  assert.notEqual(buildOperationId({ automationRunId: r, attempt: 1 }), buildOperationId({ automationRunId: r, attempt: 2 }));
});

test('すでに登録済みの相手は除外される（dispatcher 再実行で二重送信しない）', () => {
  const runId = 'auto:expiry-d7:2026-08-06';
  const key = buildRecipientKey({ automationRunId: runId, email: 'a@example.invalid' });
  const v = evaluateRecipient({
    fields: customer('a@example.invalid').fields, definition: activeDef('expiry-d7'),
    nowMs: NOW, blacklistEmails: new Set(), alreadyQueuedKeys: new Set([key]), recipientKey: key,
  });
  assert.equal(v.eligible, false);
  assert.equal(v.reason, AUTO_SKIP.ALREADY_QUEUED);
});

// ── quiet hours ───────────────────────────────────────────────

test('quiet hours は JST で判定し、日をまたぐ帯も扱える', () => {
  const q = { start: 21, end: 8 };
  assert.equal(isQuietHours({ nowMs: Date.parse('2026-08-06T03:00:00Z'), quietHours: q }), false); // JST 12:00
  assert.equal(isQuietHours({ nowMs: Date.parse('2026-08-06T13:00:00Z'), quietHours: q }), true);  // JST 22:00
  assert.equal(isQuietHours({ nowMs: Date.parse('2026-08-05T20:00:00Z'), quietHours: q }), true);  // JST 05:00
  assert.equal(isQuietHours({ nowMs: NOW, quietHours: { start: 0, end: 0 } }), false);
});

test('静音時間帯は本実行しない（dry-run は可）', () => {
  const night = Date.parse('2026-08-06T13:00:00Z');   // JST 22:00
  const d = activeDef('expiry-d7');
  assert.equal(canStartRun({ env: GATE_ON, definition: d, nowMs: night, plannedCount: 1, dryRunSnapshot: 'x', currentSnapshot: 'x' }).reason, RUN_REJECT.QUIET_HOURS);
  assert.equal(canStartRun({ env: GATE_ON, definition: d, nowMs: night, dryRun: true }).allowed, true);
});

test('JST 暦日は UTC 基準でズレない', () => {
  assert.equal(jstDateString(Date.parse('2026-08-05T15:30:00Z')), '2026-08-06');  // JST 0:30
  assert.equal(jstDateString(Date.parse('2026-08-05T14:30:00Z')), '2026-08-05');  // JST 23:30
});

// ── dry-run 必須・snapshot ────────────────────────────────────

test('dry-run 未実施なら本実行しない', () => {
  const g = canStartRun({ env: GATE_ON, definition: activeDef('expiry-d7'), nowMs: NOW, plannedCount: 1 });
  assert.equal(g.reason, RUN_REJECT.NO_DRY_RUN);
});

test('snapshot が変わっていたら止める', () => {
  const g = canStartRun({
    env: GATE_ON, definition: activeDef('expiry-d7'), nowMs: NOW,
    plannedCount: 1, dryRunSnapshot: 'aaa', currentSnapshot: 'bbb',
  });
  assert.equal(g.reason, RUN_REJECT.SNAPSHOT_MISMATCH);
});

test('snapshot 指紋はアドレスを復元できず、順序に依存しない', () => {
  const a = computeAudienceFingerprint({ automationId: 'x', occurrenceDate: '2026-08-06', campaignId: 'c', emails: ['a@e.invalid', 'b@e.invalid'] });
  const b = computeAudienceFingerprint({ automationId: 'x', occurrenceDate: '2026-08-06', campaignId: 'c', emails: ['b@e.invalid', 'A@E.invalid'] });
  assert.equal(a, b, '順序・大小で指紋が変わる');
  assert.equal(a.includes('@'), false, '指紋にアドレスが含まれている');
  assert.notEqual(a, computeAudienceFingerprint({ automationId: 'x', occurrenceDate: '2026-08-06', campaignId: 'c', emails: ['a@e.invalid'] }));
});

test('対象が増えていたら進めない / 減っていれば進める', () => {
  const grew = compareSnapshots({ dryRun: { fingerprint: 'a', count: 10 }, current: { fingerprint: 'b', count: 12 } });
  assert.equal(grew.canProceed, false);
  assert.equal(grew.grew, true);
  const shrank = compareSnapshots({ dryRun: { fingerprint: 'a', count: 10 }, current: { fingerprint: 'b', count: 8 } });
  assert.equal(shrank.canProceed, true);
  const same = compareSnapshots({ dryRun: { fingerprint: 'a', count: 10 }, current: { fingerprint: 'a', count: 10 } });
  assert.equal(same.same, true);
  assert.equal(same.canProceed, true);
});

// ── 最大件数 ──────────────────────────────────────────────────

test('最大送信件数を超えたら停止する', () => {
  const g = canStartRun({
    env: GATE_ON, definition: activeDef('expiry-d7', { maxSendsPerRun: 5 }), nowMs: NOW,
    plannedCount: 6, dryRunSnapshot: 'x', currentSnapshot: 'x',
  });
  assert.equal(g.reason, RUN_REJECT.MAX_SENDS_EXCEEDED);
  assert.equal(canStartRun({ env: GATE_ON, definition: activeDef('expiry-d7', { maxSendsPerRun: 5 }), nowMs: NOW, plannedCount: 5, dryRunSnapshot: 'x', currentSnapshot: 'x' }).allowed, true);
});

test('対象 0 件なら実行しない', () => {
  const g = canStartRun({ env: GATE_ON, definition: activeDef('expiry-d7'), nowMs: NOW, plannedCount: 0, dryRunSnapshot: 'x', currentSnapshot: 'x' });
  assert.equal(g.reason, RUN_REJECT.NOTHING_TO_SEND);
});

// ── トリガー判定 ──────────────────────────────────────────────

test('期限 N 日前 / N 日後のトリガーが JST 暦日で当たる', () => {
  const d7 = activeDef('expiry-d7');
  assert.equal(evaluateRecipient({ fields: customer('a@e.invalid', { days: 7 }).fields, definition: d7, nowMs: NOW, blacklistEmails: new Set() }).eligible, true);
  const off = evaluateRecipient({ fields: customer('a@e.invalid', { days: 6 }).fields, definition: d7, nowMs: NOW, blacklistEmails: new Set() });
  assert.equal(off.eligible, false);
  assert.equal(off.reason, AUTO_SKIP.TRIGGER_NOT_DUE);
});

test('有効期限が無ければ期限起点トリガーは評価しない', () => {
  const r = isTriggerDue({ trigger: { kind: TRIGGER_KIND.DAYS_BEFORE_EXPIRY, days: 7 }, marketing: { daysToExpiry: null } });
  assert.equal(r.due, false);
  assert.equal(r.reason, AUTO_SKIP.NO_EXPIRY);
});

test('plan_state / manual は常時 due', () => {
  for (const kind of [TRIGGER_KIND.PLAN_STATE, TRIGGER_KIND.MANUAL_CONDITION]) {
    assert.equal(isTriggerDue({ trigger: { kind }, marketing: { daysToExpiry: null } }).due, true);
  }
});

test('audienceRule は enforce のときだけ絞る', () => {
  const m = { contract: MK_CONTRACT.EXPIRED, plan: MK_PLAN.FREE };
  assert.equal(matchesAudienceRule({ rule: { enforce: false, contracts: [MK_CONTRACT.ACTIVE], plans: [] }, marketing: m }), true);
  assert.equal(matchesAudienceRule({ rule: { enforce: true, contracts: [MK_CONTRACT.ACTIVE], plans: [] }, marketing: m }), false);
  assert.equal(matchesAudienceRule({ rule: { enforce: true, contracts: [MK_CONTRACT.EXPIRED], plans: [] }, marketing: m }), true);
});

// ── 除外（既存 AK ルールを通す）────────────────────────────────

test('配信停止・バウンス・テストアカウントは既存ルールで除外される', () => {
  const d = activeDef('expiry-d7');
  const base = { days: 7 };
  // 配信停止
  const unsub = evaluateRecipient({
    fields: customer('u@e.invalid', { ...base, over: { UnsubscribedAnalyticsKeiba: true } }).fields,
    definition: d, nowMs: NOW, blacklistEmails: new Set(),
  });
  assert.equal(unsub.eligible, false);
  assert.equal(unsub.reason, AUTO_SKIP.SUPPRESSED);
  // バウンス（blacklist）
  const bounced = evaluateRecipient({
    fields: customer('b@e.invalid', base).fields, definition: d, nowMs: NOW,
    blacklistEmails: new Set(['b@e.invalid']),
  });
  assert.equal(bounced.eligible, false);
  assert.equal(bounced.reason, AUTO_SKIP.SUPPRESSED);
  // アドレス未登録
  const noEmail = evaluateRecipient({
    fields: { ...customer('x@e.invalid', base).fields, Email: '' }, definition: d, nowMs: NOW, blacklistEmails: new Set(),
  });
  assert.equal(noEmail.eligible, false);
  assert.equal(noEmail.reason, AUTO_SKIP.SUPPRESSED);
});

test('配信前に有料化した対象は案内から外れる（Free 向け案内）', () => {
  const d = activeDef('free-to-light');
  const free = evaluateRecipient({ fields: { Email: 'f@e.invalid', 'プラン': 'Free' }, definition: d, nowMs: NOW, blacklistEmails: new Set() });
  assert.equal(free.eligible, true);
  const paid = evaluateRecipient({ fields: customer('f@e.invalid', { days: 30, plan: 'Premium' }).fields, definition: d, nowMs: NOW, blacklistEmails: new Set() });
  assert.equal(paid.eligible, false);
  assert.equal(paid.reason, AUTO_SKIP.AUDIENCE_MISMATCH);
});

test('直近に送っていれば再送しない', () => {
  const d = activeDef('expiry-d7', { minResendIntervalDays: 30 });
  const v = evaluateRecipient({
    fields: customer('r@e.invalid', { days: 7 }).fields, definition: d, nowMs: NOW,
    blacklistEmails: new Set(), history: { lastSentAtMs: NOW - 5 * 86400000, sentCount: 1 },
  });
  assert.equal(v.eligible, false);
  assert.equal(v.reason, AUTO_SKIP.RECENTLY_SENT);
});

test('対象集合は件数と除外理由だけを返す（PII を持ち出さない）', () => {
  const runId = 'auto:expiry-d7:2026-08-06';
  const records = [
    customer('ok1@e.invalid', { days: 7 }),
    customer('ok2@e.invalid', { days: 7 }),
    customer('ng@e.invalid', { days: 3 }),
    customer('stop@e.invalid', { days: 7, over: { UnsubscribedAnalyticsKeiba: true } }),
  ];
  const out = buildAudience({
    records, definition: activeDef('expiry-d7'), nowMs: NOW, blacklistEmails: new Set(),
    buildKey: (email) => buildRecipientKey({ automationRunId: runId, email }),
  });
  assert.equal(out.counts.母数, 4);
  assert.equal(out.counts.対象, 2);
  assert.equal(out.skipped[AUTO_SKIP.TRIGGER_NOT_DUE], 1);
  assert.equal(out.skipped[AUTO_SKIP.SUPPRESSED], 1);
  assert.ok(out.recipients.every((r) => r.recipientKey.startsWith(runId)));
});

// ── run の結果反映・取消 ──────────────────────────────────────

test('一部キュー登録失敗は PARTIAL になる', () => {
  const run = buildRun({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06', snapshot: 'fp', plannedCount: 10, nowIso: ISO });
  const after = applyEnqueueResult({ run, result: { attempted: 10, enqueued: 8, failed: 2, skipped: 0 }, nowIso: ISO });
  assert.equal(after.state, RUN_STATE.PARTIAL);
  assert.equal(after.enqueued, 8);
  assert.equal(after.failed, 2);
});

test('全件失敗は FAILED、全件成功は ENQUEUED', () => {
  const run = buildRun({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06', snapshot: 'fp', plannedCount: 3, nowIso: ISO });
  assert.equal(applyEnqueueResult({ run, result: { attempted: 3, enqueued: 0, failed: 3 }, nowIso: ISO }).state, RUN_STATE.FAILED);
  assert.equal(applyEnqueueResult({ run, result: { attempted: 3, enqueued: 3, failed: 0 }, nowIso: ISO }).state, RUN_STATE.ENQUEUED);
});

test('取消は未送信だけ。送信済みの件数は残る', () => {
  const run = buildRun({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06', snapshot: 'fp', plannedCount: 10, nowIso: ISO });
  const sent = applyEnqueueResult({ run, result: { attempted: 10, enqueued: 10, failed: 0 }, nowIso: ISO });
  const c = cancelRun({ run: sent, nowIso: ISO });
  assert.equal(c.state, RUN_STATE.CANCELLED);
  assert.equal(c.enqueued, 10, '送信済みの件数が消えた');
  assert.match(c.cancelNote, /送信済み（SENT）は取り消せません/);
});

test('成功した登録を失敗へ巻き戻さない', () => {
  const run = buildRun({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06', snapshot: 'fp', plannedCount: 5, nowIso: ISO });
  const a = applyEnqueueResult({ run, result: { attempted: 3, enqueued: 3, failed: 0 }, nowIso: ISO });
  const b = applyEnqueueResult({ run: a, result: { attempted: 2, enqueued: 0, failed: 2 }, nowIso: ISO });
  assert.equal(b.enqueued, 3, '成功済みが減っている');
  assert.equal(b.state, RUN_STATE.PARTIAL);
});

test('画面まとめに必要な項目が揃う', () => {
  const run = buildRun({ automationId: 'expiry-d7', occurrenceDate: '2026-08-06', snapshot: 'fp', plannedCount: 10, nowIso: ISO });
  const done = applyEnqueueResult({ run, result: { attempted: 10, enqueued: 9, failed: 1, skipped: 3, skipReasons: { suppressed: 3 } }, nowIso: ISO });
  const s = summarizeAutomation({ definition: activeDef('expiry-d7'), lastRun: done, plannedCount: 10, nextRunAt: '2026-08-07T00:00:00+09:00' });
  for (const k of ['automationId', 'name', 'status', '有効', '次回実行日時', '対象予定人数',
    '前回実行', 'quietHours', '最大送信件数', 'dry-run必須', '再実行可能']) {
    assert.ok(k in s, `${k} が無い`);
  }
  assert.equal(s.前回実行.送信済み, 9);
  assert.equal(s.前回実行.失敗, 1);
  assert.deepEqual(s.前回実行.除外理由, { suppressed: 3 });
});
