/**
 * offerIntake.test.mjs — 割引オファー申込の判定
 *   node --test src/lib/promotions/offerIntake.test.mjs
 *
 * 最重要の性質（ここが崩れると割引価格を自己申告できてしまう）:
 *   請求額（RequestedAmount）とプランは **offer 由来** で、フォームの申告値では動かない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOfferKeyFormula,
  maskEmail,
  toRequestedPlan,
  planTypeFromTerm,
  termLabelFromPlanType,
  buildOfferPresentation,
  buildOfferProductName,
  resolveOfferApplication,
  jstDay,
  MAX_TRANSFER_AGE_DAYS,
  MAX_REPORTED_AMOUNT,
  REQUESTED_PLAN_ALLOW,
} from './offerIntake.js';

const KEY32 = 'a'.repeat(32);
/** 2026-08-01 12:00 JST */
const NOW = Date.parse('2026-08-01T03:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** verifyOfferToken() が返す形の検証済み offer */
function verifiedOffer(over = {}) {
  return {
    offerKey: KEY32,
    email: 'taro@example.com',
    offerId: 'premium-annual-half',
    version: 1,
    planName: 'Premium Annual',
    planType: 'Annual',
    term: 'annual',
    regularPrice: 49800,
    offerPrice: 24900,
    startsMs: NOW - 3 * DAY,
    expiresMs: NOW + 11 * DAY,
    customerRecordId: 'recCUST1',
    ...over,
  };
}

function form(over = {}) {
  return {
    fullName: '山田 太郎',
    email: 'taro@example.com',
    transferDate: jstDay(NOW),
    transferName: 'ヤマダ タロウ',
    transferAmount: '24900',
    remarks: '',
    paymentCompletedConfirm: true,
    ...over,
  };
}

// ── 小さな純粋関数 ──────────────────────────────────────────────

test('buildOfferKeyFormula は 32hex だけ受ける（DB を引かせない）', () => {
  assert.equal(buildOfferKeyFormula(KEY32), `{OfferKey}='${KEY32}'`);
  for (const bad of ['', null, 'zz', KEY32 + 'a', KEY32.toUpperCase(), "a'||1=1"]) {
    assert.equal(buildOfferKeyFormula(bad), null, `不正な値を通した: ${bad}`);
  }
});

test('maskEmail は完全なアドレスを返さない', () => {
  const masked = maskEmail('taro@example.com');
  assert.equal(masked.includes('taro@example.com'), false);
  assert.ok(masked.startsWith('ta'));
  assert.ok(masked.includes('@'));
  assert.ok(masked.endsWith('.com'));
  assert.equal(maskEmail('not-an-email'), '');
  assert.equal(maskEmail(''), '');
});

test('toRequestedPlan は期間付きの名前を Premium へ正規化し、想定外は null', () => {
  assert.equal(toRequestedPlan('Premium Annual'), 'Premium');
  assert.equal(toRequestedPlan('Premium Lifetime'), 'Premium');
  assert.equal(toRequestedPlan('Premium Monthly'), 'Premium');
  assert.equal(toRequestedPlan('Premium (¥24,900/年)'), 'Premium');
  assert.equal(toRequestedPlan('Premium'), 'Premium');
  // 権利の強い / 別系統のプランは offer 経路から作れない（fail closed）
  assert.equal(toRequestedPlan('Premium Sanrenpuku'), null);
  assert.equal(toRequestedPlan('Premium Plus'), null);
  assert.equal(toRequestedPlan('Light'), null);
  assert.equal(toRequestedPlan(''), null);
  assert.deepEqual(REQUESTED_PLAN_ALLOW, ['Premium']);
});

test('planTypeFromTerm / termLabelFromPlanType', () => {
  assert.equal(planTypeFromTerm('annual'), 'Annual');
  assert.equal(planTypeFromTerm('lifetime'), 'Lifetime');
  assert.equal(planTypeFromTerm('monthly'), 'Monthly');
  assert.equal(planTypeFromTerm('days'), null);
  assert.ok(termLabelFromPlanType('Annual').includes('年額'));
  assert.ok(termLabelFromPlanType('Lifetime').includes('買い切り'));
  assert.equal(termLabelFromPlanType('nonsense'), '');
});

test('jstDay は JST の暦日（UTC 直読みの 1 日ズレをしない）', () => {
  // 2026-08-01 00:30 JST = 2026-07-31 15:30 UTC
  assert.equal(jstDay(Date.parse('2026-07-31T15:30:00.000Z')), '2026-08-01');
  assert.equal(jstDay(Date.parse('2026-07-31T14:30:00.000Z')), '2026-07-31');
});

// ── ページ表示用 ────────────────────────────────────────────────

test('buildOfferPresentation は PII と内部 ID を出さない', () => {
  const p = buildOfferPresentation({ offer: verifiedOffer(), nowMs: NOW });
  const flat = JSON.stringify(p);
  assert.equal(flat.includes('taro@example.com'), false, '完全なメールアドレスが露出している');
  assert.equal(flat.includes('recCUST1'), false, 'recordId が露出している');
  assert.equal(flat.includes(KEY32), false, 'offerKey が露出している');
  assert.equal(p.regularPrice, 49800);
  assert.equal(p.offerPrice, 24900);
  assert.equal(p.discountAmount, 24900);
  assert.equal(p.discountPercent, 50);
  assert.equal(p.expiresOn, '2026-08-12');
  assert.equal(p.daysLeft, 11);
  assert.ok(p.termLabel.includes('年額'));
});

test('buildOfferProductName は金額を含み、プラン名の逆算元にならない文字列', () => {
  const name = buildOfferProductName({ planType: 'Lifetime', offerPrice: 39000 });
  assert.ok(name.includes('¥39,000'));
  assert.ok(name.includes('Premium'));
});

// ── 申込の確定値（最重要）────────────────────────────────────────

test('正常系: プランと請求額は offer から決まる', () => {
  const r = resolveOfferApplication({ offer: verifiedOffer(), form: form(), nowMs: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.application.requestedPlan, 'Premium');
  assert.equal(r.application.requestedPlanType, 'Annual');
  assert.equal(r.application.requestedAmount, 24900);
  assert.equal(r.application.reportedAmount, 24900);
  assert.equal(r.application.email, 'taro@example.com');
  assert.equal(r.application.offerKey, KEY32);
  assert.equal(r.application.customerRecordId, 'recCUST1');
});

test('🔒 申告金額を書き換えても請求額は offer 価格のまま（警告だけ付く）', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(),
    form: form({ transferAmount: '1000' }),
    nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.application.requestedAmount, 24900, '申告値が請求額を上書きした');
  assert.equal(r.application.reportedAmount, 1000);
  assert.deepEqual(r.warnings, ['reported_amount_less_than_offer']);
});

