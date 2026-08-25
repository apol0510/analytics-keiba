/**
 * legacySanrenpukuNormalization.test.mjs — 旧三連複会員の Light 永久無料化
 *   node --test src/lib/entitlements/legacySanrenpukuNormalization.test.mjs
 *
 * 仕様の正本: docs/spec.md §旧三連複会員は Light 永久無料として再スタートする ／
 *             docs/decisions.md 2026-08-25。
 *
 * 守る条件:
 *   1. 正規化後は **Light だけ**見られる（馬単 Premium / 三連複は復活させない）
 *   2. 退会済みの会員は **Customers に退会履歴が残らない**状態へ正規化される
 *      （監査に必要な履歴は別テーブルにあり、そちらには触れない）
 *   3. `LifetimeSanrenpuku` は**付与しない**
 *   4. Premium Plus は**別概念**。管理者が明示指定すれば販売対象にできる
 *   5. **他会員には一切影響しない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLegacySanrenpukuNormalization, isNormalizationTarget,
  NORMALIZE_SKIP, NEVER_WRITE_FIELDS, CONTRACT_WRITABLE_FIELDS, WITHDRAWAL_STATE_FIELDS,
} from './legacySanrenpukuNormalization.js';
import { resolveEntitlements, fromAirtableFields } from './resolveEntitlements.js';
import { resolveMembership, MEMBER_TYPE } from '../auth/memberResolution.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { resolveUpsellForCustomer } from '../upsell/upsellTarget.js';
import { resolveCampaignOfferIdsFor } from '../promotions/campaignOffers.js';

const NOW = Date.parse('2026-08-25T12:00:00+09:00');
const OP = 'legacy-srp-to-light-2026-08-25-0001';

/** 対象 18 名の実際の形（本番の read-only 実測に合わせた 2 パターン）*/
const ACTIVE_LEGACY = {
  Email: 'a@example.invalid',
  'プラン': 'Premium Sanrenpuku',
  PlanType: '',
  '有効期限': '2026-01-18',
  Status: '',
  'ポイント': 635,
};
/** 退会申請済み + カムバックの Light 30 日無料を受け取っている 8 名の形 */
const WITHDRAWN_LEGACY = {
  ...ACTIVE_LEGACY,
  'プラン': 'Premium Combo',
  WithdrawalRequested: true,
  WithdrawalDate: '2026-01-04T00:00:00.000Z',
  WithdrawalReason: '理由未記入',
  LightGrantUntil: '2026-09-03T03:38:11.307Z',
  LightGrantedAt: '2026-08-04T03:38:11.307Z',
  LightGrantOp: 'cb-light-30d-free-2026-08-04-1fcefd75',
};

const normalize = (fields, op = OP) => buildLegacySanrenpukuNormalization({
  fields, now: NOW, operationId: op, actor: 'admin', source: 'legacy-sanrenpuku-to-light-lifetime',
});
/** 正規化を適用した後のレコード */
const applied = (fields, op = OP) => ({ ...fields, ...normalize(fields, op).fields });

// ── 1. 正規化後にできること / できないこと ────────────────────────────
test('【要件】正規化後は Light だけ見られる（馬単・三連複は復活させない）', () => {
  for (const [label, base] of [['通常', ACTIVE_LEGACY], ['退会済み', WITHDRAWN_LEGACY]]) {
    const e = resolveEntitlements(fromAirtableFields(applied(base)), NOW);
    assert.equal(e.canLogin, true, `${label}: ログインできない`);
    assert.equal(e.canViewLight, true, `${label}: Light が開かない`);
    assert.equal(e.canViewPremium, false, `${label}: 馬単 Premium が復活している`);
    assert.equal(e.canViewSanrenpuku, false, `${label}: 三連複が復活している`);
    assert.equal(e.paidPremiumActive, false, `${label}: 有料 Premium 扱いになっている`);
    assert.equal(e.canPurchaseSanrenpuku, false, `${label}: 三連複の購入 CTA が出ている`);
    assert.equal(e.effectiveTier, 'light', `${label}: 実効ティアが light でない`);
    assert.equal(e.promo.lightLifetime, true, `${label}: Light が永久無料になっていない`);
  }
});

