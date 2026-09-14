/**
 * fullAutoOperation.test.mjs — **マーケメールは完全自動運用**（2026-09-14 MK 確定）を機械で固定する
 *   node --test src/lib/marketing/fullAutoOperation.test.mjs
 *
 * ## この確定仕様が言っていること
 *
 * 通常運用で、次のいずれも**要求してはいけない**:
 *
 *   - 配信ごと / step ごと / 毎日の承認
 *   - 毎日の env 変更（`MARKETING_SEQUENCE_ARMED=<今日の日付>` の貼り替え）
 *   - 配信前の env 開放と、配信後の再閉鎖
 *   - 配信ごとの redeploy
 *   - step2 / step3 を管理画面から手で enqueue すること
 *
 * 一度有効にしたらその状態を保ち、cron が
 * 「対象判定 → due 判定 → 除外 → enqueue → dispatch → 送信 → 台帳 → 次 step」まで進める。
 *
 * ## それでも絶対に守るもの（ここでも固定する）
 *
 *   DeliveryKey の冪等性 / 二重送信防止 / 購入済み除外 / 配信停止・バウンス除外 /
 *   契約状態 unknown は fail closed / 期間外は送らない / 1 tick で同じ人へ 2 通送らない /
 *   途中までしか送れなかったぶんは次 tick へ継続 / 走査カーソル失効からの自動復帰 /
 *   メール送信処理は Customers・課金・権限を書かない
 *
 * ⚠️ ここは**判定の単一源をそのまま呼ぶ**。テストのためだけの別実装を作らない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  readSequenceGates, planSequenceTick, SEQUENCE_ENV, TICK_ABORT,
} from './sequenceAutomation.js';
import { buildSequenceProgress, SEQ_STATUS } from './sequenceProgress.js';
import { resolveSequenceStep, isSequenceCampaign } from './campaignSequence.js';
import { computeCampaignDeliveryKey, buildDeliveryRecords, jstDateString } from './campaignSend.js';
import {
  resolveCustomerMarketing, MK_CONTRACT, MK_PLAN, MK_UNSUBSCRIBE_FIELD,
} from './customerMarketingAudience.js';
import { listCampaigns, getCampaign } from './campaignCatalog.js';
import { tickRollout, TICK_ACTION } from './rolloutOrchestrator.js';
import { ROLLOUT_BLOCK } from './rolloutPlan.js';
import {
  nextScanCursor, shouldResetCursorOnFailure, cursorAfterFailure,
} from './sequenceLedgerScan.js';
import { planAutoDispatch, AUTO_DISPATCH_SKIP } from './autoDispatchPlan.js';
import { CAMPAIGN_WINDOW } from '../promotions/campaignOffers.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 14, 3, 0);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 3,
  subject: `件名${n}`, preheader: `p${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
});
const CAMPAIGN = Object.freeze({
  campaignId: 'seq-full-auto', version: 1, name: 'テスト',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true, sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

function customer(email, over = {}) {
  const fields = { Email: email, Status: 'active', ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}
function delivered(email, n, atMs = NOW - 10 * DAY, status = 'sent') {
  const key = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
  });
  return {
    fields: {
      EmailType: 'campaign', DeliveryKey: key, RecipientEmail: email,
      Status: status, SentAt: new Date(atMs).toISOString(),
    },
  };
}
const progressOf = (selected, deliveries, extra = {}) => buildSequenceProgress({
  campaign: CAMPAIGN, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(), ...extra,
});

/** 通常運用の env（**日付 ARM を置かない**のが正しい姿） */
const AUTO_ENV = Object.freeze({
  [SEQUENCE_ENV.SCHEDULER]: 'true',
  [SEQUENCE_ENV.ENQUEUE]: 'true',
  [SEQUENCE_ENV.DISPATCH]: 'true',
});

