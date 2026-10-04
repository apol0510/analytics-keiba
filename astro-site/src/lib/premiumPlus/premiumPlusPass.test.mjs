import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildOffer, planApply, planConfirmPass, planCancelPass, planReserve, weeklyDates, memberDeliveryDates,
  resolveCredit, annualSeatsLeft, describePassesForMember, buildAdminNotice, buildPassThanksEmail,
  PASS_STATUS, PP_LIST_PRICE,
} from './premiumPlusPass.js';

const T = (iso) => Date.parse(iso);
const ME = 'recAAAAAAAAAAAAAA';
const OTHER = 'recBBBBBBBBBBBBBB';
const confirmedAt = T('2026-10-04T07:30:00+09:00');
const orders = [{ orderId: `${ME}:2026-10-04`, recordId: ME, saleDate: '2026-10-04', status: 'confirmed', confirmedAt, amount: 68000 }];
const NOW = T('2026-10-04T14:00:00+09:00');

test('価格: 単品は定価・枠は通常価格比のお得額を出す', () => {
  const o = buildOffer({ orders, passes: [], recordId: ME, nowMs: NOW });
  const by = Object.fromEntries(o.plans.map((p) => [p.id, p]));
  assert.equal(o.listPrice, 98000);
  assert.equal(by.single.price, 98000);
  assert.equal(by.single.creditApplied, 0);
  assert.equal(by.pass10.price, 680000);
  assert.equal(by.pass10.perRace, 68000);
  // 1鞍あたりが初回価格を下回らない
  for (const p of o.plans.filter((x) => x.id !== 'annual')) assert.ok(p.perRace >= o.firstPrice, p.id);
  assert.equal(by.pass10.saving, 300000);
  assert.equal(by.annual.price, 1980000);
  assert.equal(by.annual.saving, 98000 * 52 - 1980000);
  assert.equal(by.annual.seatsLeft, 5);
});

test('初回 ¥68,000 の充当: 7日以内・枠だけ・1回だけ', () => {
  const o = buildOffer({ orders, passes: [], recordId: ME, nowMs: NOW });
  const by = Object.fromEntries(o.plans.map((p) => [p.id, p]));
  assert.equal(by.pass10.payAmount, 612000);
  assert.equal(by.annual.payAmount, 1912000);
  assert.equal(by.single.payAmount, PP_LIST_PRICE);
  const late = resolveCredit({ orders, passes: [], recordId: ME, nowMs: confirmedAt + 7 * 86400000 + 1 });
  assert.equal(late.available, false);
  const applied = planApply({ orders, passes: [], recordId: ME, planId: 'pass10', nowMs: NOW }).pass;
  assert.equal(applied.amount, 612000);
  assert.equal(resolveCredit({ orders, passes: [applied], recordId: ME, nowMs: NOW }).available, false);
  const cancelled = { ...applied, status: PASS_STATUS.CANCELLED };
  assert.equal(resolveCredit({ orders, passes: [cancelled], recordId: ME, nowMs: NOW }).available, true);
});

test('申込できるのは購入済み会員だけ・入金待ちは 1 件まで', () => {
  assert.equal(planApply({ orders, passes: [], recordId: OTHER, planId: 'pass10', nowMs: NOW }).code, 'not_repeat_member');
  const p = planApply({ orders, passes: [], recordId: ME, planId: 'single', nowMs: NOW }).pass;
  assert.equal(p.amount, 98000);
  assert.equal(planApply({ orders, passes: [p], recordId: ME, planId: 'pass10', nowMs: NOW }).code, 'already_awaiting');
  assert.equal(planApply({ orders, passes: [], recordId: ME, planId: 'x', nowMs: NOW }).code, 'unknown_plan');
});

