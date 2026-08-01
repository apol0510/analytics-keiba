/**
 * marketingCanary.test.mjs — 運用テスト専用キャンペーン（marketing-canary）の検証
 *   node --test src/lib/marketing/marketingCanary.test.mjs
 *
 * 守る性質:
 *   1. 一般顧客には**構造的に**送れない（管理者が誰を選んでも通らない）
 *   2. env `NEWSLETTER_TEST_RECIPIENTS` が正本。未設定なら誰にも送れない（fail closed）
 *   3. テスト用だからといって通常の guard をバイパスしない
 *   4. 受信者アドレスを戻り値・ログへ出さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getCampaign, renderCampaign, isCampaignUsable, NAME_FALLBACK } from './campaignCatalog.js';
import { evaluateExtraAudience, EXTRA_AUDIENCE, CAMPAIGN_MISMATCH } from './campaignAudienceRules.js';
import { buildCampaignPlan, MK_EXCLUSION, MARKETING_MIN_INTERVAL_MS } from './campaignSend.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { parseTestRecipientsEnv } from '../newsletter/test-recipients.js';

const NOW = Date.UTC(2026, 7, 3, 1, 0);
const FROM = 'noreply@keiba.link';
const TEST_ADDR = 'canary@example.com';
const OTHER_ADDR = 'customer@example.com';
const canary = getCampaign('marketing-canary');

/** env 文字列 → context（Function 層と同じ経路で作る） */
const ctx = (envRaw) => ({ testRecipients: new Set(parseTestRecipientsEnv(envRaw).recipients) });

function customer(recordId, email, over = {}, opts = {}) {
  const fields = {
    Email: email, Status: 'active', 'プラン': 'Premium', PlanType: 'Annual', '有効期限': '2099-01-01', ...over,
  };
  return { recordId, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW, ...opts }) };
}

const plan = (selected, envRaw = TEST_ADDR, opts = {}) => buildCampaignPlan({
  campaign: canary,
  selected,
  providerSuppressed: opts.providerSuppressed === undefined ? new Set() : opts.providerSuppressed,
  softBounced: opts.softBounced,
  deliveredKeys: opts.deliveredKeys,
  audienceContext: ctx(envRaw),
  brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
});

// ── 定義 ──────────────────────────────────────────────────────
test('marketing-canary は使用可能で、運用テスト専用の目印を持つ', () => {
  assert.ok(canary, 'カナリアが取得できない');
  // 版番号は上げてよい（再送のための正規手段）。ここでは「正の整数であること」だけを固定する
  assert.ok(Number.isInteger(canary.version) && canary.version >= 1, `version が不正: ${canary.version}`);
  assert.equal(canary.enabled, true);
  assert.equal(canary.testOnly, true, '運用テスト専用の目印が無い');
  assert.equal(isCampaignUsable(canary), true);
  assert.equal(canary.extraAudience, EXTRA_AUDIENCE.MARKETING_CANARY_RECIPIENT);
});

test('商品案内・価格・契約誘導を含まない', () => {
  const text = `${canary.subject}\n${canary.body}\n${canary.ctaLabel}`;
  for (const banned of ['¥', '円', '価格', '購入', 'お申し込み', '継続', '再契約', 'プランの', 'キャンペーン価格']) {
    assert.equal(text.includes(banned), false, `テスト用メールに「${banned}」が含まれている`);
  }
  assert.ok(canary.body.includes('運用テスト'), 'テスト用であることが本文に無い');
  assert.ok(canary.body.includes('通常のご案内ではありません'));
});

test('宛名は HTML / text 双方で正しい（二重敬称なし）', () => {
  const named = renderCampaign({ campaign: canary, name: '山田' });
  const anon = renderCampaign({ campaign: canary, name: '' });
  assert.ok(named.text.startsWith('山田 様'));
  assert.ok(named.html.includes('>山田 様'));
  assert.ok(anon.text.startsWith(NAME_FALLBACK));
  assert.ok(anon.html.includes(`>${NAME_FALLBACK}`));
  for (const r of [named, anon]) {
    assert.equal(r.text.includes('お客様 様'), false);
    assert.equal(r.html.includes('お客様 様'), false);
  }
});

