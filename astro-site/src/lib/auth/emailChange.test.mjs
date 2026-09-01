/**
 * emailChange.test.mjs
 *   node --test src/lib/auth/emailChange.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideEmailChange, isPlausibleEmail, normalizeEmail, buildEmailChangeEmails,
  EMAIL_CHANGE_REJECT, EMAIL_CHANGE_MESSAGE, EMAIL_CHANGE_TTL_MIN,
} from './emailChange.js';

const OK = { currentEmail: 'u.non.4110@gmail.com', newEmail: 'yskr4110@gmail.com', newEmailTaken: false };

test('未使用の正しいアドレスなら通す', () => {
  const out = decideEmailChange(OK);
  assert.equal(out.ok, true);
  assert.equal(out.newEmail, 'yskr4110@gmail.com');
});

test('大文字・前後空白は正規化して扱う', () => {
  const out = decideEmailChange({ ...OK, newEmail: '  YSKR4110@Gmail.com ' });
  assert.equal(out.ok, true);
  assert.equal(out.newEmail, 'yskr4110@gmail.com');
});

test('形式が不正なら断る', () => {
  for (const bad of ['', '   ', 'no-at-mark', 'a@b', 'a@@b.com', 'a b@c.com', 'a@c', null, undefined, 42]) {
    const out = decideEmailChange({ ...OK, newEmail: bad });
    assert.equal(out.ok, false, `通ってはいけない: ${String(bad)}`);
    assert.equal(out.reason, EMAIL_CHANGE_REJECT.INVALID_FORMAT);
  }
});

test('現在と同じアドレスは断る', () => {
  const out = decideEmailChange({ ...OK, newEmail: ' U.Non.4110@gmail.com ' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, EMAIL_CHANGE_REJECT.SAME_AS_CURRENT);
});

test('既に登録済みのアドレスへは変更させない（重複レコードを作らない）', () => {
  const out = decideEmailChange({ ...OK, newEmailTaken: true });
  assert.equal(out.ok, false);
  assert.equal(out.reason, EMAIL_CHANGE_REJECT.ALREADY_REGISTERED);
});

test('【重要】使用状況を確認できないときは fail closed（勝手に通さない）', () => {
  for (const unknown of [null, undefined, 'false', 0, 1, {}]) {
    const out = decideEmailChange({ ...OK, newEmailTaken: unknown });
    assert.equal(out.ok, false, `確認できないのに通した: ${String(unknown)}`);
    assert.equal(out.reason, EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE);
  }
});

test('全ての理由コードに画面文言がある', () => {
  for (const code of Object.values(EMAIL_CHANGE_REJECT)) {
    assert.ok(EMAIL_CHANGE_MESSAGE[code], `文言が無い: ${code}`);
  }
});

test('確認メールは新アドレス宛にだけリンクを載せる（旧アドレス宛には載せない）', () => {
  const url = 'https://analytics.keiba.link/auth/change-email?token=abc123';
  const { toNew, toOld } = buildEmailChangeEmails({
    currentEmail: 'old@example.com', newEmail: 'new@example.com',
    confirmUrl: url, supportEmail: 'support@keiba.link',
  });
  assert.ok(toNew.html.includes(url) && toNew.text.includes(url), '新アドレス宛にリンクが無い');
  assert.ok(!toOld.html.includes(url) && !toOld.text.includes(url),
    '旧アドレス宛にリンクを載せている（乗っ取り時に確定されてしまう）');
  assert.ok(toOld.text.includes('support@keiba.link'), '旧アドレス宛に連絡先が無い');
  assert.ok(toNew.text.includes(`${EMAIL_CHANGE_TTL_MIN}分間`), '有効時間の案内が無い');
});

test('差し込み値は HTML エスケープする', () => {
  const { toNew } = buildEmailChangeEmails({
    currentEmail: 'old@example.com',
    newEmail: '"><script>alert(1)</script>@example.com',
    confirmUrl: 'https://analytics.keiba.link/auth/change-email?token=x&y=1',
    supportEmail: 'support@keiba.link',
  });
  assert.ok(!toNew.html.includes('<script>'), '生の script タグが本文に出ている');
  assert.ok(toNew.html.includes('&amp;y=1'), 'URL の & がエスケープされていない');
});

test('normalizeEmail / isPlausibleEmail は例外を投げない', () => {
  for (const v of [null, undefined, {}, [], 0, true]) {
    assert.doesNotThrow(() => normalizeEmail(v));
    assert.equal(isPlausibleEmail(v), false);
  }
});
