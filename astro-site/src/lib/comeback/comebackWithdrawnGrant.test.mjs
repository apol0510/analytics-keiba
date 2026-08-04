/**
 * comebackWithdrawnGrant.test.mjs — 退会した元会員をカムバック施策で扱えること
 *   node --test src/lib/comeback/comebackWithdrawnGrant.test.mjs
 *
 * ── 何を証明するか ────────────────────────────────────────────
 *   1. 退会者にもカムバックの Light 30 日無料を**付与できる**
 *   2. 付与した特典が**ログインで実際に効く**（付与できても使えない、を作らない）
 *   3. **通常の無料付与は従来どおり**退会者を弾く（施策限定であることの証明）
 *   4. 配信停止・停止・テスト・メール不正・ForceLogout は**緩めない**
 *   5. 同一メールアドレスの重複レコードは **1 件だけ**扱う
 *   6. 二重実行しても二重付与にならない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComebackPlan, checkGrantable, planCustomer, CB_SKIP, CB_SKIP_LABEL, reconcileOperation,
} from './comebackGrantPlan.js';
import { resolveComebackCustomer } from './comebackAudience.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';
import { resolveGrantEligibility, GRANT_ELIGIBILITY } from '../entitlements/grantEligibility.js';
import { resolveMembership, MEMBER_TYPE, MEMBER_REASON, MEMBER_SOURCE } from '../auth/memberResolution.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { buildCampaignPlan } from '../marketing/campaignSend.js';
import { getCampaign } from '../marketing/campaignCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';

const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
const DAY = 86400000;
const OP = 'cb-light-30d-free-2026-08-04-abcdef01';
const LIGHT30 = resolveOffer('light-30d-free', {}).offer;
const LIGHT_LIFETIME = resolveOffer('light-lifetime-free', {}).offer;
const PREMIUM30 = resolveOffer('premium-30d-free', {}).offer;

/** 退会した元 Premium 会員（37 名と同じ形）*/
const withdrawnMember = (over = {}) => ({
  Email: 'a@example.com',
  '氏名': 'テスト',
  'プラン': 'Premium',
  Status: 'active',
  '有効期限': '2026-01-31',
  WithdrawalRequested: true,
  ...over,
});

const plan = (selected, offers = [LIGHT30]) => buildComebackPlan({
  grantOffers: offers, purchaseOffer: null, selected,
  existingOffers: [], nowMs: NOW, operationId: OP, actor: 'test', source: 'test',
});

// ── 1. 退会者へ付与できる ──────────────────────────────────────

test('退会者にもカムバックの Light 30日無料を付与できる', () => {
  const r = plan([{ recordId: 'rec1', fields: withdrawnMember() }]);
  assert.equal(r.ok, true);
  assert.equal(r.counts.willGrant, 1, '退会者が対象から外れている');
  assert.equal(r.counts.skipped, 0);
  const fields = r.targets[0].grantFields;
  assert.ok(fields.LightGrantUntil, 'Light の期限が書かれていない');
  assert.equal(fields.LightGrantLifetime, false, '永久無料になっている');
  assert.equal(fields.LightGrantOp, OP);
});

test('退会・課金停止の記録は 1 つも書き換えない', () => {
  const r = plan([{ recordId: 'rec1', fields: withdrawnMember() }]);
  const written = Object.keys(r.targets[0].grantFields);
  for (const forbidden of [
    'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason', 'ForceLogout',
    'プラン', 'Plan', 'PlanType', 'Status', '有効期限', 'PaidAt', 'LifetimeSanrenpuku',
  ]) {
    assert.equal(written.includes(forbidden), false, `${forbidden} を書こうとしている`);
  }
});

