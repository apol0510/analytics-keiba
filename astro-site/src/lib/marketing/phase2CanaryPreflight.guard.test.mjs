/**
 * phase2CanaryPreflight.guard.test.mjs — Phase 2 事前確認スクリプトの**安全性**を固定する。
 *
 * 事前確認は「送る前に構造で確かめる」ためのもの。ここが write を持ったり、
 * アドレスを出力したりすると、確認そのものが事故になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = readFileSync(
  fileURLToPath(new URL('../../../scripts/phase2-canary-preflight.mjs', import.meta.url)),
  'utf8'
);
/** コメントを除いた実コード */
const CODE = SCRIPT.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

test('guard: 事前確認は read-only（write メソッドを持たない）', () => {
  for (const m of ["method: 'POST'", "method: 'PATCH'", "method: 'DELETE'", "method: 'PUT'"]) {
    assert.equal(CODE.includes(m), false, `事前確認が ${m} を含む（書き込み経路がある）`);
  }
  assert.equal(/mail\/send|sendgrid\.com/.test(CODE), false, '事前確認が送信 API を叩ける');
  assert.equal(/performUpsert/.test(CODE), false, 'upsert を含む');
});

test('guard: メールアドレス・secret を出力しない', () => {
  const logs = CODE.split('\n').filter((l) => /console\.(log|error)/.test(l));
  for (const line of logs) {
    assert.equal(/\$\{target\}|\$\{email|recipients\[0\]\}/.test(line), false, `アドレスを出力している: ${line.trim()}`);
    // env の**名前**を出すのは可（未設定の案内）。**値**を出すのが禁止
    assert.equal(/\$\{\s*(KEY|BASE|process\.env)/.test(line), false, `secret の値を出力している: ${line.trim()}`);
  }
  assert.match(CODE, /sha256:\$\{tag\(target\)\}/, 'アドレスをハッシュ断片で示していない');
  assert.match(CODE, /deliveryKey\.slice\(0, 12\)/, 'DeliveryKey を全部出している');
});

test('guard: allowlist ちょうど 1 名を必須にする（exactly-one）', () => {
  assert.match(CODE, /recipients\.length === 1/, 'allowlist の人数を 1 名に固定していない');
  assert.match(CODE, /if \(recipients\.length !== 1\) return finish\(\)/, '1 名以外で続行している');
});

test('guard: 二重送信の芽（同一 DeliveryKey / 同一 version の既存行）を検査する', () => {
  assert.match(CODE, /sameKey\.length === 0/, '同一 DeliveryKey の存在を検査していない');
  assert.match(CODE, /sameCampaign\.length === 0/, '同一 campaign:version の存在を検査していない');
});

test('guard: 実行前に gate が閉じていることを検査する', () => {
  assert.match(CODE, /MARKETING_CAMPAIGN_ENABLED !== 'true'/, '送信 gate の状態を検査していない');
  assert.match(CODE, /MARKETING_CAMPAIGN_DISPATCH_ENABLED !== 'true'/, '実送信 gate の状態を検査していない');
});

test('guard: 顧客の一意性を確認する（重複があると customer_record_id が確定しない）', () => {
  assert.match(CODE, /matched\.length === 1/, 'Customers の重複を検査していない');
  assert.match(CODE, /\^rec\[A-Za-z0-9\]\{14\}\$/, 'recordId の形式を検査していない');
});

test('guard: 判定に失敗したら非ゼロ終了（送ってよいと誤読させない）', () => {
  assert.match(CODE, /process\.exit\(ng\.length === 0 \? 0 : 1\)/, '失敗時に非ゼロ終了しない');
});
