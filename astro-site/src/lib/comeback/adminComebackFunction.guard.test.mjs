/**
 * adminComebackFunction.guard.test.mjs — Function 本体の安全条件をソースで固定する
 *   node --test src/lib/comeback/adminComebackFunction.guard.test.mjs
 *
 * 「実装を後から書き換えても壊せない」性質:
 *   1. メールを送らない（送信基盤にもキューにも触れない）
 *   2. Customers へ書くのは特典フィールドだけ（allowlist を経由しない PATCH を作らない）
 *   3. 課金・契約・三連複・Premium Plus のフィールド名がコードに現れない
 *   4. 実付与は env で二重に閉じている（既定 OFF）
 *   5. 判定を Function 内で再実装しない（純粋モジュールへ委譲する）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PROMO_FORBIDDEN_FIELDS, PROMO_WRITABLE_FIELDS } from '../entitlements/promotionalGrants.js';

const fnPath = fileURLToPath(new URL('../../../netlify/functions/admin-comeback-grants.js', import.meta.url));
const src = readFileSync(fnPath, 'utf8');
/** コメントを除いた実コード（説明文で guard が誤検知しないようにする） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('1. メールを送らない / メール系テーブルにも触れない', () => {
  for (const banned of ['sendgrid', 'mail/send', 'nodemailer', 'resend.com',
    'ScheduledEmails', 'CampaignDeliveries', 'EmailBlacklist', 'newsletter']) {
    assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false, `${banned} に触れている`);
  }
  // 「メールを送っていない」ことを応答でも明示する
  assert.ok(code.includes('emailSent: false'));
});

test('2. 書き込み対象は Customers のみ、かつ allowlist 検査を必ず通す', () => {
  const writeCalls = [...code.matchAll(/method:\s*'(PATCH|POST|DELETE|PUT)'/g)];
  assert.ok(writeCalls.length > 0, '書き込み経路が消えている（テストの前提が壊れた）');
  // PATCH は Customers テーブルにしか出てこない
  for (const m of code.matchAll(/fetch\(`https:\/\/api\.airtable\.com\/v0\/\$\{BASE\}\/([^`]+)`,\s*\{\s*\n?\s*method:\s*'PATCH'/g)) {
    assert.match(m[1], /CUSTOMERS_TABLE/, `Customers 以外へ PATCH している: ${m[1]}`);
  }
  // PATCH の直前に allowlist の最終確認がある
  assert.ok(code.includes('assertPlanWritesOnlyGrantFields'), 'PATCH 直前の allowlist 検査が無い');
  const guardCount = (code.match(/assertPlanWritesOnlyGrantFields\(/g) || []).length;
  assert.ok(guardCount >= 2, '付与と取り消しの両方で allowlist を検査していない');
});

test('3. 課金・契約・三連複・Plus のフィールドは「読むだけ」（書き込み経路に現れない）', () => {
  // 書き込み payload を Function 内で組み立てていない（計画モジュールの結果をそのまま渡す）
  assert.equal(/fields:\s*\{\s*['"]/.test(code), false, 'Function 内で fields リテラルを組み立てている');
  // PATCH の body に渡すのは計画が作った t.fields だけ
  for (const m of code.matchAll(/records:\s*batch\.map\(\(t\) => \(\{ id: t\.recordId, fields: ([^\s}]+) \}\)\)/g)) {
    assert.equal(m[1], 't.fields', `PATCH に計画以外の fields を渡している: ${m[1]}`);
  }

  // 禁止フィールド名が出てよいのは `xxx.fields['名前']` / `f['名前']` の **読み取り** だけ。
  // 代入（= を伴う出現）は 1 つも許さない。
  for (const forbidden of PROMO_FORBIDDEN_FIELDS) {
    const quoted = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of code.matchAll(new RegExp(`.{0,24}['"]${quoted}['"].{0,12}`, 'g'))) {
      const ctx = m[0];
      assert.match(ctx, /(fields|f)\s*\[\s*['"]/, `${forbidden} を読み取り以外の文脈で使っている: ${ctx.trim()}`);
      assert.equal(/\]\s*=[^=]/.test(ctx), false, `${forbidden} へ代入している: ${ctx.trim()}`);
    }
  }
});

test('4. 実付与は env 二重 gate（既定 OFF）', () => {
  assert.ok(code.includes('isGrantFieldsEnabled(process.env)'));
  assert.ok(code.includes('isGrantWriteEnabled(process.env)'));
  assert.ok(code.includes('COMEBACK_GRANT_FIELDS_READY'));
  assert.ok(code.includes('COMEBACK_GRANT_ENABLED'));
  // gate は live のときだけ判定し、dry-run は素通し（確認は常にできる）
  assert.match(code, /if \(live && !isGrantFieldsEnabled/);
  assert.match(code, /if \(live && !isGrantWriteEnabled/);
  // 認可は secret 必須（未設定なら機能ごと無効）
  assert.match(code, /if \(!SECRET\) return json\(503/);
  assert.match(code, /if \(provided !== SECRET\) return json\(403/);
});

test('5. dry-run トークン（planFingerprint）と operationId が実行の必須条件', () => {
  assert.match(code, /req\.planFingerprint/);
  assert.match(code, /json\(409/, '母集団変化時の 409 が無い');
  assert.match(code, /operationId が必要です/);
});

test('6. 判定ロジックを Function 内で再実装しない（純粋モジュールへ委譲）', () => {
  for (const fn of ['buildGrantPlan', 'buildRevokePlan', 'resolveComebackCustomer', 'reconcileOperation']) {
    assert.ok(code.includes(fn), `${fn} を使っていない`);
  }
  // 期限・特典の計算式を Function 内に書かない
  assert.equal(/30\s*\*\s*24\s*\*\s*60/.test(code), false, '無料期間の計算を Function 内で再実装している');
  assert.equal(code.includes('LightLifetimeGranted'), false, '特典フィールド名を直書きしている');
});

test('7. allowlist は promotionalGrants の単一源をそのまま使う', () => {
  assert.ok(PROMO_WRITABLE_FIELDS.length > 0);
  assert.ok(code.includes('PROMO_WRITABLE_FIELDS'));
  // Function 側で独自の許可リストを作っていない
  assert.equal(/const\s+\w*WRITABLE\w*\s*=\s*\[/.test(code), false, 'Function 内で独自 allowlist を定義している');
});
