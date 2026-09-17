/**
 * sendgridMigrationScan.test.mjs — 索引 → 通し番号別件数（**読み取りのみ**）の契約
 *
 * 本番相当の経路（prospect 索引 + `DeliveryKey` 台帳）をメモリ上の Redis で再現し、
 *   - 既に受け取った通を数え直して **次の 1 通**が正しく決まること
 *   - 台帳が読めないときは **窓ごと中止**すること（未送信と見なさない）
 *   - 走査中に索引が変われば**やり直し**になること
 *   - 窓を跨いだ合算が「確定」と言えるのは `missing` が 0 のときだけ
 * を固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProspectStore, emailHash, ACTIVE_INDEX, prospectKey } from './prospectStore.js';
import { createDeliveryKeyStore } from './deliveryKeyStore.js';
import { PROSPECT_STATE } from './prospectPolicy.js';
import { buildMessagePlan, buildMessageKeys } from './sendgridMessagePlan.js';
import {
  scanMigrationWindow, mergeScanSummaries, toExportEntries, SCAN_FAIL,
} from './sendgridMigrationScan.js';
import { MIGRATION_STATUS } from './sendgridNextMessage.js';

const BRAND = 'analytics-keiba';
const FROM = 'support@keiba.link';

/** メモリ上の Upstash 互換（この走査が使う op だけ） */
function createMemoryRedis() {
  const strings = new Map();
  const sets = new Map();
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const state = { failSmismember: false };

  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'GET') return strings.has(args[1]) ? strings.get(args[1]) : null;
    if (op === 'SET') { strings.set(args[1], String(args[2])); return 'OK'; }
    if (op === 'EXISTS') return strings.has(args[1]) ? 1 : 0;
    if (op === 'MGET') return args.slice(1).map((k) => (strings.has(k) ? strings.get(k) : null));
    if (op === 'SADD') { const s = setOf(args[1]); const before = s.size; args.slice(2).forEach((m) => s.add(String(m))); return s.size - before; }
    if (op === 'SREM') { const s = setOf(args[1]); let n = 0; args.slice(2).forEach((m) => { if (s.delete(String(m))) n += 1; }); return n; }
    if (op === 'SMEMBERS') return [...setOf(args[1])];
    if (op === 'SCARD') return setOf(args[1]).size;
    if (op === 'SISMEMBER') return setOf(args[1]).has(String(args[2])) ? 1 : 0;
    if (op === 'SMISMEMBER') {
      if (state.failSmismember) throw new Error('redis_down');
      const s = setOf(args[1]);
      return args.slice(2).map((m) => (s.has(String(m)) ? 1 : 0));
    }
    throw new Error(`unsupported_op:${op}`);
  };
  return { cmd, strings, sets, setOf, state };
}

/** prospect を索引へ入れる（store の write 経路を通さず、直接置く） */
function seedProspect(redis, { email, state = PROSPECT_STATE.SENDING, delivered = 0 }) {
  const hash = emailHash(email);
  redis.strings.set(prospectKey(hash), JSON.stringify({ email, state, delivered }));
  redis.setOf(ACTIVE_INDEX).add(hash);
  return hash;
}

/** 「その人へ n 通目まで配った」を台帳へ記録する */
function seedDelivered(redis, { email, upTo, plan }) {
  const keys = buildMessageKeys({ plan, email, brand: BRAND, fromEmail: FROM });
  for (const [n, key] of keys) {
    if (n > upTo) continue;
    const entry = plan.find((p) => p.messageNumber === n);
    redis.setOf(`ak:mkt:delivered:${BRAND}:${entry.campaignId}:v${entry.version}`).add(key);
  }
}

function makeDeps(redis) {
  return {
    store: createProspectStore({ cmd: redis.cmd }),
    deliveryKeyStore: createDeliveryKeyStore({ redisCmd: redis.cmd }),
    brand: BRAND,
    fromEmail: FROM,
  };
}

