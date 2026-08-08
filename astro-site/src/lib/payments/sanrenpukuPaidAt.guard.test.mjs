/**
 * sanrenpukuPaidAt.guard.test.mjs — 三連複購入日時の記録を恒久化する
 *   node --test src/lib/payments/sanrenpukuPaidAt.guard.test.mjs
 *
 * 背景（2026-08-07 の監査）:
 *   `プラン=Premium` + `LifetimeSanrenpuku=true` の会員について「本当に三連複を買ったのか」を
 *   系内のデータから裏取りできなかった。三連複の確認は
 *     - `LifetimeSanrenpuku=true` と `Requested*` クリアの 4 キーしか書かない
 *     - `RequestedAmount` は承認時にクリアされる
 *     - 金額は管理者宛メールにしか残らない
 *   ため、**購入日時がどこにも残らない**構造だった。
 *
 * 現在の実装（2026-07-29 以降）:
 *   `buildSanrenpukuPlusInitFields` が昇格 PATCH の**後**に別 PATCH で
 *   `SanrenpukuPaidAt` を書く。本テストはその配線と不変条件を固定する。
 *
 * ⚠️ 本 PATCH は **best effort**（失敗しても昇格・メールを巻き戻さない）。
 *    これは「未作成フィールドへの PATCH で昇格ごと 422 で落ちる」事故を防ぐための
 *    既存の設計判断なので**変えない**。代わりに、失敗を**無言にしない**ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildSanrenpukuPlusInitFields,
  SANRENPUKU_PAID_AT_FIELD,
  assertOnlyPlusFields,
} from '../premiumPlus/premiumPlusEligibility.js';
import { buildConfirmationFields } from './bankPaymentFlow.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CONFIRM_FN = read('../../../netlify/functions/confirm-bank-payment.js');

const CONFIRMED = new Date('2026-08-08T02:34:56.000Z');

// ── 1. 三連複の入金確認成功時に確認日時を保存する ──────────────
test('三連複の確認成功時に SanrenpukuPaidAt へ確認日時を保存する', () => {
  const r = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: CONFIRMED });
  assert.ok(r, '書き込み内容が組み立てられていない');
  assert.equal(r.fields[SANRENPUKU_PAID_AT_FIELD], CONFIRMED.toISOString());
  assert.equal(assertOnlyPlusFields(r.fields), true, 'Plus 専用フィールド以外を書いている');
});

test('LifetimeSanrenpuku=true と同じ成功処理から起動する', () => {
  const code = strip(CONFIRM_FN);
  // 三連複昇格の判定は confirmation.fields['LifetimeSanrenpuku'] === true の 1 箇所
  assert.match(code, /const isSanrenpukuPromotion = confirmation\.fields\['LifetimeSanrenpuku'\] === true;/);
  // その判定を条件に Plus 初期化へ入る
  assert.match(code, /if \(isSanrenpukuPromotion\)/);
  // 昇格 PATCH の**後**に実行する（順序を入れ替えない）
  const iPromote = code.indexOf('fields: confirmation.fields');
  const iInit = code.indexOf('buildSanrenpukuPlusInitFields({');
  assert.ok(iPromote >= 0 && iInit > iPromote, 'Plus 初期化が昇格 PATCH より前にある');
});

// ── 2. 通常 Premium の PaidAt と混同しない ─────────────────────
test('通常 Premium の確認は SanrenpukuPaidAt を書かない', () => {
  const r = buildConfirmationFields({
    requestedPlan: 'Premium',
    requestedPlanType: 'Annual',
    confirmedAt: CONFIRMED,
  });
  assert.ok(r, '通常昇格が組み立てられていない');
  assert.equal(Object.prototype.hasOwnProperty.call(r.fields, SANRENPUKU_PAID_AT_FIELD), false);
  assert.equal(r.fields['LifetimeSanrenpuku'], undefined, '通常購入で三連複権を与えている');
});

test('三連複の確認は通常 Premium の PaidAt / プラン / 有効期限を書かない', () => {
  const r = buildConfirmationFields({
    requestedPlan: 'Premium Sanrenpuku',
    requestedPlanType: '',
    confirmedAt: CONFIRMED,
  });
  assert.equal(r.fields['LifetimeSanrenpuku'], true);
  for (const f of ['PaidAt', 'プラン', 'PlanType', '有効期限', 'Status']) {
    assert.equal(Object.prototype.hasOwnProperty.call(r.fields, f), false, `${f} を書いている`);
  }
});

test('Plus 初期化は昇格フィールドを 1 つも書かない（2 つの PATCH が混ざらない）', () => {
  const r = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: CONFIRMED });
  for (const f of ['LifetimeSanrenpuku', 'プラン', 'PlanType', '有効期限', 'PaidAt', 'Status',
    'PaymentConfirmed', 'PaymentEmailSent']) {
    assert.equal(Object.prototype.hasOwnProperty.call(r.fields, f), false, `${f} を書いている`);
  }
});

// ── 3. 冪等性 / 遡及 write の禁止 ──────────────────────────────
test('冪等性: 既に SanrenpukuPaidAt があれば書き換えない（初回購入日時を保持）', () => {
  const existing = '2026-07-01T00:00:00.000Z';
  const r = buildSanrenpukuPlusInitFields({
    fields: { [SANRENPUKU_PAID_AT_FIELD]: existing, PremiumPlusEligibility: 'eligible' },
    confirmedAt: CONFIRMED,
  });
  assert.equal(r, null, '書くものが無いのに PATCH しようとしている');
});

test('冪等性: 確認を 2 回流しても購入日時は初回のまま', () => {
  const first = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: CONFIRMED });
  const after = { [SANRENPUKU_PAID_AT_FIELD]: first.fields[SANRENPUKU_PAID_AT_FIELD],
    PremiumPlusEligibility: 'review' };
  const second = buildSanrenpukuPlusInitFields({
    fields: after, confirmedAt: new Date('2026-12-31T00:00:00.000Z'),
  });
  assert.equal(second, null);
});

test('遡及 write をしない: 既存顧客を一括更新する経路を持たない', () => {
  const code = strip(CONFIRM_FN);
  // このレコード 1 件だけを PATCH する（listRecords → 一括更新の経路が無い）
  assert.doesNotMatch(code, /Customers\?[^`'"]*maxRecords=(?!1\b)/, '複数件取得の経路がある');
  assert.doesNotMatch(code, /for\s*\([^)]*of\s+records\s*\)[\s\S]{0,200}method:\s*'PATCH'/,
    '複数レコードへ PATCH するループがある');
  // 書き込みは常に recordId 単体宛
  const patches = code.match(/method:\s*'PATCH'/g) || [];
  const scoped = code.match(/\/\$\{CUSTOMERS_TABLE\}\/\$\{recordId\}`/g) || [];
  assert.ok(scoped.length >= patches.length - 1,
    'recordId 単体宛でない PATCH がある');
});

test('確認日時が無効なら何も書かない（fail closed）', () => {
  for (const bad of [null, undefined, '', 'not-a-date', NaN, {}]) {
    assert.equal(buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: bad }), null,
      `confirmedAt=${String(bad)}`);
  }
});

// ── 4. 失敗を無言にしない（2026-08-08 追加）────────────────────
test('Plus 初期化の結果を必ず 1 つ確定させ、ログに出す', () => {
  const code = strip(CONFIRM_FN);
  assert.match(code, /SANRENPUKU_PLUS_INIT_TAG/, '構造化ログの目印が無い');
  assert.match(code, /\[sanrenpuku-plus-init\]/, 'ログの目印文字列が変わっている');
  for (const outcome of ['gate_closed', 'nothing_to_write', 'recorded', 'failed_http_', 'failed_error']) {
    assert.ok(code.includes(outcome), `結果 ${outcome} を扱っていない`);
  }
  // 成功/失敗でログレベルを分ける
  assert.match(code, /if \(ok\) console\.log\(line\); else console\.warn\(line\);/);
});

test('失敗しても昇格は巻き戻さない（best effort の維持）', () => {
  // Plus 初期化ブロックだけを切り出す（次の処理 = メール送信の直前まで）。
  // ⚠️ コメント（'Step 5' 等）を境界にすると strip 後に消えて切り出しが崩れる。
  const code = strip(CONFIRM_FN);
  const start = code.indexOf('const isSanrenpukuPromotion');
  const end = code.indexOf('if (useV2)', start);
  assert.ok(start >= 0 && end > start, 'Plus 初期化ブロックを特定できない');
  const seg = code.slice(start, end);
  assert.match(seg, /try\s*\{/);
  assert.match(seg, /catch/);
  assert.doesNotMatch(seg, /throw\s/, '例外を再送出している');
  assert.doesNotMatch(seg, /return\s+jsonResponse\(/, '途中で応答を返している');
  assert.match(seg, /promotion: 'kept'/, '昇格を保持する意図がログに残っていない');
});

test('結果を応答に載せる（Automation / 運用者が失敗に気づける）', () => {
  const code = strip(CONFIRM_FN);
  assert.match(code, /sanrenpukuPlusInit: plusInitOutcome/);
  assert.match(code, /sanrenpukuPaidAtRecorded: plusPaidAtRecorded/);
  // 三連複購入のときだけ載せる（通常購入の応答形を変えない）
  assert.match(code, /\.\.\.\(isSanrenpukuPromotion \? \{/);
});

test('ログに secret / メール / 氏名を出さない', () => {
  const code = strip(CONFIRM_FN);
  const i = code.indexOf('SANRENPUKU_PLUS_INIT_TAG');
  const seg = code.slice(i, i + 400);
  for (const bad of ['AIRTABLE_API_KEY', 'SENDGRID_API_KEY', 'CONFIRM_SECRET', 'email', 'fullName', '氏名']) {
    assert.ok(!seg.includes(bad), `ログに ${bad} を含めている`);
  }
});

// ── 5. env gate は維持（未作成フィールドへ PATCH しない）──────
test('env gate を外していない（フィールド未作成の環境で 422 を出さない）', () => {
  assert.match(strip(CONFIRM_FN), /isPlusFieldsEnabled\(process\.env\)/);
  assert.match(strip(CONFIRM_FN), /plusInitOutcome = 'gate_closed'/);
});