// ── ① ARMED 未設定で日をまたいで継続する ─────────────────────────────
test('【確定仕様】ARMED を置かなくても動き、日をまたいでも動き続ける', () => {
  const days = [
    Date.UTC(2026, 8, 14, 3, 0),
    Date.UTC(2026, 8, 15, 3, 0),
    Date.UTC(2026, 8, 16, 15, 0),   // JST では翌日
    Date.UTC(2026, 9, 1, 3, 0),
  ];
  for (const ms of days) {
    const g = readSequenceGates(AUTO_ENV, ms);
    assert.equal(g.allOpen, true, `${new Date(ms).toISOString()} で閉じている`);
    assert.equal(g.armMode, 'always', '常時武装になっていない');
    assert.deepEqual(g.missing, [], `閉じている env がある: ${g.missing.join(',')}`);
  }
});

test('【確定仕様】昨日の日付が置き去りになっていても、翌日に黙って止まらない…とは言わない', () => {
  // 日付運用を選んだときは従来どおり「その日だけ」。**既定が自動**であることが要件で、
  // 日付運用そのものを壊してはいない（異常時の絞り込みに使える）。
  const yesterday = jstDateString(NOW - DAY);
  const g = readSequenceGates({ ...AUTO_ENV, [SEQUENCE_ENV.ARMED]: yesterday }, NOW);
  assert.equal(g.allOpen, false, '日付を置いたのに翌日も開いている');
  assert.equal(g.armMode, 'dated');
  // ただし**既定（未設定）は開いている**ことを同時に確かめる（これが通常運用）
  assert.equal(readSequenceGates(AUTO_ENV, NOW).allOpen, true);
});

test('【確定仕様】止める手段は残っている（scheduler / dispatch を落とせば即止まる）', () => {
  assert.equal(readSequenceGates({ ...AUTO_ENV, [SEQUENCE_ENV.SCHEDULER]: 'false' }, NOW).allOpen, false);
  assert.equal(readSequenceGates({ ...AUTO_ENV, [SEQUENCE_ENV.DISPATCH]: 'false' }, NOW).allOpen, false);
  assert.equal(readSequenceGates({ ...AUTO_ENV, [SEQUENCE_ENV.ENQUEUE]: 'false' }, NOW).allOpen, false);
});

// ── ② 3 つの割引キャンペーンが全部自動進行の対象になる ─────────────────
test('【確定仕様】割引 3 本すべてが自動進行の対象（env で 1 本に絞らなくても回る）', async () => {
  const { resolveTickCampaignIds } = await import('../../../netlify/functions/cron-campaign-sequence.js');
  const ids = resolveTickCampaignIds({});          // env 指定なし = 既定の自動運用
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    const c = getCampaign(id, { includeDisabled: true });
    assert.ok(c, `${id} がカタログに無い`);
    assert.equal(isSequenceCampaign(c), true, `${id} が連続配信になっていない`);
    // 期間内なら必ず自動進行の対象に入る（期間外は `getCampaign` が null を返して送れない）
    if (getCampaign(id)) assert.ok(ids.includes(id), `${id} が自動進行の対象から外れている`);
  }
});

test('【確定仕様】人数が少ないことを理由に手動 enqueue を残さない（light / premium も同じ経路）', async () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
    'utf8',
  );
  // env 指定が無いときはカタログの有効な連続配信を**全部**回す実装であること
  assert.match(src, /listCampaigns\(\{ includeDisabled: false \}\)/);
  assert.match(src, /\.filter\(\(c\) => c\.usable !== false && c\.sequence\)/);
  // 1 本しか回さない旧実装へ戻していないこと
  assert.doesNotMatch(src, /MARKETING_SEQUENCE_CAMPAIGN_ID \|\| ''\s*\)\.trim\(\);\s*\n\s*return \[id\]/);
});

// ── ③ step1 既送信者へ step1 を送り直さない ──────────────────────────
test('【安全装置】step1 を受け取った人へ step1 を積み直さない', () => {
  const selected = [customer('a@example.com')];
  const p = progressOf(selected, [delivered('a@example.com', 1)]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(AUTO_ENV, NOW) });
  assert.equal(plan.ok, true);
  assert.notEqual(plan.step, 1, 'step1 を積み直そうとしている');
  assert.equal(plan.step, 2);
});

