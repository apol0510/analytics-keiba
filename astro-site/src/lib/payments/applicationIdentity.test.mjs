/**
 * applicationIdentity.test.mjs
 *   node --test src/lib/payments/applicationIdentity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideApplicationEmail, normalizeApplicationEmail,
  APPLICATION_EMAIL, APPLICATION_EMAIL_MISMATCH_MESSAGE,
} from './applicationIdentity.js';

test('未ログイン（sessionEmail 空）は従来どおり通す', () => {
  for (const sessionEmail of [undefined, null, '', '   ']) {
    const out = decideApplicationEmail({ sessionEmail, submittedEmail: 'anyone@example.com' });
    assert.equal(out.ok, true);
    assert.equal(out.reason, APPLICATION_EMAIL.NO_SESSION);
  }
});

test('ログイン中で一致していれば通す（大文字・前後空白は無視）', () => {
  const out = decideApplicationEmail({
    sessionEmail: 'u.non.4110@gmail.com',
    submittedEmail: '  U.Non.4110@Gmail.com ',
  });
  assert.equal(out.ok, true);
  assert.equal(out.reason, APPLICATION_EMAIL.MATCH);
});

test('ログイン中に別アドレスを入れたら拒否する（2026-09-01 の重複申込）', () => {
  const out = decideApplicationEmail({
    sessionEmail: 'u.non.4110@gmail.com',
    submittedEmail: 'yskr4110@gmail.com',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, APPLICATION_EMAIL.MISMATCH);
});

test('ログイン中に空で送られたら拒否する（必須チェックをすり抜けさせない）', () => {
  const out = decideApplicationEmail({ sessionEmail: 'u.non.4110@gmail.com', submittedEmail: '' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, APPLICATION_EMAIL.MISMATCH);
});

test('文字列以外は空として扱い、例外を投げない', () => {
  for (const v of [null, undefined, 0, {}, [], true]) {
    assert.equal(normalizeApplicationEmail(v), '');
  }
  assert.doesNotThrow(() => decideApplicationEmail());
  assert.equal(decideApplicationEmail().ok, true, '引数なしは未ログイン扱い（申込を止めない）');
});

test('拒否文言はマイページでの変更を案内する（行き止まりにしない）', () => {
  assert.match(APPLICATION_EMAIL_MISMATCH_MESSAGE, /マイページ/);
  assert.match(APPLICATION_EMAIL_MISMATCH_MESSAGE, /メールアドレスを変更/);
});