test('【要件】Light 永久無料は期限が来ても失われない', () => {
  const far = Date.parse('2099-01-01T00:00:00+09:00');
  const e = resolveEntitlements(fromAirtableFields(applied(ACTIVE_LEGACY)), far);
  assert.equal(e.canViewLight, true, '永久無料が失効している');
  assert.equal(e.canViewPremium, false);
});

test('【要件】正規化後はログインすると Light の会員として扱われる', () => {
  const m = resolveMembership({ fields: applied(ACTIVE_LEGACY), recordId: 'recX', now: NOW });
  assert.equal(m.memberType, MEMBER_TYPE.PAID, '有料相当セッションが出ない（Light ページが開かない）');
  assert.equal(m.normalizedPlan, 'light', 'Light 以外のセッションが出ている');
  assert.equal(m.lifetimeSanrenpuku, false, '三連複の権利がセッションに載っている');
  assert.equal(m.entitlementSource, 'promotional_grant', '課金契約として扱われている');
});

// ── 2. 退会済み 8 名の復帰 ──────────────────────────────────────────
test('【要件】退会済みの会員が管理画面で退会扱いされなくなる', () => {
  const before = resolveCustomerMarketing({ fields: WITHDRAWN_LEGACY, nowMs: NOW });
  assert.equal(before.withdrawn, true, '前提: 退会扱い');

  const after = resolveCustomerMarketing({ fields: applied(WITHDRAWN_LEGACY), nowMs: NOW });
  assert.equal(after.withdrawn, false, '管理画面でまだ退会扱いになっている');
  assert.equal(resolveEntitlements(fromAirtableFields(applied(WITHDRAWN_LEGACY)), NOW).canLogin, true);
});

test('【要件】Customers に退会履歴を残さない（フラグ・日付・理由をすべて空にする）', () => {
  const out = normalize(WITHDRAWN_LEGACY).fields;
  assert.equal(out.WithdrawalRequested, false, '退会フラグが残っている');
  assert.equal(out.WithdrawalDate, null, '退会日が残っている');
  assert.equal(out.WithdrawalReason, null, '退会理由が残っている');
});

test('【要件】正規化後、退会関連の判定・表示が 1 つも残らない', async () => {
  const after = applied(WITHDRAWN_LEGACY);
  // 判定
  assert.equal(resolveCustomerMarketing({ fields: after, nowMs: NOW }).withdrawn, false);
  assert.equal(resolveEntitlements(fromAirtableFields(after), NOW).canLogin, true);
  assert.equal(
    resolveEntitlements(fromAirtableFields(after), NOW).reasons.includes('WITHDRAWAL_REQUESTED'),
    false, '退会を理由に権利を絞っている',
  );
  // 表示（タイムライン）に退会が出ない。
  // ⚠️ `record: { fields }` の形で渡す（`fields` 直渡しだと何も出ず、検査が素通りする）
  const { buildCustomerTimeline } = await import('../marketing/customerTimeline.js');
  const timelineOf = (f) => JSON.stringify(
    buildCustomerTimeline({ record: { id: 'recW', fields: f }, nowMs: NOW }),
  );
  assert.ok(timelineOf(WITHDRAWN_LEGACY).includes('退会'), '前提: 変更前は退会が出ている');
  assert.equal(timelineOf(after).includes('退会'), false, 'タイムラインに退会が残っている');

  // カルテにも退会が残らない（`contract.withdrawn` / `contract.withdrawalDate`）
  const { buildCustomerDossier } = await import('../marketing/customerDossier.js');
  const dossierOf = (f) => buildCustomerDossier({ record: { id: 'recW', fields: f }, nowMs: NOW });
  const dBefore = dossierOf(WITHDRAWN_LEGACY);
  assert.equal(dBefore.contract.withdrawn, true, '前提: 変更前はカルテが退会を出している');
  assert.ok(dBefore.contract.withdrawalDate, '前提: 変更前は退会日が出ている');

  const dAfter = dossierOf(after);
  assert.equal(dAfter.contract.withdrawn, false, 'カルテが退会扱いのまま');
  assert.ok(!dAfter.contract.withdrawalDate, 'カルテに退会日が残っている');
  assert.equal(JSON.stringify(dAfter.contract).includes('退会'), false, 'カルテに退会の記述が残っている');
  // 値そのものが空
  for (const f of ['WithdrawalDate', 'WithdrawalReason', 'CancelledAt']) {
    assert.ok(after[f] === null || after[f] === undefined || after[f] === '', `${f} が残っている`);
  }
  assert.notEqual(after.WithdrawalRequested, true);
});

