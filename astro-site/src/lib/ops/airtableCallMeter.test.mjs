import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  isAirtableApiUrl, countAirtableCalls, installAirtableCallMeter, jstDay, METER_KEY_PREFIX, projectMonthly,
} from './airtableCallMeter.js';
import { evaluateApiUsage, evaluateRecords } from './airtableCapacityWatch.js';

test('Airtable の API URL だけを数える', () => {
  assert.equal(isAirtableApiUrl('https://api.airtable.com/v0/app/Customers'), true);
  assert.equal(isAirtableApiUrl(new URL('https://api.airtable.com/v0/meta/bases/x/tables')), true);
  assert.equal(isAirtableApiUrl('https://api.sendgrid.com/v3/mail/send'), false);
  assert.equal(isAirtableApiUrl('https://example.com/?u=https://api.airtable.com/'), false);
});

test('数える: Redis の日別 HASH に呼び出し元ごとに足す（回数だけ・URL は送らない）', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 't' };
  const nowMs = Date.parse('2026-10-05T15:30:00Z'); // JST 10/6 00:30
  assert.equal(await countAirtableCalls('cron-x', 3, { env, fetchImpl, nowMs }), true);
  assert.equal(sent[0].url, 'https://redis.example/pipeline');
  assert.deepEqual(sent[0].body[0], ['HINCRBY', `${METER_KEY_PREFIX}2026-10-06`, 'cron-x', '3']);
  assert.equal(jstDay(nowMs), '2026-10-06');
  // Redis 未設定・失敗は false（本処理を止めない）
  assert.equal(await countAirtableCalls('cron-x', 1, { env: {}, fetchImpl }), false);
  assert.equal(await countAirtableCalls('cron-x', 1, { env, fetchImpl: async () => { throw new Error('x'); } }), false);
});

test('fetch を包んでも本体の応答・例外はそのまま返る', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).includes('boom')) throw new Error('boom'); return { ok: true, url: String(url) }; };
  try {
    const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 't' };
    assert.equal(installAirtableCallMeter({ source: 's', env }), true);
    assert.equal(installAirtableCallMeter({ source: 's', env }), false, '2 回目は包まない');
    const r = await globalThis.fetch('https://api.airtable.com/v0/a/b');
    assert.equal(r.url, 'https://api.airtable.com/v0/a/b');
    await globalThis.fetch('https://other.example/');
    await assert.rejects(globalThis.fetch('https://api.airtable.com/boom'));
    assert.equal(calls.filter((u) => u === 'https://redis.example/pipeline').length, 2, 'Airtable の 2 回だけ数える');
  } finally {
    globalThis.fetch = orig;
    delete globalThis[Symbol.for('ak.airtableCallMeter.installed')];
  }
});

test('月の見込み', () => {
  assert.equal(projectMonthly([{ total: 1000 }, { total: 3000 }]), 60000);
  assert.equal(projectMonthly([]), null);
});

test('見張り: API は月末見込み 90,000 回超で失敗、レコードは 45,000 件超で失敗', () => {
  const now = new Date('2026-10-10T03:00:00Z'); // JST 10/10
  const days = [{ day: '2026-10-10', total: 500, bySource: {} }];
  for (let i = 1; i <= 9; i += 1) days.push({ day: `2026-10-${String(10 - i).padStart(2, '0')}`, total: 2000, bySource: { a: 1500, b: 500 } });
  const ok = evaluateApiUsage(days, { now });
  assert.equal(ok.monthToDate, 18500);
  assert.equal(ok.avg7, 2000);
  assert.equal(ok.projected, 18500 + 1500 + 2000 * 21);
  assert.equal(ok.level, 'ok');
  assert.equal(ok.topSources[0].source, 'a');
  const hot = days.map((d, i) => (i === 0 ? d : { ...d, total: 5000 }));
  assert.equal(evaluateApiUsage(hot, { now }).level, 'fail');
  assert.equal(evaluateRecords({ A: 40000, B: 5001 }).level, 'fail');
  assert.equal(evaluateRecords({ A: 42001 }).level, 'warn');
  assert.equal(evaluateRecords({ A: 20000 }).level, 'ok');
});

test('guard: Airtable を呼ぶ ESM Function はすべて計測を入れている', () => {
  const dir = new URL('../../../netlify/functions/', import.meta.url);
  const missing = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const s = readFileSync(new URL(f, dir), 'utf8');
    if (!/^(import |export )/m.test(s)) continue; // CJS は SDK 経由（明示計測）
    if (!s.includes(`installAirtableCallMeter({ source: '${f.slice(0, -3)}' })`)) missing.push(f);
  }
  assert.deepEqual(missing, []);
  for (const f of ['refresh-session', 'auth-user', 'send-magic-link', 'verify-magic-link']) {
    assert.match(readFileSync(new URL(`${f}.js`, dir), 'utf8'), /meterAirtable\(/, f);
  }
  assert.match(readFileSync(new URL('../../middleware.js', import.meta.url), 'utf8'), /installAirtableCallMeter\(\{ source: 'ssr' \}\)/);
});
