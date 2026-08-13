/**
 * customerScanBounds.test.mjs — 絞り込みが**人を落とさない**こと
 *   node --test src/lib/marketing/customerScanBounds.test.mjs
 *
 * 一番危険なのは「式は正しく動くが、拾うべき人を落とす」形。
 * 落ちた人は画面から消えるだけで、エラーにならない。だから
 * **JS の鏡と突き合わせて超集合であること**をここで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustomerListFormula, buildSegmentFormula, buildComebackCandidateFormula,
  buildGrantOperationFormula, buildAnyGrantOperationFormula,
  planGroupClause, planGroupMirror, planTokensFor, paidPlanTokens, planTokenVariants,
  comebackCandidateMirror, escapeFormulaValue, describeScanLimit, describeNotNarrowable,
  SCAN_FAIL, SCAN_MAX_PAGES, GRANT_OP_FIELDS,
} from './customerScanBounds.js';
import { MK_PLAN, MK_CONTRACT, resolveCustomerMarketing } from './customerMarketingAudience.js';

const NOW = Date.parse('2026-08-13T04:00:00Z');

/** 実データに現れうる形をひととおり */
const FIXTURES = [
  { name: '無料（空欄）', fields: { Email: 'a@example.com' } },
  { name: '無料（Free）', fields: { Email: 'b@example.com', 'プラン': 'Free' } },
  { name: '無料（未知の綴り）', fields: { Email: 'c@example.com', 'プラン': 'ふつう会員' } },
  { name: '無料（旧 expired ラベル）', fields: { Email: 'd@example.com', 'プラン': 'expired' } },
  { name: 'Light', fields: { Email: 'e@example.com', 'プラン': 'Light', Status: 'active', '有効期限': '2027-01-01' } },
  { name: 'Light（旧 Standard）', fields: { Email: 'f@example.com', 'プラン': 'Standard', Status: 'active', '有効期限': '2027-01-01' } },
  { name: 'Light（ライト）', fields: { Email: 'g@example.com', 'プラン': 'ライト', Status: 'active', '有効期限': '2027-01-01' } },
  { name: 'Premium', fields: { Email: 'h@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2027-01-01' } },
  { name: 'Premium（プレミアム）', fields: { Email: 'i@example.com', 'プラン': 'プレミアム', Status: 'active', '有効期限': '2027-01-01' } },
  { name: '三連複（プラン名）', fields: { Email: 'j@example.com', 'プラン': 'Premium Sanrenpuku', Status: 'active', '有効期限': '2027-01-01' } },
  { name: '三連複（買い切りフラグ）', fields: { Email: 'k@example.com', 'プラン': 'Premium', LifetimeSanrenpuku: true, Status: 'active', '有効期限': '2027-01-01' } },
  { name: '期限切れ Premium', fields: { Email: 'l@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2020-01-01' } },
  { name: '退会', fields: { Email: 'm@example.com', 'プラン': 'Premium', Status: 'withdrawn', '有効期限': '2027-01-01' } },
];

// ── プラン区分 ────────────────────────────────────────────────
test('【重要】プラン別名は PLAN_ALIASES から導く（式と判定がズレない）', () => {
  const light = planTokensFor(MK_PLAN.LIGHT);
  for (const t of ['light', 'standard', 'ライト']) {
    assert.ok(light.includes(t), `light の別名が漏れている: ${t}`);
  }
  const srp = planTokensFor(MK_PLAN.PREMIUM_SANRENPUKU);
  assert.ok(srp.includes('premium-sanrenpuku'));
  // 保存値が空白区切りのこともあるので両方拾う
  assert.ok(srp.includes('premium sanrenpuku'), '空白区切りの保存値を拾えない');
  assert.deepEqual(planTokenVariants('a-b'), ['a-b', 'a b', 'a_b']);
});

test('【重要】free は「free と書いてある人」ではなく「有料でない人」', () => {
  const clause = planGroupClause(MK_PLAN.FREE);
  assert.match(clause, /NOT\(\{LifetimeSanrenpuku\}\)/);
  // 未知の綴りの無料会員が消えないこと（式は否定形なので拾える）
  assert.equal(planGroupMirror(MK_PLAN.FREE, { 'プラン': 'ふつう会員' }), true,
    '未知の綴りの無料会員を落としている');
  assert.equal(planGroupMirror(MK_PLAN.FREE, { 'プラン': 'Premium' }), false);
  assert.equal(planGroupMirror(MK_PLAN.FREE, { 'プラン': 'Premium', LifetimeSanrenpuku: true }), false);
});

test('【重要・超集合】プラン絞り込みが実判定の該当者を落とさない', () => {
  for (const group of Object.values(MK_PLAN)) {
    for (const fx of FIXTURES) {
      const actual = resolveCustomerMarketing({ fields: fx.fields, nowMs: NOW }).plan;
      if (actual !== group) continue;
      assert.equal(planGroupMirror(group, fx.fields), true,
        `${group} の候補から落ちている: ${fx.name}`);
    }
  }
});

test('三連複は買い切りフラグでも拾う（プラン欄が Premium のまま）', () => {
  assert.equal(planGroupMirror(MK_PLAN.PREMIUM_SANRENPUKU, { 'プラン': 'Premium', LifetimeSanrenpuku: true }), true);
  assert.match(planGroupClause(MK_PLAN.PREMIUM_SANRENPUKU), /\{LifetimeSanrenpuku\}/);
});

// ── 一覧の formula ────────────────────────────────────────────
test('【重要】絞り込みが 1 つも無ければ null（＝全件走査へ落とさせない）', () => {
  assert.equal(buildCustomerListFormula({}), null);
  assert.equal(buildCustomerListFormula({ plan: [], contract: [], premiumPlus: [] }), null);
  // 式にできない条件だけを選んでも null（呼び出し側が fail closed する）
  assert.equal(buildCustomerListFormula({ history: ['never'] }), null);
});