test('一覧の「今回付与できる」も施策を選んだときだけ変わる', () => {
  const f = withdrawnMember();
  assert.equal(resolveGrantEligibility(f, NOW).status, GRANT_ELIGIBILITY.BLOCKED, '既定で付与可能になっている');
  assert.equal(resolveGrantEligibility(f, NOW, { allowWithdrawn: true }).status, GRANT_ELIGIBILITY.GRANTABLE);

  assert.equal(resolveComebackCustomer({ fields: f, nowMs: NOW }).grantable, false);
  assert.equal(resolveComebackCustomer({ fields: f, nowMs: NOW, allowWithdrawn: true }).grantable, true);
});

// ── 2. 付与した特典がログインで効く ────────────────────────────

test('付与後、退会者は Light としてログインできる（付与＝使える）', () => {
  const r = plan([{ recordId: 'rec1', fields: withdrawnMember() }]);
  const after = { ...withdrawnMember(), ...r.targets[0].grantFields };

  const m = resolveMembership({ fields: after, recordId: 'rec1', now: NOW });
  assert.equal(m.memberType, MEMBER_TYPE.PAID, '付与したのに無料会員のまま');
  assert.equal(m.normalizedPlan, 'light');
  assert.equal(m.reason, MEMBER_REASON.PROMO_LIGHT_GRANT);
  assert.equal(m.entitlementSource, MEMBER_SOURCE.PROMOTIONAL_GRANT, '支払い実績として扱われている');

  const e = resolveEntitlements(fromAirtableFields(after), NOW);
  assert.equal(e.canViewLight, true);
  assert.equal(e.promo.lightActive, true);
});

test('期間が終われば自動的に無料会員へ戻る（会員資格の自動復帰ではない）', () => {
  const r = plan([{ recordId: 'rec1', fields: withdrawnMember() }]);
  const after = { ...withdrawnMember(), ...r.targets[0].grantFields };
  const later = NOW + 31 * DAY;

  const m = resolveMembership({ fields: after, recordId: 'rec1', now: later });
  assert.equal(m.memberType, MEMBER_TYPE.FREE);
  assert.equal(m.normalizedPlan, 'free');
  assert.equal(m.reason, MEMBER_REASON.WITHDRAWAL_REQUESTED);
  assert.equal(resolveEntitlements(fromAirtableFields(after), later).canViewLight, false);
});

test('退会者に戻すのは Light だけ（Premium・三連複・購入資格は戻さない）', () => {
  const after = {
    ...withdrawnMember({ LifetimeSanrenpuku: true, 'プラン': 'Premium Sanrenpuku' }),
    LightGrantUntil: new Date(NOW + 30 * DAY).toISOString(),
    LightGrantedAt: new Date(NOW).toISOString(),
    LightGrantOp: OP,
    // 万一 Premium 特典が残っていても退会者には効かせない
    PremiumGrantUntil: new Date(NOW + 30 * DAY).toISOString(),
    PremiumGrantedAt: new Date(NOW).toISOString(),
    PremiumGrantOp: OP,
  };
  const e = resolveEntitlements(fromAirtableFields(after), NOW);
  assert.equal(e.canViewLight, true, 'Light が開いていない');
  assert.equal(e.canViewPremium, false, 'Premium が復活している');
  assert.equal(e.promo.premiumActive, false, 'Premium 無料特典が有効になっている');
  assert.equal(e.canViewSanrenpuku, false, '三連複買い切りが復活している');
  assert.equal(e.canPurchaseSanrenpuku, false, '購入資格が復活している');
  assert.equal(e.paidPremiumActive, false, '課金契約が復活している');

  const m = resolveMembership({ fields: after, recordId: 'rec1', now: NOW });
  assert.equal(m.normalizedPlan, 'light', 'Premium で復帰している');
});

// ── 3. 通常の無料付与は従来どおり ──────────────────────────────

