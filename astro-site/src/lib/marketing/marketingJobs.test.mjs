/**
 * marketingJobs.test.mjs — 送信ジョブの状況表示と取消
 *
 * 送信は取り返しがつかない。**送った事実を取り消せてしまう**実装や、
 * 取消のつもりで送信済みを書き換える実装は、記録を壊す。
 * 「PENDING だけ取り消せる」「sent には触れない」「同じ取消は 2 回書かない」を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJobView,
  buildJobRow,
  canCancelJob,
  buildJobCancelFields,
  buildDeliveryCancelFields,
  isAlreadyCancelledBy,
  selectCancelableDeliveries,
  assertOnlyCancelFields,
  parseJobCampaign,
  JOB_STATUS,
  DELIVERY_STATUS,
  CANCEL_REJECT,
  JOB_CANCEL_WRITABLE_FIELDS,
  DELIVERY_CANCEL_WRITABLE_FIELDS,
} from './marketingJobs.js';

const JOB_ID = 'mkt-expired-comeback-v2-abc12345-1';
const job = (over = {}) => ({
  id: 'recJOB0000000001',
  fields: {
    JobId: JOB_ID,
    Status: JOB_STATUS.PENDING,
    ScheduledFor: '2026-08-02T00:00:00.000Z',
    RecipientCount: 3,
    TargetPlan: 'campaign:expired-comeback',
    Notes: 'marketing campaign expired-comeback v2',
    CreatedBy: 'admin-marketing',
    ...over,
  },
});

const delivery = (status, over = {}) => ({
  id: 'recDEL' + Math.random().toString(36).slice(2, 13).padEnd(11, '0'),
  fields: {
    ScheduledEmailJobId: JOB_ID,
    EmailType: 'campaign',
    CampaignType: 'expired-comeback:v2',
    Status: status,
    QueuedAt: '2026-08-02T00:00:00.000Z',
    ...over,
  },
});

// ── 状況表示 ────────────────────────────────────────────────
test('ジョブ表示: 件数は配信行（1 通ごとの正本）から数える', () => {
  const row = buildJobRow({
    job: job(),
    deliveries: [
      delivery(DELIVERY_STATUS.QUEUED),
      delivery(DELIVERY_STATUS.SENT, { SentAt: '2026-08-02T01:00:00.000Z' }),
      delivery(DELIVERY_STATUS.FAILED, { ErrorMessage: 'send_failed' }),
      delivery('skipped-blacklist', { ErrorMessage: 'provider_suppressed' }),
      delivery(DELIVERY_STATUS.QUEUED, { ScheduledEmailJobId: 'other-job' }), // 別ジョブ
    ],
  });
  assert.deepEqual(row.counts, { queued: 1, sent: 1, failed: 1, skipped: 1, cancelled: 0 });
  assert.equal(row.campaignId, 'expired-comeback');
  assert.equal(row.version, '2');
  assert.equal(row.status, JOB_STATUS.PENDING);
  assert.equal(row.cancelable, true);
});

test('ジョブ表示: 失敗・スキップの理由を分類として数える（アドレスは持たない）', () => {
  const row = buildJobRow({
    job: job(),
    deliveries: [
      delivery(DELIVERY_STATUS.FAILED, { ErrorMessage: 'send_failed' }),
      delivery(DELIVERY_STATUS.FAILED, { ErrorMessage: 'send_failed' }),
      delivery('skipped-unsubscribed', { ErrorMessage: 'unsubscribed' }),
    ],
  });
  assert.deepEqual(row.errorReasons, { send_failed: 2, unsubscribed: 1 });
  assert.equal(JSON.stringify(row).includes('@'), false, '表示用データにアドレスが混ざっている');
});

test('ジョブ一覧: マーケティングジョブ以外を出さない', () => {
  const rows = buildJobView({
    jobRecords: [job(), job({ JobId: 'newsletter-1', CreatedBy: 'cron-email-scheduler' })],
    deliveryRecords: [],
    isMarketingJob: (f) => String(f.CreatedBy || '') === 'admin-marketing',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, JOB_ID);
});

test('parseJobCampaign: TargetPlan と Notes から campaign と version を取り出す', () => {
  assert.deepEqual(parseJobCampaign({ TargetPlan: 'campaign:premium-renewal', Notes: 'marketing campaign premium-renewal v3' }),
    { campaignId: 'premium-renewal', version: '3', contentHash: '', contentEdited: false });
  assert.deepEqual(parseJobCampaign({}), { campaignId: '', version: '', contentHash: '', contentEdited: false });
});

test('parseJobCampaign: 何を送ったかの内容 hash を Notes から読む', () => {
  const withHash = parseJobCampaign({
    TargetPlan: 'campaign:expired-comeback',
    Notes: 'marketing campaign expired-comeback v2 content:0123456789ab edited',
  });
  assert.equal(withHash.contentHash, '0123456789ab');
  assert.equal(withHash.contentEdited, true, '編集した文面であることを記録できていない');
});

// ── 取消の可否 ──────────────────────────────────────────────
test('PENDING だけ取り消せる', () => {
  assert.deepEqual(canCancelJob(job()), { ok: true });
});

for (const [status, reason] of [
  [JOB_STATUS.SENT, CANCEL_REJECT.ALREADY_SENT],
  [JOB_STATUS.FAILED, CANCEL_REJECT.ALREADY_FAILED],
  [JOB_STATUS.CANCELLED, CANCEL_REJECT.ALREADY_CANCELLED],
]) {
  test(`${status} は取り消せない（送信済みの事実を消さない）`, () => {
    assert.deepEqual(canCancelJob(job({ Status: status })), { ok: false, reason });
  });
}

test('ジョブが無ければ取り消せない', () => {
  assert.deepEqual(canCancelJob(null), { ok: false, reason: CANCEL_REJECT.NOT_FOUND });
});

test('取消不可のジョブは一覧でも cancelable=false と理由を出す', () => {
  const row = buildJobRow({ job: job({ Status: JOB_STATUS.SENT }), deliveries: [] });
  assert.equal(row.cancelable, false);
  assert.equal(row.cancelReason, CANCEL_REJECT.ALREADY_SENT);
});

// ── 取消の書き込み内容 ──────────────────────────────────────
test('取消は queued の配信行だけを対象にする（sent には触れない）', () => {
  const rows = [
    delivery(DELIVERY_STATUS.QUEUED),
    delivery(DELIVERY_STATUS.SENT),
    delivery(DELIVERY_STATUS.FAILED),
    delivery(DELIVERY_STATUS.QUEUED, { ScheduledEmailJobId: 'other' }),
  ];
  const targets = selectCancelableDeliveries({ jobId: JOB_ID, deliveryRecords: rows });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].fields.Status, DELIVERY_STATUS.QUEUED);
});

test('operationId が無い取消は組み立てない（再実行を判別できないため）', () => {
  assert.equal(buildJobCancelFields({ nowMs: 1 }), null);
  assert.equal(buildDeliveryCancelFields({ nowMs: 1 }), null);
});

test('取消で書く列は allow-list の中だけ', () => {
  const jf = buildJobCancelFields({ operationId: 'op-1', nowMs: Date.parse('2026-08-02T02:00:00Z') });
  assert.equal(assertOnlyCancelFields(jf, JOB_CANCEL_WRITABLE_FIELDS), true);
  assert.equal(jf.Status, JOB_STATUS.CANCELLED);
  assert.match(jf.Notes, /op=op-1/);

  const df = buildDeliveryCancelFields({ operationId: 'op-1', nowMs: Date.parse('2026-08-02T02:00:00Z') });
  assert.equal(assertOnlyCancelFields(df, DELIVERY_CANCEL_WRITABLE_FIELDS), true);
  assert.equal(df.Status, DELIVERY_STATUS.CANCELLED);

  // 契約・課金・決済メールの列は allow-list に含まれない
  for (const banned of ['プラン', 'PlanType', 'PaymentEmailStatus', 'Email']) {
    assert.equal(JOB_CANCEL_WRITABLE_FIELDS.includes(banned), false);
    assert.equal(DELIVERY_CANCEL_WRITABLE_FIELDS.includes(banned), false);
  }
  assert.equal(assertOnlyCancelFields({ Status: 'CANCELLED', プラン: 'Free' }, JOB_CANCEL_WRITABLE_FIELDS), false);
});

test('取消は既存 Notes を消さずに追記する（記録を失わない）', () => {
  const jf = buildJobCancelFields({ operationId: 'op-2', nowMs: 1, previousNotes: 'marketing campaign x v1' });
  assert.match(jf.Notes, /marketing campaign x v1/);
  assert.match(jf.Notes, /op=op-2/);
});

// ── 冪等性 ──────────────────────────────────────────────────
test('同じ operationId の取消は「実施済み」と判定する（2 回書かない）', () => {
  const cancelled = job({ Status: JOB_STATUS.CANCELLED, Notes: 'x / cancelled by admin-marketing op=op-9' });
  assert.equal(isAlreadyCancelledBy({ job: cancelled, operationId: 'op-9' }), true);
  assert.equal(isAlreadyCancelledBy({ job: cancelled, operationId: 'op-other' }), false);
  // PENDING のままなら「実施済み」ではない
  assert.equal(isAlreadyCancelledBy({ job: job(), operationId: 'op-9' }), false);
});
