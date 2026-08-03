/**
 * comebackFilterSelection.test.mjs
 *
 * 複数選択（配列）での絞り込み。
 * **同じ項目内は OR / 異なる項目間は AND / 未選択は条件なし**。
 * 旧形式（単一文字列）でも同じ結果になること（互換）も見る。
 *
 * 併せて「対象区分」が区分（退会・休眠）と契約状態（期限切れ・契約なし）の
 * どちらでも当たることを固定する。ここが片方だけだと、既定の
 * 「期限切れ＋退会済み＋休眠」で 0 件になる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveComebackCustomer, matchesComebackFilter } from './comebackAudience.js';

const NOW = Date.parse('2026-08-02T12:00:00+09:00');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const view = (fields) => resolveComebackCustomer({ fields, nowMs: NOW });

/** 期限切れ Premium（元有料・現在は権限なし） */
const expired = view({
  Email: 'a@example.com', 'プラン': 'Premium', Status: 'expired',
  '有効期限': iso(NOW - 40 * DAY),
});
/** 退会申請済み */
const withdrawn = view({
  Email: 'b@example.com', 'プラン': 'Light', Status: 'active',
  WithdrawalRequested: true, '有効期限': iso(NOW + 40 * DAY),
});
/** 無料・長期未ログイン */
const dormant = view({
  Email: 'c@example.com', 'プラン': 'Free', Status: 'none',
});
/** 現在有効な Premium 会員 */
const active = view({
  Email: 'd@example.com', 'プラン': 'Premium', Status: 'active',
  '有効期限': iso(NOW + 200 * DAY),
});

test('未選択（空配列 / undefined）は条件なし＝全員通す', () => {
  for (const c of [expired, withdrawn, dormant, active]) {
    assert.equal(matchesComebackFilter(c, {}), true);
    assert.equal(matchesComebackFilter(c, { contract: [], plan: [] }), true);
  }
});

test('同じ項目内は OR（期限切れ + 退会済み + 休眠）', () => {
  const f = { contract: ['expired', 'withdrawn', 'dormant'] };
  assert.equal(matchesComebackFilter(expired, f), true);
  assert.equal(matchesComebackFilter(withdrawn, f), true);
  assert.equal(matchesComebackFilter(dormant, f), true);
  // 現有効会員は既定の候補に混ざらない
  assert.equal(matchesComebackFilter(active, f), false);
});

test('退会・休眠は「区分」でしか判定できない（契約状態だけでは 0 件になる）', () => {
  assert.equal(withdrawn.segment, 'withdrawn');
  assert.equal(dormant.segment, 'dormant');
  assert.equal(matchesComebackFilter(withdrawn, { contract: ['withdrawn'] }), true);
  assert.equal(matchesComebackFilter(dormant, { contract: ['dormant'] }), true);
});

test('「カムバック候補すべて」は現有効会員を含めない', () => {
  const f = { contract: ['candidates'] };
  assert.equal(matchesComebackFilter(expired, f), true);
  assert.equal(matchesComebackFilter(withdrawn, f), true);
  assert.equal(matchesComebackFilter(dormant, f), true);
  assert.equal(matchesComebackFilter(active, f), false);
});

test('現有効会員は明示的に選んだときだけ当たる', () => {
  assert.equal(matchesComebackFilter(active, { contract: ['active'] }), true);
  assert.equal(matchesComebackFilter(expired, { contract: ['active'] }), false);
});

test('異なる項目間は AND（区分 AND プラン）', () => {
  const f = { contract: ['expired', 'withdrawn'], plan: ['light'] };
  assert.equal(matchesComebackFilter(withdrawn, f), true);   // 退会 かつ Light
  assert.equal(matchesComebackFilter(expired, f), false);    // 期限切れだが Premium
});

test('プランの複数選択（Premium + Light）', () => {
  const f = { plan: ['premium', 'light'] };
  assert.equal(matchesComebackFilter(expired, f), true);
  assert.equal(matchesComebackFilter(withdrawn, f), true);
  assert.equal(matchesComebackFilter(dormant, f), false);    // Free
});

test('旧形式（単一文字列）でも同じ結果になる', () => {
  assert.equal(matchesComebackFilter(expired, { contract: 'expired' }), true);
  assert.equal(matchesComebackFilter(withdrawn, { contract: 'expired' }), false);
  assert.equal(matchesComebackFilter(expired, { contract: 'all' }), true);
});

