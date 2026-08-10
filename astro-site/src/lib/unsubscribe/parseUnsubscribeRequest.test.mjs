import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REQUEST_KIND, mediaType, parseUnsubscribeRequest, statusForResult,
} from './parseUnsubscribeRequest.js';

const Q = { email: 'user@example.com', brand: 'analytics-keiba' };

test('mediaType は charset を落とす', () => {
  assert.equal(mediaType('application/json; charset=utf-8'), 'application/json');
  assert.equal(mediaType('APPLICATION/JSON'), 'application/json');
  assert.equal(mediaType(undefined), '');
});

// ── RFC 8058 ワンクリック ───────────────────────────────────────
test('【本件】Gmail のワンクリックを受理する（従来は 400 で全部落ちていた）', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/x-www-form-urlencoded',
    rawBody: 'List-Unsubscribe=One-Click',
    query: Q,
  });
  assert.equal(r.kind, REQUEST_KIND.ONE_CLICK);
  assert.equal(r.email, Q.email);
  assert.equal(r.brand, Q.brand);
  assert.equal(r.action, 'unsubscribe');
  assert.equal(statusForResult({ kind: r.kind, ok: true }), 200);
});

test('charset 付き・大文字小文字違いでも受理する', () => {
  for (const [ct, body] of [
    ['application/x-www-form-urlencoded; charset=UTF-8', 'List-Unsubscribe=One-Click'],
    ['Application/X-WWW-Form-Urlencoded', 'list-unsubscribe=one-click'],
  ]) {
    const r = parseUnsubscribeRequest({ contentType: ct, rawBody: body, query: Q });
    assert.equal(r.kind, REQUEST_KIND.ONE_CLICK, `${ct} を弾いている`);
  }
});

test('【重要】宛先は URL から取る。body のアドレスを宛先にしない', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/x-www-form-urlencoded',
    rawBody: 'List-Unsubscribe=One-Click&email=victim@example.com',
    query: Q,
  });
  assert.equal(r.email, Q.email, 'body の email を採用している（第三者を止められてしまう）');
});

test('ワンクリックで resubscribe はできない（配信停止専用）', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/x-www-form-urlencoded',
    rawBody: 'List-Unsubscribe=One-Click&action=resubscribe',
    query: Q,
  });
  assert.equal(r.action, 'unsubscribe');
});

test('One-Click の合図が無い form は受理しない', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/x-www-form-urlencoded',
    rawBody: 'foo=bar',
    query: Q,
  });
  assert.equal(r.kind, REQUEST_KIND.INVALID);
  assert.equal(r.reason, 'not-one-click');
});

// ── 既存 JSON 経路を壊さない ────────────────────────────────────
test('確認ページからの JSON POST は従来どおり', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/json',
    rawBody: JSON.stringify({ email: 'a@b.com', brand: 'analytics-keiba' }),
    query: {},
  });
  assert.equal(r.kind, REQUEST_KIND.JSON_API);
  assert.equal(r.email, 'a@b.com');
  assert.equal(r.action, 'unsubscribe');
});

test('JSON の resubscribe は従来どおり通る', () => {
  const r = parseUnsubscribeRequest({
    contentType: 'application/json',
    rawBody: JSON.stringify({ email: 'a@b.com', brand: 'analytics-keiba', action: 'resubscribe' }),
    query: {},
  });
  assert.equal(r.action, 'resubscribe');
});

test('Content-Type 未指定でも JSON として解釈する（従来互換）', () => {
  const r = parseUnsubscribeRequest({
    contentType: undefined,
    rawBody: JSON.stringify({ email: 'a@b.com', brand: 'analytics-keiba' }),
    query: {},
  });
  assert.equal(r.kind, REQUEST_KIND.JSON_API);
});

test('壊れた JSON は従来どおり invalid', () => {
  const r = parseUnsubscribeRequest({ contentType: 'application/json', rawBody: '{oops', query: {} });
  assert.equal(r.kind, REQUEST_KIND.INVALID);
  assert.equal(r.reason, 'invalid-json-body');
});

test('JSON に無ければ URL の値で補う', () => {
  const r = parseUnsubscribeRequest({ contentType: 'application/json', rawBody: '{}', query: Q });
  assert.equal(r.email, Q.email);
  assert.equal(r.brand, Q.brand);
});

test('未対応 Content-Type は弾く', () => {
  const r = parseUnsubscribeRequest({ contentType: 'application/xml', rawBody: '<x/>', query: Q });
  assert.equal(r.kind, REQUEST_KIND.INVALID);
  assert.equal(r.reason, 'unsupported-content-type');
});

// ── status の決め方 ─────────────────────────────────────────────
test('ワンクリックは「登録が無い」でも 2xx（クライアントが失敗扱いしない・存在を漏らさない）', () => {
  assert.equal(statusForResult({ kind: REQUEST_KIND.ONE_CLICK, ok: false, reason: 'email-not-found' }), 200);
  assert.equal(statusForResult({ kind: REQUEST_KIND.JSON_API, ok: false, reason: 'email-not-found' }), 404);
});

test('【重要】構成不備・Airtable 障害は 2xx にしない（握り潰すと直す機会を失う）', () => {
  for (const kind of [REQUEST_KIND.ONE_CLICK, REQUEST_KIND.JSON_API]) {
    assert.equal(statusForResult({ kind, ok: false, reason: 'missing-env' }), 503);
    assert.equal(statusForResult({ kind, ok: false, reason: 'airtable-patch-failed' }), 502);
    assert.equal(statusForResult({ kind, ok: false, reason: 'invalid-email' }), 400);
    assert.equal(statusForResult({ kind, ok: false, reason: 'unknown-brand' }), 400);
  }
});

// ── 回帰ガード ─────────────────────────────────────────────────
const FN = readFileSync(new URL('../../../netlify/functions/unsubscribe.js', import.meta.url), 'utf8');

test('guard: handler が body を無条件 JSON.parse する実装へ戻らない', () => {
  assert.doesNotMatch(FN, /JSON\.parse\(await request\.text\(\)\)/,
    'Content-Type を見ずに JSON 固定へ戻っている（ワンクリックが全部 400 になる）');
  assert.match(FN, /parseUnsubscribeRequest\(\{/);
  assert.match(FN, /contentType: request\.headers\.get\('content-type'\)/);
});

test('guard: ワンクリックの status 判定を単一源に委ねる', () => {
  assert.match(FN, /statusForResult\(\{ kind: parsed\.kind, ok: false, reason: result\.reason \}\)/);
});

test('guard: ログに email をそのまま出さない（trace のみ）', () => {
  const logs = FN.split('\n').filter((l) => /console\.(log|warn|error)/.test(l));
  for (const l of logs) {
    assert.equal(/\$\{(postEmail|email|normEmail)\}/.test(l), false, `ログに生アドレス: ${l.trim().slice(0, 80)}`);
  }
});

test('guard: 送信側が RFC 8058 ヘッダを出し続ける（片方だけ消さない）', () => {
  const dispatch = readFileSync(
    new URL('../../../netlify/functions/marketing-campaign-dispatch.js', import.meta.url), 'utf8',
  );
  assert.match(dispatch, /'List-Unsubscribe':/);
  assert.match(dispatch, /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/);
});
