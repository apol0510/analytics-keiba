/**
 * customerMarketingAudience.test.mjs — マーケティング対象判定の検証
 *   node --test src/lib/marketing/customerMarketingAudience.test.mjs
 *
 * 重点:
 *   - 期限切れ・Free・Light まで母集団に入る（Premium Plus 販売候補とは別の母集団）
 *   - legacy レコードの契約状態を推測で確定しない（unknown を返す）
 *   - suppression は fail closed（1 つでも該当したら送らない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveCustomerMarketing,
  resolveContractState,
  resolvePlanGroup,
  resolveSendability,
  matchesMarketingFilter,
  summarizeSegments,
  MK_CONTRACT,
  MK_PLAN,
  MK_SEND,
  MK_SUPPRESSION,
  EXPIRING_SOON_DAYS,
} from './customerMarketingAudience.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';

const NOW = Date.UTC(2026, 7, 3, 1, 0); // 2026-08-03 10:00 JST
const DAY = 86400000;
const jstDate = (offsetDays) => new Date(NOW + offsetDays * DAY + 9 * 3600000).toISOString().slice(0, 10);

const base = (over = {}) => ({ Email: 'a@example.com', Status: 'active', ...over });
const resolve = (fields, opts = {}) => resolveCustomerMarketing({ fields, nowMs: NOW, ...opts });

// ── プラン区分 ────────────────────────────────────────────────
test('プラン区分は「何を買ったか」で決まる（三連複保有は Premium 表記でも三連複扱い）', () => {
  assert.equal(resolvePlanGroup({ 'プラン': 'Premium', LifetimeSanrenpuku: true }), MK_PLAN.PREMIUM_SANRENPUKU);
  assert.equal(resolvePlanGroup({ 'プラン': 'Premium Sanrenpuku' }), MK_PLAN.PREMIUM_SANRENPUKU);
  assert.equal(resolvePlanGroup({ 'プラン': 'Premium' }), MK_PLAN.PREMIUM);
  assert.equal(resolvePlanGroup({ 'プラン': 'Light' }), MK_PLAN.LIGHT);
  assert.equal(resolvePlanGroup({ 'プラン': 'Free' }), MK_PLAN.FREE);
  assert.equal(resolvePlanGroup({}), MK_PLAN.FREE, '不明は free（fail closed）');
});

// ── 契約状態 ──────────────────────────────────────────────────
test('有効期限 < 現在JST は期限切れ（entitlement 判定と整合）', () => {
  const fields = base({ 'プラン': 'Premium', PlanType: 'Annual', '有効期限': jstDate(-1) });
  const m = resolve(fields);
  assert.equal(m.contract, MK_CONTRACT.EXPIRED);
  const ent = resolveEntitlements(fromAirtableFields(fields), NOW);
  assert.equal(ent.canViewPremium, false, '既存 entitlement 側も無効と判定している');
  assert.equal(ent.premiumExpired, true);
});

test('期限まで N 日以内は期限間近 / それ以外は有効', () => {
  const at = (d) => resolve(base({ 'プラン': 'Premium', PlanType: 'Annual', '有効期限': jstDate(d) })).contract;
  assert.equal(at(EXPIRING_SOON_DAYS), MK_CONTRACT.EXPIRING_SOON);
  assert.equal(at(EXPIRING_SOON_DAYS + 1), MK_CONTRACT.ACTIVE);
  assert.equal(at(0), MK_CONTRACT.EXPIRING_SOON, '当日は期限間近（まだ切れていない）');
  assert.equal(at(-1), MK_CONTRACT.EXPIRED);
});

test('Status=expired / unpaidrefunded は日付が無くても期限切れ', () => {
  assert.equal(resolve(base({ 'プラン': 'Premium', Status: 'expired' })).contract, MK_CONTRACT.EXPIRED);
  assert.equal(resolve(base({ 'プラン': 'Premium', Status: 'unpaidrefunded' })).contract, MK_CONTRACT.EXPIRED);
});

test('PlanType=Lifetime は期限で切れない', () => {
  assert.equal(resolve(base({ 'プラン': 'Premium', PlanType: 'Lifetime' })).contract, MK_CONTRACT.ACTIVE);
});

test('【推測しない】有料 tier だが期限も Status も手掛かりが無い legacy は unknown', () => {
  const m = resolve(base({ 'プラン': 'Premium', Status: 'active' })); // 有効期限なし
  assert.equal(m.contract, MK_CONTRACT.UNKNOWN);
  // entitlement 側は「期限なし＝有効」と見るが、こちらはその曖昧さを可視化するだけで書き換えない
  const ent = resolveEntitlements(fromAirtableFields(base({ 'プラン': 'Premium', Status: 'active' })), NOW);
  assert.equal(ent.canViewPremium, true);
  assert.equal(m.premiumActive, true, 'entitlement の値はそのまま保持して併記する');
});

test('入金待ち(pending)は契約未確定として unknown', () => {
  assert.equal(resolve(base({ 'プラン': 'Premium', Status: 'pending' })).contract, MK_CONTRACT.UNKNOWN);
});

test('Free は契約なし（none）。unknown に混ぜない', () => {
  assert.equal(resolve(base({ 'プラン': 'Free' })).contract, MK_CONTRACT.NONE);
  assert.equal(resolve(base({})).contract, MK_CONTRACT.NONE);
});

test('resolveContractState は entitlements 未指定でも落ちない', () => {
  const r = resolveContractState({ fields: { 'プラン': 'Premium' }, nowMs: NOW });
  assert.equal(r.contract, MK_CONTRACT.UNKNOWN);
});

// ── 送信可否（fail closed）──────────────────────────────────────
test('配信停止・ブラックリスト・退会・停止・test は送信不可', () => {
  const cases = [
    [{ UnsubscribedAnalyticsKeiba: true }, MK_SUPPRESSION.UNSUBSCRIBED, undefined],
    [{ WithdrawalRequested: true }, MK_SUPPRESSION.WITHDRAWN, undefined],
    [{ Status: 'withdrawn' }, MK_SUPPRESSION.WITHDRAWN, undefined],
    [{ Status: 'suspended' }, MK_SUPPRESSION.SUSPENDED, undefined],
    [{ Status: 'test' }, MK_SUPPRESSION.TEST_ACCOUNT, undefined],
    [{ 'プラン': 'Test' }, MK_SUPPRESSION.TEST_ACCOUNT, undefined],
    [{ Email: '' }, MK_SUPPRESSION.NO_EMAIL, undefined],
    [{ Email: 'not-an-email' }, MK_SUPPRESSION.INVALID_EMAIL, undefined],
    [{}, MK_SUPPRESSION.BLACKLIST, new Set(['a@example.com'])],
  ];
  for (const [over, reason, blacklist] of cases) {
    const m = resolve(base(over), { blacklistEmails: blacklist });
    assert.equal(m.sendable, false, `${reason} が送信可になっている`);
    assert.equal(m.sendState, MK_SEND.SUPPRESSED);
    assert.ok(m.suppressionReasons.includes(reason), `理由 ${reason} が付いていない`);
  }
});

test('期限切れ会員はマーケティング送信可（販売資格とは別概念）', () => {
  const m = resolve(base({ 'プラン': 'Premium', PlanType: 'Annual', '有効期限': jstDate(-30) }));
  assert.equal(m.contract, MK_CONTRACT.EXPIRED);
  assert.equal(m.sendable, true, '期限切れは送信対象から外さない');
  assert.equal(m.premiumActive, false, 'ただし権限は無効のまま');
});

test('複数の除外理由はすべて記録される（最初の 1 件で打ち切らない）', () => {
  const m = resolve(base({ UnsubscribedAnalyticsKeiba: true, WithdrawalRequested: true }));
  assert.ok(m.suppressionReasons.includes(MK_SUPPRESSION.UNSUBSCRIBED));
  assert.ok(m.suppressionReasons.includes(MK_SUPPRESSION.WITHDRAWN));
});

test('resolveSendability は blacklist 未指定でも落ちない', () => {
  assert.equal(resolveSendability({ fields: base({}) }).sendable, true);
  assert.equal(resolveSendability({}).sendable, false, 'fields 無しは送らない側へ');
});

// ── セグメント / フィルタ ────────────────────────────────────────
test('セグメント文字列に契約・プラン・送信可否・Plus 資格が入る', () => {
  const m = resolve(base({ 'プラン': 'Premium', '有効期限': jstDate(-5), PremiumPlusEligibility: 'blocked' }));
  assert.ok(m.segments.includes('contract:expired'));
  assert.ok(m.segments.includes('plan:premium'));
  assert.ok(m.segments.includes('mk:sendable'));
  assert.ok(m.segments.includes('pp:blocked'));
  assert.ok(m.segments.includes('history:never'));
});

test('フィルタは AND / 未指定は素通し', () => {
  const m = resolve(base({ 'プラン': 'Premium', '有効期限': jstDate(-5) }));
  assert.equal(matchesMarketingFilter(m, {}), true);
  assert.equal(matchesMarketingFilter(m, { contract: 'expired' }), true);
  assert.equal(matchesMarketingFilter(m, { contract: 'active' }), false);
  assert.equal(matchesMarketingFilter(m, { contract: 'expired', plan: 'light' }), false);
  assert.equal(matchesMarketingFilter(m, { marketing: MK_SEND.SUPPRESSED }), false);
  assert.equal(matchesMarketingFilter(m, { premiumPlus: 'unset' }), true);
  assert.equal(matchesMarketingFilter(null, {}), false);
});

test('送信履歴から history:recent が付く', () => {
  const recent = resolve(base({}), { history: { lastSentAtMs: NOW - 3 * DAY, sentCount: 1 } });
  assert.ok(recent.segments.includes('history:recent'));
  assert.ok(recent.segments.includes('history:sent'));
  const old = resolve(base({}), { history: { lastSentAtMs: NOW - 90 * DAY, sentCount: 2 } });
  assert.equal(old.segments.includes('history:recent'), false);
  assert.equal(old.history.sentCount, 2);
});

test('summarizeSegments は件数だけを返す（PII を含まない）', () => {
  const list = [
    resolve(base({ 'プラン': 'Premium', '有効期限': jstDate(-1) })),
    resolve(base({ 'プラン': 'Light', '有効期限': jstDate(100) })),
    resolve(base({ Email: '', 'プラン': 'Free' })),
  ];
  const s = summarizeSegments(list);
  assert.equal(s.total, 3);
  assert.equal(s.contract.expired, 1);
  assert.equal(s.plan.light, 1);
  assert.equal(s.marketing.suppressed, 1);
  assert.equal(JSON.stringify(s).includes('@'), false, '集計に email が混ざっている');
});

// ── 分離の guard ──────────────────────────────────────────────
const src = readFileSync(fileURLToPath(new URL('./customerMarketingAudience.js', import.meta.url)), 'utf8');
/** コメントを除いた実コード（説明文に出てくる語で guard が誤検知しないようにする） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('マーケティング判定は Premium Plus 販売判定を import しない（責務を混ぜない）', () => {
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const i of imports) {
    assert.equal(i.includes('premiumPlus'), false, `Premium Plus 判定 ${i} を import している`);
  }
  assert.deepEqual(imports, ['../entitlements/resolveEntitlements.js', '../auth/planNormalization.js']);
});

test('マーケティング判定は I/O を持たない（純粋関数）', () => {
  for (const banned of ['fetch(', 'api.airtable.com', 'process.env', 'sendgrid', 'SendGrid']) {
    assert.equal(code.includes(banned), false, `実コードに ${banned} が含まれている`);
  }
});
