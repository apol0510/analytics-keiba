/**
 * proxyPaymentNotice.test.mjs — 運営者による代理入金連絡の判定・組み立て
 *   node --test src/lib/payments/proxyPaymentNotice.test.mjs
 *
 * 守りたいこと:
 * - 代理登録は**申込情報だけ**を書く（有料権限には触れない）
 * - 実入金額を掲載価格へ捏造しない
 * - 二重登録・推測登録・打ち間違いは fail closed で止まる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideProxyPaymentNotice, buildProxyNoticeFields, describeProxyNoticeForLog,
  isProxyAuditFieldsEnabled, normalizeProxyEmail,
  PROXY_REJECT, PROXY_NOTICE_FIELDS, PROXY_SOURCE_VALUE,
  MAX_RECEIVED_AMOUNT,
} from './proxyPaymentNotice.js';
import { buildConfirmationFields } from './bankPaymentFlow.js';

/** 2026-09-16 12:00 JST */
const NOW = Date.parse('2026-09-16T03:00:00Z');

/**
 * ⚠️ fixture は**必ず合成値**にすること。実顧客のメールアドレス・recordId を
 *    テストへ書くと、試験用スクリプトへコピーされて本番レコードを指す事故になり得る。
 *    実案件の記録（どのお客様の件か）は docs/progress.md 側に置く。
 */
const RECORD = Object.freeze({
  id: 'recE2ETESTONLY01',
  fields: { Email: 'proxy-test@example.test', '氏名': 'テスト太郎', 'プラン': 'Premium', '有効期限': '2026-04-06' },
});

/** 代表ケース: 期限切れ Premium 会員が ¥44,800 を振り込んだ（掲載は ¥44,820）*/
const BASE_INPUT = Object.freeze({
  operator: 'MK',
  email: 'proxy-test@example.test',
  productName: 'Premium Annual - Campaign (¥44,820/年)',
  receivedAmount: 44800,
  paidDate: '2026-09-16',
  reason: '本人がフォーム送信できないため代理登録',
  record: RECORD,
  nowMs: NOW,
});

// ── 受理の基本形 ────────────────────────────────────────────────

test('商品名からプラン・契約種別を導き、実入金額をそのまま保持する', () => {
  const d = decideProxyPaymentNotice(BASE_INPUT);
  assert.equal(d.ok, true);
  assert.equal(d.planName, 'Premium');
  assert.equal(d.planType, 'Annual');
  // ⚠️ 掲載価格 44,820 へ丸めない
  assert.equal(d.amount, 44800);
  assert.equal(d.recordId, RECORD.id);
  assert.equal(d.email, 'proxy-test@example.test');
});

test('運営者が指定したアドレスがそのまま採用される（セッションのアドレスへ置換されない）', () => {
  const d = decideProxyPaymentNotice(BASE_INPUT);
  assert.equal(d.ok, true);
  assert.equal(d.email, normalizeProxyEmail('  Proxy-Test@Example.TEST '));
});

test('書き込むのは申込情報だけ。有料権限のフィールドは 1 つも含まない', () => {
  const d = decideProxyPaymentNotice(BASE_INPUT);
  const fields = buildProxyNoticeFields({ decision: d, nowMs: NOW });

  for (const forbidden of ['プラン', 'PlanType', '有効期限', 'PaidAt', 'PaymentEmailSent',
    'LifetimeSanrenpuku', 'PromotedBy', 'PromotedAt']) {
    assert.ok(!(forbidden in fields), `${forbidden} を書いてはいけない`);
  }
  assert.equal(fields.RequestedPlan, 'Premium');
  assert.equal(fields.RequestedPlanType, 'Annual');
  assert.equal(fields.RequestedAmount, 44800);
  assert.equal(fields.PaymentConfirmed, false); // 入金確認は MK の 1 アクション
  assert.equal(fields.Status, 'pending');       // 非 active の会員は pending
});

test('既存 active 会員の Status は据え置く（申込だけで権限を動かさない）', () => {
  const d = decideProxyPaymentNotice({
    ...BASE_INPUT,
    record: { id: 'recActive', fields: { '氏名': 'テスト', Status: 'active', 'プラン': 'Light' } },
  });
  const fields = buildProxyNoticeFields({ decision: d, nowMs: NOW });
  assert.ok(!('Status' in fields), 'active 会員の Status を pending へ落としてはいけない');
});

test('氏名が空の会員で氏名を空文字で上書きしない', () => {
  const d = decideProxyPaymentNotice({
    ...BASE_INPUT, record: { id: 'recNoName', fields: { Email: 'x@example.com' } },
  });
  const fields = buildProxyNoticeFields({ decision: d, nowMs: NOW });
  assert.ok(!('氏名' in fields));
});

// ── 既存の昇格フローへそのまま乗る ──────────────────────────────