// ── ④ step2 が自動で積まれる ────────────────────────────────────────
test('【確定仕様】step1 受領者の step2 は人が押さなくても積まれる', () => {
  const selected = ['a@example.com', 'b@example.com'].map((e) => customer(e));
  const p = progressOf(selected, selected.map((c) => delivered(c.fields.Email, 1)));
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(AUTO_ENV, NOW) });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 2);
  assert.equal(plan.recipients, 2);
});

// ── ⑤ step3 も自動で続く ────────────────────────────────────────────
test('【確定仕様】step2 受領者の step3 も自動で続く（間隔が来たら次の tick で進む）', () => {
  const email = 'a@example.com';
  const selected = [customer(email)];
  const p = progressOf(selected, [
    delivered(email, 1, NOW - 10 * DAY), delivered(email, 2, NOW - 5 * DAY),
  ]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(AUTO_ENV, NOW) });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 3);
});

test('【安全装置】間隔が来ていない人は進めない（早回ししない）', () => {
  const email = 'a@example.com';
  const selected = [customer(email)];
  const p = progressOf(selected, [
    delivered(email, 1, NOW - 10 * DAY), delivered(email, 2, NOW - 1 * DAY),
  ]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(AUTO_ENV, NOW) });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.NO_DUE);
});

// ── ⑥ 1 tick で同じ人へ複数 step を送らない ────────────────────────
test('【安全装置】1 tick で進むのは 1 step だけ（同じ人に 2 通同時に行かない）', () => {
  const selected = [customer('a@example.com'), customer('b@example.com')];
  const p = progressOf(selected, [
    delivered('a@example.com', 1, NOW - 10 * DAY),                          // → step2 が due
    delivered('b@example.com', 1, NOW - 20 * DAY), delivered('b@example.com', 2, NOW - 10 * DAY), // → step3 が due
  ]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(AUTO_ENV, NOW) });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 2, '最小の due step 以外を混ぜている');
  assert.equal(plan.recipients, 1, '別 step の人まで同じ tick に混ぜている');
});

