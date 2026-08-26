/**
 * prospectMigrationPlan.test.mjs — CSV 取り込み分を prospect へ戻す計画
 *   node --test src/lib/marketing/prospectMigrationPlan.test.mjs
 *
 * ## 守る条件
 *   1. **迷ったら残す**（消しても失うものが無いと確認できた行だけ移す）
 *   2. 顧客になった人・反応した人・配信を止めた人は**移さない**
 *   3. 母数 = 判定の合計（取りこぼしを検知する）
 *   4. 移す行は**巻き戻せる**（Customers へ戻すのに要る項目がそろっている）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideForRecord, buildMigrationPlan, hasCustomerEvidence, isSuppressed,
  assertRollbackComplete, MIGRATION_DECISION, ROLLBACK_REQUIRED_FIELDS,
} from './prospectMigrationPlan.js';

const imported = (over = {}) => ({
  id: 'rec' + Math.random().toString(36).slice(2, 10),
  fields: { Email: `u${Math.random()}@example.invalid`, Source: 'customer-import:imp-2026-08-09-001', 'プラン': 'Free', ...over },
});

test('【要件】反応が無い取り込み分だけを prospect へ戻す', () => {
  const r = decideForRecord({ fields: imported().fields });
  assert.equal(r.decision, MIGRATION_DECISION.MIGRATE);
  assert.equal(r.batchId, 'imp-2026-08-09-001');
});

test('【要件】取り込み由来でない顧客は移さない', () => {
  for (const src of ['admin', '', undefined, 'ak:marketing-automation:x']) {
    const d = decideForRecord({ fields: { Email: 'a@x.com', Source: src, 'プラン': 'Free' } });
    assert.equal(d.decision, MIGRATION_DECISION.KEEP_NOT_IMPORTED, String(src));
  }
});

test('【要件】顧客になった証拠があれば移さない', () => {
  const cases = [
    ['有料プラン', { 'プラン': 'Premium' }],
    ['Light', { 'プラン': 'Light' }],
    ['入金あり', { PaidAt: '2026-08-01T00:00:00.000Z' }],
    ['入金確認済み', { PaymentConfirmed: true }],
    ['申込中', { RequestedPlan: 'Premium' }],
    ['申込金額あり', { RequestedAmount: 49800 }],
    ['三連複 買い切り', { LifetimeSanrenpuku: true }],
    ['Light 永久無料', { LightGrantLifetime: true }],
    ['Light 期間無料', { LightGrantUntil: '2026-09-03T00:00:00.000Z' }],
    ['Premium 無料', { PremiumGrantLifetime: true }],
    ['Plus 販売資格', { PremiumPlusEligibility: 'review' }],
    ['ポイント残高', { 'ポイント': 160 }],
    ['ログイン実績', { '最終ログイン': '2026-08-25T00:00:00.000Z' }],
  ];
  for (const [label, over] of cases) {
    assert.equal(hasCustomerEvidence({ 'プラン': 'Free', ...over }), true, label);
    assert.equal(decideForRecord({ fields: imported(over).fields }).decision,
      MIGRATION_DECISION.KEEP_CONVERTED, label);
  }
});

test('ポイント 0 とログイン無しは「顧客になった証拠」にしない', () => {
  assert.equal(hasCustomerEvidence({ 'プラン': 'Free', 'ポイント': 0 }), false);
  assert.equal(hasCustomerEvidence({ 'プラン': 'Free' }), false);
});

test('【要件】反応があった人は移さない（本来の方針でも昇格対象）', () => {
  const rec = imported({ Email: 'opener@example.invalid' });
  const d = decideForRecord({ fields: rec.fields, engagedEmails: new Set(['opener@example.invalid']) });
  assert.equal(d.decision, MIGRATION_DECISION.KEEP_ENGAGED);
});

test('【要件】配信停止・バウンス・退会は移さない（Customers 側で管理を続ける）', () => {
  for (const over of [
    { UnsubscribedAnalyticsKeiba: true }, { WithdrawalRequested: true },
    { ForceLogout: true }, { Status: 'suspended' }, { Status: '退会' },
  ]) {
    assert.equal(isSuppressed(over), true, JSON.stringify(over));
    assert.equal(decideForRecord({ fields: imported(over).fields }).decision,
      MIGRATION_DECISION.KEEP_SUPPRESSED, JSON.stringify(over));
  }
});

test('顧客の証拠が配信停止より優先される（有料会員を prospect へ落とさない）', () => {
  const d = decideForRecord({ fields: imported({ 'プラン': 'Premium', UnsubscribedAnalyticsKeiba: true }).fields });
  assert.equal(d.decision, MIGRATION_DECISION.KEEP_CONVERTED);
});

// ── 計画全体 ─────────────────────────────────────────────────
test('【要件】母数 = 判定の合計（取りこぼしを検知する）', () => {
  const records = [
    imported(), imported(), imported({ 'プラン': 'Light' }),
    imported({ UnsubscribedAnalyticsKeiba: true }),
    { id: 'recX', fields: { Email: 'old@x.com', Source: 'admin' } },
  ];
  const plan = buildMigrationPlan({ records });
  assert.equal(plan.total, 5);
  assert.equal(plan.balanced, true, '母数と判定の合計が合わない');
  assert.equal(plan.counts.migrate, 2);
  assert.equal(plan.counts.keep_converted, 1);
  assert.equal(plan.counts.keep_suppressed, 1);
  assert.equal(plan.counts.keep_not_imported, 1);
  assert.equal(plan.migrateIds.length, 2);
});

test('取り込みバッチごとに内訳が出る', () => {
  const a = imported({ Source: 'customer-import:imp-A' });
  const b = imported({ Source: 'customer-import:imp-B', 'プラン': 'Premium' });
  const plan = buildMigrationPlan({ records: [a, b] });
  assert.equal(plan.byBatch['imp-A'].migrate, 1);
  assert.equal(plan.byBatch['imp-B'].keep_converted, 1);
});

test('空・壊れた入力でも落ちない（0 件の計画を返す）', () => {
  for (const records of [null, undefined, [], [null, {}, { fields: null }]]) {
    const p = buildMigrationPlan({ records });
    assert.equal(p.balanced, true);
    assert.ok(p.migrateIds.length >= 0);
  }
});

// ── 巻き戻し ─────────────────────────────────────────────────
test('【要件】移す行は Customers へ戻せる（必要な項目がそろっている）', () => {
  const records = [imported(), imported()];
  const plan = buildMigrationPlan({ records });
  const r = assertRollbackComplete({ records, migrateIds: plan.migrateIds });
  assert.equal(r.ok, true, '巻き戻しに必要な項目が欠けている');
  assert.equal(r.checked, 2);
  assert.deepEqual([...ROLLBACK_REQUIRED_FIELDS], ['Email', 'Source']);
});

test('【安全】戻せない行があれば検知する（欠けたまま移さない）', () => {
  const broken = { id: 'recBroken', fields: { Source: 'customer-import:imp-A', 'プラン': 'Free' } }; // Email 無し
  const r = assertRollbackComplete({ records: [broken], migrateIds: ['recBroken'] });
  assert.equal(r.ok, false);
  assert.equal(r.missing[0].field, 'Email');
});

test('移さない行は巻き戻しの検査対象にしない', () => {
  const keep = { id: 'recKeep', fields: { Source: 'admin' } };
  assert.equal(assertRollbackComplete({ records: [keep], migrateIds: [] }).ok, true);
});
