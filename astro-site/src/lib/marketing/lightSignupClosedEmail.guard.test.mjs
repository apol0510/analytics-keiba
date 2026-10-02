/**
 * Light 新規募集停止・Stripe 月額への再編に伴うメール横断監査（2026-10-02 MK 確定・PR #677）の固定。
 *
 * - 新規・無料向けメールで Light を募集しない（Light を案内する文面の campaign は送信計画を作らない）
 * - 旧 Premium 月額の銀行振込・旧価格の CTA を出さない
 * - 既存の有料 Light 会員の更新権は残すが、主導線は同額の Premium ¥4,980（中央＋南関）
 * - Premium 会員に同じプランの購入 CTA を出さない／会場限定 Premium に三連複を売らない
 * - Stripe live 決済が無効な間は、Stripe 月額を案内するメールを実送信しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CAMPAIGNS, matchesCampaignAudience, SANRENPUKU_SALES_CAMPAIGNS } from './campaignCatalog.js';
import { LIGHT_SIGNUP_CLOSED_CAMPAIGNS, isLightSignupClosedCampaign } from './lightSignupClosedCampaigns.js';
import { RETIRED_SEQUENCE_STEPS, retiredStepsFor } from './retiredSequenceSteps.js';
import { buildCampaignPlan } from './campaignSend.js';
import { checkStripeLiveSales, gateModeOnStripeSales } from '../billing/stripeSalesGate.js';
import { planById } from '../billing/stripePlans.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');

const stepsOf = (c) => (c.sequence?.steps?.length ? c.sequence.steps : [{ ...c, stepNumber: 0 }]);
const textOf = (c, s) => [s.subject, s.preheader, s.body, s.ctaLabel, s.ctaUrl ?? c.ctaUrl].filter(Boolean).join('\n');

/**
 * 文面そのものではなく、本文に差し込まれる割引一覧（campaignOffers）に Light が出ていたため止めた campaign。
 * 割引一覧からは Light を外した（campaignOffers.test）が、再開は文面・差込内容の再確認のうえで行う。
 */
const LIGHT_VIA_OFFER_LIST = new Set(['campaign-prospect-phase2']);

/** 無償付与・終了のお知らせとして Light に触れてよい step（購入・継続の案内はしない） */
const LIGHT_GRANT_NOTICES = new Set([
  'comeback-light-30d-granted#0',
  'light-lifetime-restart#0',
  'light-trial-post-expiry-sequence#1',
]);
const LIGHT_WORDS = /Light|ライト/;
const PURCHASE_WORDS = /お申し?込み(いただ|くださ|はこちら)|お振込|銀行振込で|ご継続|更新(して|手続|のお手続)|購入|[¥￥]\s?\d|\d+円/;

/** 送信されうる（止めていない）step の一覧 */
function liveSteps() {
  const out = [];
  for (const c of CAMPAIGNS) {
    if (isLightSignupClosedCampaign(c.campaignId)) continue;
    const retired = retiredStepsFor(c.campaignId);
    for (const s of stepsOf(c)) {
      if (retired.includes(s.stepNumber)) continue;
      out.push({ c, s, key: `${c.campaignId}#${s.stepNumber}`, text: textOf(c, s) });
    }
  }
  return out;
}

test('送信されうるメールで Light を案内するのは無償付与・終了のお知らせだけ（購入・継続の文言なし）', () => {
  const steps = liveSteps();
  assert.ok(steps.length > 20, `step を読めていない: ${steps.length}`);
  for (const { key, text } of steps) {
    if (!LIGHT_WORDS.test(text)) continue;
    assert.ok(LIGHT_GRANT_NOTICES.has(key), `${key} が Light に触れている（送信停止リストか retired step へ）`);
    assert.equal(PURCHASE_WORDS.test(text), false, `${key}: Light の購入・継続を案内している`);
  }
});

test('送信されうるメールに旧価格（Light ¥18,000 等）・旧 Premium 月額の銀行振込 CTA が無い', () => {
  for (const { key, text } of liveSteps()) {
    assert.equal(/18,?000|9,?980|19,?820/.test(text), false, `${key}: 旧価格`);
    assert.equal(/月額[^\n]{0,20}(銀行)?振込|振込[^\n]{0,20}月額/.test(text), false, `${key}: 月額の銀行振込`);
    assert.equal(/light-campaign|plan-upgrade-guide/.test(text), false, `${key}: 廃止した導線`);
  }
});

test('送信停止リストは実在する campaign だけ・理由付き／Light 文面のまま外すと上のテストで落ちる', () => {
  const ids = new Set(CAMPAIGNS.map((c) => c.campaignId));
  for (const [id, why] of Object.entries(LIGHT_SIGNUP_CLOSED_CAMPAIGNS)) {
    assert.ok(ids.has(id), `存在しない campaign: ${id}`);
    assert.ok(String(why).length > 5, `${id}: 理由が無い`);
  }
  // 再開シミュレーション: 停止リストから外したとき Light 文面が残っていれば検知される
  for (const id of Object.keys(LIGHT_SIGNUP_CLOSED_CAMPAIGNS)) {
    if (LIGHT_VIA_OFFER_LIST.has(id)) continue;
    const c = CAMPAIGNS.find((x) => x.campaignId === id);
    const flagged = stepsOf(c).some((s) => LIGHT_WORDS.test(textOf(c, s)) && !LIGHT_GRANT_NOTICES.has(`${id}#${s.stepNumber}`));
    assert.ok(flagged, `${id} は Light 文面が無いのに停止中（書き直し済みなら停止リストから外す）`);
  }
});