test('同じ項目内は OR / 項目間は AND', () => {
  const f = buildCustomerListFormula({ plan: [MK_PLAN.LIGHT, MK_PLAN.PREMIUM], premiumPlus: ['review'] });
  assert.match(f, /^AND\(/);
  assert.match(f, /OR\(/);
  assert.match(f, /PremiumPlusEligibility/);
});

test('未知の選択値が混ざったら絞り込みを諦める（超集合を壊さない）', () => {
  assert.equal(buildCustomerListFormula({ plan: [MK_PLAN.LIGHT, 'ナニカ'] }), null);
});

test('契約状態は「有料 tier である」だけを課す（日付判定を式で二重実装しない）', () => {
  const f = buildCustomerListFormula({ contract: [MK_CONTRACT.EXPIRED] });
  assert.match(f, /LifetimeSanrenpuku/);
  assert.equal(/有効期限/.test(f), false, '期限の判定を式へ持ち込んでいる（JS と二重管理になる）');
  // none は Free と同義
  assert.equal(buildCustomerListFormula({ contract: [MK_CONTRACT.NONE] }), planGroupClause(MK_PLAN.FREE));
});

// ── セグメント ────────────────────────────────────────────────
test('セグメントは 1 つずつ絞れる（絞れないものは null で fail closed）', () => {
  for (const id of ['free-all', 'free-recent-login', 'free-dormant', 'ex-paid-now-free',
    'expired', 'withdrawn', 'logged-in-not-purchased']) {
    assert.ok(buildSegmentFormula(id), `絞れないセグメント: ${id}`);
  }
  // 開封記録は Customers に無い → 式にできない。**推測で絞らない**
  assert.equal(buildSegmentFormula('opened-not-logged-in'), null);
  assert.equal(buildSegmentFormula('未知'), null);
});

test('【重要】無料セグメントの式は未知の綴りを落とさない', () => {
  const f = buildSegmentFormula('free-all');
  assert.match(f, /NOT\(/);
  assert.equal(/= 'free'/.test(f), false, 'free と書いてある人だけに絞っている');
});

// ── カムバック ────────────────────────────────────────────────
test('【重要】カムバック候補は「現役の有効会員でない人」（それ以外は落とさない）', () => {
  const f = buildComebackCandidateFormula({});
  assert.ok(f);
  const active = { Status: 'active', 'プラン': 'Premium' };
  assert.equal(comebackCandidateMirror({}, active), false, '現役会員を候補に入れている');
  for (const fx of FIXTURES) {
    const isActivePaid = String(fx.fields.Status || '').toLowerCase() === 'active'
      && (fx.fields.LifetimeSanrenpuku === true
        || paidPlanTokens().includes(String(fx.fields['プラン'] || '').toLowerCase()));
    if (isActivePaid) continue;
    assert.equal(comebackCandidateMirror({}, fx.fields), true, `候補から落ちている: ${fx.name}`);
  }
});

test('現役会員も見たいときは否定を課さない', () => {
  assert.equal(comebackCandidateMirror({ contract: ['active'] }, { Status: 'active', 'プラン': 'Premium' }), true);
});

test('付与操作 ID で名指しに引ける（無ければ null）', () => {
  const f = buildGrantOperationFormula('op-2026-08-13-001');
  for (const field of GRANT_OP_FIELDS) assert.ok(f.includes(field), `${field} を見ていない`);
  assert.equal(buildGrantOperationFormula(''), null);
  assert.equal(buildGrantOperationFormula(null), null);
  for (const field of GRANT_OP_FIELDS) assert.ok(buildAnyGrantOperationFormula().includes(field));
});

// ── 安全性 ────────────────────────────────────────────────────
test('【重要】入力で式を壊さない（壊れると全件一致にも 0 件にも化ける）', () => {
  assert.equal(escapeFormulaValue("O'Brien"), "O\\'Brien");
  assert.equal(escapeFormulaValue('a\\b'), 'a\\\\b');
  const f = buildGrantOperationFormula("op'); DROP");
  const quotes = (f.replace(/\\'/g, '').match(/'/g) || []).length;
  assert.equal(quotes % 2, 0, `式が閉じていない: ${f}`);
});

test('Airtable の罠: != BLANK() を使っていない（常に真になる）', () => {
  for (const id of ['ex-paid-now-free', 'logged-in-not-purchased', 'expired']) {
    assert.equal(/!=\s*BLANK\(\)/.test(buildSegmentFormula(id)), false, `${id} が != BLANK() を使っている`);
  }
  assert.equal(/!=\s*BLANK\(\)/.test(buildAnyGrantOperationFormula()), false);
});

// ── 失敗の伝え方 ──────────────────────────────────────────────
test('【重要】打ち切りも絞れないも「0 件」と読ませない', () => {
  const limit = describeScanLimit({ what: '顧客一覧', pagesFetched: SCAN_MAX_PAGES });
  assert.equal(limit.code, SCAN_FAIL.LIMIT);
  assert.match(limit.error, /0 件・少ない件数として表示しません/);
  assert.equal(limit.sideEffects, 'none');

  const narrow = describeNotNarrowable({ what: 'セグメント下見' });
  assert.equal(narrow.code, SCAN_FAIL.NOT_NARROWABLE);
  assert.match(narrow.error, /人が静かに消えます/);
});

test('上限は増やして解決しない（値を固定する）', () => {
  assert.equal(SCAN_MAX_PAGES, 40);
});