test('退会していない会員には退会列を 1 つも書かない', () => {
  const out = normalize(ACTIVE_LEGACY).fields;
  for (const f of WITHDRAWAL_STATE_FIELDS) {
    assert.equal(f in out, false, `${f} を無駄に書いている`);
  }
});

test('CancelledAt は値があるときだけ空にする', () => {
  assert.equal('CancelledAt' in normalize(WITHDRAWN_LEGACY).fields, false, '空の列を書いている');
  const withCancel = { ...WITHDRAWN_LEGACY, CancelledAt: '2026-01-04T00:00:00.000Z' };
  assert.equal(normalize(withCancel).fields.CancelledAt, null, '退会日時が残っている');
});

test('【要件】決済・入金・監査の履歴には触れない', () => {
  const rich = {
    ...WITHDRAWN_LEGACY,
    PaidAt: '2025-06-01T00:00:00.000Z', PaymentConfirmed: true, PaymentMethod: 'Bank Transfer',
    PaymentEmailSent: true, PaymentEmailStatus: 'delivered', SanrenpukuPaidAt: '2025-06-01T00:00:00.000Z',
    Memo: '運用メモ', Source: 'customer-import:imp-001', 'ポイント': 635, '登録日': '2025-01-01',
  };
  const out = normalize(rich).fields;
  for (const f of ['PaidAt', 'PaymentConfirmed', 'PaymentMethod', 'PaymentEmailSent', 'PaymentEmailStatus',
    'SanrenpukuPaidAt', 'Memo', 'Source', 'ポイント', '登録日', '有効期限']) {
    assert.equal(f in out, false, `${f} を書き換えている`);
  }
});

test('【要件】rollback で変更前の退会状態を復元できる', () => {
  const built = normalize(WITHDRAWN_LEGACY);
  // changes には「変更前の値」が全列ぶん入っている
  const restore = Object.fromEntries(built.changes.map((c) => [c.field, c.before]));
  const after = { ...WITHDRAWN_LEGACY, ...built.fields };
  const rolledBack = { ...after, ...restore };

  for (const f of ['WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason']) {
    assert.deepEqual(rolledBack[f], WITHDRAWN_LEGACY[f], `${f} が戻っていない`);
  }
  assert.equal(rolledBack['プラン'], WITHDRAWN_LEGACY['プラン'], '会員ランクが戻っていない');
  assert.equal(rolledBack.LightGrantLifetime, null, '永久無料が残っている');
  assert.equal(rolledBack.LightGrantUntil, WITHDRAWN_LEGACY.LightGrantUntil, '元の 30 日無料が戻っていない');
  // 判定も**変更前とまったく同じ**に戻る（値を並べ直すのではなく判定で確かめる）
  const before = resolveEntitlements(fromAirtableFields(WITHDRAWN_LEGACY), NOW);
  const back = resolveEntitlements(fromAirtableFields(rolledBack), NOW);
  for (const k of ['canLogin', 'canViewFree', 'canViewLight', 'canViewPremium',
    'canViewSanrenpuku', 'canPurchaseSanrenpuku', 'effectiveTier']) {
    assert.deepEqual(back[k], before[k], `${k} が変更前に戻っていない`);
  }
  assert.equal(resolveCustomerMarketing({ fields: rolledBack, nowMs: NOW }).withdrawn, true,
    '退会扱いに戻っていない');
});

// ── 3. 書き込む列を固定する ────────────────────────────────────────
test('【回帰】選択式の列は null で空にする（空文字だと Airtable が 422 で落ちる）', () => {
  // 2026-08-26 の本番実行が 1 件目で停止した原因。
  //   422 INVALID_MULTIPLE_CHOICE_OPTIONS / create new select option
  // `PlanType` は singleSelect なので、空文字を送ると空の選択肢を作ろうとして失敗する。
  // **選択式を空にするときは null**。
  const out = normalize({ ...ACTIVE_LEGACY, PlanType: 'Monthly' }).fields;
  assert.equal(out.PlanType, null);
  assert.notEqual(out.PlanType, '', '空文字を送ると本番で 422 になる');
  assert.equal(out['プラン'], 'Free', '選択式には実在する選択肢だけを書く');
});

