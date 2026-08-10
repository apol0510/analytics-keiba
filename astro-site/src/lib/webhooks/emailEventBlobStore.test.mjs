import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  BLOB_PREFIX, MAX_EVENTS_PER_BLOB, BLOB_EVENT_FIELDS,
  sanitizeEventForBlob, assertNoRawEmail, buildBatchBlobKey, buildNdjson,
  createEmailEventBlobStore, EmailEventBlobError,
} from './emailEventBlobStore.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const AT = Date.UTC(2026, 7, 9, 15, 31, 24); // 2026-08-09T15:31:24Z

const EVENT = {
  eventKey: 'sg:abc123',
  eventType: 'delivered',
  eventAtMs: AT,
  campaignId: 'dormant-reactivation',
  campaignVersion: 2,
  deliveryKey: 'a'.repeat(64),
  campaignDeliveryRecordId: 'recCD1',
  customerRecordId: 'recCU1',
  emailHash: 'deadbeef',
  providerEventId: 'abc123',
  providerMessageId: 'msg-1',
  resolutionStatus: 'resolved',
};

test('キーは日付階層 + 時刻 + 内容ハッシュで、バッチごとに固有', () => {
  const k = buildBatchBlobKey({ receivedAtMs: AT, batchHash: 'abcdef012345' });
  assert.equal(k, `${BLOB_PREFIX}/2026/08/09/153124-abcdef012345.ndjson`);
  assert.ok(k.startsWith('ak/'), 'AK 名前空間から外れている');
});

test('壊れた入力でキーを作らない', () => {
  assert.throws(() => buildBatchBlobKey({ receivedAtMs: 0, batchHash: 'abcdef01' }), EmailEventBlobError);
  assert.throws(() => buildBatchBlobKey({ receivedAtMs: AT, batchHash: 'xyz' }), EmailEventBlobError);
});

test('allow-list 外の項目は保存しない（生 payload を丸ごと置かない）', () => {
  const out = sanitizeEventForBlob({
    ...EVENT,
    email: 'someone@example.com',
    ip: '203.0.113.1',
    useragent: 'Mozilla/5.0',
    url: 'https://example.com/x?token=secret',
    sg_content_type: 'html',
  });
  for (const k of Object.keys(out)) {
    assert.ok(BLOB_EVENT_FIELDS.includes(k), `allow-list 外の ${k} が残っている`);
  }
  assert.equal(out.email, undefined);
  assert.equal(out.ip, undefined);
  assert.equal(out.url, undefined);
  assert.equal(out.useragent, undefined);
});

test('emailHash は残すが、生アドレスは残さない', () => {
  const out = sanitizeEventForBlob({ ...EVENT, email: 'a@b.com' });
  assert.equal(out.emailHash, 'deadbeef');
  assert.doesNotMatch(JSON.stringify(out), /@/);
});

test('理由文からアドレスを落とし、長さを切る', () => {
  const out = sanitizeEventForBlob({
    ...EVENT, eventType: 'bounce', reasonText: '550 5.1.1 user unknown someone@example.com not found',
  });
  assert.match(out.reasonText, /\[addr\]/);
  assert.doesNotMatch(out.reasonText, /@example/);
  const long = sanitizeEventForBlob({ ...EVENT, reasonText: 'x'.repeat(500) });
  assert.ok(long.reasonText.length <= 200);
});

test('eventKey / eventType が無ければ書かない', () => {
  assert.throws(() => sanitizeEventForBlob({ ...EVENT, eventKey: '' }), /missing_event_key/);
  assert.throws(() => sanitizeEventForBlob({ ...EVENT, eventType: '' }), /missing_event_type/);
});

test('最終防壁: 生アドレスが混ざっていたら書かせない', () => {
  assert.throws(() => assertNoRawEmail([{ reasonText: 'to a@b.com' }]), /raw_email_in:reasonText/);
  assert.doesNotThrow(() => assertNoRawEmail([sanitizeEventForBlob(EVENT)]));
});

