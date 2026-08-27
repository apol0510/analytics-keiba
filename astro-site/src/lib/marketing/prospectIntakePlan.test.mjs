/**
 * prospectIntakePlan.test.mjs — Redis へ投入する内容の引き継ぎと、投入の安全条件
 *   node --test src/lib/marketing/prospectIntakePlan.test.mjs
 *
 * 守る条件:
 *   1. delivered は `sent` の行数だけ（`queued` を数えない = 打ち切りを早めない）
 *   2. 既送信の `DeliveryKey` をそのまま引き継ぐ（変えると二重送信）
 *   3. 反応の集計が無ければ **1 件も作らない**（開封した人を移さない）
 *   4. 移行対象（`migrate`）以外は 1 件も作らない
 *   5. 投入は env・確認文字列・反応の適用・parity の**4 つ全部**が揃って初めて許される
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  planProspectIntakeFromCustomers, summarizeDeliveriesForIntake,
  canIntake, INTAKE_BLOCK,
} from './prospectIntakePlan.js';
import { PROSPECT_STATE } from './prospectPolicy.js';
import { MIGRATION_DECISION } from './prospectMigrationPlan.js';

const NOW = Date.UTC(2026, 7, 27);
const hashEmail = (e) => createHash('sha256').update(String(e), 'utf8').digest('hex');
const signalHash = (e) => hashEmail(e).slice(0, 32);

const imported = (email, over = {}) => ({
  id: `rec-${email}`,
  fields: { Email: email, Source: 'customer-import:imp-2026-08-09-001', 'プラン': 'Free', 'ポイント': 0, ...over },
});
const delivery = (email, key, status, sentAt) => ({
  fields: {
    EmailType: 'campaign', DeliveryKey: key, RecipientEmail: email,
    Status: status, SentAt: sentAt,
  },
});

const noEngagement = { openHashes: new Set(), clickHashes: new Set() };

test('delivered は sent の行数だけ（queued を数えない）', () => {
  const d = [
    delivery('a@x.com', 'k1', 'sent', '2026-08-25T00:00:00Z'),
    delivery('a@x.com', 'k2', 'queued', '2026-08-26T00:00:00Z'),
    delivery('a@x.com', 'k3', 'failed', '2026-08-26T00:00:00Z'),
  ];
  const sum = summarizeDeliveriesForIntake(d).get('a@x.com');
  assert.equal(sum.sends, 2, 'sent + queued が試行');
  assert.equal(sum.delivered, 1, '⚠️ 届いた証拠があるのは sent だけ');
  assert.equal(sum.keys.size, 2, 'failed は台帳へ引き継がない');
});

test('最終送信時刻は最大値（次 step の間隔計算に使う）', () => {
  const sum = summarizeDeliveriesForIntake([
    delivery('a@x.com', 'k1', 'sent', '2026-08-20T00:00:00Z'),
    delivery('a@x.com', 'k2', 'sent', '2026-08-26T05:00:00Z'),
  ]).get('a@x.com');
  assert.equal(new Date(sum.lastSentAtMs).toISOString(), '2026-08-26T05:00:00.000Z');
});

test('引き継ぎ: sends / delivered / lastSentAt / DeliveryKey がそのまま入る', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('a@x.com')],
    deliveries: [delivery('a@x.com', 'k1', 'sent', '2026-08-26T01:00:00Z')],
    ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 1);
  const p = plan.prospects[0];
  assert.equal(p.email, 'a@x.com');
  assert.equal(p.batchId, 'imp-2026-08-09-001');
  assert.equal(p.sends, 1);
  assert.equal(p.delivered, 1);
  assert.equal(p.lastSentAt, '2026-08-26T01:00:00.000Z');
  assert.equal(p.state, PROSPECT_STATE.SENDING);
  assert.deepEqual(plan.ledgerKeys, ['k1'], '⚠️ 鍵はそのまま引き継ぐ（変えると二重送信）');
});

test('一度も送っていない人は NEW で入る', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('n@x.com')], deliveries: [],
    ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects[0].state, PROSPECT_STATE.NEW);
  assert.equal(plan.prospects[0].delivered, 0);
  assert.equal(plan.ledgerKeys.length, 0);
});

test('開封していた人は opens=1 で入る（あとで昇格対象になる）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('o@x.com')], deliveries: [],
    openHashes: new Set([signalHash('o@x.com')]), clickHashes: new Set(),
    hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects[0].opens, 1);
});

test('⚠️ 反応の集計を渡さなければ 1 件も作らない（開封した人を移さないため）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('a@x.com')], deliveries: [], hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 0);
  assert.equal(plan.skipped.engagement_unavailable, 1);
});

test('⚠️ 移行対象以外は 1 件も作らない（理由別に数える）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [
      imported('a@x.com'),
      imported('b@x.com', { 'プラン': 'Premium' }),                    // 本人が動いた
      imported('c@x.com', { PremiumPlusEligibility: 'review' }),        // 運営付与のみ
      imported('d@x.com', { WithdrawalRequested: true }),               // 配信停止
      { id: 'e', fields: { Email: 'e@x.com', Source: 'nankan-analytics' } }, // 取り込み由来でない
    ],
    deliveries: [], ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 1);
  assert.equal(plan.prospects[0].email, 'a@x.com');
  assert.equal(plan.skipped[MIGRATION_DECISION.KEEP_CONVERTED], 1);
  assert.equal(plan.skipped[MIGRATION_DECISION.REVIEW_OPERATOR_GRANT], 1);
  assert.equal(plan.skipped[MIGRATION_DECISION.KEEP_SUPPRESSED], 1);
  assert.equal(plan.skipped[MIGRATION_DECISION.KEEP_NOT_IMPORTED], 1);
  assert.equal(plan.counts['対象'], 5);
  assert.equal(plan.counts['投入'], 1);
});

test('⚠️ batchId を復元できない行は投入しない（コホート判定が効かなくなる）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [{ id: 'x', fields: { Email: 'x@x.com', Source: 'customer-import:', 'プラン': 'Free' } }],
    deliveries: [], ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 0);
});

/* ── 投入の安全条件 ─────────────────────────────────────────── */