// ── ⑦ partial は切り捨てず次 tick へ ────────────────────────────────
test('【安全装置】上限を超えたぶんは捨てずに次 tick へ持ち越す', () => {
  const selected = Array.from({ length: 7 }, (_, i) => customer(`u${i}@example.com`));
  const p = progressOf(selected, selected.map((c) => delivered(c.fields.Email, 1)));
  const plan = planSequenceTick({
    progress: p, gates: readSequenceGates(AUTO_ENV, NOW), maxRecipients: 3,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.recipients, 3);
  assert.equal(plan.carriedOver, 4, '残りを数えていない（黙って捨てている）');
  assert.equal(plan.dueTotal, 7);
});

// ── ⑧ 購入済み除外 ──────────────────────────────────────────────────
test('【安全装置】購入した人は自動配信から外れる', () => {
  const email = 'buyer@example.com';
  const bought = customer(email, { プラン: 'Premium', PlanType: 'Annual', 有効期限: '2099-01-01' });
  const p = progressOf([bought], [delivered(email, 1)]);
  const row = p.rows.find((r) => r.email === email);
  assert.ok(row, '対象行が無い');
  assert.notEqual(row.status, SEQ_STATUS.DUE, '購入者が due のままになっている');
});

// ── ⑨ suppression（配信停止・バウンス）除外 ────────────────────────
test('【安全装置】配信基盤の停止リストに載っている人は外れる', () => {
  const email = 'bounced@example.com';
  const p = progressOf([customer(email)], [delivered(email, 1)], {
    providerSuppressed: new Set([email]),
  });
  const row = p.rows.find((r) => r.email === email);
  assert.ok(row);
  assert.notEqual(row.status, SEQ_STATUS.DUE, '停止リストの相手が due のまま');
});

test('【安全装置】配信停止（unsubscribe）した人は外れる', () => {
  const email = 'unsub@example.com';
  const mk = resolveCustomerMarketing({
    fields: { Email: email, Status: 'active', [MK_UNSUBSCRIBE_FIELD]: true }, nowMs: NOW,
  });
  assert.equal(mk.sendable, false, '配信停止なのに送れることになっている');
  assert.ok(mk.suppressionReasons.includes('unsubscribed'));
  const p = progressOf([customer(email, { [MK_UNSUBSCRIBE_FIELD]: true })], [delivered(email, 1)]);
  const row = p.rows.find((r) => r.email === email);
  if (row) assert.notEqual(row.status, SEQ_STATUS.DUE, '配信停止の相手が due のまま');
});

// ── ⑩ 契約状態が分からない相手は fail closed ───────────────────────
test('【安全装置】契約状態を判断できない相手へは送らない（fail closed）', () => {
  // アドレスが読めない＝その人の状態を確かめられない。**送れない側**へ倒れること
  const unknown = resolveCustomerMarketing({ fields: { Email: '' }, nowMs: NOW });
  assert.equal(unknown.sendable, false, '状態を確かめられない相手が送信可になっている');
  assert.ok(unknown.suppressionReasons.length > 0, '理由を残さずに送信不可にしている');
  // 進行にも載らない（載ると due として数えられてしまう）
  const broken = { recordId: 'rec-broken', fields: { Email: '' }, marketing: unknown };
  const p = progressOf([broken], []);
  assert.ok(!p.rows.some((r) => r.status === SEQ_STATUS.DUE), 'アドレス不明の行が due になっている');
});

// ── ⑪ キャンペーン期間外は送らない（終了後は自動停止） ────────────
test('【安全装置】期間が終わったら送る手段そのものが消える（自動停止）', (t) => {
  const endsAt = Date.parse(CAMPAIGN_WINDOW.endsAtIso);
  t.mock.timers.enable({ apis: ['Date'], now: endsAt - 1 });
  assert.ok(getCampaign('campaign-discount-free'), '期間内なのに使えない');
  t.mock.timers.setTime(endsAt);
  assert.equal(getCampaign('campaign-discount-free'), null, '終了ちょうどでも有効なまま');
  t.mock.timers.setTime(endsAt + 7 * DAY);
  assert.equal(getCampaign('campaign-discount-free'), null, '期間後も有効なまま');
});

// ── ⑫ kill で即停止 / 解除後は未送信ぶんから再開 ────────────────────
test('【確定仕様】異常時の kill は即停止（他のすべてに優先する）', () => {
  const out = tickRollout({
    state: { killed: true, stage: 'running' },
    nowMs: NOW,
    envEnabled: true,
    facts: { remainingCandidates: 100, grantedPendingQueue: 10, pendingJobs: 2, outstandingStep1: 0 },
    env: {},
  });
  assert.equal(out.action, TICK_ACTION.SKIP);
  assert.equal(out.reason, ROLLOUT_BLOCK.KILLED);
});

test('【確定仕様】kill を解除すれば、未送信ぶんから再開する（最初からやり直さない）', () => {
  const facts = { remainingCandidates: 100, grantedPendingQueue: 10, pendingJobs: 2, outstandingStep1: 0 };
  // 通常運用の env（工程ごとの許可は開いたまま保つ）
  const env = {
    MARKETING_ROLLOUT_ENABLED: 'true',
    MARKETING_CAMPAIGN_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
    COMEBACK_GRANT_FIELDS_READY: '1',
    COMEBACK_GRANT_ENABLED: 'true',
    LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  };
  const killed = tickRollout({ state: { killed: true, stage: 'running' }, nowMs: NOW, envEnabled: true, facts, env });
  const resumed = tickRollout({ state: { killed: false, stage: 'running', alwaysArmed: true }, nowMs: NOW, envEnabled: true, facts, env });
  assert.equal(killed.action, TICK_ACTION.SKIP);
  assert.notEqual(resumed.action, TICK_ACTION.SKIP, 'kill を外しても止まったまま');
  // 再開して最初にやるのは「積み残しの処理」であって、新規付与ではない
  assert.ok([TICK_ACTION.QUEUE, TICK_ACTION.DISPATCH, TICK_ACTION.FOLLOW_UP, TICK_ACTION.SETTLE, TICK_ACTION.GRANT]
    .includes(resumed.action), `想定外の action: ${resumed.action}`);
});

// ── ⑬ 走査カーソルの失効から自動復帰 ────────────────────────────────
test('【安全装置】走査カーソルが失効したら先頭から読み直す（人手を要求しない）', () => {
  assert.equal(shouldResetCursorOnFailure({ status: 422, hadOffset: true }), true);
  const after = cursorAfterFailure({ pass: 15 });
  assert.equal(after.offset, null, '失効した offset を持ち続けている');
  assert.equal(after.pass, 15, '周回数まで巻き戻している');
  // 5xx（相手側の一時障害）はカーソルを捨てない
  assert.equal(shouldResetCursorOnFailure({ status: 503, hadOffset: true }), false);
  // offset を持っていなければ、そもそも捨てるものが無い
  assert.equal(shouldResetCursorOnFailure({ status: 422, hadOffset: false }), false);
});

test('【安全装置】読み切ったらカーソルを畳み、次の周回を先頭から始める', () => {
  const mid = nextScanCursor({ offset: 'abc', pass: 3 });
  assert.equal(mid.offset, 'abc');
  assert.equal(mid.completedPass, false);
  const done = nextScanCursor({ offset: null, pass: 3 });
  assert.equal(done.offset, null);
  assert.equal(done.pass, 4, '読み切ったのに周回数が進んでいない');
  assert.equal(done.completedPass, true);
});

// ── ⑭ duplicate 0（同じ人・同じ step の鍵は 1 つ） ─────────────────
test('【安全装置】DeliveryKey は 受信者 × step で一意（同じ人へ同じ通を二度作らない）', () => {
  const email = 'a@example.com';
  const k2a = computeCampaignDeliveryKey({ campaign: resolveSequenceStep(CAMPAIGN, 2), recipientEmail: email, brand: BRAND, fromEmail: FROM });
  const k2b = computeCampaignDeliveryKey({ campaign: resolveSequenceStep(CAMPAIGN, 2), recipientEmail: email, brand: BRAND, fromEmail: FROM });
  const k3 = computeCampaignDeliveryKey({ campaign: resolveSequenceStep(CAMPAIGN, 3), recipientEmail: email, brand: BRAND, fromEmail: FROM });
  assert.equal(k2a, k2b, '同じ通なのに鍵が変わる（＝二重送信の芽）');
  assert.notEqual(k2a, k3, 'step が違うのに同じ鍵');
});

test('【安全装置】queued の行がある人は「既に積んである」として扱う（sent と同じ扱い）', () => {
  const email = 'a@example.com';
  const p = progressOf([customer(email)], [
    delivered(email, 1, NOW - 10 * DAY),
    delivered(email, 2, NOW - 1000, 'queued'),      // 積んだばかり
  ]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(AUTO_ENV, NOW) });
  assert.equal(plan.ok, false, 'queued 済みの人をもう一度積もうとしている');
});