test('代理登録した Requested* から、既存の昇格ロジックが正しく昇格を組み立てられる', () => {
  const d = decideProxyPaymentNotice(BASE_INPUT);
  const applied = buildProxyNoticeFields({ decision: d, nowMs: NOW });

  // PaymentConfirmed を押した後に走るのは**既存の単一源**
  const confirmed = buildConfirmationFields({
    requestedPlan: applied.RequestedPlan,
    requestedPlanType: applied.RequestedPlanType,
    confirmedAt: new Date(NOW),
  });
  assert.ok(confirmed, '代理登録した申込から昇格できない');
  assert.equal(confirmed.fields['プラン'], 'Premium');
  assert.equal(confirmed.fields.Status, 'active');
  assert.equal(confirmed.expiration, '2027-09-16'); // 入金確認日 JST + 1年
  assert.equal(confirmed.fields.RequestedPlan, '', '承認時に申込内容がクリアされない');
});

test('代理登録 → 昇格 → 再度 PaymentConfirmed でも二重昇格しない（既存の冪等性）', () => {
  const d = decideProxyPaymentNotice(BASE_INPUT);
  const applied = buildProxyNoticeFields({ decision: d, nowMs: NOW });
  const first = buildConfirmationFields({
    requestedPlan: applied.RequestedPlan, requestedPlanType: applied.RequestedPlanType,
    confirmedAt: new Date(NOW),
  });
  // 承認時に Requested* が空になる → 再実行は fail closed
  const second = buildConfirmationFields({
    requestedPlan: first.fields.RequestedPlan, requestedPlanType: first.fields.RequestedPlanType,
    confirmedAt: new Date(NOW + 86400000),
  });
  assert.equal(second, null, '有効期限が二重に延長されてしまう');
});

// ── fail closed ─────────────────────────────────────────────────

test('操作者が無ければ受け付けない（監査のため必須）', () => {
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, operator: '   ' });
  assert.equal(d.ok, false);
  assert.equal(d.reason, PROXY_REJECT.OPERATOR_REQUIRED);
});

test('会員が見つからなければ受け付けない（新規作成しない）', () => {
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, record: null });
  assert.equal(d.ok, false);
  assert.equal(d.reason, PROXY_REJECT.CUSTOMER_NOT_FOUND);
});

test('メールアドレスが不正なら受け付けない', () => {
  for (const email of ['', '   ', 'not-an-email', 'a@b']) {
    const d = decideProxyPaymentNotice({ ...BASE_INPUT, email });
    assert.equal(d.ok, false, `${email} を通してはいけない`);
    assert.equal(d.reason, PROXY_REJECT.EMAIL_REQUIRED);
  }
});

test('判定できないプランは受け付けない（推測で昇格させない）', () => {
  for (const productName of ['', '謎の商品', 'Unknown Plan Annual']) {
    const d = decideProxyPaymentNotice({ ...BASE_INPUT, productName });
    assert.equal(d.ok, false, `${productName} を通してはいけない`);
    assert.equal(d.reason, PROXY_REJECT.UNKNOWN_PLAN);
  }
});

test('Premium Plus は代理登録の対象外（対象日・クーポン・販売停止を迂回させない）', () => {
  for (const productName of ['Premium Plus', 'premium plus 9/16（大井）', 'Premium Plus Lifetime']) {
    const d = decideProxyPaymentNotice({ ...BASE_INPUT, productName });
    assert.equal(d.ok, false);
    assert.equal(d.reason, PROXY_REJECT.PREMIUM_PLUS_UNSUPPORTED);
  }
});

test('実入金額が不正なら受け付けない', () => {
  for (const receivedAmount of [0, -1, '', 'abc', 1.5, MAX_RECEIVED_AMOUNT + 1, null, undefined]) {
    const d = decideProxyPaymentNotice({ ...BASE_INPUT, receivedAmount });
    assert.equal(d.ok, false, `${receivedAmount} を通してはいけない`);
    assert.equal(d.reason, PROXY_REJECT.INVALID_AMOUNT);
  }
});

test('「44,800」のようなカンマ付き入力は読めるが、桁を落とさない', () => {
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, receivedAmount: '44,800' });
  assert.equal(d.ok, true);
  assert.equal(d.amount, 44800);
});

test('入金日が未来なら受け付けない（着金前に申込を作らない）', () => {
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, paidDate: '2026-09-17' });
  assert.equal(d.ok, false);
  assert.equal(d.reason, PROXY_REJECT.FUTURE_PAID_DATE);
});

test('入金日は JST の暦日で比較する（UTC 基準で前日にならない）', () => {
  // 2026-09-17 00:30 JST = 2026-09-16T15:30Z。JST では当日なので通す
  const d = decideProxyPaymentNotice({
    ...BASE_INPUT, paidDate: '2026-09-17', nowMs: Date.parse('2026-09-16T15:30:00Z'),
  });
  assert.equal(d.ok, true);
});

