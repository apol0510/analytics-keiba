/**
 * unsubscribeSignature.test.mjs — 配信停止 URL の改ざん防止を固定する。
 *   node --test src/lib/unsubscribe/unsubscribeSignature.test.mjs
 *
 * 完成条件 10「不正リクエストで他人を unsubscribe できない」の本体。
 * 旧実装は `?email=` をそのまま信頼していたため、第三者が email を書き換えて
 * RFC 8058 の POST を投げるだけで他人を配信停止できた（2026-09-16 MK 指摘）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveUnsubscribeSigningKeys, signUnsubscribe, verifyUnsubscribeSignature,
  decideSignatureAcceptance, isLegacyUnsignedAllowed, canonicalUnsubscribePayload,
  SIGNATURE_CHECK, SIGNATURE_HEX_LENGTH, DERIVED_KEY_LABEL,
} from './unsubscribeSignature.js';
import { buildUnsubscribeUrl } from './listUnsubscribeHeaders.js';
import { parseUnsubscribeRequest, statusForResult, REQUEST_KIND } from './parseUnsubscribeRequest.js';

const ENV = { PROMO_OFFER_SECRET: 'p'.repeat(32) };
const KEYS = resolveUnsubscribeSigningKeys(ENV);
const EMAIL = 'owner@example.test';
const BRAND = 'analytics-keiba';
const SIG = signUnsubscribe({ email: EMAIL, brand: BRAND, key: KEYS.signing });

const accept = (sig, { email = EMAIL, brand = BRAND, allowUnsigned = false } = {}) =>
  decideSignatureAcceptance({
    check: verifyUnsubscribeSignature({ email, brand, sig, keys: KEYS.accept }),
    allowUnsigned,
  });

// ── 鍵 ──────────────────────────────────────────────────────────

test('既存の PROMO_OFFER_SECRET から用途分離した鍵を derive する（新 env を増やさない）', () => {
  assert.equal(KEYS.accept.length, 1);
  assert.notEqual(KEYS.signing, ENV.PROMO_OFFER_SECRET, '元の secret をそのまま鍵にしている（用途分離なし）');
  assert.match(DERIVED_KEY_LABEL, /unsubscribe/, '派生ラベルが用途を表していない');
});

test('専用鍵があればそちらで署名し、派生鍵の署名も検証は通る（鍵入れ替えでリンクを壊さない）', () => {
  const both = resolveUnsubscribeSigningKeys({ ...ENV, UNSUBSCRIBE_LINK_SECRET: 'd'.repeat(32) });
  assert.equal(both.accept.length, 2);
  assert.equal(both.signing, 'd'.repeat(32), '専用鍵を優先していない');
  const r = verifyUnsubscribeSignature({ email: EMAIL, brand: BRAND, sig: SIG, keys: both.accept });
  assert.equal(r, SIGNATURE_CHECK.VALID, '派生鍵で署名した既存リンクが無効になる');
});

test('短すぎる secret は鍵にしない', () => {
  assert.deepEqual(resolveUnsubscribeSigningKeys({ PROMO_OFFER_SECRET: 'short' }).accept, []);
  assert.equal(resolveUnsubscribeSigningKeys({}).signing, null);
});

// ── 必須ケース ──────────────────────────────────────────────────

test('正しい URL + 正しい署名 → 受理', () => {
  assert.equal(SIG.length, SIGNATURE_HEX_LENGTH);
  assert.deepEqual(accept(SIG), { ok: true, reason: null });
});

test('【本件】email を書き換える → 拒否（書き込みへ到達しない）', () => {
  const r = accept(SIG, { email: 'victim@example.test' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-invalid');
});

test('【本件】brand を書き換える → 拒否', () => {
  const r = accept(SIG, { brand: 'keiba-intelligence' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-invalid');
});

test('sig 欠落 → 拒否（既定は strict）', () => {
  for (const missing of [null, undefined, '', '   ']) {
    const r = accept(missing);
    assert.equal(r.ok, false, `${JSON.stringify(missing)} を通している`);
    assert.equal(r.reason, 'signature-required');
  }
});

test('sig 改ざん → 拒否（長さ違い・1 文字違いとも）', () => {
  const flipped = (SIG[0] === 'a' ? 'b' : 'a') + SIG.slice(1);
  assert.equal(accept(flipped).reason, 'signature-invalid');
  assert.equal(accept(SIG.slice(0, -1)).reason, 'signature-invalid');
  assert.equal(accept(`${SIG}00`).reason, 'signature-invalid');
});

test('鍵が 1 本も無い環境では受理しない（改ざんを通すより止める）', () => {
  const r = decideSignatureAcceptance({
    check: verifyUnsubscribeSignature({ email: EMAIL, brand: BRAND, sig: SIG, keys: [] }),
    allowUnsigned: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-key-missing');
});

// ── 既送信メールの救済（既定 OFF）────────────────────────────────

test('救済スイッチは既定 OFF', () => {
  assert.equal(isLegacyUnsignedAllowed({}), false);
  assert.equal(isLegacyUnsignedAllowed({ UNSUBSCRIBE_ALLOW_UNSIGNED: '0' }), false);
  assert.equal(isLegacyUnsignedAllowed({ UNSUBSCRIBE_ALLOW_UNSIGNED: '1' }), true);
});

test('救済スイッチを開けても「改ざんされた署名」は通さない', () => {
  const r = accept('deadbeef'.repeat(4), { allowUnsigned: true });
  assert.equal(r.ok, false, '改ざんが通っている');
  assert.equal(r.reason, 'signature-invalid');
});

// ── URL 生成と突き合わせ ────────────────────────────────────────

test('生成した URL の署名がそのまま検証を通る', () => {
  const url = buildUnsubscribeUrl({ email: EMAIL, brand: BRAND, env: ENV });
  const q = new URL(url).searchParams;
  assert.equal(q.get('email'), EMAIL);
  assert.equal(q.get('brand'), BRAND);
  assert.deepEqual(accept(q.get('sig')), { ok: true, reason: null });
});

test('別受信者の URL の署名を使い回せない', () => {
  const mine = new URL(buildUnsubscribeUrl({ email: EMAIL, brand: BRAND, env: ENV })).searchParams;
  const r = accept(mine.get('sig'), { email: 'other@example.test' });
  assert.equal(r.ok, false);
});

test('鍵が無い環境では署名なしの URL になる（生成で落ちない）', () => {
  const url = buildUnsubscribeUrl({ email: EMAIL, brand: BRAND, env: {} });
  assert.ok(!/[?&]sig=/.test(url));
});

test('署名対象の正規化は大文字小文字・空白を吸収する', () => {
  assert.equal(
    canonicalUnsubscribePayload({ email: '  Owner@Example.TEST ', brand: ' Analytics-Keiba ' }),
    canonicalUnsubscribePayload({ email: EMAIL, brand: BRAND }),
  );
});

// ── ワンクリック body との関係 ──────────────────────────────────

test('【本件】one-click body に別 email を入れても対象は変わらない', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/x-www-form-urlencoded',
    rawBody: 'List-Unsubscribe=One-Click&email=victim@example.test&sig=forged',
    query: { email: EMAIL, brand: BRAND, sig: SIG },
  });
  assert.equal(r.email, EMAIL, 'body の email を宛先にしている');
  assert.equal(r.sig, SIG, 'body の sig を採用している');
  assert.deepEqual(accept(r.sig, { email: r.email, brand: r.brand }), { ok: true, reason: null });
});

test('署名エラーはワンクリックでも 2xx にしない', () => {
  for (const reason of ['signature-required', 'signature-invalid']) {
    assert.equal(statusForResult({ kind: REQUEST_KIND.ONE_CLICK, ok: false, reason }), 400);
    assert.equal(statusForResult({ kind: REQUEST_KIND.JSON_API, ok: false, reason }), 400);
  }
  assert.equal(statusForResult({ kind: REQUEST_KIND.ONE_CLICK, ok: false, reason: 'signature-key-missing' }), 503);
});
