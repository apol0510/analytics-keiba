/**
 * upsellExplain.test.mjs — 管理画面の「なぜこの CTA が出ているのか」説明
 *   node --test src/lib/upsell/upsellExplain.test.mjs
 *
 * 固定したいこと:
 *   1. しきい値・優先順位は既存のまま（ROUTE B = Premium 加入 30 日以上 かつ 三連複未購入）
 *   2. 2 商品を同時に表示しない（channel は常に 1 つ）
 *   3. 管理画面の「自動判定理由」が顧客側 resolver の結果と一致する
 *   4. 経過日数が取れないときに理由を捏造しない
 *
 * ⚠️ このモジュールは説明生成であって判定ではない。判定の期待値は
 *    resolveUpsellForCustomer（顧客側と同一）から取り、説明側と突き合わせる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  explainUpsell,
  describeUpsellReasonText,
  describeDaysSincePremium,
  UPSELL_AUTO_RULE_TEXT,
  UPSELL_CHANNEL_LABEL,
  ROUTE_LABEL,
} from './upsellExplain.js';
import {
  UPSELL_CHANNEL,
  UPSELL_REASON,
  resolveUpsellForCustomer,
} from './upsellTarget.js';
import { PP_ROUTE, PREMIUM_30D_DAYS } from '../premiumPlus/premiumPlusRelease.js';

const NOW = Date.parse('2026-08-07T02:00:00.000Z'); // JST 11:00（受付時間内）
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString();

/** 通常 Premium 会員（三連複 未購入）。PaidAt を N 日前に置く。 */
function premiumMember(days, extra = {}) {
  return {
    'プラン': 'Premium',
    PlanType: 'Annual',
    Status: 'active',
    '有効期限': '2099-12-31',
    PaidAt: days === null ? undefined : daysAgo(days),
    ...extra,
  };
}

/** 三連複 保有会員。 */
function sanrenpukuMember(extra = {}) {
  return {
    'プラン': 'Premium Sanrenpuku',
    PlanType: 'Lifetime',
    Status: 'active',
    '有効期限': '2099-12-31',
    LifetimeSanrenpuku: true,
    ...extra,
  };
}