test('年間枠: 曜日必須・一括払いのみ・限定5名', () => {
  assert.equal(planApply({ orders, passes: [], recordId: ME, planId: 'annual', nowMs: NOW }).code, 'weekday_required');
  const p = planApply({ orders, passes: [], recordId: ME, planId: 'annual', weekday: 6, installments: 2, nowMs: NOW }).pass;
  assert.equal(p.installments, 1);
  assert.equal(p.firstPayment, 1912000);
  const five = Array.from({ length: 5 }, (_, i) => ({ passId: `x${i}`, recordId: OTHER, plan: 'annual', status: 'active' }));
  assert.equal(annualSeatsLeft(five), 0);
  assert.equal(planApply({ orders, passes: five, recordId: ME, planId: 'annual', weekday: 6, nowMs: NOW }).code, 'sold_out');
  assert.equal(annualSeatsLeft([...five.slice(1), { ...five[0], status: 'cancelled' }]), 1);
});

test('入金確認で有効化・期限は確認日から・取消は入金待ちだけ', () => {
  const p = planApply({ orders, passes: [], recordId: ME, planId: 'pass10', nowMs: NOW }).pass;
  assert.equal(planConfirmPass(p, { actor: '', nowMs: NOW }).code, 'missing_actor');
  const a = planConfirmPass(p, { actor: 'MK', nowMs: NOW }).pass;
  assert.equal(a.status, 'active');
  assert.equal(a.startDate, '2026-10-04');
  assert.equal(a.validUntil, '2027-04-05');
  assert.equal(planConfirmPass(a, { actor: 'MK', nowMs: NOW }).idempotent, true);
  assert.equal(planCancelPass(a, { actor: 'MK', reason: 'x', nowMs: NOW }).code, 'not_awaiting');
});

test('年間枠の配信日は指定曜日・毎週・最大52回', () => {
  const p = planConfirmPass(planApply({ orders, passes: [], recordId: ME, planId: 'annual', weekday: 6, nowMs: NOW }).pass, { actor: 'MK', nowMs: NOW }).pass;
  const ds = weeklyDates(p);
  assert.equal(ds[0], '2026-10-10');
  assert.equal(ds.length, 52);
  assert.ok(ds.every((d) => new Date(`${d}T12:00:00+09:00`).getUTCDay() === 6));
});

test('予約: 翌日以降・期限内・残りあり・同じ日を二重にしない', () => {
  let p = planConfirmPass(planApply({ orders, passes: [], recordId: ME, planId: 'pass10', nowMs: NOW }).pass, { actor: 'MK', nowMs: NOW }).pass;
  const r = (saleDate, pass = p) => planReserve({ pass, passes: [pass], orders, recordId: ME, saleDate, nowMs: NOW });
  assert.equal(r('2026-10-04').code, 'too_late');
  assert.equal(r('2027-05-01').code, 'after_expiry');
  assert.equal(planReserve({ pass: p, passes: [p], orders, recordId: OTHER, saleDate: '2026-10-10', nowMs: NOW }).code, 'pass_not_found');
  const pend = planApply({ orders, passes: [], recordId: ME, planId: 'pass10', nowMs: NOW }).pass;
  assert.equal(planReserve({ pass: pend, passes: [pend], orders, recordId: ME, saleDate: '2026-10-10', nowMs: NOW }).code, 'not_active');
  for (let i = 0; i < 10; i += 1) {
    const d = `2026-10-${String(10 + i).padStart(2, '0')}`;
    const out = r(d);
    assert.equal(out.ok, true, d);
    p = out.pass;
  }
  assert.equal(r('2026-10-25').code, 'no_credits');
  const one = { ...p, reservations: ['2026-10-10'] };
  assert.equal(r('2026-10-10', one).code, 'already_reserved');
  // 単発注文の日とも重ねない
  const p2 = { ...p, reservations: [] };
  assert.equal(planReserve({ pass: p2, passes: [p2], orders: [...orders, { recordId: ME, saleDate: '2026-10-11', status: 'confirmed' }], recordId: ME, saleDate: '2026-10-11', nowMs: NOW }).code, 'already_reserved');
});

test('提供日 = 単発注文＋枠（他人・入金待ち・取消は含めない）', () => {
  const act = { recordId: ME, status: 'active', schedule: 'choose', reservations: ['2026-10-12'] };
  const pend = { recordId: ME, status: 'awaiting_payment', schedule: 'choose', reservations: ['2026-10-13'] };
  const other = { recordId: OTHER, status: 'active', schedule: 'choose', reservations: ['2026-10-14'] };
  assert.deepEqual(memberDeliveryDates({ orders, passes: [act, pend, other], recordId: ME }), ['2026-10-04', '2026-10-12']);
});