test('🔒 フォームの productName / planType を渡しても無視される', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(),
    form: form({
      productName: 'Premium Lifetime (¥1,000（永久アクセス）)',
      requestedPlan: 'Premium Sanrenpuku',
      requestedPlanType: 'Lifetime',
      requestedAmount: 1,
      planType: 'Lifetime',
    }),
    nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.application.requestedPlanType, 'Annual');
  assert.equal(r.application.requestedPlan, 'Premium');
  assert.equal(r.application.requestedAmount, 24900);
});

test('多く払ったときも受け付けて警告にする（締め出さない）', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(), form: form({ transferAmount: '30000' }), nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['reported_amount_more_than_offer']);
});

test('発行日より前の振込日は警告（拒否はしない）', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(), form: form({ transferDate: jstDay(NOW - 5 * DAY) }), nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.includes('transfer_before_offer_issued'));
});

test('email が offer と違えば拒否（転送されたリンクを他人が使えない）', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(), form: form({ email: 'other@example.com' }), nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'email_mismatch');
});

test('大小文字・前後空白の違いは同一アドレスとして通す', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(), form: form({ email: '  Taro@Example.com ' }), nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.application.email, 'taro@example.com');
});

test('入金済みチェックが無ければ拒否', () => {
  for (const v of [false, undefined, 'true', 1]) {
    const r = resolveOfferApplication({
      offer: verifiedOffer(), form: form({ paymentCompletedConfirm: v }), nowMs: NOW,
    });
    assert.equal(r.ok, false, `${v} を通した`);
    assert.equal(r.reason, 'payment_not_confirmed');
  }
});

