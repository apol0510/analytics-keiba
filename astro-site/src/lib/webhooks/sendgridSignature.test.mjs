/**
 * sendgridSignature.test.mjs — SendGrid Event Webhook 署名検証の単体テスト。
 *
 * 実際に ECDSA P-256 の鍵ペアを生成し、SendGrid と同じ手順
 * （署名対象 = timestamp + rawBody / base64 DER 署名 / base64 SPKI 公開鍵）で
 * 署名を作って検証する。**鍵未設定が「素通り」にならないこと**が最重要。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifySendgridEventWebhookSignature,
  verifyTimestamp,
  parseVerificationKey,
  signatureFailureStatus,
  SIGNATURE_REASON,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DEFAULT_MAX_SKEW_SEC,
} from './sendgridSignature.js';

const NOW_MS = 1_770_000_000_000; // 固定時刻（テストを時計に依存させない）
const TS = String(Math.floor(NOW_MS / 1000));
const BODY = JSON.stringify([{ event: 'bounce', email: 'x@example.test', reason: 'invalid' }]);

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKeyBase64 };
}

function sign(privateKey, timestamp, rawBody) {
  const signer = crypto.createSign('SHA256');
  signer.update(timestamp + rawBody);
  signer.end();
  return signer.sign(privateKey).toString('base64');
}

test('正しい署名は ok=true', () => {
  const { privateKey, publicKeyBase64 } = makeKeyPair();
  const signatureBase64 = sign(privateKey, TS, BODY);

  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64, timestamp: TS, rawBody: BODY, nowMs: NOW_MS,
  });
  assert.deepEqual(r, { ok: true });
});

test('検証鍵が未設定なら拒否（素通りさせない）', () => {
  const { privateKey } = makeKeyPair();
  const signatureBase64 = sign(privateKey, TS, BODY);

  for (const key of [undefined, null, '', '   ']) {
    const r = verifySendgridEventWebhookSignature({
      publicKeyBase64: key, signatureBase64, timestamp: TS, rawBody: BODY, nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SIGNATURE_REASON.KEY_MISSING);
  }
});

test('body を改竄すると署名不一致', () => {
  const { privateKey, publicKeyBase64 } = makeKeyPair();
  const signatureBase64 = sign(privateKey, TS, BODY);

  const tampered = JSON.stringify([{ event: 'bounce', email: 'victim@example.test', reason: 'invalid' }]);
  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64, timestamp: TS, rawBody: tampered, nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.SIGNATURE_MISMATCH);
});

test('別の鍵で署名されたリクエスト（spoof）は拒否', () => {
  const victim = makeKeyPair();
  const attacker = makeKeyPair();
  const signatureBase64 = sign(attacker.privateKey, TS, BODY);

  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64: victim.publicKeyBase64, signatureBase64, timestamp: TS, rawBody: BODY, nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.SIGNATURE_MISMATCH);
});

test('timestamp を差し替えると署名不一致（timestamp も署名対象）', () => {
  const { privateKey, publicKeyBase64 } = makeKeyPair();
  const signatureBase64 = sign(privateKey, TS, BODY);
  const shifted = String(Number(TS) + 1);

  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64, timestamp: shifted, rawBody: BODY, nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.SIGNATURE_MISMATCH);
});

test('署名が無い / timestamp が無い場合は拒否', () => {
  const { privateKey, publicKeyBase64 } = makeKeyPair();
  const signatureBase64 = sign(privateKey, TS, BODY);

  const noSig = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64: null, timestamp: TS, rawBody: BODY, nowMs: NOW_MS,
  });
  assert.equal(noSig.reason, SIGNATURE_REASON.SIGNATURE_MISSING);

  const noTs = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64, timestamp: null, rawBody: BODY, nowMs: NOW_MS,
  });
  assert.equal(noTs.reason, SIGNATURE_REASON.TIMESTAMP_MISSING);
});

test('古い timestamp（リプレイ）は許容窓の外で拒否', () => {
  const { privateKey, publicKeyBase64 } = makeKeyPair();
  const oldTs = String(Math.floor(NOW_MS / 1000) - (DEFAULT_MAX_SKEW_SEC + 60));
  const signatureBase64 = sign(privateKey, oldTs, BODY);

  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64, timestamp: oldTs, rawBody: BODY, nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.TIMESTAMP_SKEW);
});

test('未来の timestamp も許容窓の外なら拒否', () => {
  const r = verifyTimestamp({
    timestamp: String(Math.floor(NOW_MS / 1000) + DEFAULT_MAX_SKEW_SEC + 60), nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.TIMESTAMP_SKEW);
});

test('timestamp が数値でない場合は拒否', () => {
  const r = verifyTimestamp({ timestamp: 'not-a-number', nowMs: NOW_MS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.TIMESTAMP_INVALID);
});

test('壊れた検証鍵は KEY_INVALID（例外を投げない）', () => {
  const r = parseVerificationKey('!!!not-base64-spki!!!');
  assert.equal(r.ok, false);
  assert.equal(r.reason, SIGNATURE_REASON.KEY_INVALID);
});

test('壊れた署名（不正 DER）でも例外を投げず拒否する', () => {
  const { publicKeyBase64 } = makeKeyPair();
  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64,
    signatureBase64: Buffer.from('garbage-not-der').toString('base64'),
    timestamp: TS,
    rawBody: BODY,
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.ok([SIGNATURE_REASON.SIGNATURE_MISMATCH, SIGNATURE_REASON.VERIFY_ERROR].includes(r.reason));
});

test('失敗理由に鍵・署名・timestamp の値そのものを含めない', () => {
  const { privateKey, publicKeyBase64 } = makeKeyPair();
  const signatureBase64 = sign(privateKey, TS, BODY);
  const r = verifySendgridEventWebhookSignature({
    publicKeyBase64, signatureBase64, timestamp: TS, rawBody: 'tampered', nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  const reason = String(r.reason);
  assert.ok(!reason.includes(publicKeyBase64));
  assert.ok(!reason.includes(signatureBase64));
  assert.ok(!reason.includes(TS));
  assert.ok(Object.values(SIGNATURE_REASON).includes(reason), 'reason は固定コードのみ');
});

test('検証失敗は常に 403（設定不備を 500 にしない）', () => {
  assert.equal(signatureFailureStatus(), 403);
});

test('ヘッダ名は SendGrid 仕様の小文字固定', () => {
  assert.equal(SIGNATURE_HEADER, 'x-twilio-email-event-webhook-signature');
  assert.equal(TIMESTAMP_HEADER, 'x-twilio-email-event-webhook-timestamp');
});