test('退会履歴・付与可否も複数選択で効く', () => {
  assert.equal(matchesComebackFilter(withdrawn, { withdrawn: ['yes'] }), true);
  assert.equal(matchesComebackFilter(expired, { withdrawn: ['yes'] }), false);
  assert.equal(matchesComebackFilter(expired, { withdrawn: ['yes', 'no'] }), true);
});

// ── 無料付与: 「いま」と「これまで」を別条件で絞る（2026-08-03）─────────
import { FREE_GRANT_NOW, FREE_GRANT_HISTORY } from '../entitlements/freeGrantStatus.js';

const DAY_MS = 86400000;
const at = (offsetDays) => new Date(NOW + offsetDays * DAY_MS).toISOString();

/** いま Light 無料期間中 */
const lightNow = view({ Email: 'g1@example.com', 'プラン': 'Free', Status: 'none',
  LightGrantUntil: at(20), LightGrantedAt: at(-10) });
/** いまは無し・過去に Light を配って期間終了 */
const lightPast = view({ Email: 'g2@example.com', 'プラン': 'Free', Status: 'none',
  LightGrantUntil: at(-5), LightGrantedAt: at(-35) });
/** Premium 永久無料 */
const premiumLifetime = view({ Email: 'g3@example.com', 'プラン': 'Free', Status: 'none',
  PremiumGrantLifetime: true, PremiumGrantedAt: at(-2) });
/** 付与の記録なし */
const noRecord = view({ Email: 'g4@example.com', 'プラン': 'Free', Status: 'none' });

test('現在の無料付与は複数選択 OR で絞れる', () => {
  const f = { currentGrant: [FREE_GRANT_NOW.LIGHT_PERIOD, FREE_GRANT_NOW.PREMIUM_LIFETIME] };
  assert.equal(matchesComebackFilter(lightNow, f), true);
  assert.equal(matchesComebackFilter(premiumLifetime, f), true);
  assert.equal(matchesComebackFilter(lightPast, f), false);
  assert.equal(matchesComebackFilter(noRecord, f), false);
});

test('無料付与履歴は複数選択 OR で絞れる', () => {
  const f = { grantHistory: [FREE_GRANT_HISTORY.LIGHT, FREE_GRANT_HISTORY.PREMIUM] };
  assert.equal(matchesComebackFilter(lightPast, f), true);
  assert.equal(matchesComebackFilter(premiumLifetime, f), true);
  assert.equal(matchesComebackFilter(noRecord, f), false);
});

test('「いま無し × 過去あり」を AND で作れる（この組合せが目的）', () => {
  const f = {
    currentGrant: [FREE_GRANT_NOW.NONE],
    grantHistory: [FREE_GRANT_HISTORY.LIGHT, FREE_GRANT_HISTORY.PREMIUM],
  };
  assert.equal(matchesComebackFilter(lightPast, f), true, '狙った母集団が作れない');
  assert.equal(matchesComebackFilter(lightNow, f), false, 'いま有効な人が混ざる');
  assert.equal(matchesComebackFilter(noRecord, f), false, '記録の無い人が混ざる');
});

test('無料付与の条件が空なら絞らない', () => {
  for (const c of [lightNow, lightPast, premiumLifetime, noRecord]) {
    assert.equal(matchesComebackFilter(c, { currentGrant: [], grantHistory: [] }), true);
    assert.equal(matchesComebackFilter(c, {}), true);
  }
});

test('現在有効かどうかと、過去に付与したかを取り違えない', () => {
  assert.ok(lightPast.currentGrantCodes.includes(FREE_GRANT_NOW.NONE));
  assert.ok(lightPast.grantHistoryCodes.includes(FREE_GRANT_HISTORY.LIGHT));
  assert.ok(lightNow.currentGrantCodes.includes(FREE_GRANT_NOW.LIGHT_PERIOD));
  // 表示（一覧の要約）と検索コードが同じ判定から出ている
  assert.deepEqual(lightPast.freeGrant.currentCodes, lightPast.currentGrantCodes);
  assert.deepEqual(lightNow.freeGrant.historyCodes, lightNow.grantHistoryCodes);
});
