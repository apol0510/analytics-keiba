/**
 * magicLinkSingleActiveToken.test.mjs — 有効なマジックリンクを常に 1 本に保つ
 *   node --test src/lib/auth/magicLinkSingleActiveToken.test.mjs
 *
 * 2026-08-09: TTL を 15 → 60 分へ延ばしたため、未無効化のままだと
 * 露出面が「本数 × 60 分」に広がる。1 本に限定して「1 × 60 分」に抑える。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  selectTokensToInvalidate, chunkForUpdate, SWEEP_MAX_RECORDS,
} from './magicLinkTokenSweep.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
const iso = (min) => new Date(NOW + min * 60000).toISOString();
const rec = (id, over = {}) => ({
  id, fields: { Email: 'a@example.com', Used: false, ExpiresAt: iso(60), ...over },
});

// ── 1. 基本 ──────────────────────────────────────────────────
test('自分以外の未使用・未期限トークンだけを無効化する', () => {
  const r = selectTokensToInvalidate({
    records: [rec('old1'), rec('old2'), rec('new')],
    keepTokenId: 'new', nowMs: NOW,
  });
  assert.deepEqual(r.ids.sort(), ['old1', 'old2']);
  assert.equal(r.skipped.self, 1);
});

test('使用済みトークンは壊さない', () => {
  const r = selectTokensToInvalidate({
    records: [rec('used', { Used: true }), rec('new')], keepTokenId: 'new', nowMs: NOW,
  });
  assert.deepEqual(r.ids, []);
  assert.equal(r.skipped.used, 1);
});

test('期限切れトークンは壊さない（既に無効）', () => {
  const r = selectTokensToInvalidate({
    records: [rec('exp', { ExpiresAt: iso(-1) }), rec('new')], keepTokenId: 'new', nowMs: NOW,
  });
  assert.deepEqual(r.ids, []);
  assert.equal(r.skipped.expired, 1);
});

test('期限が読めないトークンは無効化する（fail closed）', () => {
  const r = selectTokensToInvalidate({
    records: [rec('bad', { ExpiresAt: 'not-a-date' }), rec('new')], keepTokenId: 'new', nowMs: NOW,
  });
  assert.deepEqual(r.ids, ['bad']);
});

test('新トークンを取り違えて消さない（keepTokenId 必須）', () => {
  const r = selectTokensToInvalidate({ records: [rec('new')], keepTokenId: 'new', nowMs: NOW });
  assert.deepEqual(r.ids, [], '自分自身を消そうとしている');
});

test('keepTokenId が空でも既存を全部消しはしない範囲に収まる', () => {
  const r = selectTokensToInvalidate({
    records: [rec('a'), rec('b')], keepTokenId: '', nowMs: NOW,
  });
  // 発行に失敗して id が取れなかった場合。古いものは消えるが、新しいリンクは
  // メールで既に配られているため、ここで消えるのは「古い方」だけ
  assert.deepEqual(r.ids.sort(), ['a', 'b']);
});

test('1 回の掃除で触る件数に上限がある', () => {
  const many = Array.from({ length: 200 }, (_, i) => rec(`t${i}`));
  const r = selectTokensToInvalidate({ records: many, keepTokenId: 'none', nowMs: NOW });
  assert.equal(r.ids.length, SWEEP_MAX_RECORDS);
});

// ── 2. 同一 Customer で 2 回連続発行 ──────────────────────────
test('2 回連続発行すると、旧トークンが無効・新トークンだけ有効になる', () => {
  // 1 回目
  let store = [rec('T1')];
  let r = selectTokensToInvalidate({ records: store, keepTokenId: 'T1', nowMs: NOW });
  assert.deepEqual(r.ids, [], '1 本目で何かを消している');

  // 2 回目（T2 を作ってから掃除）
  store = [rec('T1'), rec('T2')];
  r = selectTokensToInvalidate({ records: store, keepTokenId: 'T2', nowMs: NOW });
  assert.deepEqual(r.ids, ['T1']);

  const active = store.filter((x) => !r.ids.includes(x.id));
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'T2');
});

// ── 3. 同時発行（競合）─────────────────────────────────────
test('同時に 2 本発行されても、最終的に有効なのは 1 本だけ', () => {
  // A と B が両方 create を終えた状態から、それぞれが掃除する
  const store = [rec('TA'), rec('TB')];
  const invalid = new Set();

  // A の掃除（自分 TA を残す）→ TB を無効化
  for (const id of selectTokensToInvalidate({
    records: store.filter((x) => !invalid.has(x.id)), keepTokenId: 'TA', nowMs: NOW,
  }).ids) invalid.add(id);

  // B の掃除（自分 TB を残す）→ TA を無効化
  for (const id of selectTokensToInvalidate({
    records: store.map((x) => (invalid.has(x.id) ? { ...x, fields: { ...x.fields, Used: true } } : x)),
    keepTokenId: 'TB', nowMs: NOW,
  }).ids) invalid.add(id);

  const active = store.filter((x) => !invalid.has(x.id));
  assert.ok(active.length <= 1, `有効トークンが ${active.length} 本残った`);
});

test('掃除が後勝ちで収束する（順序が逆でも 1 本以下）', () => {
  for (const order of [['TA', 'TB'], ['TB', 'TA']]) {
    const store = [rec('TA'), rec('TB')];
    const invalid = new Set();
    for (const keep of order) {
      const live = store.map((x) => (invalid.has(x.id)
        ? { ...x, fields: { ...x.fields, Used: true } } : x));
      for (const id of selectTokensToInvalidate({ records: live, keepTokenId: keep, nowMs: NOW }).ids) {
        invalid.add(id);
      }
    }
    assert.ok(store.filter((x) => !invalid.has(x.id)).length <= 1, `order=${order}`);
  }
});

// ── 4. update の分割 ────────────────────────────────────────
test('update は 10 件ずつに割る（Airtable の上限）', () => {
  const ids = Array.from({ length: 23 }, (_, i) => `x${i}`);
  const b = chunkForUpdate(ids);
  assert.deepEqual(b.map((x) => x.length), [10, 10, 3]);
});

// ── 5. Function 側の配線と PII ──────────────────────────────
const SENDER = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/send-magic-link.js', import.meta.url)), 'utf8');

test('create の後に掃除する（前に掃除しない）', () => {
  const c = SENDER.indexOf('authTokensTable.create(');
  const s = SENDER.indexOf('await sweepOldTokens({');   // 定義ではなく**呼び出し**を見る
  assert.ok(c > -1, 'create が見つからない');
  assert.ok(s > -1, 'sweepOldTokens の呼び出しが無い');
  assert.ok(s > c, 'create より前に掃除している（2 本残りうる）');
});

test('掃除は新トークンを keepTokenId で除外する', () => {
  assert.match(SENDER, /keepTokenId:\s*newTokenId/);
});

test('掃除は使用済みを対象にしない（filterByFormula で NOT(Used)）', () => {
  assert.match(SENDER, /NOT\(\{Used\}\)/);
});

test('send-magic-link はメールアドレス・トークンをログに出さない', () => {
  const logs = SENDER.match(/console\.(log|warn|error)\([^\n]*/g) || [];
  for (const l of logs) {
    assert.ok(!/\$\{email\}/.test(l), `email をログしている: ${l}`);
    assert.ok(!/tokenPrefix/.test(l), `token 断片をログしている: ${l}`);
    assert.ok(!/\$\{token\b/.test(l), `token をログしている: ${l}`);
  }
});

test('掃除の失敗でログイン送信を止めない（best-effort）', () => {
  const i = SENDER.indexOf('async function sweepOldTokens');
  const body = SENDER.slice(i, i + 1600);
  assert.match(body, /try\s*\{/);
  assert.match(body, /\}\s*catch/);
});