test('通常の無料付与では退会者は従来どおり弾かれる', () => {
  const f = withdrawnMember();
  assert.equal(checkGrantable(f).ok, false);
  assert.equal(checkGrantable(f).reason, CB_SKIP.WITHDRAWAL_BLOCKED);

  for (const offer of [LIGHT_LIFETIME, PREMIUM30]) {
    const r = plan([{ recordId: 'rec1', fields: f }], [offer]);
    assert.equal(r.counts.willGrant, 0, `${offer.offerId} が退会者へ付与できてしまう`);
    assert.equal(r.skipped[0].reason, CB_SKIP.WITHDRAWAL_BLOCKED);
  }
});

test('退会していない顧客の判定は一切変わらない', () => {
  const f = withdrawnMember({ WithdrawalRequested: false });
  assert.equal(checkGrantable(f).ok, true);
  assert.equal(checkGrantable(f, { allowWithdrawn: true }).ok, true);
  const m = resolveMembership({ fields: f, recordId: 'rec1', now: NOW });
  assert.equal(m.memberType, MEMBER_TYPE.FREE, '期限切れ会員の判定が変わっている');
});

// ── 4. 緩めないもの ────────────────────────────────────────────

test('ForceLogout・停止・テスト・メール不正は施策でも弾く', () => {
  const cases = [
    ['ForceLogout', withdrawnMember({ ForceLogout: true }), CB_SKIP.FORCE_LOGOUT_BLOCKED],
    ['停止', withdrawnMember({ Status: 'suspended' }), CB_SKIP.ACCOUNT_SUSPENDED],
    ['テスト', withdrawnMember({ Status: 'test' }), CB_SKIP.ACCOUNT_SUSPENDED],
    ['テストプラン', withdrawnMember({ 'プラン': 'Test' }), CB_SKIP.ACCOUNT_SUSPENDED],
    ['メール不正', withdrawnMember({ Email: 'not-an-email' }), CB_SKIP.DATA_INCOMPLETE],
    ['メール未登録', withdrawnMember({ Email: '' }), CB_SKIP.DATA_INCOMPLETE],
  ];
  for (const [label, fields, reason] of cases) {
    const r = plan([{ recordId: 'rec1', fields }]);
    assert.equal(r.counts.willGrant, 0, `${label} へ付与できてしまう`);
    assert.equal(r.skipped[0].reason, reason, `${label} の理由が違う`);
  }
});

test('ForceLogout の退会者はログインでも Light を認めない', () => {
  const after = {
    ...withdrawnMember({ ForceLogout: true }),
    LightGrantUntil: new Date(NOW + 30 * DAY).toISOString(),
    LightGrantedAt: new Date(NOW).toISOString(),
    LightGrantOp: OP,
  };
  assert.equal(resolveMembership({ fields: after, recordId: 'r', now: NOW }).memberType, MEMBER_TYPE.DENIED);
  assert.equal(resolveEntitlements(fromAirtableFields(after), NOW).canViewLight, false);
});

test('配信停止・バウンスは送信側で従来どおり除外される（付与とは別軸）', () => {
  const campaign = getCampaign('comeback-light-30d-granted');
  const mk = (fields) => ({
    recordId: 'rec1', fields,
    marketing: resolveCustomerMarketing({ fields, nowMs: NOW }),
  });
  const run = (selected, opts = {}) => buildCampaignPlan({
    campaign, selected, deliveredKeys: new Set(),
    providerSuppressed: opts.suppressed || new Set(),
    softBounced: opts.soft || new Set(),
    brand: 'analytics-keiba', fromEmail: 'info@example.com', nowMs: NOW,
  });

  // 退会しているだけなら送れる（AK 仕様: 退会は受信拒否ではない）
  assert.equal(run([mk(withdrawnMember())]).counts.recipients, 1);
  // 配信停止は送らない
  assert.equal(run([mk(withdrawnMember({ UnsubscribedAnalyticsKeiba: true }))]).counts.recipients, 0);
  // provider suppression は送らない
  assert.equal(run([mk(withdrawnMember())], { suppressed: new Set(['a@example.com']) }).counts.recipients, 0);
  // ソフトバウンスも販促では送らない
  assert.equal(run([mk(withdrawnMember())], { soft: new Set(['a@example.com']) }).counts.recipients, 0);
});