test('入金日の形式が違えば受け付けない', () => {
  for (const paidDate of ['2026/09/16', '9月16日', '', '2026-9-16']) {
    const d = decideProxyPaymentNotice({ ...BASE_INPUT, paidDate });
    assert.equal(d.ok, false, `${paidDate} を通してはいけない`);
    assert.equal(d.reason, PROXY_REJECT.INVALID_PAID_DATE);
  }
});

// ── 二重登録の防止 ───────────────────────────────────────────────

test('未確認の申込が残っていれば二度目の代理登録を止める', () => {
  const withPending = {
    id: RECORD.id,
    fields: { ...RECORD.fields, RequestedPlan: 'Premium', RequestedPlanType: 'Annual', RequestedAmount: 44800 },
  };
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, record: withPending });
  assert.equal(d.ok, false);
  assert.equal(d.reason, PROXY_REJECT.ALREADY_PENDING);
});

test('明示的に置き換えを指示したときだけ上書きでき、その事実が残る', () => {
  const withPending = {
    id: RECORD.id,
    fields: { ...RECORD.fields, RequestedPlan: 'Light', RequestedPlanType: 'Monthly' },
  };
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, record: withPending, replaceExisting: true });
  assert.equal(d.ok, true);
  assert.equal(d.replacedPending, true);
  assert.equal(describeProxyNoticeForLog(d).replacedPending, true);
});

test('昇格済み（Requested* が空 / PaymentConfirmed=true）のレコードは通常どおり次の申込を作れる', () => {
  // 更新・再購入は正当なので塞がない。ただし PaymentConfirmed は false へ戻り、
  // 昇格には MK のチェックが改めて必要になる（黙って再昇格しない）。
  const settled = {
    id: RECORD.id,
    fields: { ...RECORD.fields, Status: 'active', RequestedPlan: '', PaymentConfirmed: true },
  };
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, record: settled });
  assert.equal(d.ok, true);
  const fields = buildProxyNoticeFields({ decision: d, nowMs: NOW });
  assert.equal(fields.PaymentConfirmed, false, '承認済みフラグを落とさないと再チェックできない');
  assert.ok(!('有効期限' in fields), '再登録だけで有効期限を動かしてはいけない');
});

// ── 監査（本人送信と代理登録の区別）──────────────────────────────

test('監査列が未作成のうちは監査フィールドを書かない（422 を出さない）', () => {
  assert.equal(isProxyAuditFieldsEnabled({}), false);
  assert.equal(isProxyAuditFieldsEnabled({ PROXY_PAYMENT_NOTICE_FIELDS_READY: '0' }), false);
  const d = decideProxyPaymentNotice(BASE_INPUT);
  const fields = buildProxyNoticeFields({ decision: d, auditFieldsReady: false, nowMs: NOW });
  for (const name of Object.values(PROXY_NOTICE_FIELDS)) {
    assert.ok(!(name in fields), `${name} は列の作成前に書いてはいけない`);
  }
});

test('監査列が作成済みなら、本人送信と代理登録を区別できる値を書く', () => {
  assert.equal(isProxyAuditFieldsEnabled({ PROXY_PAYMENT_NOTICE_FIELDS_READY: '1' }), true);
  const d = decideProxyPaymentNotice(BASE_INPUT);
  const fields = buildProxyNoticeFields({ decision: d, auditFieldsReady: true, nowMs: NOW });
  assert.equal(fields[PROXY_NOTICE_FIELDS.SOURCE], PROXY_SOURCE_VALUE);
  assert.equal(fields[PROXY_NOTICE_FIELDS.BY], 'MK');
  assert.equal(fields[PROXY_NOTICE_FIELDS.AT], new Date(NOW).toISOString());
  // 昇格時にクリアされる RequestedAmount と違い、実入金額は残せる
  assert.equal(fields[PROXY_NOTICE_FIELDS.RECEIVED_AMOUNT], 44800);
  assert.equal(fields[PROXY_NOTICE_FIELDS.REASON], '本人がフォーム送信できないため代理登録');
});

test('監査列が無くても構造化ログで代理登録の事実を残せる', () => {
  const d = decideProxyPaymentNotice(BASE_INPUT);
  const log = describeProxyNoticeForLog(d);
  assert.equal(log.event, 'admin_proxy_payment_notice');
  assert.equal(log.operator, 'MK');
  assert.equal(log.receivedAmount, 44800);
  assert.equal(log.recordId, RECORD.id);
});

test('ok:false の判定でフィールドを組み立てようとしたら例外（中途半端な書き込みを作らない）', () => {
  const d = decideProxyPaymentNotice({ ...BASE_INPUT, operator: '' });
  assert.throws(() => buildProxyNoticeFields({ decision: d, nowMs: NOW }));
  assert.throws(() => buildProxyNoticeFields({ decision: null, nowMs: NOW }));
});
