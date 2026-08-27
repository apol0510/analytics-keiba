/**
 * prospectSequenceParity.test.mjs — **移行しても 8/31・9/6 の配信が変わらない**ことの証明
 *   node --test src/lib/marketing/prospectSequenceParity.test.mjs
 *
 * 移行の可否を決めるのはこのテストの考え方そのもの:
 *   Customers 経路と prospect 経路が、同じ入力から
 *   **同じ相手・同じ step・同じ DeliveryKey・同じ停止理由**を出すか。
 *   1 つでも違えば移行しない（`assertParityBeforeMigration`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSequenceProgress, SEQ_STATUS, SEQ_STOP } from './sequenceProgress.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import { compareSequenceParity, assertParityBeforeMigration, PARITY_UNUSABLE } from './sequenceParity.js';
import {
  buildProspectSequenceRows, prospectToCustomerRow, prospectToImportFields,
  prospectRecordId, isProspectRecordId, PROSPECT_RECORD_PREFIX,
} from './prospectSequenceAdapter.js';
import { buildProspect, applyDelivered, applySend, applySuppression } from './prospectPolicy.js';
import {
  hydrateProspectSequenceInputs, hydrateProspectDeliveries, hydrateProspectEngagement,
  hydrateProspectSuppression, buildProspectDeliveryKeys, HYDRATION_FAIL,
} from './prospectSequenceHydration.js';
import { IMPORT_SOURCE_PREFIX } from '../crm/importWritePlan.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 31);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const BATCH = 'imp-2026-08-09-001';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 5,
  subject: `件名${n}`, preheader: `プリヘッダー${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
});

const CAMPAIGN = Object.freeze({
  campaignId: 'parity-test', version: 1, name: 'パリティ検証',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true,
  requiresImportCohort: { batchIds: [BATCH] },
  sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

const emails = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];

/** 取り込みが Customers へ書いたのと同じ fields */
const importedFields = (email) => ({
  Email: email, 'プラン': 'Free', 'ポイント': 0, Source: `${IMPORT_SOURCE_PREFIX}:${BATCH}`,
});

const customerRow = (email, over = {}) => {
  const fields = { ...importedFields(email), ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
};

const deliveryKeyFor = (email, n) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** step1 を送った事実 */
const delivered = (email, n, atMs) => ({
  fields: {
    EmailType: 'campaign', DeliveryKey: deliveryKeyFor(email, n), RecipientEmail: email,
    Status: 'sent', SentAt: new Date(atMs).toISOString(),
  },
});

/** 全員 delivered 同数の Map（差が無い前提を明示する）*/
const sameDelivered = (n) => new Map(emails.map((e) => [e, n]));

const run = (selected, deliveries, over = {}) => buildSequenceProgress({
  campaign: CAMPAIGN, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(), ...over,
});

/** email → delivered 回数（Customers 側は台帳の行数、prospect 側はレコードの値）*/
const deliveredMap = (obj) => new Map(Object.entries(obj));

/** email → 次に送る step の DeliveryKey */
const keyMap = (progress) => {
  const m = new Map();
  for (const r of progress.rows) {
    if (!r.email || !Number.isInteger(r.nextStep)) continue;
    m.set(r.email, deliveryKeyFor(r.email, r.nextStep));
  }
  return m;
};

/* ── 変換そのもの ─────────────────────────────────────────── */

test('prospect → 取り込みが書いたのと同じ fields になる', () => {
  const p = { ...buildProspect({ email: 'a@example.com', nowMs: NOW, batchId: BATCH, source: 'csv' }), hash: 'h1' };
  assert.deepEqual(prospectToImportFields(p), importedFields('a@example.com'));
});

test('batchId が分からなければ変換しない（推測で Source を作らない）', () => {
  const p = { ...buildProspect({ email: 'a@example.com', nowMs: NOW, batchId: '', source: 'csv' }), hash: 'h1' };
  assert.equal(prospectToImportFields(p), null);
  assert.equal(prospectToCustomerRow({ prospect: p, nowMs: NOW }), null);
});

test('recordId は Airtable の rec… と取り違えない形', () => {
  const id = prospectRecordId({ hash: 'abc' });
  assert.equal(id, `${PROSPECT_RECORD_PREFIX}abc`);
  assert.equal(isProspectRecordId(id), true);
  assert.equal(isProspectRecordId('rec123'), false);
});

test('prospect 由来の行は 出所=prospect（台帳の書き分けに使う）', () => {
  const p = { ...buildProspect({ email: 'a@example.com', nowMs: NOW, batchId: BATCH, source: 'csv' }), hash: 'h1' };
  assert.equal(prospectToCustomerRow({ prospect: p, nowMs: NOW })['出所'], 'prospect');
});

/* ── parity 本体 ─────────────────────────────────────────── */

const prospectRows = (over = {}) => buildProspectSequenceRows({
  prospects: emails.map((e, i) => ({
    ...buildProspect({ email: e, nowMs: NOW - 30 * DAY, batchId: BATCH, source: 'csv' }),
    hash: `h${i}`,
  })),
  nowMs: NOW, ...over,
}).rows;

test('step1 送信済みの 4 名: 両経路が同じ相手へ同じ step2 を出す', () => {
  const deliveries = emails.map((e) => delivered(e, 1, NOW - 6 * DAY));
  const A = run(emails.map((e) => customerRow(e)), deliveries);
  const B = run(prospectRows(), deliveries);

  // 前提: そもそも step2 が due になっている（空同士の一致で合格しない）
  assert.equal(A.summary.due, 4);
  assert.equal(A.summary.dueByStep[2], 4);

  const r = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyMap(A), prospectKeys: keyMap(B),
    customerDelivered: sameDelivered(1), prospectDelivered: sameDelivered(1),
  });
  assert.equal(r.ok, true, JSON.stringify(r.diff));
  assert.equal(r.diff['DeliveryKey不一致'], 0);
  assert.equal(r.diff['delivered不一致'], 0);
  assert.equal(r.counts.due.customers, r.counts.due.prospects);
  assert.equal(assertParityBeforeMigration(r).migrateAllowed, true);
});

