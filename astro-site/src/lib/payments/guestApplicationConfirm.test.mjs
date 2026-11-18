/**
 * guestApplicationConfirm.test.mjs — 未ログインの申込の書き込み経路・確定トークンの単一源
 *   node --test src/lib/payments/guestApplicationConfirm.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICATION_WRITE, decideApplicationWrite, generateApplicationToken, isWellFormedToken,
  pendingApplicationKey, buildConfirmUrl, escapeHtml,
} from './guestApplicationConfirm.js';

test('書き込み経路: 未ログイン × 既存レコードは本人の確定待ち（書き換えない）', () => {
  assert.equal(decideApplicationWrite({ authenticated: false, existingRecord: true }), APPLICATION_WRITE.OWNER_CONFIRMATION);
  assert.equal(decideApplicationWrite({ authenticated: true, existingRecord: true }), APPLICATION_WRITE.OWNER_UPDATE);
  assert.equal(decideApplicationWrite({ authenticated: false, existingRecord: false }), APPLICATION_WRITE.CREATE);
  assert.equal(decideApplicationWrite({ authenticated: true, existingRecord: false }), APPLICATION_WRITE.CREATE);
  // 判定材料が欠けたら本人扱いしない
  assert.equal(decideApplicationWrite({ existingRecord: true }), APPLICATION_WRITE.OWNER_CONFIRMATION);
  assert.equal(decideApplicationWrite({ authenticated: 'yes', existingRecord: true }), APPLICATION_WRITE.OWNER_CONFIRMATION);
});

test('トークン: 32 バイト乱数・毎回違う・形式検査', () => {
  const a = generateApplicationToken();
  const b = generateApplicationToken();
  assert.notEqual(a, b);
  assert.ok(isWellFormedToken(a));
  for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}/`, null, 123]) {
    assert.equal(isWellFormedToken(bad), false, String(bad));
  }
});

test('Redis の鍵はトークンの SHA-256（本体を含まない）', () => {
  const t = generateApplicationToken();
  const k = pendingApplicationKey(t);
  assert.ok(!k.includes(t));
  assert.match(k, /^ak:bank-app-pending:v1:[0-9a-f]{64}$/);
});

test('確定リンクはトークンを # 以降に載せる', () => {
  const t = 'A'.repeat(43);
  assert.equal(buildConfirmUrl('https://analytics.keiba.link/', t), `https://analytics.keiba.link/bank-transfer/confirm/#t=${t}`);
  assert.equal(buildConfirmUrl(undefined, t), `https://analytics.keiba.link/bank-transfer/confirm/#t=${t}`);
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(escapeHtml(undefined), '');
});