test('provider suppression を確認できないときは計画自体を作らない', () => {
  const r = buildCampaignPlan({
    campaign: getCampaign('comeback-light-30d-granted'),
    selected: [], providerSuppressed: null,
    brand: 'analytics-keiba', fromEmail: 'info@example.com', nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'provider_suppression_unavailable');
});

// ── 5. 同一メールアドレスの重複レコード ────────────────────────

test('同じメールアドレスの別レコードは 1 件だけ付与する', () => {
  const r = plan([
    { recordId: 'rec1', fields: withdrawnMember() },
    { recordId: 'rec2', fields: withdrawnMember({ '氏名': '別レコード' }) },
    { recordId: 'rec3', fields: withdrawnMember({ Email: 'A@Example.com  ' }) }, // 大小・空白違い
  ]);
  assert.equal(r.counts.willGrant, 1, '同一人物へ 2 回以上付与している');
  assert.equal(r.counts.byReason[CB_SKIP.DUPLICATE_EMAIL], 2, '重複が理由付きで記録されていない');
  assert.equal(r.targets[0].recordId, 'rec1', '先頭のレコードを採用していない');
});

test('落ちるレコードがアドレスを先取りしない（正常な方が付与される）', () => {
  const r = plan([
    // 先頭は停止アカウント。ここで枠を取ってしまうと下の正常レコードが落ちる
    { recordId: 'recNG', fields: withdrawnMember({ Status: 'suspended' }) },
    { recordId: 'recOK', fields: withdrawnMember() },
  ]);
  assert.equal(r.counts.willGrant, 1, '正常なレコードまで落ちている');
  assert.equal(r.targets[0].recordId, 'recOK');
  assert.equal(r.counts.byReason[CB_SKIP.ACCOUNT_SUSPENDED], 1);
  assert.equal(r.counts.byReason[CB_SKIP.DUPLICATE_EMAIL], undefined);
});

test('Customers 全体で重複しているアドレスへは付与しない（ログインできないため）', () => {
  // 片方だけ選んでも落とす。重複アドレスは customerLookup が CONFLICT で
  // ログインを拒否するので、付与しても本人は使えない
  const r = buildComebackPlan({
    grantOffers: [LIGHT30], purchaseOffer: null,
    selected: [{ recordId: 'rec1', fields: withdrawnMember() }],
    existingOffers: [], duplicateEmails: new Set(['a@example.com']),
    nowMs: NOW, operationId: OP, actor: 'test', source: 'test',
  });
  assert.equal(r.counts.willGrant, 0, '重複アドレスへ付与している');
  assert.equal(r.skipped[0].reason, CB_SKIP.DUPLICATE_EMAIL);
});

test('重複していないアドレスは duplicateEmails を渡しても影響を受けない', () => {
  const r = buildComebackPlan({
    grantOffers: [LIGHT30], purchaseOffer: null,
    selected: [{ recordId: 'rec1', fields: withdrawnMember() }],
    existingOffers: [], duplicateEmails: new Set(['other@example.com']),
    nowMs: NOW, operationId: OP, actor: 'test', source: 'test',
  });
  assert.equal(r.counts.willGrant, 1);
});

test('別アドレスは当然それぞれ付与する', () => {
  const r = plan([
    { recordId: 'rec1', fields: withdrawnMember({ Email: 'a@example.com' }) },
    { recordId: 'rec2', fields: withdrawnMember({ Email: 'b@example.com' }) },
  ]);
  assert.equal(r.counts.willGrant, 2);
  assert.equal(r.counts.byReason[CB_SKIP.DUPLICATE_EMAIL], undefined);
});

test('案内メールも同一アドレスへ 1 通だけ', () => {
  const campaign = getCampaign('comeback-light-30d-granted');
  const one = (recordId) => ({
    recordId, fields: withdrawnMember(),
    marketing: resolveCustomerMarketing({ fields: withdrawnMember(), nowMs: NOW }),
  });
  const r = buildCampaignPlan({
    campaign, selected: [one('rec1'), one('rec2')],
    deliveredKeys: new Set(), providerSuppressed: new Set(),
    brand: 'analytics-keiba', fromEmail: 'info@example.com', nowMs: NOW,
  });
  assert.equal(r.counts.recipients, 1, '同じアドレスへ 2 通送ろうとしている');
  assert.equal(r.counts.byReason.duplicate, 1);
});

// ── 6. 冪等性（二重実行しても二重にならない）──────────────────

test('付与済みの相手へ同じ内容をもう一度出しても増えない', () => {
  const first = plan([{ recordId: 'rec1', fields: withdrawnMember() }]);
  const after = { ...withdrawnMember(), ...first.targets[0].grantFields };

  // 同じ操作の再実行 → 適用済み
  const same = plan([{ recordId: 'rec1', fields: after }]);
  assert.equal(same.counts.willGrant, 0, '同じ特典が二重に付与される');
  assert.equal(same.skipped[0].reason, CB_SKIP.ALREADY_APPLIED);

  // 別の操作 ID でも、同等以上を持っているので増えない
  // （既存仕様: 強い内容＝期限が伸びるときだけ適用される）
  const other = buildComebackPlan({
    grantOffers: [LIGHT30], purchaseOffer: null,
    selected: [{ recordId: 'rec1', fields: after }],
    existingOffers: [], nowMs: NOW,
    operationId: 'cb-light-30d-free-2026-08-04-99999999', actor: 'test', source: 'test',
  });
  assert.equal(other.counts.willGrant, 0, '別操作で二重付与される');
  assert.equal(other.skipped[0].reason, CB_SKIP.ALREADY_GRANTED);
});

test('同じ operationId の再実行は適用済みとして数える', () => {
  const first = plan([{ recordId: 'rec1', fields: withdrawnMember() }]);
  const after = { ...withdrawnMember(), ...first.targets[0].grantFields };
  const r = reconcileOperation({
    records: [{ recordId: 'rec1', fields: after }], operationId: OP,
  });
  assert.equal(r.applied.length, 1);
  assert.equal(r.missing.length, 0);
});

test('既に送信済みの相手へは案内メールを積まない（既存 28 名の再送防止）', () => {
  const campaign = getCampaign('comeback-light-30d-granted');
  const fields = withdrawnMember();
  const selected = [{
    recordId: 'rec1', fields,
    marketing: resolveCustomerMarketing({ fields, nowMs: NOW }),
  }];
  const common = {
    campaign, selected, providerSuppressed: new Set(),
    brand: 'analytics-keiba', fromEmail: 'info@example.com', nowMs: NOW,
  };
  const first = buildCampaignPlan({ ...common, deliveredKeys: new Set() });
  assert.equal(first.counts.recipients, 1);

  const again = buildCampaignPlan({
    ...common, deliveredKeys: new Set([first.recipients[0].deliveryKey]),
  });
  assert.equal(again.counts.recipients, 0, '送信済みの相手へ再送しようとしている');
  assert.equal(again.counts.byReason.already_delivered, 1);
});

// ── 一覧 / 全選択 / dry-run が同じ判定になる ──────────────────
// 実際に起きた不整合: 対象区分「退会」を選ぶと全行が「付与不可：退会・強制ログアウト」に
// なり「付与可能者を全選択」が 0 名。なのに手動チェックだけは通り、dry-run では付与できた。

test('一覧の grantable と dry-run の結果が一致する（施策を選んでいるとき）', () => {
  const rows = [
    { recordId: 'rec1', fields: withdrawnMember({ Email: 'a@example.com' }) },
    { recordId: 'rec2', fields: withdrawnMember({ Email: 'b@example.com' }) },
    { recordId: 'rec3', fields: withdrawnMember({ Email: 'c@example.com', ForceLogout: true }) },
  ];
  // 一覧側（Step 1〜2）: 施策の metadata で判定する
  const listGrantable = rows.filter((r) => resolveComebackCustomer({
    fields: r.fields, nowMs: NOW, allowWithdrawn: true,
  }).grantable);
  assert.equal(listGrantable.length, 2, '一覧で退会者が付与可能にならない');

  // dry-run 側: 同じ 2 名が付与対象になる
  const p = plan(rows);
  assert.equal(p.counts.willGrant, 2);
  assert.deepEqual(p.targets.map((t) => t.recordId).sort(), ['rec1', 'rec2']);
  assert.equal(p.skipped[0].reason, CB_SKIP.FORCE_LOGOUT_BLOCKED);
});

test('施策を選んでいなければ一覧も dry-run も付与不可で一致する', () => {
  const rows = [{ recordId: 'rec1', fields: withdrawnMember() }];
  assert.equal(resolveComebackCustomer({ fields: rows[0].fields, nowMs: NOW }).grantable, false);
  assert.equal(plan(rows, [LIGHT_LIFETIME]).counts.willGrant, 0);
});

test('重複メールは一覧でも選べない（dry-run と同じ理由）', () => {
  const view = resolveComebackCustomer({
    fields: withdrawnMember(), nowMs: NOW, allowWithdrawn: true, duplicateEmail: true,
  });
  assert.equal(view.grantable, false, '重複アドレスが一覧で選べてしまう');
  assert.equal(view.grantBlockedReason, CB_SKIP.DUPLICATE_EMAIL);
  assert.equal(view.eligibility.status, GRANT_ELIGIBILITY.BLOCKED);
  assert.match(view.eligibility.text, /重複/);
});

test('退会と強制ログアウトは別の理由コード・別の表示にする', () => {
  const wd = checkGrantable(withdrawnMember());
  const fl = checkGrantable(withdrawnMember({ WithdrawalRequested: false, ForceLogout: true }));
  assert.equal(wd.reason, CB_SKIP.WITHDRAWAL_BLOCKED);
  assert.equal(fl.reason, CB_SKIP.FORCE_LOGOUT_BLOCKED);
  assert.notEqual(wd.reason, fl.reason, '同じ理由コードにまとめられている');
  assert.notEqual(CB_SKIP_LABEL[wd.reason], CB_SKIP_LABEL[fl.reason], '表示が同じ文言になっている');
  assert.doesNotMatch(CB_SKIP_LABEL[wd.reason], /強制ログアウト/, '退会の説明に強制ログアウトが混ざっている');
  assert.doesNotMatch(CB_SKIP_LABEL[fl.reason], /退会/, '強制ログアウトの説明に退会が混ざっている');

  // ForceLogout は施策を許可しても通らない / 退会は許可すれば通る
  assert.equal(checkGrantable(withdrawnMember({ ForceLogout: true }), { allowWithdrawn: true }).ok, false);
  assert.equal(checkGrantable(withdrawnMember(), { allowWithdrawn: true }).ok, true);
});

// ── planCustomer 単体（offer ごとに判定が変わること）──────────

test('同じ顧客でも付与内容ごとに可否が変わる', () => {
  const fields = withdrawnMember();
  const args = { recordId: 'rec1', fields, nowMs: NOW, operationId: OP, actor: 't', source: 't' };
  const ok = planCustomer({ ...args, grantOffers: [LIGHT30], purchaseOffer: null });
  assert.equal(Object.keys(ok.grantFields).length > 0, true);

  const ng = planCustomer({ ...args, grantOffers: [LIGHT_LIFETIME], purchaseOffer: null });
  assert.equal(Object.keys(ng.grantFields).length, 0);
  assert.equal(ng.partSkips[0].reason, CB_SKIP.WITHDRAWAL_BLOCKED);
});
