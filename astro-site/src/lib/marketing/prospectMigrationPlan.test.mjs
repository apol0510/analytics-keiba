/**
 * prospectMigrationPlan.test.mjs — CSV 取り込み分を prospect へ戻す計画
 *   node --test src/lib/marketing/prospectMigrationPlan.test.mjs
 *
 * ## 守る条件
 *   1. **迷ったら残す**（消しても失うものが無いと確認できた行だけ移す）
 *   2. 顧客になった人・反応した人・配信を止めた人は**移さない**
 *   3. 母数 = 判定の合計（取りこぼしを検知する）
 *   4. 移す行は**巻き戻せる**（Customers へ戻すのに要る項目がそろっている）
 *   5. **運営側が付けた販売資格・無料付与を「本人の反応」と同一視しない**（2026-08-27 MK 確定）
 *   6. 配信停止・バウンス・退会も**恒久保持を前提にしない**（抑止台帳へ hash で引き継ぐ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  decideForRecord, buildMigrationPlan, isSuppressed,
  hasSelfConversion, hasOperatorAssignment, hasAmbiguousSignal, isKeepDecision,
  assertRollbackComplete, MIGRATION_DECISION, ROLLBACK_REQUIRED_FIELDS,
  buildSuppressionHandoff, assertHandoffComplete, canPurgeRawEmails,
  resolveSuppressionReason, HANDOFF_REASON,
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

test('【要件】本人が動いた証拠があれば「顧客になった」として残す', () => {
  const cases = [
    ['有料プラン', { 'プラン': 'Premium' }],
    ['Light', { 'プラン': 'Light' }],
    ['入金あり', { PaidAt: '2026-08-01T00:00:00.000Z' }],
    ['入金確認済み', { PaymentConfirmed: true }],
    ['申込中', { RequestedPlan: 'Premium' }],
    ['申込金額あり', { RequestedAmount: 49800 }],
    ['三連複 買い切り', { LifetimeSanrenpuku: true }],
    ['ログイン実績', { '最終ログイン': '2026-08-25T00:00:00.000Z' }],
  ];
  for (const [label, over] of cases) {
    assert.equal(hasSelfConversion({ 'プラン': 'Free', ...over }), true, label);
    assert.equal(decideForRecord({ fields: imported(over).fields }).decision,
      MIGRATION_DECISION.KEEP_CONVERTED, label);
  }
});

test('⚠️【要件】運営側が付けた販売資格・無料付与を「本人の反応」と同一視しない', () => {
  const cases = [
    ['Light 永久無料（運営付与）', { LightGrantLifetime: true }],
    ['Light 期間無料（運営付与）', { LightGrantUntil: '2026-09-03T00:00:00.000Z' }],
    ['Premium 無料（運営付与）', { PremiumGrantLifetime: true }],
    ['Premium 期間無料（運営付与）', { PremiumGrantUntil: '2026-09-03T00:00:00.000Z' }],
    ['Plus 販売資格（運営・自動処理）', { PremiumPlusEligibility: 'review' }],
    ['Plus 販売資格 eligible', { PremiumPlusEligibility: 'eligible' }],
  ];
  for (const [label, over] of cases) {
    assert.equal(hasSelfConversion({ 'プラン': 'Free', ...over }), false, `${label}: 本人の反応ではない`);
    assert.equal(hasOperatorAssignment({ 'プラン': 'Free', ...over }), true, label);
    const d = decideForRecord({ fields: imported(over).fields });
    assert.equal(d.decision, MIGRATION_DECISION.REVIEW_OPERATOR_GRANT, label);
    assert.equal(d.reason, 'operator_grant_only');
    // ⚠️ 保留であって削除ではない
    assert.equal(isKeepDecision(d.decision), true, `${label}: 保留は消さない`);
  }
});

test('⚠️【要件】由来の分からない値（ポイント残高）は顧客化と数えず保留にする', () => {
  const d = decideForRecord({ fields: imported({ 'ポイント': 160 }).fields });
  assert.equal(d.decision, MIGRATION_DECISION.REVIEW_AMBIGUOUS);
  assert.equal(isKeepDecision(d.decision), true);
  // 取り込みは ポイント 0 で作るので、0 は保留にしない
  assert.equal(decideForRecord({ fields: imported({ 'ポイント': 0 }).fields }).decision,
    MIGRATION_DECISION.MIGRATE);
});

test('⚠️ 運営付与だけの人を keep_converted に数え直さない（1,615 件の内訳が変わる）', () => {
  const records = [
    { id: 'r1', fields: imported({ 'プラン': 'Premium' }).fields },          // 本人
    { id: 'r2', fields: imported({ PremiumPlusEligibility: 'review' }).fields }, // 運営
    { id: 'r3', fields: imported({ LightGrantLifetime: true }).fields },     // 運営
    { id: 'r4', fields: imported({}).fields },                                // 移行対象
  ];
  const plan = buildMigrationPlan({ records });
  assert.equal(plan.counts.keep_converted, 1, '本人が動いた 1 件だけ');
  assert.equal(plan.counts.review_operator_grant, 2);
  assert.equal(plan.counts.migrate, 1);
  assert.equal(plan.balanced, true);
  // 保留は migrate に入らない（＝消さない）
  assert.equal(plan.migrateIds.length, 1);
  assert.equal(plan.migrateIds[0], 'r4');
});

test('ポイント 0 とログイン無しは「本人が動いた証拠」にしない', () => {
  assert.equal(hasSelfConversion({ 'プラン': 'Free', 'ポイント': 0 }), false);
  assert.equal(hasSelfConversion({ 'プラン': 'Free' }), false);
  assert.equal(hasOperatorAssignment({ 'プラン': 'Free' }), false);
  assert.equal(hasAmbiguousSignal({ 'プラン': 'Free', 'ポイント': 0 }), false);
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


/* ── 配信停止・バウンス・退会を抑止台帳へ引き継ぐ ────────────────── */