// ── ⑮ 配信行に JobId が無い行を作らない（2026-09 の本番障害） ────────
test('【重要】`jobIdByEmail` に文字列を渡したら配信行を作らない（JobId 欠落行を作らせない）', () => {
  const recipients = [{ email: 'a@example.com', deliveryKey: 'k'.repeat(64), recordId: 'recAAAAAAAAAAAAAA' }];
  const wrong = buildDeliveryRecords({
    campaign: resolveSequenceStep(CAMPAIGN, 2),
    recipients,
    jobIdByEmail: new Map([['a@example.com', 'mkt-seq-full-auto-v1-abc-1']]),   // ← 旧実装の形
    nowMs: NOW,
  });
  assert.equal(wrong.length, 0, '形が違うのに行を作っている（JobId 欠落行が生まれる）');

  const right = buildDeliveryRecords({
    campaign: resolveSequenceStep(CAMPAIGN, 2),
    recipients,
    jobIdByEmail: new Map([['a@example.com', { jobId: 'mkt-seq-full-auto-v1-abc-1', recordId: 'recBBBBBBBBBBBBBB' }]]),
    nowMs: NOW,
  });
  assert.equal(right.length, 1);
  assert.equal(right[0].fields.ScheduledEmailJobId, 'mkt-seq-full-auto-v1-abc-1');
  assert.equal(right[0].fields.ScheduledEmailRecordId, 'recBBBBBBBBBBBBBB');
});

