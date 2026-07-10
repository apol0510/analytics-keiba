import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildPlanTierByToken, PLAN_TIER_BY_CANONICAL } from './planTiers.js';
import { CANONICAL_PLANS, normalizePlanToken } from '../auth/planNormalization.js';

const PRICING_ASTRO = fileURLToPath(
  new URL('../../pages/pricing.astro', import.meta.url),
);

test('CANONICAL_PLANS すべてに tier が定義されている', () => {
  for (const plan of CANONICAL_PLANS) {
    assert.equal(typeof PLAN_TIER_BY_CANONICAL[plan], 'number', `tier 未定義: ${plan}`);
  }
});

test('tier の上下関係: free < light < premium 系', () => {
  const map = buildPlanTierByToken();
  assert.ok(map['free'] < map['light']);
  assert.ok(map['light'] < map['premium']);
  assert.ok(map['premium'] <= map['premium-plus']);
});

test('別名も同じ tier に解決される（light の旧表記を取りこぼさない）', () => {
  const map = buildPlanTierByToken();
  for (const alias of ['light', 'standard', 'ライト']) {
    assert.equal(map[normalizePlanToken(alias)], 1, `light tier にならない: ${alias}`);
  }
  for (const alias of ['free', 'expired', '無料', 'free-registered']) {
    assert.equal(map[normalizePlanToken(alias)], 0, `free tier にならない: ${alias}`);
  }
  assert.equal(map[normalizePlanToken('プレミアム')], 2);
  assert.equal(map[normalizePlanToken('pro-plus')], 3);
});

test('未知プランは表に載らない（pricing 側で fail-open になる）', () => {
  const map = buildPlanTierByToken();
  assert.equal(map[normalizePlanToken('vip')], undefined);
  assert.equal(map[normalizePlanToken('')], undefined);
});

// pricing.astro のインライン script は import できないため正規化を再掲している。
// planNormalization.js の recipe と食い違うと Light 会員の出し分けが静かに壊れるので固定する。
test('guard: pricing.astro のインライン正規化が normalizePlanToken と同一 recipe', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const recipe = `.normalize('NFKC').trim().toLowerCase().replace(/[\\s_]+/g, '-')`;
  assert.ok(
    src.includes(recipe),
    'pricing.astro のトークン正規化が planNormalization.js と一致しません',
  );
  assert.equal(normalizePlanToken(' Light '), 'light');
  assert.equal(normalizePlanToken('Premium_Plus'), 'premium-plus');
});

// Light 会員に無料/Light カードを出さない CSS ルールが消えていないこと（デザイン修正での事故防止）
test('guard: pricing.astro に Light 会員向けの下位カード非表示ルールがある', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  for (const tier of ['0', '1']) {
    assert.ok(
      src.includes(`:global(:root[data-plan-tier="1"]) .plan-card[data-plan-tier="${tier}"]`),
      `非表示ルールが無い: .plan-card[data-plan-tier="${tier}"]`,
    );
  }
  assert.ok(/class="plan-card" data-plan-tier="1"/.test(src), 'Light カードに tier 属性が無い');
  assert.ok(/class="plan-card" data-plan-tier="0"/.test(src), '無料カードに tier 属性が無い');
});

