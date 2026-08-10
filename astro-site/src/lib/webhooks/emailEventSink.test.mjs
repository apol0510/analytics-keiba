import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_SINK, resolveEventSinkMode, writesAirtableEvents, writesBlobEvents, writesCounters,
  buildCounterKey, tallyEvents, writeEventBatch, COUNTER_NAMESPACE,
} from './emailEventSink.js';

const EV = (o = {}) => ({
  eventKey: 'k', eventType: 'delivered', campaignId: 'dormant-reactivation', campaignVersion: 2, ...o,
});

test('未設定・未知の値は airtable へ倒す', () => {
  assert.equal(resolveEventSinkMode({}), EVENT_SINK.AIRTABLE);
  assert.equal(resolveEventSinkMode({ MARKETING_EVENT_SINK: 'nope' }), EVENT_SINK.AIRTABLE);
  assert.equal(resolveEventSinkMode({ MARKETING_EVENT_SINK: 'BLOB' }), EVENT_SINK.BLOB);
});

test('モードごとの書き込み先', () => {
  assert.deepEqual(
    ['airtable', 'dual', 'blob'].map((m) => [writesAirtableEvents(m), writesBlobEvents(m), writesCounters(m)]),
    [[true, false, false], [true, true, true], [false, true, true]],
  );
});

test('カウンタキーは campaign×version のみ（PII を含まない）', () => {
  const k = buildCounterKey({ campaignId: 'dormant-reactivation', version: 2 });
  assert.equal(k, `${COUNTER_NAMESPACE}:dormant-reactivation:v2`);
  assert.doesNotMatch(k, /@/);
  assert.equal(buildCounterKey({ campaignId: 'x' }), `${COUNTER_NAMESPACE}:x:vunknown`);
  assert.throws(() => buildCounterKey({ campaignId: 'a b' }), /bad_campaign/);
});

test('tally は campaign×version×種別で数える', () => {
  const t = tallyEvents([
    EV(), EV(), EV({ eventType: 'open' }),
    EV({ campaignId: 'other', campaignVersion: 1, eventType: 'bounce' }),
  ]);
  assert.deepEqual(t[`${COUNTER_NAMESPACE}:dormant-reactivation:v2`], { delivered: 2, open: 1 });
  assert.deepEqual(t[`${COUNTER_NAMESPACE}:other:v1`], { bounce: 1 });
});

test('壊れた campaign 名は数えないが、他を落とさない', () => {
  const t = tallyEvents([EV({ campaignId: 'bad name' }), EV()]);
  assert.equal(Object.keys(t).length, 1);
});

test('dual は 3 か所すべてへ書く', async () => {
  const hit = [];
  const out = await writeEventBatch({
    mode: 'dual',
    events: [EV()],
    receivedAtMs: 1,
    writeAirtable: async () => hit.push('a'),
    writeBlob: async () => { hit.push('b'); return { key: 'ak/email-events/x.ndjson' }; },
    writeCounters: async () => hit.push('c'),
  });
  assert.deepEqual(hit, ['a', 'b', 'c']);
  assert.equal(out.airtable, 'ok');
  assert.equal(out.blob, 'ok');
  assert.equal(out.counters, 'ok');
  assert.equal(out.blobKey, 'ak/email-events/x.ndjson');
});

test('dual で Blob が落ちても Airtable が正本なので継続し、degraded に残す', async () => {
  const out = await writeEventBatch({
    mode: 'dual',
    events: [EV()],
    receivedAtMs: 1,
    writeAirtable: async () => {},
    writeBlob: async () => { throw new Error('blobs down'); },
    writeCounters: async () => {},
  });
  assert.equal(out.airtable, 'ok');
  assert.equal(out.blob, 'failed');
  assert.deepEqual(out.degraded, ['blob_unavailable']);
});

test('【fail closed】blob モードで Blob が落ちたら例外（provider に再送させる）', async () => {
  await assert.rejects(() => writeEventBatch({
    mode: 'blob',
    events: [EV()],
    receivedAtMs: 1,
    writeBlob: async () => { throw new Error('blobs down'); },
    writeCounters: async () => {},
  }), /blobs down/);
});

test('カウンタの失敗は致命にしない（Blob から数え直せる）', async () => {
  const out = await writeEventBatch({
    mode: 'blob',
    events: [EV()],
    receivedAtMs: 1,
    writeBlob: async () => ({ key: 'k' }),
    writeCounters: async () => { throw new Error('redis down'); },
  });
  assert.equal(out.blob, 'ok');
  assert.equal(out.counters, 'failed');
  assert.deepEqual(out.degraded, ['counters_unavailable']);
});

test('【致命】Airtable を書くモードでの Airtable 失敗は握り潰さない', async () => {
  await assert.rejects(() => writeEventBatch({
    mode: 'dual',
    events: [EV()],
    receivedAtMs: 1,
    writeAirtable: async () => { throw new Error('airtable down'); },
    writeBlob: async () => ({ key: 'k' }),
    writeCounters: async () => {},
  }), /airtable down/);
});

test('blob モードでは Airtable を触らない', async () => {
  let touched = false;
  const out = await writeEventBatch({
    mode: 'blob',
    events: [EV()],
    receivedAtMs: 1,
    writeAirtable: async () => { touched = true; },
    writeBlob: async () => ({ key: 'k' }),
    writeCounters: async () => {},
  });
  assert.equal(touched, false);
  assert.equal(out.airtable, 'skipped');
});

test('writer が無いまま書こうとしたら例外', async () => {
  await assert.rejects(() => writeEventBatch({ mode: 'dual', events: [EV()], receivedAtMs: 1 }),
    /airtable_writer_missing/);
});

// ── dual の実効性を観測できること（2026-08-10）─────────────────
import { readFileSync as _rf } from 'node:fs';
const WEBHOOK = _rf(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url), 'utf8');

test('guard: dual の結果を Redis カウンタへ残す（Blob へ書けていないのに気づけない事故を防ぐ）', () => {
  assert.match(WEBHOOK, /ak:mkt:events:sink/);
  assert.match(WEBHOOK, /HINCRBY/);
  assert.match(WEBHOOK, /'blob_' \+ sink\.blob/);
  assert.match(WEBHOOK, /last_degraded/);
});

test('guard: 観測用の書き込みが失敗しても webhook を落とさない', () => {
  const i = WEBHOOK.indexOf('ak:mkt:events:sink');
  const around = WEBHOOK.slice(Math.max(0, i - 900), i + 900);
  assert.match(around, /try \{/);
  assert.match(around, /\} catch \{/);
});

test('guard: webhook は Web 形式（Request）。Lambda 形式へ変えるなら connectLambda が要る', () => {
  // Web 形式では Blobs が自動設定される。Lambda 形式へ変えると
  // MissingBlobsEnvironmentError になり、dual では degraded で黙って落ちる。
  assert.match(WEBHOOK, /export default async \(req\)/);
  assert.equal(/export const handler = async \(event/.test(WEBHOOK), false);
});