test('NDJSON は 1 行 1 イベント', () => {
  const body = buildNdjson([{ a: 1 }, { b: 2 }]);
  assert.equal(body.split('\n').length, 2);
  assert.deepEqual(JSON.parse(body.split('\n')[1]), { b: 2 });
});

// ── multi-writer 事故を作らない ────────────────────────────────
test('【重要】書き込みは set のみ。get / list を呼ばない（read-modify-write しない）', async () => {
  const calls = [];
  const store = createEmailEventBlobStore({
    setBlob: async (k, b) => { calls.push(['set', k, b.length]); },
    hashFn: sha,
  });
  await store.writeBatch({ events: [EVENT], receivedAtMs: AT });
  assert.deepEqual(calls.map((c) => c[0]), ['set']);
});

test('同じ内容のバッチは同じキー（再送で行が増えない＝冪等）', async () => {
  const keys = [];
  const store = createEmailEventBlobStore({
    setBlob: async (k) => { keys.push(k); }, hashFn: sha,
  });
  await store.writeBatch({ events: [EVENT], receivedAtMs: AT });
  await store.writeBatch({ events: [EVENT], receivedAtMs: AT });
  assert.equal(keys[0], keys[1], '同一バッチで別キーになっている');
});

test('内容が違えばキーも違う（別バッチが同じキーへ衝突しない）', async () => {
  const keys = [];
  const store = createEmailEventBlobStore({
    setBlob: async (k) => { keys.push(k); }, hashFn: sha,
  });
  await store.writeBatch({ events: [EVENT], receivedAtMs: AT });
  await store.writeBatch({ events: [{ ...EVENT, eventKey: 'sg:zzz' }], receivedAtMs: AT });
  assert.notEqual(keys[0], keys[1]);
});

test('空バッチは何も書かない', async () => {
  let called = false;
  const store = createEmailEventBlobStore({ setBlob: async () => { called = true; }, hashFn: sha });
  const r = await store.writeBatch({ events: [], receivedAtMs: AT });
  assert.deepEqual(r, { key: null, written: 0 });
  assert.equal(called, false);
});

test('大きすぎるバッチは拒否（分割は呼び出し側の責務）', async () => {
  const store = createEmailEventBlobStore({ setBlob: async () => {}, hashFn: sha });
  const many = Array.from({ length: MAX_EVENTS_PER_BLOB + 1 }, (_, i) => ({ ...EVENT, eventKey: `k${i}` }));
  await assert.rejects(() => store.writeBatch({ events: many, receivedAtMs: AT }), /batch_too_large/);
});

test('【fail closed】Blob 書き込みの失敗を握り潰さない', async () => {
  const store = createEmailEventBlobStore({
    setBlob: async () => { throw new Error('blobs down'); }, hashFn: sha,
  });
  await assert.rejects(() => store.writeBatch({ events: [EVENT], receivedAtMs: AT }), /blobs down/);
});

test('依存が無ければ store を作らない（暗黙の no-op を作らない）', () => {
  assert.throws(() => createEmailEventBlobStore({}), /blob_not_configured/);
  assert.throws(() => createEmailEventBlobStore({ setBlob: async () => {} }), /hash_not_configured/);
});

// ── 回帰ガード ─────────────────────────────────────────────────
test('guard: blob を読んで書き戻す実装へ戻さない', () => {
  // コメントは対象外。**実コード**だけを見る（説明文の「manifest」に反応させない）
  const code = readFileSync(new URL('./emailEventBlobStore.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const forbidden of ['getBlob', 'getWithMetadata', '.list(', 'readBlob', 'manifest']) {
    assert.equal(code.includes(forbidden), false,
      `${forbidden} が入っている（Premium Plus と同じ read-modify-write 競合になる）`);
  }
  // 依存として受け取ってよいのは書き込み関数だけ
  assert.match(code, /createEmailEventBlobStore\(\{ setBlob, hashFn \} = \{\}\)/);
});