// ── 1. しきい値（既存ルールを変えていないこと）────────────────────
test(`Premium ${PREMIUM_30D_DAYS - 1}日・三連複未購入 → auto で三連複`, () => {
  const e = explainUpsell({ fields: premiumMember(PREMIUM_30D_DAYS - 1), nowMs: NOW });
  assert.equal(e.autoChannel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(e.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(e.route, PP_ROUTE.NONE, 'ROUTE B は成立しない');
  assert.equal(e.daysSincePremium, PREMIUM_30D_DAYS - 1);
});

test(`Premium ${PREMIUM_30D_DAYS}日以上・三連複未購入・販売可 → ROUTE B / Plus`, () => {
  const fields = premiumMember(40, {
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(40),
  });
  const e = explainUpsell({ fields, nowMs: NOW });
  assert.equal(e.route, PP_ROUTE.PREMIUM_30D);
  assert.equal(e.autoChannel, UPSELL_CHANNEL.PLUS);
  assert.equal(e.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(e.daysSincePremium, 40);
});

test(`ROUTE B ちょうど ${PREMIUM_30D_DAYS} 日で成立する（境界を動かしていない）`, () => {
  const mk = (d) => explainUpsell({
    fields: premiumMember(d, { PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(d) }),
    nowMs: NOW,
  });
  assert.equal(mk(PREMIUM_30D_DAYS - 1).route, PP_ROUTE.NONE);
  assert.equal(mk(PREMIUM_30D_DAYS).route, PP_ROUTE.PREMIUM_30D);
});

test('三連複保有済み → 三連複の再購入 CTA を出さない', () => {
  const e = explainUpsell({ fields: sanrenpukuMember(), nowMs: NOW });
  assert.equal(e.hasSanrenpuku, true);
  assert.equal(e.route, PP_ROUTE.SANRENPUKU, '保有者は常に ROUTE A');
  assert.notEqual(e.autoChannel, UPSELL_CHANNEL.SANRENPUKU);
  assert.notEqual(e.channel, UPSELL_CHANNEL.SANRENPUKU);
});

// ── 2. 2 商品を同時に表示しない ────────────────────────────────
test('auto でも 2 商品を同時に表示しない（channel は常に 1 つ）', () => {
  const cases = [
    premiumMember(10),
    premiumMember(40, { PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(40) }),
    premiumMember(40, { PremiumPlusEligibility: 'review' }),
    premiumMember(null),
    sanrenpukuMember({ PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(20) }),
    sanrenpukuMember({ PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(4) }),
  ];
  for (const fields of cases) {
    const v = resolveUpsellForCustomer({ fields, nowMs: NOW });
    assert.ok(Object.values(UPSELL_CHANNEL).includes(v.channel));
    const bothOn = v.sanrenpuku.allowed === true && v.plus.allowed === true;
    assert.equal(bothOn, false, '三連複と Plus を同時に許可している');
    if (v.channel !== UPSELL_CHANNEL.SANRENPUKU) assert.equal(v.sanrenpuku.allowed, false);
    if (v.channel !== UPSELL_CHANNEL.PLUS) assert.equal(v.plus.allowed, false);
  }
});

// ── 3. 手動指定が排他的に反映される ────────────────────────────
test('manual sanrenpuku / plus / none が排他的に反映される', () => {
  const base = premiumMember(40, {
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(40),
  });

  const none = explainUpsell({ fields: { ...base, UpsellTarget: 'none' }, nowMs: NOW });
  assert.equal(none.channel, UPSELL_CHANNEL.NONE);
  assert.equal(none.isManual, true);
  assert.equal(none.autoChannel, UPSELL_CHANNEL.PLUS, '自動判定は手動指定に影響されない');
  assert.equal(none.differsFromAuto, true);

  const srp = explainUpsell({ fields: { ...base, UpsellTarget: 'sanrenpuku' }, nowMs: NOW });
  assert.equal(srp.channel, UPSELL_CHANNEL.SANRENPUKU);
  assert.equal(srp.autoChannel, UPSELL_CHANNEL.PLUS);

  const plus = explainUpsell({ fields: { ...base, UpsellTarget: 'plus' }, nowMs: NOW });
  assert.equal(plus.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(plus.differsFromAuto, false);
});

test('手動 sanrenpuku でも保有済みなら CTA を出さない（fail closed を維持）', () => {
  const e = explainUpsell({ fields: sanrenpukuMember({ UpsellTarget: 'sanrenpuku' }), nowMs: NOW });
  assert.equal(e.channel, UPSELL_CHANNEL.NONE);
  assert.equal(e.reason, UPSELL_REASON.SANRENPUKU_OWNED);
  assert.match(e.reasonText, /保有済み/);
});

test('手動 plus でも blocked は表示しない（fail closed を維持）', () => {
  const fields = premiumMember(40, { PremiumPlusEligibility: 'blocked', UpsellTarget: 'plus' });
  const e = explainUpsell({ fields, nowMs: NOW });
  assert.equal(e.channel, UPSELL_CHANNEL.NONE);
  assert.equal(e.reason, UPSELL_REASON.PLUS_NOT_ELIGIBLE);
  assert.match(e.reasonText, /販売対象外/);
});

test('退会・期限切れ等でログイン不可なら手動指定でも何も出さない', () => {
  for (const target of ['auto', 'plus', 'sanrenpuku', 'none']) {
    const e = explainUpsell({
      fields: { 'プラン': 'Premium', Status: 'inactive', '有効期限': '2020-01-01', UpsellTarget: target },
      nowMs: NOW,
    });
    assert.equal(e.channel, UPSELL_CHANNEL.NONE, `target=${target}`);
  }
});

// ── 4. 管理画面の説明が顧客側 resolver と一致する ──────────────
test('自動判定・実表示ともに顧客側 resolver と channel が一致する', () => {
  const cases = [
    premiumMember(5),
    premiumMember(29),
    premiumMember(30, { PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(30) }),
    premiumMember(40, { PremiumPlusEligibility: 'review' }),
    premiumMember(null, { PremiumPlusEligibility: 'eligible' }),
    sanrenpukuMember({ PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(20) }),
    { ...premiumMember(40, { PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(40) }), UpsellTarget: 'none' },
    { ...premiumMember(40, { PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(40) }), UpsellTarget: 'sanrenpuku' },
    { ...sanrenpukuMember(), UpsellTarget: 'plus' },
  ];
  for (const fields of cases) {
    const e = explainUpsell({ fields, nowMs: NOW });
    const customer = resolveUpsellForCustomer({ fields, nowMs: NOW });
    assert.equal(e.channel, customer.channel, '実表示が顧客側と食い違う');
    assert.equal(e.reason, customer.reason, '理由コードが顧客側と食い違う');

    const auto = resolveUpsellForCustomer({ fields, nowMs: NOW, targetOverride: 'auto' });
    assert.equal(e.autoChannel, auto.channel, '自動判定が顧客側 resolver と食い違う');
    assert.equal(e.autoReasonText, describeUpsellReasonText(auto, auto.plusRelease));
  }
});

test('targetOverride を渡さない既定動作は従来と完全に同じ', () => {
  const fields = premiumMember(40, {
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(40),
    UpsellTarget: 'none',
  });
  const a = resolveUpsellForCustomer({ fields, nowMs: NOW });
  const b = resolveUpsellForCustomer({ fields, nowMs: NOW, targetOverride: undefined });
  assert.equal(a.channel, b.channel);
  assert.equal(a.target, 'none');
  assert.equal(a.reason, b.reason);
});

// ── 5. ROUTE B の理由は具体的に出す ────────────────────────────
test('ROUTE B の Plus 表示は「30日以上経過・三連複未購入」を理由に明示する', () => {
  const fields = premiumMember(42, {
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(42),
  });
  const e = explainUpsell({ fields, nowMs: NOW });
  assert.equal(e.route, PP_ROUTE.PREMIUM_30D);
  assert.match(e.autoReasonText, new RegExp(`${PREMIUM_30D_DAYS}日以上経過`));
  assert.match(e.autoReasonText, /三連複未購入/);
  assert.match(e.autoReasonText, /42/, '実際の経過日数を出す');
  // 「自動（Plus 販売対象）」だけで終わらせない
  assert.notEqual(e.autoReasonText, '自動（Plus 販売対象）');
  assert.ok(e.autoReasonText.length > 20, '説明が短すぎる');
});

// ── 6. 経過日数を捏造しない ────────────────────────────────────
test('PaidAt 未記録なら日数を作らず「未記録」と明示する', () => {
  const e = explainUpsell({ fields: premiumMember(null, { PremiumPlusEligibility: 'eligible' }), nowMs: NOW });
  assert.equal(e.daysSincePremium, null);
  assert.match(e.daysSincePremiumText, /未記録/);
  assert.doesNotMatch(e.daysSincePremiumText, /\d+\s*日/, '存在しない日数を出している');
  // 理由文でも「加入から N 日」を捏造しない（しきい値 30 日の言及は可）
  assert.match(e.autoReasonText, /未記録/);
  assert.doesNotMatch(e.autoReasonText, /加入から\s*\d+\s*日/, '存在しない経過日数を出している');
});

test('describeDaysSincePremium: 数値以外は「未記録」（ROUTE A 以外）', () => {
  assert.equal(describeDaysSincePremium(0), '0 日');
  assert.equal(describeDaysSincePremium(30), '30 日');
  for (const v of [null, undefined, NaN, Infinity, '30', {}]) {
    assert.match(describeDaysSincePremium(v), /未記録/, `v=${String(v)}`);
  }
});

// ── 6-b. ROUTE A の null を「未記録」と言わない（2026-08-07 の表示不備）──
//
// resolvePlusRoute は ROUTE A で最初に短絡し daysSincePremium を **常に null** で返す。
// 三連複保有者に「Premium 加入からの 30 日」は無関係だからで、PaidAt が無いという意味ではない。
// 本番の ROUTE A 3 件のうち 2 件は PaidAt を持っているのに「未記録」と表示されていた。
test('ROUTE A は PaidAt があっても null になる（既存仕様の確認）', () => {
  const fields = sanrenpukuMember({ PaidAt: daysAgo(200) });
  const e = explainUpsell({ fields, nowMs: NOW });
  assert.equal(e.route, PP_ROUTE.SANRENPUKU);
  assert.equal(e.daysSincePremium, null, 'ROUTE A は経過日数を返さない');
  assert.equal(e.hasPaidAt, true, 'PaidAt は存在する');
});

test('ROUTE A + PaidAtあり → 「未記録」と表示しない', () => {
  const e = explainUpsell({ fields: sanrenpukuMember({ PaidAt: daysAgo(200) }), nowMs: NOW });
  assert.doesNotMatch(e.daysSincePremiumText, /未記録/, 'データ欠損だと誤読させている');
});

test('ROUTE A + PaidAtなし でも「未記録」と表示しない（判定対象外が理由）', () => {
  const e = explainUpsell({ fields: sanrenpukuMember(), nowMs: NOW });
  assert.equal(e.hasPaidAt, false);
  assert.doesNotMatch(e.daysSincePremiumText, /未記録/);
});

test('ROUTE A は「判定対象外」であることを明示する', () => {
  for (const fields of [sanrenpukuMember({ PaidAt: daysAgo(200) }), sanrenpukuMember()]) {
    const e = explainUpsell({ fields, nowMs: NOW });
    assert.match(e.daysSincePremiumText, /ROUTE A/);
    assert.match(e.daysSincePremiumText, /判定対象外/);
  }
  assert.match(describeDaysSincePremium(null, { route: PP_ROUTE.SANRENPUKU }), /判定対象外/);
  // ROUTE A では日数の有無に関わらず対象外（数値が来ても日数を語らない）
  assert.match(describeDaysSincePremium(99, { route: PP_ROUTE.SANRENPUKU }), /判定対象外/);
});

test('ROUTE B + PaidAtなし → 「未記録」を維持する', () => {
  const fields = premiumMember(null, { PremiumPlusEligibility: 'eligible' });
  const e = explainUpsell({ fields, nowMs: NOW });
  assert.notEqual(e.route, PP_ROUTE.SANRENPUKU);
  assert.equal(e.hasPaidAt, false);
  assert.match(e.daysSincePremiumText, /未記録/);
  assert.doesNotMatch(e.daysSincePremiumText, /判定対象外/);
});

test('ROUTE B + PaidAtあり → 経過日数を表示する', () => {
  const fields = premiumMember(42, {
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(42),
  });
  const e = explainUpsell({ fields, nowMs: NOW });
  assert.equal(e.route, PP_ROUTE.PREMIUM_30D);
  assert.equal(e.hasPaidAt, true);
  assert.equal(e.daysSincePremiumText, '42 日');
});

test('ROUTE A の「販売できる商品がない」理由も PaidAt 欠損と言わない', () => {
  const text = describeUpsellReasonText(
    { reason: UPSELL_REASON.NOTHING_TO_SELL, reasonLabel: '' },
    { route: PP_ROUTE.SANRENPUKU, daysSincePremium: null, phase: 4 }
  );
  assert.doesNotMatch(text, /未記録/);
  assert.match(text, /保有済み/);
});

test('この修正で顧客側 resolver の結果は変わらない（説明レイヤーのみ）', () => {
  const cases = [
    sanrenpukuMember({ PaidAt: daysAgo(200) }),
    sanrenpukuMember(),
    sanrenpukuMember({ PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(20) }),
    premiumMember(null, { PremiumPlusEligibility: 'eligible' }),
    premiumMember(42, { PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(42) }),
  ];
  for (const fields of cases) {
    const e = explainUpsell({ fields, nowMs: NOW });
    const customer = resolveUpsellForCustomer({ fields, nowMs: NOW });
    assert.equal(e.channel, customer.channel);
    assert.equal(e.reason, customer.reason);
    assert.equal(e.route, customer.plusRelease.route);
    assert.equal(e.phase, customer.plusRelease.phase);
    // 判定値そのもの（表示文字列ではない）は不変
    assert.equal(e.daysSincePremium, customer.plusRelease.daysSincePremium ?? null);
  }
});

test('Plus 非対象の理由は「PaidAt 未記録」と「30日未達」を区別する', () => {
  const view = { reason: UPSELL_REASON.PLUS_NOT_ELIGIBLE, reasonLabel: '' };

  const missing = describeUpsellReasonText(view, { route: PP_ROUTE.NONE, daysSincePremium: null, phase: 0 });
  assert.match(missing, /未記録/);
  assert.doesNotMatch(missing, /加入から\s*\d+\s*日/, '存在しない経過日数を出している');

  const short = describeUpsellReasonText(view, { route: PP_ROUTE.NONE, daysSincePremium: 12, phase: 0 });
  assert.match(short, /12日/);
  assert.doesNotMatch(short, /未記録/);
});

test('手動 plus の Premium 会員は ROUTE C で救済される（PaidAt 空でも塞がない）', () => {
  // 既存仕様: 管理者が Plus を明示指定した有効 Premium は、PaidAt が無くても販売対象になる。
  // ここを変えないことを固定する（30 日ルールは auto の話であって、明示指定を縛らない）。
  const e = explainUpsell({
    fields: premiumMember(null, {
      PremiumPlusEligibility: 'eligible',
      PremiumPlusEligibleAt: daysAgo(40),
      UpsellTarget: 'plus',
    }),
    nowMs: NOW,
  });
  assert.equal(e.route, PP_ROUTE.PREMIUM_ADMIN);
  assert.equal(e.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(e.daysSincePremium, null);
  assert.match(e.daysSincePremiumText, /未記録/, '経過日数を捏造しない');
  // 自動判定では Plus にならない（手動指定との差を管理者に見せる）
  assert.notEqual(e.autoChannel, UPSELL_CHANNEL.PLUS);
  assert.equal(e.differsFromAuto, true);
});

// ── 7. auto の意味の明記 ───────────────────────────────────────
test('「自動」の判定ルール文言が resolveUpsellDisplay の優先順位と対応している', () => {
  assert.ok(UPSELL_AUTO_RULE_TEXT.length >= 3);
  assert.match(UPSELL_AUTO_RULE_TEXT[0], /Plus/);
  assert.match(UPSELL_AUTO_RULE_TEXT[1], /三連複/);
  // 「2 商品同時表示なし」を必ず明記する
  assert.ok(UPSELL_AUTO_RULE_TEXT.some((t) => /同時/.test(t)), '同時表示しない旨が無い');
});

test('ラベルは 4 種すべて定義済み', () => {
  for (const c of Object.values(UPSELL_CHANNEL)) {
    assert.equal(typeof UPSELL_CHANNEL_LABEL[c], 'string');
    assert.ok(UPSELL_CHANNEL_LABEL[c].length > 0);
  }
  for (const r of Object.values(PP_ROUTE)) {
    assert.equal(typeof ROUTE_LABEL[r], 'string');
  }
});

test('すべての理由コードに具体的な日本語文がある（コード名が露出しない）', () => {
  for (const reason of Object.values(UPSELL_REASON)) {
    const text = describeUpsellReasonText({ reason, reasonLabel: '' }, { route: PP_ROUTE.NONE, phase: 0 });
    assert.ok(text && text.length > 0, `${reason} の説明が無い`);
    assert.doesNotMatch(text, /^[a-z_]+$/, `${reason} でコード名がそのまま出ている`);
  }
});

// ── 8. read-only であること ────────────────────────────────────
test('explainUpsell は書き込み用フィールドを組み立てない', () => {
  const e = explainUpsell({ fields: premiumMember(40), nowMs: NOW });
  // 返り値に Airtable のフィールド名（書き込み対象）が現れない
  const keys = Object.keys(e);
  for (const f of ['UpsellTarget', 'PremiumPlusEligibility', 'プラン', '有効期限', 'PaidAt']) {
    assert.ok(!keys.includes(f), `${f} を返している`);
  }
});
