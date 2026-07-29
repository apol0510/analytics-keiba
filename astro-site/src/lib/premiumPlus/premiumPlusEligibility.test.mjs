/**
 * premiumPlusEligibility.test.mjs — Premium Plus 販売資格の書き込みフィールド組み立ての検証
 *   node --test src/lib/premiumPlus/premiumPlusEligibility.test.mjs
 *
 * 最重要: Plus 専用フィールド以外を**絶対に書かない**こと（既存権限・決済・メールを壊さない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_WRITABLE_FIELDS,
  PP_FORBIDDEN_FIELDS,
  SANRENPUKU_PAID_AT_FIELD,
  PP_REASON_MAX_LENGTH,
  isPlusFieldsEnabled,
  assertOnlyPlusFields,
  buildSanrenpukuPlusInitFields,
  buildEligibilityUpdateFields,
} from './premiumPlusEligibility.js';
import { PP_ELIGIBILITY, PP_ELIGIBILITY_FIELDS } from './premiumPlusRelease.js';

const CONFIRMED = new Date('2026-07-29T05:00:00.000Z');

// ── 書き込み許可の境界 ────────────────────────────────────────────
test('書けるのは Plus 専用フィールドだけ（禁止フィールドと交差しない）', () => {
  for (const f of PP_FORBIDDEN_FIELDS) {
    assert.ok(!PP_WRITABLE_FIELDS.includes(f), `${f} が書込許可に入っている`);
  }
  assert.deepEqual([...PP_WRITABLE_FIELDS].sort(), [
    'PremiumPlusEligibility',
    'PremiumPlusEligibilityReason',
    'PremiumPlusEligibilityUpdatedAt',
    'PremiumPlusEligibilityUpdatedBy',
    'PremiumPlusEligibleAt',
    'SanrenpukuPaidAt',
  ].sort());
});

test('assertOnlyPlusFields: 禁止フィールドが 1 つでも混ざれば false', () => {
  assert.equal(assertOnlyPlusFields({ [PP_ELIGIBILITY_FIELDS.STATUS]: 'review' }), true);
  for (const f of ['プラン', 'Status', '有効期限', 'LifetimeSanrenpuku', 'PaidAt', 'PaymentEmailSent']) {
    assert.equal(assertOnlyPlusFields({ [PP_ELIGIBILITY_FIELDS.STATUS]: 'review', [f]: 'x' }), false, f);
  }
  assert.equal(assertOnlyPlusFields({}), false);
  assert.equal(assertOnlyPlusFields(null), false);
  assert.equal(assertOnlyPlusFields([]), false);
});

test('本番フィールド作成前は書き込みが無効（fail closed）', () => {
  assert.equal(isPlusFieldsEnabled({}), false);
  assert.equal(isPlusFieldsEnabled({ PREMIUM_PLUS_FIELDS_READY: '0' }), false);
  assert.equal(isPlusFieldsEnabled({ PREMIUM_PLUS_FIELDS_READY: 'true' }), false);
  assert.equal(isPlusFieldsEnabled(null), false);
  assert.equal(isPlusFieldsEnabled({ PREMIUM_PLUS_FIELDS_READY: '1' }), true);
});

// ── 三連複購入確定時の初期化 ─────────────────────────────────────
test('初回: SanrenpukuPaidAt を記録し eligibility は review（自動 eligible にしない）', () => {
  const r = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: CONFIRMED });
  assert.equal(r.fields[SANRENPUKU_PAID_AT_FIELD], CONFIRMED.toISOString());
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.STATUS], PP_ELIGIBILITY.REVIEW);
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.UPDATED_AT], CONFIRMED.toISOString());
  assert.equal(assertOnlyPlusFields(r.fields), true);
  assert.notEqual(r.fields[PP_ELIGIBILITY_FIELDS.STATUS], PP_ELIGIBILITY.ELIGIBLE);
});

test('冪等性: SanrenpukuPaidAt が既にあれば書き換えない（初回購入日時を保持）', () => {
  const existing = '2026-07-01T00:00:00.000Z';
  const r = buildSanrenpukuPlusInitFields({
    fields: { [SANRENPUKU_PAID_AT_FIELD]: existing, [PP_ELIGIBILITY_FIELDS.STATUS]: 'review' },
    confirmedAt: CONFIRMED,
  });
  assert.equal(r, null, '書くものが無ければ PATCH しない');
});

test('冪等性: 管理者が設定した eligible / blocked を confirm 再実行で上書きしない', () => {
  for (const admin of [PP_ELIGIBILITY.ELIGIBLE, PP_ELIGIBILITY.BLOCKED, PP_ELIGIBILITY.REVIEW]) {
    const r = buildSanrenpukuPlusInitFields({
      fields: { [PP_ELIGIBILITY_FIELDS.STATUS]: admin },
      confirmedAt: CONFIRMED,
    });
    // SanrenpukuPaidAt だけは未設定なので入るが、eligibility には触れない
    assert.ok(r, admin);
    assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.STATUS], undefined, `${admin} を上書きしている`);
    assert.equal(r.fields[SANRENPUKU_PAID_AT_FIELD], CONFIRMED.toISOString());
  }
});

test('三連複昇格フィールド（LifetimeSanrenpuku 等）を一切含まない', () => {
  const r = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: CONFIRMED });
  for (const f of PP_FORBIDDEN_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(r.fields, f), false, f);
  }
});

test('confirmedAt が不正なら null（推測で日時を作らない）', () => {
  assert.equal(buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: null }), null);
  assert.equal(buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: new Date('bad') }), null);
  assert.equal(buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: 'x' }), null);
});

// ── 管理画面からの資格変更 ───────────────────────────────────────
test('管理操作: 3 値それぞれへ変更でき、監査情報が付く', () => {
  for (const next of [PP_ELIGIBILITY.ELIGIBLE, PP_ELIGIBILITY.REVIEW, PP_ELIGIBILITY.BLOCKED]) {
    const r = buildEligibilityUpdateFields({ next, reason: '管理者判断', actor: 'admin', now: CONFIRMED });
    assert.equal(r.next, next);
    assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.STATUS], next);
    assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.REASON], '管理者判断');
    assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.UPDATED_AT], CONFIRMED.toISOString());
    assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.UPDATED_BY], 'admin');
    assert.equal(assertOnlyPlusFields(r.fields), true);
  }
});

// ── 段階公開 anchor（PremiumPlusEligibleAt）の更新規則 ─────────────
// ⚠️ 監査日時（UpdatedAt）と兼用しない。兼用すると内部メモの編集で phase が Day 0 へ戻る。
const LATER = new Date('2026-08-10T02:00:00.000Z');
const EAT = PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT;
const has = (fields, key) => Object.prototype.hasOwnProperty.call(fields, key);

test('anchor: review → eligible の実遷移でだけ EligibleAt を書く', () => {
  for (const current of [PP_ELIGIBILITY.REVIEW, PP_ELIGIBILITY.BLOCKED, undefined, null, '', 'ゴミ']) {
    const r = buildEligibilityUpdateFields({ next: PP_ELIGIBILITY.ELIGIBLE, current, now: CONFIRMED });
    assert.equal(r.eligibleAtUpdated, true, `current=${String(current)}`);
    assert.equal(r.fields[EAT], CONFIRMED.toISOString());
  }
});

test('anchor: eligible → eligible の再保存では EligibleAt を更新しない', () => {
  const r = buildEligibilityUpdateFields({
    next: PP_ELIGIBILITY.ELIGIBLE, current: PP_ELIGIBILITY.ELIGIBLE, now: LATER,
  });
  assert.equal(r.eligibleAtUpdated, false);
  assert.equal(has(r.fields, EAT), false, 'EligibleAt を touch している（phase が Day 0 へ戻る）');
  // 監査日時は更新してよい
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.UPDATED_AT], LATER.toISOString());
});

test('anchor: eligible 会員の内部メモだけの変更で EligibleAt を更新しない', () => {
  const r = buildEligibilityUpdateFields({
    next: PP_ELIGIBILITY.ELIGIBLE, current: PP_ELIGIBILITY.ELIGIBLE,
    reason: 'メモを直しただけ', now: LATER,
  });
  assert.equal(r.eligibleAtUpdated, false);
  assert.equal(has(r.fields, EAT), false);
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.REASON], 'メモを直しただけ');
});

test('anchor: eligible → blocked / review では EligibleAt を上書きしない', () => {
  for (const next of [PP_ELIGIBILITY.BLOCKED, PP_ELIGIBILITY.REVIEW]) {
    const r = buildEligibilityUpdateFields({ next, current: PP_ELIGIBILITY.ELIGIBLE, now: LATER });
    assert.equal(r.eligibleAtUpdated, false, next);
    assert.equal(has(r.fields, EAT), false, `${next} で EligibleAt を書いている`);
  }
});

test('anchor: eligible を経由しない遷移（blocked → review）でも書かない', () => {
  const r = buildEligibilityUpdateFields({
    next: PP_ELIGIBILITY.REVIEW, current: PP_ELIGIBILITY.BLOCKED, now: LATER,
  });
  assert.equal(has(r.fields, EAT), false);
});

test('anchor: eligible → blocked → eligible は最後の解除日時になる', () => {
  const first = buildEligibilityUpdateFields({
    next: PP_ELIGIBILITY.ELIGIBLE, current: PP_ELIGIBILITY.REVIEW, now: CONFIRMED,
  });
  assert.equal(first.fields[EAT], CONFIRMED.toISOString());

  const blocked = buildEligibilityUpdateFields({
    next: PP_ELIGIBILITY.BLOCKED, current: PP_ELIGIBILITY.ELIGIBLE, now: LATER,
  });
  assert.equal(has(blocked.fields, EAT), false, 'blocked 化で解除日時を消してはいけない');

  const again = buildEligibilityUpdateFields({
    next: PP_ELIGIBILITY.ELIGIBLE, current: PP_ELIGIBILITY.BLOCKED, now: LATER,
  });
  assert.equal(again.eligibleAtUpdated, true);
  assert.equal(again.fields[EAT], LATER.toISOString(), '再解除日時へ更新されていない');
});

test('anchor: 初期化（review）では EligibleAt を書かない', () => {
  const r = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: CONFIRMED });
  assert.equal(has(r.fields, EAT), false, '初期 review で anchor を作ってはいけない');
});

test('anchor: confirm 再実行で EligibleAt が変わらない（そもそも書かない）', () => {
  const existing = '2026-07-10T00:00:00.000Z';
  for (const current of [PP_ELIGIBILITY.ELIGIBLE, PP_ELIGIBILITY.REVIEW, PP_ELIGIBILITY.BLOCKED]) {
    const r = buildSanrenpukuPlusInitFields({
      fields: {
        [PP_ELIGIBILITY_FIELDS.STATUS]: current,
        [EAT]: existing,
        SanrenpukuPaidAt: '2026-07-01T00:00:00.000Z',
      },
      confirmedAt: LATER,
    });
    assert.equal(r, null, `${current}: 再実行で何も書かない`);
  }
});

test('anchor: UpdatedAt（監査）と EligibleAt は別フィールド', () => {
  assert.notEqual(PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT, PP_ELIGIBILITY_FIELDS.UPDATED_AT);
  assert.equal(PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT, 'PremiumPlusEligibleAt');
  assert.equal(PP_ELIGIBILITY_FIELDS.UPDATED_AT, 'PremiumPlusEligibilityUpdatedAt');
  assert.ok(PP_WRITABLE_FIELDS.includes(PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT));
});

test('管理操作: 未知の値は丸めずに拒否する', () => {
  for (const bad of ['', null, undefined, 'allow', 'blacklist', 'ok', 1, {}]) {
    assert.equal(buildEligibilityUpdateFields({ next: bad, now: CONFIRMED }), null, String(bad));
  }
});

test('管理操作: blocked → eligible でも会員プラン・決済・メール系を一切変更しない', () => {
  const r = buildEligibilityUpdateFields({ next: PP_ELIGIBILITY.ELIGIBLE, now: CONFIRMED });
  const keys = Object.keys(r.fields);
  for (const f of PP_FORBIDDEN_FIELDS) assert.ok(!keys.includes(f), f);
  // 課金・昇格・送信のトリガーになりうるキーが無いこと
  assert.doesNotMatch(JSON.stringify(r.fields), /sendgrid|mail|charge|stripe|paypal/i);
});

test('管理操作: 内部メモは長さを制限する（顧客画面には出さない値）', () => {
  const long = 'あ'.repeat(500);
  const r = buildEligibilityUpdateFields({ next: PP_ELIGIBILITY.BLOCKED, reason: long, now: CONFIRMED });
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.REASON].length, PP_REASON_MAX_LENGTH);
});

test('管理操作: reason 未指定なら Reason フィールドを touch しない', () => {
  const r = buildEligibilityUpdateFields({ next: PP_ELIGIBILITY.REVIEW, now: CONFIRMED });
  assert.equal(Object.prototype.hasOwnProperty.call(r.fields, PP_ELIGIBILITY_FIELDS.REASON), false);
});