test('会員表示: 残数と予定', () => {
  let p = planConfirmPass(planApply({ orders, passes: [], recordId: ME, planId: 'pass10', nowMs: NOW }).pass, { actor: 'MK', nowMs: NOW }).pass;
  p = planReserve({ pass: p, passes: [p], orders, recordId: ME, saleDate: '2026-10-10', nowMs: NOW }).pass;
  const [v] = describePassesForMember([p], { recordId: ME, nowMs: NOW });
  assert.equal(v.remaining, 9);
  assert.deepEqual(v.upcoming, ['2026-10-10']);
  assert.equal(describePassesForMember([p], { recordId: OTHER, nowMs: NOW }).length, 0);
});

test('メールに成績（的中率など）や買い目を書かない', () => {
  const p = planConfirmPass(planApply({ orders, passes: [], recordId: ME, planId: 'pass10', nowMs: NOW }).pass, { actor: 'MK', nowMs: NOW }).pass;
  const t = buildPassThanksEmail({ pass: p, fullName: '山田' }).text;
  const n = buildAdminNotice({ pass: p, fullName: '山田', email: 'a@example.com' }).text;
  for (const s of [t, n]) assert.doesNotMatch(s, /的中率|回収率\s*\d|1着|2着|3着/);
  assert.match(t, /10鞍/);
  assert.match(n, /¥612,000/);
});

test('guard: 金額をクライアントから受け取らない／購入済み会員の初回価格申込を止める', () => {
  const api = readFileSync(new URL('../../pages/api/premium-plus-pass.json.js', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /body\.(amount|price|payAmount)/);
  assert.match(api, /payload\?\.sub/);
  assert.match(api, /const offerVisible = true;/);
  const bt = readFileSync(new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url), 'utf8');
  const guard = bt.indexOf("code: 'plus_repeat_member'");
  assert.ok(guard > 0);
  assert.ok(guard < bt.indexOf('recordOrderOnApplication({'), '注文台帳へ書く前に止める');
});

test('補償はない・返品特約（保証なし／返金なし）は申込ボタンの近くに読める形で出す', () => {
  const o = buildOffer({ orders, passes: [], recordId: ME, nowMs: NOW });
  assert.ok(o.plans.every((p) => p.compensation === 0));
  const card = readFileSync(new URL('../../components/PremiumPlusPassCard.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(card, /追加でお届け/);
  assert.match(card, /キャンセル・返金は承っておりません/);
  assert.match(card, /保証するものではありません/);
  // 隠さない: display:none / hidden / 極小文字にしない
  const terms = /\.ppp-terms \{([^}]*)\}/.exec(card)[1];
  assert.doesNotMatch(terms, /display:\s*none|visibility:\s*hidden/);
  const size = Number(/font-size:\s*\.?(\d*\.?\d+)rem/.exec(terms)[0].match(/[\d.]+/)[0]);
  assert.ok(size >= 0.75, '返品特約の文字を小さくしすぎない');
  assert.ok(card.indexOf('ppp-terms">') > card.indexOf('id="ppp-plans"'), '申込ボタンの直後に置く');
});

test('購入済み会員の判定は特定の会員に依存しない（確認済み注文が 1 件以上なら誰でも）', () => {
  const someone = 'recCCCCCCCCCCCCCC';
  const o2 = [{ orderId: `${someone}:2026-11-01`, recordId: someone, saleDate: '2026-11-01', status: 'confirmed', confirmedAt: NOW }];
  assert.equal(buildOffer({ orders: o2, passes: [], recordId: someone, nowMs: NOW }).plans.find((p) => p.id === 'single').price, 98000);
  assert.equal(planApply({ orders: o2, passes: [], recordId: someone, planId: 'pass10', nowMs: NOW }).ok, true);
  const awaitingOnly = [{ ...o2[0], status: 'awaiting_payment' }];
  assert.equal(planApply({ orders: awaitingOnly, passes: [], recordId: someone, planId: 'pass10', nowMs: NOW }).code, 'not_repeat_member');
});