test('停止中の campaign は送信計画を作らない（管理画面・連続配信・rollout 共通の入口）', () => {
  const selected = [{ recordId: 'recA', email: 'a@example.com', name: 'A' }];
  for (const id of Object.keys(LIGHT_SIGNUP_CLOSED_CAMPAIGNS)) {
    const campaign = CAMPAIGNS.find((x) => x.campaignId === id);
    const plan = buildCampaignPlan({ campaign, selected, fromEmail: 'noreply@keiba.link', nowMs: Date.now() });
    assert.equal(plan.error, 'light_signup_closed', id);
    assert.equal(plan.recipients.length, 0, id);
  }
  // テスト用の解除は本番コードから呼ばない
  const out = execFileSync('git', ['grep', '-l', '__allowLightSignupClosedCampaignsForTests', '--', 'src', 'netlify', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const f of out) assert.match(f, /\.test\.mjs$|lightSignupClosedCampaigns\.js$/, f);
});

test('無料登録オンボーディングの step5（Light 比較）は送らない・定期 tick が retired step を渡す', () => {
  assert.deepEqual(retiredStepsFor('free-signup-onboarding'), [5]);
  assert.deepEqual(retiredStepsFor('unknown'), []);
  assert.ok(RETIRED_SEQUENCE_STEPS['free-signup-onboarding'][5]);
  assert.match(read('netlify/functions/cron-campaign-sequence.js'), /\[\.\.\.retiredStepsFor\(base\.campaignId\)\]/);
});

test('会場限定 Premium（中央版・南関版）には三連複を売らない／両会場 Premium には送る', () => {
  for (const id of SANRENPUKU_SALES_CAMPAIGNS) {
    const c = CAMPAIGNS.find((x) => x.campaignId === id);
    assert.ok(c, id);
    const r = matchesCampaignAudience(c, { premiumVenueOnly: true, contract: 'active', plan: 'premium' });
    assert.equal(r.ok, false, id);
    assert.equal(r.reason, 'venue_only_premium');
  }
  const offer = CAMPAIGNS.find((x) => x.campaignId === 'sanrenpuku-offer');
  assert.notEqual(matchesCampaignAudience(offer, { premiumVenueOnly: false, contract: 'active', plan: 'premium' }).reason, 'venue_only_premium');
});

test('Stripe live 決済が無効な間は live 送信を dry-run に落とす（fail closed）', async () => {
  const fake = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
  const open = { charges_enabled: true, capabilities: { card_payments: 'active' } };
  assert.deepEqual(await checkStripeLiveSales({ STRIPE_SECRET_KEY: 'rk_live_x' }, { fetchImpl: fake(open) }), { open: true, reason: 'ok' });
  assert.equal((await checkStripeLiveSales({ STRIPE_SECRET_KEY: 'rk_live_x' }, { fetchImpl: fake({ charges_enabled: false, requirements: { disabled_reason: 'under_review' } }) })).open, false);
  assert.equal((await checkStripeLiveSales({ STRIPE_SECRET_KEY: 'rk_live_x' }, { fetchImpl: fake({ charges_enabled: true, capabilities: { card_payments: 'inactive' } }) })).open, false);
  assert.equal((await checkStripeLiveSales({ STRIPE_SECRET_KEY: 'rk_live_x' }, { fetchImpl: fake({}, false, 500) })).open, false);
  assert.equal((await checkStripeLiveSales({ STRIPE_SECRET_KEY: 'rk_live_x' }, { fetchImpl: async () => { throw new Error('x'); } })).open, false);
  assert.equal((await checkStripeLiveSales({})).reason, 'stripe_key_missing');

  assert.equal(gateModeOnStripeSales('live', { open: false }), 'dry-run');
  assert.equal(gateModeOnStripeSales('live', null), 'dry-run');
  assert.equal(gateModeOnStripeSales('live', { open: true }), 'live');
  assert.equal(gateModeOnStripeSales('off', { open: true }), 'off', '広げる方向に変えない');
  assert.equal(gateModeOnStripeSales('dry-run', { open: true }), 'dry-run');

  for (const f of ['netlify/functions/cron-premium-renewal-reminder.js', 'netlify/functions/cron-light-renewal-reminder.js']) {
    const s = read(f);
    assert.match(s, /gateModeOnStripeSales\(resolveMode\(process\.env\), sales\)/, f);
    assert.match(s, /await checkStripeLiveSales\(process\.env\)/, f);
  }
});

test('有料 Light 会員の更新メール: 主導線は同額 Premium ¥4,980（中央＋南関）・Light 更新は残すが CTA にしない', () => {
  const s = read('src/lib/marketing/lightRenewal/lightRenewalEmail.js');
  assert.equal(planById('premium').amountYen, 4980);
  assert.match(s, /planById\('premium'\)\.amountYen/);
  assert.match(s, /Premium へ変更する手続きへ/);
  assert.match(s, /\/login\/\?next=\/pricing\//);
  assert.equal(/Light を続ける|Lightを続ける|Light のままご利用/.test(s), false);
});

test('Premium 更新メール: 3 プラン（中央版・南関版・Premium）を案内し、Light を案内しない', async () => {
  const { renderPremiumRenewalEmail } = await import('./premiumRenewal/premiumRenewalEmail.js');
  const { STAGE } = await import('./premiumRenewal/premiumRenewalPolicy.js');
  for (const stage of [STAGE.PRE, STAGE.POST]) {
    const { subject, text } = renderPremiumRenewalEmail({ stage, cycle: '2026-10-20', name: 'テスト' });
    const all = `${subject}\n${text}`;
    assert.match(all, /¥4,980／月・中央＋南関/, stage);
    assert.match(all, /中央版・南関版（各 ¥2,980／月）/, stage);
    assert.match(all, /\/login\/\?next=\/pricing\//, stage);
    assert.equal(/Light|ライト|18,000/.test(all), false, stage);
  }
});