/** テスト用の hash。**アドレスを復元できない形**にする（本番は sha256） */
const hashFn = (e) => createHash('sha256').update(String(e), 'utf8').digest('hex');

test('停止理由は 1 つに決まる（強い順・奪い合いをさせない）', () => {
  assert.equal(resolveSuppressionReason({ UnsubscribedAnalyticsKeiba: true, WithdrawalRequested: true }),
    HANDOFF_REASON.UNSUBSCRIBED);
  assert.equal(resolveSuppressionReason({ WithdrawalRequested: true }), HANDOFF_REASON.WITHDRAWN);
  assert.equal(resolveSuppressionReason({ ForceLogout: true }), HANDOFF_REASON.FORCE_LOGOUT);
  assert.equal(resolveSuppressionReason({ Status: '停止' }), HANDOFF_REASON.ACCOUNT_STOPPED);
  assert.equal(resolveSuppressionReason({}), null);
});

test('keep_suppressed の行だけが台帳へ引き継がれ、アドレスは持ち回らない', () => {
  const records = [
    { id: 's1', fields: imported({ UnsubscribedAnalyticsKeiba: true }).fields },
    { id: 's2', fields: imported({ WithdrawalRequested: true }).fields },
    { id: 'm1', fields: imported({}).fields },                       // 移行対象（引き継がない）
    { id: 'c1', fields: imported({ 'プラン': 'Premium' }).fields },   // 顧客（引き継がない）
  ];
  const ho = buildSuppressionHandoff({ records, hashFn, nowIso: '2026-08-27T00:00:00.000Z' });
  assert.equal(ho.counts['対象'], 2);
  assert.equal(ho.counts['引き継ぎ'], 2);
  for (const e of ho.entries) {
    assert.match(e.hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(e).includes('@'), false, '台帳の計画にアドレスが入っている');
  }
});

test('⚠️ hash 化できないなら計画を作らない（生アドレスを持ち回らない）', () => {
  const ho = buildSuppressionHandoff({ records: [{ id: 's1', fields: imported({ WithdrawalRequested: true }).fields }] });
  assert.equal(ho.entries.length, 0);
  assert.equal(ho.skipped.no_hash_fn, 1);
});

test('⚠️ 台帳へ載る前に生アドレスを消せない（順序を逆にすると復活する）', () => {
  const records = [{ id: 's1', fields: imported({ WithdrawalRequested: true }).fields }];
  const ho = buildSuppressionHandoff({ records, hashFn, nowIso: 'now' });
  // 台帳が空 → 消せない
  assert.equal(canPurgeRawEmails({ handoff: ho, blockedHashes: new Set() }).purgeAllowed, false);
  // 台帳を読めない → 消せない（fail closed）
  assert.equal(canPurgeRawEmails({ handoff: ho }).purgeAllowed, false);
  assert.equal(canPurgeRawEmails({ handoff: ho }).reason, 'ledger_unreadable');
  // 台帳に載って初めて消せる
  const led = new Set(ho.entries.map((e) => e.hash));
  assert.equal(canPurgeRawEmails({ handoff: ho, blockedHashes: led }).purgeAllowed, true);
});

test('⚠️ 引き継ぎが 0 件のときを「完了」にしない', () => {
  assert.equal(assertHandoffComplete({ entries: [], blockedHashes: new Set() }).ok, false);
});
