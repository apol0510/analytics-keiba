/**
 * senderIdentity.test.mjs — 決済メール送信元契約の単一源テスト。
 *
 * 恒久ルール:
 * - AK 正式送信元は support@keiba.link のみ
 * - env 未設定 / 空 / 不一致は fail closed（送信しない）
 * - noreply@keiba.link への fallback は存在しない
 * - 判定結果・エラーに env の値を含めない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFICIAL_FROM_EMAIL, OFFICIAL_FROM_NAME, SENDER_REASON,
  resolveVerifiedSender, hasVerifiedSender,
} from './senderIdentity.js';

test('正式送信元と一致 → ok（送信 payload 用の from が確定する）', () => {
  const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: 'support@keiba.link' });
  assert.equal(r.ok, true);
  assert.equal(r.email, OFFICIAL_FROM_EMAIL);
  assert.equal(r.email, 'support@keiba.link');
  assert.equal(r.name, OFFICIAL_FROM_NAME);
});

test('正規化: 前後空白と大文字小文字は既存方針（trim + toLowerCase）で吸収する', () => {
  for (const v of ['  support@keiba.link  ', 'Support@Keiba.Link', '\tSUPPORT@KEIBA.LINK\n']) {
    const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: v });
    assert.equal(r.ok, true, `正規化で一致すべき: ${JSON.stringify(v)}`);
    // 返す値は常に正規化済みの正式値（env の綴りをそのまま使わない）
    assert.equal(r.email, 'support@keiba.link');
  }
});

test('noreply@keiba.link は fail closed（旧 FROM_EMAIL へ fallback しない）', () => {
  const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: 'noreply@keiba.link' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SENDER_REASON.MISMATCH);
  assert.equal(r.email, undefined, '不一致時に送信元を返してはいけない');
});

test('他ブランド / 別ドメインの送信元も fail closed', () => {
  for (const v of ['noreply@analytics.keiba.link', 'nankan-analytics@keiba.link', 'support@keiba.jp', 'support@example.com']) {
    const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: v });
    assert.equal(r.ok, false, `不一致にすべき: ${v}`);
    assert.equal(r.reason, SENDER_REASON.MISMATCH);
  }
});

test('env 未設定 → fail closed', () => {
  assert.equal(resolveVerifiedSender({}).ok, false);
  assert.equal(resolveVerifiedSender({}).reason, SENDER_REASON.MISSING);
  assert.equal(resolveVerifiedSender({ SENDGRID_FROM_EMAIL: undefined }).reason, SENDER_REASON.MISSING);
  assert.equal(resolveVerifiedSender({ SENDGRID_FROM_EMAIL: null }).reason, SENDER_REASON.MISSING);
});

test('空値 / 空白のみ → fail closed', () => {
  for (const v of ['', '   ', '\t\n']) {
    const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: v });
    assert.equal(r.ok, false, `空扱いにすべき: ${JSON.stringify(v)}`);
    assert.equal(r.reason, SENDER_REASON.EMPTY);
  }
});

test('非文字列は空扱いで fail closed（型で落ちない）', () => {
  for (const v of [123, {}, [], true]) {
    const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: v });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SENDER_REASON.EMPTY);
  }
});

test('reason に env の値を含めない（送信元漏洩の防止）', () => {
  const secretish = 'leaked-sender@evil.example';
  const r = resolveVerifiedSender({ SENDGRID_FROM_EMAIL: secretish });
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(secretish), 'reason / 戻り値に env の値が混入している');
  assert.ok(!serialized.includes('evil.example'), 'ドメインが混入している');
  // reason は固定のコード集合のみ
  assert.ok(Object.values(SENDER_REASON).includes(r.reason));
});

test('hasVerifiedSender は resolveVerifiedSender と一致する', () => {
  assert.equal(hasVerifiedSender({ SENDGRID_FROM_EMAIL: 'support@keiba.link' }), true);
  assert.equal(hasVerifiedSender({ SENDGRID_FROM_EMAIL: 'noreply@keiba.link' }), false);
  assert.equal(hasVerifiedSender({}), false);
});