test('【要件】LifetimeSanrenpuku は付与しない', () => {
  for (const base of [ACTIVE_LEGACY, WITHDRAWN_LEGACY]) {
    const out = normalize(base).fields;
    assert.equal('LifetimeSanrenpuku' in out, false, '三連複の恒久権を付与している');
    assert.equal('三連複Lifetime' in out, false);
  }
});

test('契約・課金・履歴の列を 1 つも書かない（退会列は正規化対象なので除く）', () => {
  for (const base of [ACTIVE_LEGACY, WITHDRAWN_LEGACY]) {
    const out = normalize(base).fields;
    for (const f of NEVER_WRITE_FIELDS) {
      assert.equal(f in out, false, `${f} を書き換えている`);
    }
  }
});

test('書き込む列は「無料権利 + 契約の正規化」だけ / 変わる列しか書かない', () => {
  const out = normalize(WITHDRAWN_LEGACY).fields;
  const allowed = new Set([...CONTRACT_WRITABLE_FIELDS, ...WITHDRAWAL_STATE_FIELDS]);
  for (const k of Object.keys(out).filter((x) => !x.startsWith('LightGrant') && x !== 'ComebackGrantSource')) {
    assert.ok(allowed.has(k), `${k} は書いてよい列ではない`);
  }
  assert.equal(out['プラン'], 'Free', '会員ランクを Free にしていない（旧三連複ティアが残る）');
  assert.equal(out.WithdrawalRequested, false);
  assert.equal(out.LightGrantLifetime, true);
  assert.equal(out.LightGrantUntil, null, '永久無料なのに終了日が残っている');
  // 既に空の列は書かない（不要な更新で監査を汚さない）
  assert.equal('PlanType' in out, false, '同じ値を書き戻している');

  // 値が違うときだけ書く
  const monthly = normalize({ ...ACTIVE_LEGACY, PlanType: 'Monthly' }).fields;
  assert.equal(monthly.PlanType, null, 'Free になったのに課金サイクルが残っている');

  // 退会していない会員には退会列を書かない
  assert.equal('WithdrawalRequested' in normalize(ACTIVE_LEGACY).fields, false);
});

test('30 日無料を持っている会員は「期限付き → 永久」の強化として上書きされる', () => {
  const out = normalize(WITHDRAWN_LEGACY).fields;
  assert.equal(out.LightGrantOp, OP, '付与の操作 ID が更新されていない');
  assert.equal(out.LightGrantRevokedAt, null);
});

test('同じ操作 ID の再実行は書き込みを増やさない（冪等）', () => {
  const once = applied(WITHDRAWN_LEGACY);
  const twice = normalize(once);
  assert.ok(twice.skipped || Object.keys(twice.fields || {}).length === 0
    || twice.skipped === undefined, '二度目の結果が壊れている');
  // プランが Free になっているので、そもそも対象から外れる
  assert.equal(isNormalizationTarget(once, NOW).ok, false);
  assert.equal(isNormalizationTarget(once, NOW).reason, NORMALIZE_SKIP.NOT_LEGACY_PLAN);
});

// ── 4. 対象の絞り込み（fail closed）────────────────────────────────
test('買い切り保有者・期限内・停止アカウントは対象にしない', () => {
  const cases = [
    ['買い切り保有', { ...ACTIVE_LEGACY, LifetimeSanrenpuku: true }, NORMALIZE_SKIP.HAS_LIFETIME_SANRENPUKU],
    ['PlanType=Lifetime', { ...ACTIVE_LEGACY, PlanType: 'Lifetime' }, NORMALIZE_SKIP.LIFETIME_BILLING],
    ['まだ有効', { ...ACTIVE_LEGACY, '有効期限': '2098-07-29' }, NORMALIZE_SKIP.NOT_EXPIRED],
    ['期限が無い', { ...ACTIVE_LEGACY, '有効期限': '' }, NORMALIZE_SKIP.NO_EXPIRY],
    ['停止アカウント', { ...ACTIVE_LEGACY, Status: 'suspended' }, NORMALIZE_SKIP.SUSPENDED_STATUS],
    ['そもそも Free', { ...ACTIVE_LEGACY, 'プラン': 'Free' }, NORMALIZE_SKIP.NOT_LEGACY_PLAN],
    ['有効な Premium', { ...ACTIVE_LEGACY, 'プラン': 'Premium', '有効期限': '2027-01-01' }, NORMALIZE_SKIP.NOT_LEGACY_PLAN],
  ];
  for (const [label, fields, reason] of cases) {
    assert.equal(isNormalizationTarget(fields, NOW).ok, false, `${label} が対象になっている`);
    assert.equal(isNormalizationTarget(fields, NOW).reason, reason, label);
    assert.deepEqual(normalize(fields), { skipped: reason }, `${label}: 書き込みを組み立てている`);
  }
});

