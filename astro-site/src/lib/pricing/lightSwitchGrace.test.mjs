/**
 * lightSwitchGrace.test.mjs — 失効後 30 日以内の有料 Light 会員の乗り換え特典（2026-09-29 MK 確定）を固定する
 *
 * | 状態 | 価格資格（¥44,820）|
 * |---|---|
 * | 有効な有料 Light | あり（従来どおり）|
 * | 期限日 D 当日〜 D+30 日の終わり | **あり（猶予）** |
 * | D+31 日以降 | なし（通常条件）|
 * | PaidAt が無い（無料付与・支払い実績なし）| なし |
 * | 入金待ち・停止・テスト | なし |
 *
 * 表示（/pricing/ の tier）と申込時のサーバー判定（checkMemberOnlyPricing）が**同じ関数**であることも固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolvePaidPricingTierFromFields, isWithinLightSwitchGrace, checkMemberOnlyPricing,
  LIGHT_SWITCH_GRACE_DAYS, PRICING_TIER,
} from './pricingEligibility.js';
import {
  resolveLoginNext, encodeLoginNext, decodeLoginNext, LOGIN_NEXT_ALLOWED, LOGIN_NEXT_TTL_MS,
} from '../auth/loginNext.js';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');
const at = (d, t = '12:00:00') => Date.parse(`${d}T${t}+09:00`);
const LIGHT = { 'プラン': 'Light', 'PlanType': 'Monthly', 'Status': 'active', 'PaidAt': '2026-08-01T00:00:00.000Z', '有効期限': '2026-09-01' };

test('猶予日数は 30（無期限にしない）', () => {
  assert.equal(LIGHT_SWITCH_GRACE_DAYS, 30);
});

test('期限の境界: 有効中・D 当日・D+30 の終わりまでは資格あり、D+31 から通常条件', () => {
  const tier = (d, t) => resolvePaidPricingTierFromFields(LIGHT, at(d, t));
  assert.equal(tier('2026-08-31'), PRICING_TIER.LIGHT, '有効中');
  assert.equal(tier('2026-09-01', '08:00:00'), PRICING_TIER.LIGHT, 'D 当日（朝）');
  assert.equal(tier('2026-09-01', '23:00:00'), PRICING_TIER.LIGHT, 'D 当日（夜）');
  assert.equal(tier('2026-09-15'), PRICING_TIER.LIGHT, '失効中（猶予内）');
  assert.equal(tier('2026-10-01', '23:59:00'), PRICING_TIER.LIGHT, 'D+30 の終わり');
  assert.equal(tier('2026-10-02', '00:00:01'), PRICING_TIER.NONE, 'D+31');
  assert.equal(tier('2026-12-01'), PRICING_TIER.NONE, '31 日超');
});

test('実際に支払った Light だけ（PaidAt 無し・無料付与・入金待ち・停止・テストは資格なし）', () => {
  const t = (over) => resolvePaidPricingTierFromFields({ ...LIGHT, ...over }, at('2026-09-10'));
  assert.equal(t({ PaidAt: '' }), PRICING_TIER.NONE, 'PaidAt なし');
  assert.equal(t({ PaidAt: undefined }), PRICING_TIER.NONE, 'PaidAt なし');
  assert.equal(t({ Status: 'pending' }), PRICING_TIER.NONE, '入金待ち');
  assert.equal(t({ Status: 'suspended' }), PRICING_TIER.NONE, '停止');
  assert.equal(t({ 'プラン': 'Standard' }), PRICING_TIER.LIGHT, '旧 Standard は Light 扱い');
  assert.equal(t({ 'プラン': 'Premium' }), PRICING_TIER.NONE, 'Premium の失効は対象外（Light の乗り換え特典）');
  assert.equal(t({ 'プラン': 'Free' }), PRICING_TIER.NONE);
  assert.equal(isWithinLightSwitchGrace({ ...LIGHT, '有効期限': '' }, at('2026-09-10')), false, '期限不明は猶予にしない');
});

test('価格表示と申込時のサーバー判定が一致する（同じ関数・同じ境界）', () => {
  const pn = 'Premium Annual - Campaign (¥44,820/年)';
  for (const [d, t, expect] of [['2026-09-15', '12:00:00', true], ['2026-10-01', '23:59:00', true], ['2026-10-02', '00:00:01', false]]) {
    const now = at(d, t);
    const display = resolvePaidPricingTierFromFields(LIGHT, now) >= PRICING_TIER.LIGHT;
    const server = checkMemberOnlyPricing({ productName: pn, fields: LIGHT, nowMs: now }).eligible;
    assert.equal(display, expect, `${d} 表示`);
    assert.equal(server, expect, `${d} 申込判定`);
  }
  const src = read('src/lib/pricing/pricingEligibility.js');
  assert.match(src, /export function checkMemberOnlyPricing[\s\S]*resolvePaidPricingTierFromFields\(fields, nowMs\)/);
});

test('/pricing/: 猶予日数はサーバーと同じ定数・サーバー tier を期限切れでも使う・31 日超は出さない', () => {
  const src = read('src/pages/pricing.astro');
  assert.match(src, /import \{ LIGHT_SWITCH_GRACE_DAYS \} from '\.\.\/lib\/pricing\/pricingEligibility\.js'/);
  assert.match(src, /graceDays: LIGHT_SWITCH_GRACE_DAYS/);
  const script = src.slice(src.indexOf('define:vars={{ planTierByToken'), src.indexOf('</script>', src.indexOf('define:vars={{ planTierByToken')));
  const iGrace = script.indexOf('graceDays * 86400000');
  const iTier = script.indexOf("typeof up.pricingTier === 'number'");
  const iExpired = script.indexOf("localStorage.getItem('isExpired') === 'true'");
  assert.ok(iGrace > 0 && iTier > iGrace, '31 日超の判定がサーバー tier より先');
  assert.ok(iExpired > iTier, '期限切れの従来判定はサーバー tier が無いときだけ');
});

test('auth-user: 無料ログインの pricingTier は契約終了を伝えるときだけ計算し、それ以外は 0', () => {
  const src = read('netlify/functions/auth-user.js');
  assert.match(src, /pricingTier: previousPlanEnded\s*\?\s*\(await import\('\.\.\/\.\.\/src\/lib\/pricing\/pricingEligibility\.js'\)\)\.resolvePaidPricingTierFromFields\(record\.fields\)\s*:\s*0/);
  const login = read('src/pages/login.astro');
  assert.match(login, /nonAuthoritative: true, pricingTier \}/);
});

test('ログイン後の戻り先: 許可リストの完全一致だけ（オープンリダイレクトにしない）', () => {
  assert.deepEqual([...LOGIN_NEXT_ALLOWED], ['/pricing/']);
  assert.equal(resolveLoginNext('/pricing/'), '/pricing/');
  for (const bad of ['https://evil.example/', '//evil.example/pricing/', '/pricing', '/pricing/?x=1', '/dashboard/', 'javascript:alert(1)', '', null]) {
    assert.equal(resolveLoginNext(bad), null, String(bad));
  }
  const now = Date.UTC(2026, 8, 29);
  assert.equal(decodeLoginNext(encodeLoginNext('/pricing/', now), now + 1000), '/pricing/');
  assert.equal(decodeLoginNext(encodeLoginNext('/pricing/', now), now + LOGIN_NEXT_TTL_MS + 1), null, '古い戻り先は使わない');
  assert.equal(decodeLoginNext('{"path":"https://evil.example/","at":0}', 1), null);
  assert.equal(encodeLoginNext('/admin/'), null);
});

test('ログイン画面とマジックリンク確認画面は同じ許可リストを使う', () => {
  const login = read('src/pages/login.astro');
  assert.match(login, /from '\.\.\/lib\/auth\/loginNext\.js'/);
  assert.match(login, /window\.location\.href = nextPath \|\| '\/dashboard\/'/);
  const verify = read('src/pages/auth/verify.astro');
  assert.match(verify, /NEXT_ALLOWED: LOGIN_NEXT_ALLOWED/);
  assert.match(verify, /NEXT_ALLOWED\.includes\(o\.path\)/);
  assert.match(verify, /ok\(nextPath \|\| data\.redirectTo \|\| '\/dashboard\/'\)/);
});