test('振込完了日: 形式不正 / 未来日 / 古すぎる日 を拒否', () => {
  const bad = [
    ['2026/08/01', 'invalid_transfer_date'],
    ['', 'invalid_transfer_date'],
    [jstDay(NOW + DAY), 'future_transfer_date'],
    [jstDay(NOW - (MAX_TRANSFER_AGE_DAYS + 1) * DAY), 'transfer_date_too_old'],
  ];
  for (const [transferDate, reason] of bad) {
    const r = resolveOfferApplication({ offer: verifiedOffer(), form: form({ transferDate }), nowMs: NOW });
    assert.equal(r.ok, false, `${transferDate} を通した`);
    assert.equal(r.reason, reason);
  }
});

test('未来日の判定は JST 基準（UTC だと 1 日ズレる時刻で確認）', () => {
  // 2026-08-01 00:30 JST。JST の「今日」は 08-01 なので 08-01 の振込報告は通る
  const jstMidnight = Date.parse('2026-07-31T15:30:00.000Z');
  const r = resolveOfferApplication({
    offer: verifiedOffer({ startsMs: jstMidnight - 3 * DAY, expiresMs: jstMidnight + DAY }),
    form: form({ transferDate: '2026-08-01' }),
    nowMs: jstMidnight,
  });
  assert.equal(r.ok, true, 'JST の当日を未来日として弾いた');
});

test('氏名 / 金額の不正を拒否', () => {
  const cases = [
    [{ fullName: '' }, 'missing_full_name'],
    [{ fullName: 'あ'.repeat(101) }, 'full_name_too_long'],
    [{ email: '' }, 'missing_email'],
    [{ transferAmount: '0' }, 'invalid_amount'],
    [{ transferAmount: 'abc' }, 'invalid_amount'],
    [{ transferAmount: '-100' }, 'invalid_amount'],
    [{ transferAmount: String(MAX_REPORTED_AMOUNT + 1) }, 'amount_too_large'],
  ];
  for (const [over, reason] of cases) {
    const r = resolveOfferApplication({ offer: verifiedOffer(), form: form(over), nowMs: NOW });
    assert.equal(r.ok, false, `${JSON.stringify(over)} を通した`);
    assert.equal(r.reason, reason);
  }
});

test('offer 側が壊れていたら fail closed（申込を作らない）', () => {
  const cases = [
    [{ planName: 'Premium Sanrenpuku' }, 'invalid_offer_plan'],
    [{ planName: '' }, 'invalid_offer_plan'],
    [{ planType: 'Weekly', term: 'weekly' }, 'invalid_offer_plan_type'],
    [{ offerPrice: 0 }, 'invalid_offer_price'],
    [{ offerPrice: -1 }, 'invalid_offer_price'],
    [{ offerPrice: 1234.5 }, 'invalid_offer_price'],
  ];
  for (const [over, reason] of cases) {
    const r = resolveOfferApplication({ offer: verifiedOffer(over), form: form(), nowMs: NOW });
    assert.equal(r.ok, false, `${JSON.stringify(over)} を通した`);
    assert.equal(r.reason, reason);
  }
  assert.equal(resolveOfferApplication({ offer: null, form: form(), nowMs: NOW }).ok, false);
  assert.equal(resolveOfferApplication({ offer: verifiedOffer(), form: null, nowMs: NOW }).ok, false);
  assert.equal(resolveOfferApplication({ offer: verifiedOffer(), form: form(), nowMs: NaN }).ok, false);
});

test('PlanType が空でも BillingTerm から復元する（旧行の救済）', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer({ planType: '', term: 'lifetime' }), form: form(), nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.application.requestedPlanType, 'Lifetime');
});

test('備考は 1000 文字で切る', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(), form: form({ remarks: 'あ'.repeat(2000) }), nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.application.remarks.length, 1000);
});

test('振込名義人が空ならお名前を使う', () => {
  const r = resolveOfferApplication({
    offer: verifiedOffer(), form: form({ transferName: '' }), nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.application.transferName, '山田 太郎');
});