// プラン別出し分け。only-for はデフォルト非表示 → Light 会員でだけ表示、が両方必要
test('guard: pricing.astro にプラン別出し分けルールがある', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  // !important が無いと .plan-button 等の後発 display 宣言に負けて乗り換えボタンが全員に見える
  assert.ok(
    /\[data-only-for\]\s*\{\s*display:\s*none\s*!important/.test(src),
    'data-only-for のデフォルト非表示が !important でない（乗り換え価格が全員に露出する）',
  );
  assert.ok(
    /\[data-hide-for="light"\]\s*\{\s*display:\s*none\s*!important/.test(src),
    'data-hide-for の非表示が !important でない',
  );
  assert.ok(src.includes(':global(:root[data-plan-tier="1"]) [data-hide-for="light"]'));
  assert.ok(src.includes('data-hide-for="light"'), 'hide-for を使う要素が無い');
  assert.ok(src.includes('data-only-for="light"'), 'only-for を使う要素が無い');

  // display の復帰値を明示していない要素があると、表示されるべきものが出ない
  for (const sel of ['.faq-item', '.plan-price', '.plan-button', '.recommended-badge', '.feature-item']) {
    assert.ok(
      src.includes(`${sel}[data-only-for="light"]`),
      `only-for の復帰ルールが無い: ${sel}`,
    );
  }
});

// 乗り換えキャンペーン: 金額と、Functions 側のプラン名正規化を通ることを固定する。
// bank-transfer-application.js は productName から料金部分と "- Campaign" を除去して
// Airtable Single select の planName / planType を作る。接尾辞を変えると壊れる。
test('guard: 乗り換え特典価格が Functions のプラン名正規化を通る', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const listPrice = 49800;
  const discount = 4980; // Light 1ヶ月分
  const switchPrice = listPrice - discount;
  assert.equal(switchPrice, 44820);
  assert.equal(switchPrice / 12, 3735); // カードの「月額換算 ¥3,735」
  assert.equal(4980 * 12 - switchPrice, 14940); // FAQ の「¥14,940 お得」

  assert.ok(
    src.includes("openBankModal('Premium Annual - Campaign', 44820, 'annual')"),
    '乗り換えボタンの引数が変わった',
  );
  assert.ok(src.includes('¥44,820'), 'カード/FAQ に乗り換え価格が無い');
  assert.ok(src.includes('¥14,940'), 'FAQ の差額表記が無い');

  // bank-transfer-application.js の正規化を再現して planName='Premium' / planType='Annual' を確認
  const productName = 'Premium Annual - Campaign (¥44,820/年)';
  const fullPlanName = productName.replace(/\s*\(.*\)$/, '').trim();
  const planType = fullPlanName.includes('Annual') ? 'Annual' : 'Monthly';
  const planName = fullPlanName
    .replace(/\s*\(Standard Upgrade\)/, '')
    .replace(/\s*-\s*Campaign/, '')
    .replace(/\s*\(ライト\)/, '')
    .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|30日)$/, '')
    .trim();
  assert.equal(planName, 'Premium', 'Airtable の Single select が不正値になる');
  assert.equal(planType, 'Annual', '有効期限が1ヶ月後で上書きされる');
});

// FAQ の手順は銀行振込モーダルの .bank-steps と同じ順序（振込 → 報告フォーム）でなければならない
test('guard: FAQ の利用開始フローが「振込が先」になっている', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const faq = src.slice(src.indexOf('Q: 利用開始までの流れは？'));
  const flow = faq.slice(0, faq.indexOf('</div>'));
  assert.ok(
    flow.indexOf('①銀行振込') < flow.indexOf('報告フォーム'),
    'FAQ が「フォーム送信 → 振込」の順になっている（モーダルの実手順と矛盾）',
  );
  // モーダル側の実手順が変わっていないことも確認
  assert.ok(src.includes('上記の口座情報に振込金額をお振込みください'));
  assert.ok(src.includes('振込完了後、下記のフォームから必要情報をご送信ください'));
});

// 買い目 FAQ は「昨日の買い目」へ導線を張る（購入前に実物を確認できる状態を維持する）
test('guard: 買い目 FAQ が昨日の買い目へリンクしている', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const heading = 'Q: 買い目は何点ですか？';
  assert.ok(src.includes(heading), '買い目 FAQ の見出しが変わった');

  const faq = src.slice(src.indexOf(heading));
  const answer = faq.slice(0, faq.indexOf('</div>'));
  for (const href of ['/results-showcase/nankan/', '/results-showcase/jra/']) {
    assert.ok(answer.includes(`href="${href}"`), `買い目 FAQ に導線が無い: ${href}`);
  }
});

// Light → プレミアム年払いの価格比較を FAQ に書いている。カードの価格を直したら破綻するため固定する
test('guard: FAQ の Light 年間換算がカード表示価格と整合する', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const lightMonthly = 4980;
  const premiumAnnual = 49800;
  assert.equal(lightMonthly * 12, 59760);
  assert.equal(premiumAnnual / 12, 4150); // カードの「月額換算 ¥4,150」

  assert.ok(src.includes("openBankModal('Light', 4980, 'monthly')"), 'Light の価格が変わった');
  assert.ok(src.includes("openBankModal('Premium Annual', 49800, 'annual')"), 'プレミアム年払いの価格が変わった');
  assert.ok(src.includes('¥59,760'), 'FAQ の Light 年間換算が無い');
});
