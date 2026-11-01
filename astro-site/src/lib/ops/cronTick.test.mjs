/**
 * cronTick.test.mjs — 定期処理を cron-tick にまとめても、間隔・即時性・独立性・公開 URL 遮断が変わらないことを固定する
 * 正本: docs/SAFETY_CHECKS.md ルール 9
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  dueJobs, runCronTick, cronTickRequest, isCronTickRequest, directInvocationNotFound, CRON_TICK_SCHEDULE,
} from './cronTick.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const FN_DIR = new URL('../../../netlify/functions/', import.meta.url);
const TICK_SRC = read('../../../netlify/functions/cron-tick.js');
const at = (min, sec = 0) => new Date(Date.UTC(2026, 10, 1, 12, min, sec));
const JOBS = [
  { name: 'a5', every: 5 }, { name: 'b10', every: 10 }, { name: 'c15', every: 15 },
];
const names = (d) => dueJobs(JOBS, d).map((j) => j.name);

test('間隔は従来の */5・*/10・*/15 と同じ分に走る（UTC）', () => {
  for (let m = 0; m < 60; m += 5) {
    const want = ['a5'];
    if (m % 10 === 0) want.push('b10');
    if (m % 15 === 0) want.push('c15');
    assert.deepEqual(names(at(m)), want, `minute ${m}`);
  }
});

test('起動が数秒〜数分遅れても同じ区切りの処理を走らせる（取りこぼさない）', () => {
  assert.deepEqual(names(at(0, 59)), ['a5', 'b10', 'c15']);
  assert.deepEqual(names(at(31, 30)), ['a5', 'b10', 'c15']);
  assert.deepEqual(names(at(44, 59)), ['a5', 'b10']);
  assert.deepEqual(names(at(9, 59)), ['a5']);
});

test('1 つの処理の例外・失敗が他の処理を止めない', async () => {
  const ran = [];
  const lines = [];
  const jobs = [
    { name: 'boom', every: 5, run: async () => { ran.push('boom'); throw new Error('x'); } },
    { name: 'fail', every: 5, run: async () => { ran.push('fail'); return new Response('', { status: 500 }); } },
    { name: 'okay', every: 5, run: async (req) => { ran.push(isCronTickRequest(req) ? 'okay' : 'unmarked'); return new Response('{}', { status: 200 }); } },
  ];
  const out = await runCronTick(jobs, { now: at(5), log: (l) => lines.push(l) });
  assert.deepEqual(ran.sort(), ['boom', 'fail', 'okay']);
  assert.deepEqual(out.results.map((r) => [r.name, r.ok]), [['boom', false], ['fail', false], ['okay', true]]);
  assert.equal(lines.length, 3);
});

test('印は cron-tick が作ったリクエストだけ。HTTP から来たリクエスト・空引数は印なし', async () => {
  assert.equal(isCronTickRequest(cronTickRequest()), true);
  assert.equal(isCronTickRequest(new Request('https://analytics.keiba.link/.netlify/functions/cron-tick', { method: 'POST' })), false);
  assert.equal(isCronTickRequest(undefined), false);
  assert.equal(isCronTickRequest({}), false);
  assert.equal(directInvocationNotFound().status, 404);
  // 本文は各リクエストで独立（rollout は req.json() を読む）
  const a = cronTickRequest(); const b = cronTickRequest();
  assert.deepEqual(await a.json(), {});
  assert.deepEqual(await b.json(), {});
});

test('cron-tick の表・schedule は静的に読める文字列で、cronTick.js と一致する', () => {
  assert.match(TICK_SRC, /export const config = \{\s*schedule: '\*\/5 \* \* \* \*',\s*\};/);
  assert.equal(CRON_TICK_SCHEDULE, '*/5 * * * *');
  assert.match(TICK_SRC, /^import '\.\.\/\.\.\/src\/lib\/ops\/cronTickMeter\.js';/m, 'meter が最初の import でない');
  const first = TICK_SRC.indexOf("import '../../src/lib/ops/cronTickMeter.js'");
  assert.ok(first >= 0 && first < TICK_SRC.indexOf("from './cron-"), 'meter より先に処理を import している');
});

test('まとめた処理は自分の schedule を持たず、cron-tick 以外の起動を 404 にする（二重起動・公開 URL 起動の防止）', () => {
  const rows = [...TICK_SRC.matchAll(/\{ name: '([a-z0-9-]+)', every: (\d+), run: \w+ \}/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(rows, [
    ['cron-marketing-rollout', 5],
    ['cron-marketing-dispatch', 5],
    ['cron-premium-plus-delivery', 5],
    ['cron-prospect-worker', 10],
    ['cron-email-scheduler', 15],
  ]);
  const toml = read('../../../netlify.toml');
  for (const [name] of rows) {
    const src = readFileSync(new URL(`${name}.js`, FN_DIR), 'utf8');
    assert.doesNotMatch(src, /export const config\s*=/, `${name} に config が残っている`);
    assert.doesNotMatch(toml, new RegExp(`\\[functions\\."${name}"\\]`), `${name} の schedule が netlify.toml に残っている`);
    assert.match(src, /export default async function handler\((req|request)[^)]*\) \{\n  \/\/[^\n]*\n  if \(!isCronTickRequest\((req|request)\)\) return directInvocationNotFound\(\);/,
      `${name} の先頭で cron-tick 以外を弾いていない`);
  }
});

test('🛑 決済メール・重い処理は cron-tick にまとめない（各自の schedule のまま）', () => {
  for (const name of ['payment-email-dispatcher', 'cron-payment-email-reconciler', 'cron-campaign-sequence']) {
    assert.doesNotMatch(TICK_SRC, new RegExp(`'${name}'`), `${name} を cron-tick に入れている`);
    const src = readFileSync(new URL(`${name}.js`, FN_DIR), 'utf8');
    assert.match(src, /export const config = \{[\s\S]*schedule:/, `${name} の schedule が無い`);
  }
});

test('実物の 5 処理: 公開 URL からの起動は 404 で何もしない', async () => {
  const env = { ...process.env };
  try {
    for (const k of ['AIRTABLE_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
    for (const name of ['cron-marketing-rollout', 'cron-marketing-dispatch', 'cron-premium-plus-delivery', 'cron-prospect-worker', 'cron-email-scheduler']) {
      const mod = await import(new URL(`${name}.js`, FN_DIR).href);
      const res = await mod.default(new Request(`https://analytics.keiba.link/.netlify/functions/${name}`, { method: 'POST', body: '{}' }));
      assert.equal(res.status, 404, name);
      const res2 = await mod.default();
      assert.equal(res2.status, 404, `${name}（引数なし）`);
    }
  } finally {
    process.env = env;
  }
});

test('netlify/functions に cron-tick 以外の 5 分毎 schedule が増えていない（まとめ漏れの検知）', () => {
  const fiveMin = readdirSync(FN_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .filter((f) => /schedule:\s*['"]\*\/5 \* \* \* \*['"]/.test(readFileSync(new URL(f, FN_DIR), 'utf8')))
    .sort();
  assert.deepEqual(fiveMin, ['cron-tick.js', 'payment-email-dispatcher.js']);
});