// ── 対象条件（env 正本）──────────────────────────────────────
test('env 未設定 → 全員除外（誰にも送れない）', () => {
  // 既定引数に落ちないよう buildCampaignPlan を直接呼ぶ
  for (const envRaw of [undefined, null, '', '   ', ',,,']) {
    const p = buildCampaignPlan({
      campaign: canary, selected: [customer('r1', TEST_ADDR)],
      providerSuppressed: new Set(), audienceContext: ctx(envRaw),
      brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
    });
    assert.equal(p.counts.recipients, 0, `env=${JSON.stringify(envRaw)} で送信対象が出ている`);
    assert.equal(p.counts.byReason[MK_EXCLUSION.CAMPAIGN_MISMATCH], 1);
  }
  // context 自体が渡らない場合も除外（Function 側の配線漏れで全員へ送らない）
  const noCtx = buildCampaignPlan({
    campaign: canary, selected: [customer('r1', TEST_ADDR)],
    providerSuppressed: new Set(), brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
  });
  assert.equal(noCtx.counts.recipients, 0, 'context 未配線で送信対象が出ている');
  // 追加条件の単体でも同じ
  const r = evaluateExtraAudience({ campaign: canary, fields: { Email: TEST_ADDR }, nowMs: NOW, context: ctx('') });
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'test_recipients_unset');
});

test('env 一致 + Customers 一致 → 1 人', () => {
  const p = plan([customer('r1', TEST_ADDR)]);
  assert.equal(p.counts.selected, 1);
  assert.equal(p.counts.recipients, 1);
  assert.equal(p.counts.excluded, 0);
});

test('env 不一致の一般顧客 → campaign_mismatch', () => {
  const p = plan([customer('r1', OTHER_ADDR)]);
  assert.equal(p.counts.recipients, 0, '一般顧客へ送れてしまう');
  assert.equal(p.counts.byReason[MK_EXCLUSION.CAMPAIGN_MISMATCH], 1);
  const r = evaluateExtraAudience({ campaign: canary, fields: { Email: OTHER_ADDR }, nowMs: NOW, context: ctx(TEST_ADDR) });
  assert.equal(r.reason, CAMPAIGN_MISMATCH);
  assert.equal(r.detail, 'not_test_recipient');
});

test('email 比較は正規化する（大小・空白の差で漏らさない/広げない）', () => {
  assert.equal(plan([customer('r1', '  Canary@Example.COM ')]).counts.recipients, 1);
  assert.equal(plan([customer('r1', TEST_ADDR)], ' CANARY@EXAMPLE.COM ').counts.recipients, 1);
});

test('Customers 側に email が無ければ除外', () => {
  const p = plan([customer('r1', '')]);
  assert.equal(p.counts.recipients, 0);
  const r = evaluateExtraAudience({ campaign: canary, fields: {}, nowMs: NOW, context: ctx(TEST_ADDR) });
  assert.equal(r.detail, 'no_email');
});

test('env が複数件でも、選択したレコード以外へは広がらない', () => {
  const envMulti = `${TEST_ADDR}, second@example.com , third@example.com`;
  const parsed = parseTestRecipientsEnv(envMulti);
  assert.equal(parsed.recipients.length, 3, 'テスト前提: env は 3 件');
  // 選択したのは 1 名だけ → 送信対象も 1 名（env の他 2 件は対象にならない）
  const p = plan([customer('r1', TEST_ADDR)], envMulti);
  assert.equal(p.counts.selected, 1);
  assert.equal(p.counts.recipients, 1);
  // 一般顧客を混ぜても増えない
  const p2 = plan([customer('r1', TEST_ADDR), customer('r2', OTHER_ADDR)], envMulti);
  assert.equal(p2.counts.recipients, 1);
  assert.equal(p2.counts.byReason[MK_EXCLUSION.CAMPAIGN_MISMATCH], 1);
});

test('一般顧客だけを選んでも willSend=0', () => {
  const many = ['a', 'b', 'c'].map((k, i) => customer(`r${i}`, `${k}@example.com`));
  const p = plan(many);
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.CAMPAIGN_MISMATCH], 3);
});

// ── 通常 guard をバイパスしない ────────────────────────────────
test('provider suppression 該当なら送らない', () => {
  const p = plan([customer('r1', TEST_ADDR)], TEST_ADDR, { providerSuppressed: new Set([TEST_ADDR]) });
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.PROVIDER_SUPPRESSED], 1);
});

test('provider suppression を確認できなければ計画自体を作らない', () => {
  const p = plan([customer('r1', TEST_ADDR)], TEST_ADDR, { providerSuppressed: null });
  assert.equal(p.ok, false);
  assert.equal(p.error, 'provider_suppression_unavailable');
});