test('DeliveryKey は移行しても変わらない（変わると二重送信になる）', () => {
  const deliveries = emails.map((e) => delivered(e, 1, NOW - 6 * DAY));
  const A = run(emails.map((e) => customerRow(e)), deliveries);
  const B = run(prospectRows(), deliveries);
  const ka = keyMap(A); const kb = keyMap(B);
  for (const e of emails) {
    assert.equal(ka.get(e), kb.get(e), `${e} の鍵が変わってはいけない`);
    assert.match(ka.get(e), /^[a-f0-9]{64}$/);
  }
});

test('停止理由も一致する（配信停止の人は両経路とも止まる）', () => {
  const deliveries = emails.map((e) => delivered(e, 1, NOW - 6 * DAY));
  const blacklist = new Set(['b@example.com']);
  const A = run(emails.map((e) => customerRow(e)), deliveries, {});
  // Customers 側も同じ blacklist を通す（同じ入力でないと比較の意味が無い）
  const A2 = run(
    emails.map((e) => {
      const fields = importedFields(e);
      return { recordId: `rec-${e}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW, blacklistEmails: blacklist }) };
    }),
    deliveries,
  );
  const B = run(prospectRows({ blacklistEmails: blacklist }), deliveries);

  // 前提: blacklist が実際に効いている
  assert.equal(A.summary.stopped, 0);
  assert.equal(A2.summary.byStopReason[SEQ_STOP.NOT_SENDABLE], 1);

  const r = compareSequenceParity({
    customers: A2, prospects: B, customerKeys: keyMap(A2), prospectKeys: keyMap(B),
    customerDelivered: sameDelivered(1), prospectDelivered: sameDelivered(1),
  });
  assert.equal(r.ok, true, JSON.stringify(r.diff));
  assert.equal(r.diff['停止理由不一致'], 0);
});

test('未送信（step1 も送っていない）の相手でも一致する', () => {
  const A = run(emails.map((e) => customerRow(e)), []);
  const B = run(prospectRows(), []);
  assert.equal(A.summary.dueByStep[1], 4);
  const r = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyMap(A), prospectKeys: keyMap(B),
    customerDelivered: sameDelivered(0), prospectDelivered: sameDelivered(0),
  });
  assert.equal(r.ok, true, JSON.stringify(r.diff));
});

test('⚠️ delivered がズレたら parity は落ちる（打ち切り判定が食い違うため）', () => {
  const A = run(emails.map((e) => customerRow(e)), []);
  const B = run(prospectRows(), []);
  const off = sameDelivered(1); off.set('a@example.com', 2);
  const r = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyMap(A), prospectKeys: keyMap(B),
    customerDelivered: sameDelivered(1), prospectDelivered: off,
  });
  assert.equal(r.ok, false);
  assert.equal(r.diff['delivered不一致'], 1);
  assert.equal(assertParityBeforeMigration(r).migrateAllowed, false);
});

test('⚠️ delivered を突き合わせない parity は合格にしない', () => {
  const A = run(emails.map((e) => customerRow(e)), []);
  const B = run(prospectRows(), []);
  const r = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyMap(A), prospectKeys: keyMap(B),
  });
  assert.equal(r.deliveredChecked, false);
  assert.equal(r.ok, false);
  assert.equal(r.diff['delivered不一致'], null);
});

test('⚠️ ズレたら parity は落ちる（テストが素通りしていないことの確認）', () => {
  const deliveries = emails.map((e) => delivered(e, 1, NOW - 6 * DAY));
  const A = run(emails.map((e) => customerRow(e)), deliveries);
  // prospect 側から 1 人落とす = 送信漏れの状態
  const B = run(prospectRows().slice(0, 3), deliveries);
  const r = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyMap(A), prospectKeys: keyMap(B),
  });
  assert.equal(r.ok, false);
  assert.equal(r.diff['対象のみ片側'].customers, 1);
  assert.equal(assertParityBeforeMigration(r).migrateAllowed, false);
});

test('⚠️ 鍵を突き合わせない parity は合格にしない', () => {
  const deliveries = emails.map((e) => delivered(e, 1, NOW - 6 * DAY));
  const A = run(emails.map((e) => customerRow(e)), deliveries);
  const B = run(prospectRows(), deliveries);
  const r = compareSequenceParity({ customers: A, prospects: B });   // Keys を渡さない
  assert.equal(r.keysChecked, false);
  assert.equal(r.ok, false, '鍵未確認のまま移行を許してはいけない');
  assert.equal(r.diff['DeliveryKey不一致'], null);
});

test('⚠️ 突合できなかったものを合格にしない', () => {
  const A = run(emails.map((e) => customerRow(e)), []);
  assert.equal(compareSequenceParity({ customers: A }).unusable, PARITY_UNUSABLE.MISSING_SIDE);
  assert.equal(assertParityBeforeMigration(compareSequenceParity({ customers: A })).migrateAllowed, false);
});

test('打ち切り済み prospect は変換対象から外れ、理由が残る', () => {
  let p = { ...buildProspect({ email: 'z@example.com', nowMs: NOW - 40 * DAY, batchId: BATCH, source: 'csv' }), hash: 'hz' };
  for (let i = 1; i <= 10; i += 1) p = applyDelivered({ prospect: p, nowMs: NOW - (30 - i) * DAY }).prospect;
  const out = buildProspectSequenceRows({ prospects: [p], nowMs: NOW });
  assert.equal(out.rows.length, 0);
  assert.equal(out.skipped['state:EXHAUSTED'], 1, '黙って落とさず理由を数える');
});

test('コホート宣言があるので、取り込み由来でない prospect は step が進まない', () => {
  const other = { ...buildProspect({ email: 'x@example.com', nowMs: NOW, batchId: 'imp-other-batch', source: 'csv' }), hash: 'hx' };
  const rows = buildProspectSequenceRows({ prospects: [other], nowMs: NOW }).rows;
  const progress = run(rows, []);
  assert.equal(progress.rows[0].status, SEQ_STATUS.STOPPED);
  assert.equal(progress.rows[0].stopReason, SEQ_STOP.NOT_IN_COHORT);
});


/* ── hydration: Redis 台帳から既送信 step を復元する ───────────────── */

/** step1 を送った prospect（送信時刻つき） */
const sentProspect = (email, i, atMs) => {
  let p = { ...buildProspect({ email, nowMs: atMs, batchId: BATCH, source: 'csv' }), hash: `h${i}` };
  p = applySend({ prospect: p, nowMs: atMs, runId: 'run1' });
  p = applyDelivered({ prospect: p, nowMs: atMs }).prospect;
  return p;
};

test('hydration: 台帳にある DeliveryKey から step1 送信済みを復元し、parity が成立する', () => {
  const at = NOW - 6 * DAY;
  const prospects = emails.map((e, i) => sentProspect(e, i, at));
  const ledger = new Set(emails.map((e) => deliveryKeyFor(e, 1)));

  const h = hydrateProspectSequenceInputs({
    prospects, campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, deliveredKeys: ledger,
  });
  assert.equal(h.ok, true);
  assert.equal(h.counts['復元'], 4);
  // prospect が持つ delivered は、Customers 側の台帳行数と一致していること
  for (const p of prospects) assert.equal(p.delivered, 1);

  const rows = buildProspectSequenceRows({ prospects, nowMs: NOW }).rows;
  const B = run(rows, h.deliveries, {
    engagementByEmail: h.engagementByEmail, providerSuppressed: h.providerSuppressed,
  });
  // Customers 側は Airtable の行から同じ事実を読む
  const A = run(emails.map((e) => customerRow(e)), emails.map((e) => delivered(e, 1, at)));

  assert.equal(A.summary.dueByStep[2], 4, '前提: step2 が due');
  const r = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyMap(A), prospectKeys: keyMap(B),
    customerDelivered: sameDelivered(1),
    prospectDelivered: new Map(prospects.map((p) => [p.email, p.delivered])),
  });
  assert.equal(r.ok, true, JSON.stringify(r.diff));
  assert.equal(r.diff['delivered不一致'], 0);
});

test('⚠️ hydration: 台帳を読めなければ中止する（未送信と見なして全員へ再送しない）', () => {
  const prospects = emails.map((e, i) => sentProspect(e, i, NOW - 6 * DAY));
  const h = hydrateProspectSequenceInputs({
    prospects, campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, deliveredKeys: null,
  });
  assert.equal(h.ok, false);
  assert.equal(h.reason, HYDRATION_FAIL.LEDGER_UNAVAILABLE);
  assert.deepEqual(h.deliveries, []);
});

test('⚠️ hydration: 台帳が空（本当に 0 件）は中止しない', () => {
  const prospects = emails.map((e, i) => sentProspect(e, i, NOW - 6 * DAY));
  const h = hydrateProspectSequenceInputs({
    prospects, campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, deliveredKeys: new Set(),
  });
  assert.equal(h.ok, true);
  assert.equal(h.deliveries.length, 0);
});

test('hydration: 送信時刻が無い行は復元せず、件数に残す（時刻を推測しない）', () => {
  const p = { ...buildProspect({ email: 'a@example.com', nowMs: NOW, batchId: BATCH, source: 'csv' }), hash: 'h0' };
  assert.equal(p.lastSentAt, null, '前提: 送信時刻が無い');
  const d = hydrateProspectDeliveries({
    prospects: [p], campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM,
    deliveredKeys: new Set([deliveryKeyFor('a@example.com', 1)]),
  });
  assert.equal(d.ok, true);
  assert.equal(d.counts['既送信'], 1);
  assert.equal(d.counts['復元'], 0);
  assert.equal(d.counts['時刻不明で除外'], 1);
});

test('hydration: 反応の統計はシーケンス側の停止条件と同じ条件で成立する', () => {
  // delivered 10 / open 0 → prospect は EXHAUSTED、シーケンスは engagement_blocked
  let p = { ...buildProspect({ email: 'q@example.com', nowMs: NOW - 40 * DAY, batchId: BATCH, source: 'csv' }), hash: 'hq' };
  for (let i = 1; i <= 10; i += 1) p = applyDelivered({ prospect: p, nowMs: NOW - (30 - i) * DAY }).prospect;

  const eng = hydrateProspectEngagement([p]);
  assert.equal(eng.get('q@example.com').delivered, 10);
  assert.equal(eng.get('q@example.com').open, 0);

  // 変換対象から外れる（prospect 側の打ち切り）
  assert.equal(buildProspectSequenceRows({ prospects: [p], nowMs: NOW }).rows.length, 0);

  // 仮に変換されたとしても、シーケンス側でも止まる（二重の防御）
  const forced = prospectToCustomerRow({ prospect: p, nowMs: NOW });
  const progress = run([forced], [], { engagementByEmail: eng });
  assert.equal(progress.rows[0].stopReason, SEQ_STOP.ENGAGEMENT_BLOCKED);
});

test('hydration: SUPPRESSED は配信側でも止まる', () => {
  let p = { ...buildProspect({ email: 's@example.com', nowMs: NOW, batchId: BATCH, source: 'csv' }), hash: 'hs' };
  p = applySuppression({ prospect: p, nowMs: NOW, reason: 'bounce' }).prospect;
  const sup = hydrateProspectSuppression([p]);
  assert.equal(sup.has('s@example.com'), true);
  const forced = prospectToCustomerRow({ prospect: p, nowMs: NOW });
  const progress = run([forced], [], { providerSuppressed: sup });
  assert.equal(progress.rows[0].stopReason, SEQ_STOP.PROVIDER_SUPPRESSED);
});

test('DeliveryKey は step ごとに違い、同じ人でも混ざらない', () => {
  const p = sentProspect('a@example.com', 0, NOW - 6 * DAY);
  const keys = buildProspectDeliveryKeys({ prospects: [p], campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM });
  const byStep = keys.get('a@example.com');
  assert.equal(byStep.size, 3);
  assert.equal(new Set([...byStep.values()]).size, 3, 'step ごとに別の鍵');
  assert.equal(byStep.get(1), deliveryKeyFor('a@example.com', 1));
});