test('既送信を引き継いで「次の 1 通」を決める（全員 1 通目から送り直さない）', async () => {
  const plan = buildMessagePlan().plan;
  const redis = createMemoryRedis();
  seedProspect(redis, { email: 'fresh@example.test' });
  seedProspect(redis, { email: 'two@example.test', delivered: 2 });
  seedProspect(redis, { email: 'five@example.test', delivered: 5 });
  seedProspect(redis, { email: 'done@example.test', delivered: 10 });
  seedProspect(redis, { email: 'engaged@example.test', state: PROSPECT_STATE.ENGAGED });
  seedDelivered(redis, { email: 'two@example.test', upTo: 2, plan });
  seedDelivered(redis, { email: 'five@example.test', upTo: 5, plan });
  seedDelivered(redis, { email: 'done@example.test', upTo: 10, plan });

  const out = await scanMigrationWindow({ ...makeDeps(redis), limit: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.window.indexSize, 5);
  assert.equal(out.window.missing, 0);
  assert.equal(out.window.nextOffset, null);

  const byEmail = Object.fromEntries(out.results.map((r) => [r.email, r]));
  assert.equal(byEmail['fresh@example.test'].nextMessageNumber, 1);
  assert.equal(byEmail['two@example.test'].nextMessageNumber, 3);
  assert.equal(byEmail['five@example.test'].nextMessageNumber, 6);
  assert.equal(byEmail['done@example.test'].status, MIGRATION_STATUS.COMPLETED);
  assert.equal(byEmail['engaged@example.test'].status, MIGRATION_STATUS.EXCLUDED);

  assert.equal(out.summary['移行対象'], 3);
  assert.equal(out.summary['配り終えた'], 1);
  assert.equal(out.summary['除外'], 1);
  assert.deepEqual(
    [1, 3, 6].map((n) => out.summary['次に送る番号別'][n]), [1, 1, 1],
  );

  // 変換層へ渡るのは ready だけ
  const entries = toExportEntries(out.results);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.nextMessageNumber > e.highestSent), '再送になる組み合わせが無い');
});

test('台帳が読めない窓は中止する（未送信と見なさない）', async () => {
  const plan = buildMessagePlan().plan;
  const redis = createMemoryRedis();
  seedProspect(redis, { email: 'x@example.test' });
  seedDelivered(redis, { email: 'x@example.test', upTo: 2, plan });
  redis.state.failSmismember = true;

  const out = await scanMigrationWindow({ ...makeDeps(redis), limit: 100 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, SCAN_FAIL.LEDGER_UNAVAILABLE);
});

test('窓を跨ぐ間に索引が変わったらやり直す', async () => {
  const redis = createMemoryRedis();
  seedProspect(redis, { email: 'a@example.test' });
  const first = await scanMigrationWindow({ ...makeDeps(redis), limit: 1 });
  assert.equal(first.ok, true);
  seedProspect(redis, { email: 'b@example.test' });
  const second = await scanMigrationWindow({
    ...makeDeps(redis), limit: 1, offset: 1, expectDigest: first.window.digest,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, SCAN_FAIL.INDEX_CHANGED);
});

test('窓は scanned で進み、読み切ると nextOffset が null になる', async () => {
  const redis = createMemoryRedis();
  for (let i = 0; i < 5; i += 1) seedProspect(redis, { email: `u${i}@example.test` });
  const w1 = await scanMigrationWindow({ ...makeDeps(redis), limit: 2 });
  assert.equal(w1.window.scanned, 2);
  assert.equal(w1.window.nextOffset, 2);
  const w2 = await scanMigrationWindow({
    ...makeDeps(redis), limit: 2, offset: w1.window.nextOffset, expectDigest: w1.window.digest,
  });
  const w3 = await scanMigrationWindow({
    ...makeDeps(redis), limit: 2, offset: w2.window.nextOffset, expectDigest: w1.window.digest,
  });
  assert.equal(w3.window.nextOffset, null);

  const merged = mergeScanSummaries([w1, w2, w3]);
  assert.equal(merged['走査済み'], 5);
  assert.equal(merged['移行対象'], 5);
  assert.equal(merged['確定'], true);
});

test('値を読めなかった人が居る合算は「確定」と言わない', async () => {
  const redis = createMemoryRedis();
  const hash = seedProspect(redis, { email: 'ghost@example.test' });
  seedProspect(redis, { email: 'real@example.test' });
  // 索引には居るがレコードが無い＝ missing
  redis.strings.delete(prospectKey(hash));

  const out = await scanMigrationWindow({ ...makeDeps(redis), limit: 10 });
  assert.equal(out.ok, true);
  assert.equal(out.window.missing, 1);
  assert.equal(mergeScanSummaries([out])['確定'], false);
});