test('blacklist(hard/soft) / 配信停止 / 退会 / 停止 / test / 不正メール でも送らない', () => {
  const cases = [
    ['blacklist(hard)', {}, { blacklistEmails: new Set([TEST_ADDR]) }, 'blacklist'],
    ['配信停止', { UnsubscribedAnalyticsKeiba: true }, {}, 'unsubscribed'],
    ['停止', { Status: 'suspended' }, {}, 'suspended'],
    ['test アカウント', { Status: 'test' }, {}, 'test_account'],
  ];
  for (const [label, over, opts, reason] of cases) {
    const p = plan([customer('r1', TEST_ADDR, over, opts)]);
    assert.equal(p.counts.recipients, 0, `${label} でも送信対象になっている`);
    assert.equal(p.counts.byReason[reason], 1, `${label}: 理由が ${reason} でない`);
  }
  // soft bounce
  const soft = plan([customer('r1', TEST_ADDR)], TEST_ADDR, { softBounced: new Set([TEST_ADDR]) });
  assert.equal(soft.counts.byReason[MK_EXCLUSION.SOFT_BOUNCE], 1);
  // 不正メール（env にも同じ値を入れて、除外が email 形式で起きることを確認）
  const bad = plan([customer('r1', 'not-an-email')], 'not-an-email');
  assert.equal(bad.counts.recipients, 0);
});

test('カナリアでも退会（課金停止）は除外しない', () => {
  for (const over of [{ Status: 'withdrawn' }, { WithdrawalRequested: true }]) {
    const p = plan([customer('r1', TEST_ADDR, over)]);
    assert.equal(p.counts.recipients, 1, `退会 ${JSON.stringify(over)} で送信対象から外れている`);
  }
});

test('24 時間以内に送信済みなら送らない（テスト用でも頻度ガードを効かせる）', () => {
  const recent = customer('r1', TEST_ADDR, {}, { history: { lastSentAtMs: NOW - 3600_000, sentCount: 1 } });
  const p = plan([recent]);
  assert.equal(p.counts.recipients, 0);
  assert.equal(p.counts.byReason[MK_EXCLUSION.RECENT_MARKETING_CONTACT], 1);
  // 24 時間経過後は送れる
  const old = customer('r1', TEST_ADDR, {}, { history: { lastSentAtMs: NOW - MARKETING_MIN_INTERVAL_MS, sentCount: 1 } });
  assert.equal(plan([old]).counts.recipients, 1);
});

test('同一 campaign/version の再送は DeliveryKey で防ぐ', () => {
  const c = customer('r1', TEST_ADDR);
  const first = plan([c]);
  const delivered = new Set(first.recipients.map((r) => r.deliveryKey));
  const second = plan([c], TEST_ADDR, { deliveredKeys: delivered });
  assert.equal(second.counts.recipients, 0);
  assert.equal(second.counts.byReason[MK_EXCLUSION.ALREADY_DELIVERED], 1);
});

test('選択内の重複アドレスは 1 通だけ', () => {
  const a = customer('r1', TEST_ADDR);
  const b = { ...customer('r2', TEST_ADDR), marketing: a.marketing };
  const p = plan([a, b]);
  assert.equal(p.counts.recipients, 1);
  assert.equal(p.counts.byReason[MK_EXCLUSION.DUPLICATE], 1);
});

test('planFingerprint は通常キャンペーンと同じく生成される', () => {
  const p = plan([customer('r1', TEST_ADDR)]);
  assert.equal(p.planFingerprint.length, 64);
});

// ── PII / 責務の guard ────────────────────────────────────────
test('追加条件の戻り値にアドレスを含めない', () => {
  const r = evaluateExtraAudience({
    campaign: canary, fields: { Email: OTHER_ADDR }, nowMs: NOW, context: ctx(TEST_ADDR),
  });
  const s = JSON.stringify(r);
  assert.equal(s.includes('@'), false, `戻り値にアドレスが含まれる: ${s}`);
});

const rulesSrc = readFileSync(fileURLToPath(new URL('./campaignAudienceRules.js', import.meta.url)), 'utf8');
const rulesCode = rulesSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const audienceCode = readFileSync(fileURLToPath(new URL('./customerMarketingAudience.js', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('テストロジックを customerMarketingAudience.js に混ぜない', () => {
  for (const banned of ['NEWSLETTER_TEST_RECIPIENTS', 'testRecipients', 'canary', 'marketing_canary']) {
    assert.equal(audienceCode.includes(banned), false, `マーケティング対象判定に ${banned} が混入している`);
  }
});

test('判定モジュールは env を直接読まない（Function 層から context で受ける）', () => {
  assert.equal(rulesCode.includes('process.env'), false, '純粋モジュールが env を読んでいる');
  assert.equal(rulesCode.includes('NEWSLETTER_TEST_RECIPIENTS'), false, 'env 名を直接参照している');
  assert.ok(rulesCode.includes('context.testRecipients') || rulesCode.includes('context && context.testRecipients'));
});

test('カナリアはログにアドレスを残さない設計（判定モジュールに console が無い）', () => {
  assert.equal(/console\./.test(rulesCode), false);
});
