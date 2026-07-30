/**
 * comebackGrantPlan.test.mjs — 付与計画（dry-run の中身）
 *   node --test src/lib/comeback/comebackGrantPlan.test.mjs
 *
 * 守る性質:
 *   - 理由別に必ず数える（黙って落とさない）
 *   - 複合オファーは 1 顧客 1 PATCH（片方だけ付く状態が構造上作れない）
 *   - 同じ operationId の再実行で二重付与にならない
 *   - 有料 Premium を短縮しない
 *   - 取り消しは promotional grant だけ
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMEBACK_OFFERS,
  getOffer,
  buildGrantPlan,
  buildRevokePlan,
  planCustomerGrant,
  describeCustomerState,
  checkGrantable,
  reconcileOperation,
  chunkTargets,
  assertPlanWritesOnlyGrantFields,
  computeGrantPlanFingerprint,
  CB_SKIP,
  MAX_GRANT_RECORDS,
} from './comebackGrantPlan.js';
import { PROMO_FIELDS, PROMO_GRANT, resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const OP = 'cb-comeback_full-2026-07-30-abcd1234';
const iso = (ms) => new Date(ms).toISOString();

const FULL = getOffer('comeback_full');
const LIGHT_ONLY = getOffer('light_lifetime');
const TRIAL_ONLY = getOffer('premium_trial_30d');

const cust = (id, fields) => ({ recordId: id, fields });
const EXPIRED = { Email: 'ex@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-03-01' };
const plan = (offer, selected, opts = {}) => buildGrantPlan({
  offer, selected, nowMs: NOW, operationId: OP, actor: 'MK', source: 'comeback-2026-07', ...opts,
});

// ═══ オファー定義 ════════════════════════════════════════════════════

test('オファーは 3 つだけ。複合は 2 つの独立 grant で表現する', () => {
  assert.equal(COMEBACK_OFFERS.length, 3);
  assert.deepEqual(COMEBACK_OFFERS.map((o) => o.offerId),
    ['light_lifetime', 'premium_trial_30d', 'comeback_full']);
  assert.deepEqual(FULL.grants, [PROMO_GRANT.PREMIUM_TRIAL_30D, PROMO_GRANT.LIGHT_LIFETIME]);
  assert.equal(getOffer('unknown'), null);
  assert.equal(getOffer(''), null);
});

// ═══ 対象確定 ════════════════════════════════════════════════════════

test('期限切れ会員へ複合オファー: 1 顧客 1 PATCH で両方の grant が入る', () => {
  const p = plan(FULL, [cust('rec1', EXPIRED)]);
  assert.equal(p.ok, true);
  assert.equal(p.counts.willGrant, 1);
  const t = p.targets[0];
  assert.equal(t.applied.length, 2, '複合オファーが 1 つしか適用されていない');
  // 同一レコードの 1 回の PATCH に両方の grant が含まれる = 顧客単位で原子的
  assert.ok(t.fields[PROMO_FIELDS.LIGHT_GRANTED]);
  assert.ok(t.fields[PROMO_FIELDS.TRIAL_UNTIL]);
  assert.equal(t.fields[PROMO_FIELDS.LIGHT_GRANT_OP], OP);
  assert.equal(t.fields[PROMO_FIELDS.TRIAL_GRANT_OP], OP, '両 grant が同じ operationId を持たない');
  assert.equal(assertPlanWritesOnlyGrantFields(p.targets), true);
});

test('付与後の状態（after）は runtime 判定と一致する', () => {
  const t = plan(FULL, [cust('rec1', EXPIRED)]).targets[0];
  const merged = { ...EXPIRED, ...t.fields };
  const g = resolvePromotionalGrants(merged, NOW);
  assert.equal(g.premiumTrial.active, true);
  assert.equal(g.lightLifetime.active, true);
  assert.match(t.before.text, /期限切れ/);
  assert.match(t.after.text, /Premium 無料/);
  assert.match(t.after.text, /Light 永久無料/);
});

test('除外は理由別に必ず数える', () => {
  const p = plan(FULL, [
    cust('rec1', EXPIRED),                                             // 付与
    cust('recX', null),                                                // 不明
    cust('rec2', { ...EXPIRED, Email: '' }),                           // データ不備
    cust('rec3', { ...EXPIRED, Status: 'suspended' }),                 // 停止
    cust('rec4', { ...EXPIRED, WithdrawalRequested: true }),           // 退会
    cust('rec5', { ...EXPIRED, Status: 'test' }),                      // テスト
  ]);
  assert.equal(p.counts.willGrant, 1);
  assert.equal(p.counts.skipped, 5);
  assert.equal(p.counts.byReason[CB_SKIP.UNKNOWN_CUSTOMER], 1);
  assert.equal(p.counts.byReason[CB_SKIP.DATA_INCOMPLETE], 1);
  assert.equal(p.counts.byReason[CB_SKIP.ACCOUNT_SUSPENDED], 2); // suspended + test
  assert.equal(p.counts.byReason[CB_SKIP.WITHDRAWAL_BLOCKED], 1);
  // 合計が選択数と一致する（どこにも消えない）
  assert.equal(p.counts.willGrant + p.counts.skipped, p.counts.selected);
});

test('退会者は付与せず理由を出す（退会フラグには絶対に触らない）', () => {
  const withdrawn = { ...EXPIRED, WithdrawalRequested: true };
  assert.equal(checkGrantable(withdrawn).reason, CB_SKIP.WITHDRAWAL_BLOCKED);
  const p = plan(FULL, [cust('rec1', withdrawn)]);
  assert.equal(p.counts.willGrant, 0);
  assert.equal(p.targets.length, 0);
  assert.equal(withdrawn.WithdrawalRequested, true, '退会フラグが書き換わっている');
});

test('同一レコードを重複選択しても 1 回だけ', () => {
  const p = plan(FULL, [cust('rec1', EXPIRED), cust('rec1', EXPIRED)]);
  assert.equal(p.counts.willGrant, 1);
});

// ═══ 冪等性 ══════════════════════════════════════════════════════════

test('同じ operationId で再実行しても二重付与しない（already_applied）', () => {
  const first = plan(FULL, [cust('rec1', EXPIRED)]);
  const applied = { ...EXPIRED, ...first.targets[0].fields };

  const again = buildGrantPlan({
    offer: FULL, selected: [cust('rec1', applied)],
    nowMs: NOW + 2 * DAY, operationId: OP, actor: 'MK',
  });
  assert.equal(again.counts.willGrant, 0);
  assert.equal(again.counts.byReason[CB_SKIP.ALREADY_APPLIED], 1);
});

test('別 operationId でも既に特典があれば付与しない（already_granted）', () => {
  const applied = { ...EXPIRED, ...plan(FULL, [cust('rec1', EXPIRED)]).targets[0].fields };
  const again = buildGrantPlan({
    offer: FULL, selected: [cust('rec1', applied)],
    nowMs: NOW + 2 * DAY, operationId: 'cb-other-op', actor: 'MK',
  });
  assert.equal(again.counts.willGrant, 0);
  assert.equal(again.counts.byReason[CB_SKIP.ALREADY_GRANTED], 1);
});

test('部分適用からの再開: Light だけ入っている顧客は Premium 無料だけが対象になる', () => {
  const halfApplied = {
    ...EXPIRED,
    [PROMO_FIELDS.LIGHT_GRANTED]: true,
    [PROMO_FIELDS.LIGHT_GRANTED_AT]: iso(NOW),
    [PROMO_FIELDS.LIGHT_GRANT_OP]: OP,
  };
  const p = buildGrantPlan({
    offer: FULL, selected: [cust('rec1', halfApplied)], nowMs: NOW, operationId: OP, actor: 'MK',
  });
  assert.equal(p.counts.willGrant, 1);
  const t = p.targets[0];
  assert.equal(t.applied.length, 1);
  assert.equal(t.applied[0].grantType, PROMO_GRANT.PREMIUM_TRIAL_30D);
  assert.equal(t.skippedParts[0].reason, 'already_applied');
  assert.equal(PROMO_FIELDS.LIGHT_GRANTED in t.fields, false, '適用済みの Light を再度書いている');
});

// ═══ 有料契約を壊さない ═══════════════════════════════════════════════

test('有料 Premium が trial 終了日より後まで有効なら trial は no-op', () => {
  const paid = { ...EXPIRED, '有効期限': '2099-01-01' };
  const p = plan(TRIAL_ONLY, [cust('rec1', paid)]);
  assert.equal(p.counts.willGrant, 0);
  assert.equal(p.counts.byReason[CB_SKIP.PAID_STRONGER], 1);
});

test('有料 Premium が trial 終了より先に切れるなら trial を付与する（延長になる）', () => {
  const soon = { ...EXPIRED, '有効期限': iso(NOW + 5 * DAY).slice(0, 10) };
  const p = plan(TRIAL_ONLY, [cust('rec1', soon)]);
  assert.equal(p.counts.willGrant, 1);
  assert.equal(p.targets[0].fields[PROMO_FIELDS.TRIAL_UNTIL], iso(NOW + 30 * DAY));
});

test('有効 Premium への複合オファーは Light だけ付与し trial はスキップ（部分適用ではなく設計どおりの no-op）', () => {
  const paid = { ...EXPIRED, '有効期限': '2099-01-01' };
  const p = plan(FULL, [cust('rec1', paid)]);
  assert.equal(p.counts.willGrant, 1);
  const t = p.targets[0];
  assert.deepEqual(t.applied.map((a) => a.grantType), [PROMO_GRANT.LIGHT_LIFETIME]);
  assert.equal(t.skippedParts[0].reason, CB_SKIP.PAID_STRONGER);
  assert.equal(PROMO_FIELDS.TRIAL_UNTIL in t.fields, false);
});

test('計画は課金・契約・三連複・Plus のフィールドを 1 つも含まない', () => {
  const p = plan(FULL, [cust('rec1', EXPIRED), cust('rec2', { ...EXPIRED, Email: 'b@example.com' })]);
  for (const t of p.targets) {
    for (const k of Object.keys(t.fields)) {
      assert.equal(['プラン', 'Plan', 'PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
        'PaymentEmailSent', 'LifetimeSanrenpuku', 'PremiumPlusEligibility', 'WithdrawalRequested'].includes(k),
      false, `${k} を書こうとしている`);
    }
  }
});

// ═══ 上限・入力検証 ═══════════════════════════════════════════════════

test('上限超過・空選択・未知オファーは計画を作らない', () => {
  const many = Array.from({ length: MAX_GRANT_RECORDS + 1 }, (_, i) => cust(`rec${i}`, EXPIRED));
  assert.equal(plan(FULL, many).ok, false);
  assert.match(plan(FULL, many).error, /too_many_records/);
  assert.equal(plan(FULL, []).ok, false);
  assert.equal(plan(null, [cust('rec1', EXPIRED)]).ok, false);
  assert.equal(buildGrantPlan({ offer: FULL, selected: [cust('rec1', EXPIRED)], nowMs: NOW, operationId: '' }).ok, false);
});

// ═══ fingerprint ═════════════════════════════════════════════════════

test('対象が 1 人でも変われば fingerprint が変わる', () => {
  const a = plan(FULL, [cust('rec1', EXPIRED)]);
  const b = plan(FULL, [cust('rec1', EXPIRED), cust('rec2', { ...EXPIRED, Email: 'b@example.com' })]);
  assert.notEqual(a.planFingerprint, b.planFingerprint);
  // 同じ入力なら安定
  assert.equal(a.planFingerprint, plan(FULL, [cust('rec1', EXPIRED)]).planFingerprint);
  // オファーが変われば変わる
  assert.notEqual(a.planFingerprint, plan(LIGHT_ONLY, [cust('rec1', EXPIRED)]).planFingerprint);
  // operationId が変われば変わる
  assert.notEqual(a.planFingerprint,
    computeGrantPlanFingerprint({ offer: FULL, operationId: 'other', targets: a.targets }));
});

// ═══ 取り消し ════════════════════════════════════════════════════════

test('取り消しは promotional grant だけを消す', () => {
  const granted = { ...EXPIRED, LifetimeSanrenpuku: true, ...plan(FULL, [cust('rec1', EXPIRED)]).targets[0].fields };
  const r = buildRevokePlan({
    grantTypes: [PROMO_GRANT.LIGHT_LIFETIME, PROMO_GRANT.PREMIUM_TRIAL_30D],
    selected: [cust('rec1', granted)], nowMs: NOW + DAY, actor: 'MK', reason: '誤付与',
  });
  assert.equal(r.counts.willRevoke, 1);
  const t = r.targets[0];
  assert.equal(assertPlanWritesOnlyGrantFields([t]), true);
  const after = resolvePromotionalGrants({ ...granted, ...t.fields }, NOW + 2 * DAY);
  assert.equal(after.lightLifetime.active, false);
  assert.equal(after.premiumTrial.active, false);
  // 有料契約・三連複は残る
  const state = describeCustomerState({ ...granted, ...t.fields }, NOW + 2 * DAY);
  assert.equal(state.canViewSanrenpuku, true, '三連複買い切りが取り消しで消えた');
});

test('特典を持たない相手の取り消しは not_granted', () => {
  const r = buildRevokePlan({
    grantTypes: [PROMO_GRANT.LIGHT_LIFETIME], selected: [cust('rec1', EXPIRED)], nowMs: NOW,
  });
  assert.equal(r.counts.willRevoke, 0);
  assert.equal(r.counts.byReason[CB_SKIP.NOT_GRANTED], 1);
});

test('取り消しで有料プランや三連複を指定できない（未知の種別は拒否）', () => {
  for (const bad of [['premium'], ['LifetimeSanrenpuku'], [], ['paid_premium']]) {
    assert.equal(buildRevokePlan({ grantTypes: bad, selected: [cust('rec1', EXPIRED)], nowMs: NOW }).ok, false);
  }
});

// ═══ reconcile ═══════════════════════════════════════════════════════

test('reconcile は operationId の適用済み / 未適用を数える', () => {
  const applied = { ...EXPIRED, ...plan(FULL, [cust('rec1', EXPIRED)]).targets[0].fields };
  const r = reconcileOperation({
    operationId: OP,
    records: [
      { recordId: 'rec1', fields: applied },
      { recordId: 'rec2', fields: EXPIRED },
    ],
    nowMs: NOW,
  });
  assert.equal(r.counts.applied, 1);
  assert.equal(r.counts.missing, 1);
  assert.deepEqual(r.missing, ['rec2']);
});

test('chunkTargets は 10 件ずつに分ける（Airtable batch 上限）', () => {
  const list = Array.from({ length: 23 }, (_, i) => ({ recordId: `r${i}` }));
  const chunks = chunkTargets(list);
  assert.deepEqual(chunks.map((c) => c.length), [10, 10, 3]);
});

// ═══ 表示 ════════════════════════════════════════════════════════════

test('describeCustomerState は課金と特典を分けて出す', () => {
  const s = describeCustomerState(EXPIRED, NOW);
  assert.match(s.paid, /期限切れ/);
  assert.equal(s.promo, '特典なし');
  const granted = describeCustomerState({ ...EXPIRED, [PROMO_FIELDS.LIGHT_GRANTED]: true }, NOW);
  assert.match(granted.text, /期限切れ/);
  assert.match(granted.text, /Light 永久無料/);
});

test('planCustomerGrant は before / after を返す（管理画面の確認用）', () => {
  const t = planCustomerGrant({
    offer: LIGHT_ONLY, recordId: 'rec1', fields: EXPIRED, nowMs: NOW, operationId: OP, actor: 'MK',
  });
  assert.ok(t.before.text);
  assert.ok(t.after.text);
  assert.notEqual(t.before.text, t.after.text);
});