test('操作 ID が無ければ何も組み立てない（fail closed）', () => {
  assert.equal(normalize(ACTIVE_LEGACY, ''), null);
  assert.equal(buildLegacySanrenpukuNormalization({ fields: null, now: NOW, operationId: OP }), null);
});

// ── 5. Premium Plus は別概念 ──────────────────────────────────────
test('【要件】Light 永久無料でも、明示指定すれば Premium Plus の販売対象にできる', () => {
  const member = { ...applied(ACTIVE_LEGACY), UpsellTarget: 'plus' };
  const v = resolveUpsellForCustomer({ fields: member, nowMs: NOW });
  assert.equal(v.plus.showPurchaseCta, true, 'Light 永久無料だから、を理由に Plus を塞いでいる');
});

test('【要件】指定が無ければ Plus は出ない（自動的に配らない）', () => {
  const v = resolveUpsellForCustomer({ fields: applied(ACTIVE_LEGACY), nowMs: NOW });
  assert.equal(v.plus.showPurchaseCta, false, '指定が無いのに Plus が出ている');
});

test('販売停止（blocked）は明示指定より強い', () => {
  const member = { ...applied(ACTIVE_LEGACY), UpsellTarget: 'plus', PremiumPlusEligibility: 'blocked' };
  const v = resolveUpsellForCustomer({ fields: member, nowMs: NOW });
  assert.equal(v.plus.showPurchaseCta, false, 'blocked を無視して売っている');
});

// ── 6. キャンペーン割引の出し分け ──────────────────────────────────
test('正規化後は Premium の割引が案内される（三連複保有者として扱われない）', () => {
  const e = resolveEntitlements(fromAirtableFields(applied(ACTIVE_LEGACY)), NOW);
  const ids = resolveCampaignOfferIdsFor(e);
  assert.ok(ids.length > 0, '案内する割引が 1 件も無い');
  assert.equal(ids.includes('campaign-light-monthly-500off'), false, '既に持っている Light を勧めている');
});

// ── 7. 他会員へ影響しない ──────────────────────────────────────────
test('【要件】他の会員の判定は 1 つも変わらない', () => {
  const OTHERS = {
    '有料 Premium': { 'プラン': 'Premium', PlanType: 'Annual', '有効期限': '2027-07-14', Status: 'active' },
    '三連複 買い切り': { 'プラン': 'Premium', PlanType: 'Annual', '有効期限': '2027-07-14', Status: 'active', LifetimeSanrenpuku: true },
    '有効な旧三連複': { 'プラン': 'Premium Sanrenpuku', PlanType: 'Lifetime', '有効期限': '2099-12-31', Status: 'active' },
    '通常の無料会員': { 'プラン': 'Free', Status: '' },
    'Light 会員': { 'プラン': 'Light', PlanType: 'Monthly', '有効期限': '2027-01-01', Status: 'active' },
  };
  const expected = {
    '有料 Premium': { canViewPremium: true, canViewSanrenpuku: false, canViewLight: true },
    '三連複 買い切り': { canViewPremium: true, canViewSanrenpuku: true, canViewLight: true },
    '有効な旧三連複': { canViewPremium: true, canViewSanrenpuku: true, canViewLight: true },
    '通常の無料会員': { canViewPremium: false, canViewSanrenpuku: false, canViewLight: false },
    'Light 会員': { canViewPremium: false, canViewSanrenpuku: false, canViewLight: true },
  };
  for (const [label, fields] of Object.entries(OTHERS)) {
    // 正規化の対象にならない
    assert.equal(isNormalizationTarget(fields, NOW).ok, false, `${label} が正規化の対象になっている`);
    // 判定も従来どおり
    const e = resolveEntitlements(fromAirtableFields(fields), NOW);
    for (const [k, v] of Object.entries(expected[label])) {
      assert.equal(e[k], v, `${label}: ${k} が変わっている`);
    }
  }
});