// ── ⑯ 積んだら送る（自動 dispatch が存在する） ──────────────────────
test('【確定仕様】積まれた PENDING ジョブを起動する自動経路がある', () => {
  const rows = [
    { id: 'rec1', fields: { JobId: 'mkt-a-1', Status: 'PENDING', ScheduledFor: '2026-09-10T00:00:00.000Z', TargetPlan: 'campaign:x', Notes: '' } },
    { id: 'rec2', fields: { JobId: 'mkt-a-2', Status: 'PENDING', ScheduledFor: '2026-09-09T00:00:00.000Z', TargetPlan: 'campaign:x', Notes: '' } },
  ];
  const plan = planAutoDispatch({ jobs: rows, maxJobs: 10, nowMs: NOW });
  assert.equal(plan.start.length, 2);
  assert.equal(plan.start[0].jobId, 'mkt-a-2', '古いものから起動していない');
});

test('【安全装置】`queue:unverified` のジョブは自動でも起動しない', () => {
  const rows = [{
    id: 'rec1',
    fields: { JobId: 'mkt-a-1', Status: 'PENDING', ScheduledFor: '2026-09-10T00:00:00.000Z', TargetPlan: 'campaign:x', Notes: 'content:abc queue:unverified' },
  }];
  const plan = planAutoDispatch({ jobs: rows, maxJobs: 10, nowMs: NOW });
  assert.equal(plan.start.length, 0);
  assert.equal(plan.skipped[0].reason, AUTO_DISPATCH_SKIP.UNVERIFIED);
});

test('【安全装置】マーケ以外のジョブには触らない', () => {
  const rows = [{
    id: 'rec1',
    fields: { JobId: 'newsletter-1', Status: 'PENDING', ScheduledFor: '2026-09-10T00:00:00.000Z', TargetPlan: 'all', CreatedBy: 'cron-email-scheduler' },
  }];
  const plan = planAutoDispatch({ jobs: rows, maxJobs: 10, nowMs: NOW });
  assert.equal(plan.start.length, 0);
  assert.equal(plan.skipped[0].reason, AUTO_DISPATCH_SKIP.NOT_MARKETING);
});

// ── ⑰ メール送信処理は Customers・課金・権限を書かない ──────────────
test('【安全装置】送信系 cron は Customers / 課金 / 権限を書かない', () => {
  const files = [
    '../../../netlify/functions/cron-campaign-sequence.js',
    '../../../netlify/functions/cron-marketing-dispatch.js',
  ];
  for (const rel of files) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /encodeURIComponent\(CUSTOMERS_TABLE\)[^\n]*\n[^\n]*method: 'PATCH'/,
      `${rel} が Customers を PATCH している`);
    for (const field of ['プラン', 'PlanType', 'LifetimeSanrenpuku', '有効期限']) {
      assert.doesNotMatch(src, new RegExp(`fields:[^\\n]*${field}`), `${rel} が ${field} を書いている`);
    }
  }
});