const okPlan = { prospects: [{ email: 'a@x.com' }] };

test('⚠️ 4 つ全部そろって初めて投入できる', () => {
  assert.equal(canIntake({
    writeEnabled: true, confirmed: true, engagementApplied: true, parityOk: true, plan: okPlan,
  }).allowed, true);

  for (const missing of ['writeEnabled', 'confirmed', 'engagementApplied', 'parityOk']) {
    const args = {
      writeEnabled: true, confirmed: true, engagementApplied: true, parityOk: true, plan: okPlan,
    };
    args[missing] = false;
    const r = canIntake(args);
    assert.equal(r.allowed, false, `${missing} が false でも投入できてしまう`);
    assert.equal(r.reasons.length, 1);
  }
});

test('⚠️ 投入対象 0 件を「成功」にしない', () => {
  const r = canIntake({
    writeEnabled: true, confirmed: true, engagementApplied: true, parityOk: true,
    plan: { prospects: [] },
  });
  assert.equal(r.allowed, false);
  assert.deepEqual(r.reasons, [INTAKE_BLOCK.NOTHING_TO_WRITE]);
});

test('既定（引数なし）は投入不可', () => {
  assert.equal(canIntake().allowed, false);
});

/* ── Function 側の配線（guard）──────────────────────────────── */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');

test('guard: 投入は env で閉じており、既定は下見だけ', () => {
  assert.match(FN, /PROSPECT_MIGRATION_ENABLED/);
  assert.match(FN, /const dryRun = req\.apply !== true/, '既定が書き込みになっている');
  assert.match(FN, /canIntake\(/, '安全条件の単一源を通っていない');
});

test('⚠️ guard: 投入はページ単位の parity を確かめてから書く', () => {
  assert.match(FN, /computePageParity/);
  assert.match(FN, /parityOk: parity\.ok/, 'parity の結果がゲートへ渡っていない');
});

test('⚠️ guard: 投入経路が Customers を削除していない', () => {
  const i = FN.indexOf('async function handleProspectIntake');
  const j = FN.indexOf('function computePageParity');
  assert.ok(i > 0 && j > i);
  const body = FN.slice(i, j);
  assert.doesNotMatch(body, /method:\s*'DELETE'/, '投入で Customers を消している');
  assert.doesNotMatch(body, /records\[\]=/, '削除クエリらしきものがある');
  assert.match(body, /customersDeleted: 0/);
});

test('⚠️ guard: 既存 prospect を上書きしない（addIfAbsent）', () => {
  const i = FN.indexOf('async function handleProspectIntake');
  const body = FN.slice(i, i + 9000);
  assert.match(body, /store\.addIfAbsent\(/);
  assert.doesNotMatch(body, /store\.write\(/);
});

test('⚠️ guard: 台帳へ書いたあと読み戻して確かめている', () => {
  const i = FN.indexOf('async function handleProspectIntake');
  const body = FN.slice(i, i + 9000);
  assert.match(body, /markDelivered\(/);
  assert.match(body, /filterDelivered\(/);
  assert.match(body, /unverified/);
});

test('guard: Customers は 1 ページずつ・取り込み由来だけを名指しで読む', () => {
  assert.match(FN, /fetchCustomersPage/);
  assert.match(FN, /LEFT\(\{Source\}/, '取り込み由来だけに絞っていない（全件走査になる）');
});
