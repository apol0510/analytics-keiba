/**
 * prospectLedgerRepair.test.mjs — 名指しした hash の抑止台帳・抑止索引だけを state に合わせて直す
 *
 * 守る条件:
 *   1. 既定は下見（apply が無ければ 1 バイトも書かない）
 *   2. レコードは変えない（CAS の KEEP）
 *   3. EXHAUSTED / SUPPRESSED 以外・レコード無しには何もしない（送信候補へ戻さない）
 *   4. 揃っていれば 0 コマンド
 *   5. 直した後は `prospectStateAudit` の判定で異常 0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createProspectStore, prospectKey, blockedKey, ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX,
} from './prospectStore.js';
import { isProspectCasEval, emulateProspectCas } from './prospectCasFakeForTests.mjs';
import { classifyProspectConsistency } from './prospectStateAudit.js';

const H = (c) => c.repeat(64);

function fakeRedis() {
  const kv = new Map(); const sets = new Map(); const commands = [];
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const cmd = async (args) => {
    commands.push(args);
    if (isProspectCasEval(args)) {
      return emulateProspectCas(args, {
        get: (k) => (kv.has(k) ? kv.get(k) : null), set: (k, v) => kv.set(k, v), del: (k) => kv.delete(k),
        sadd: (k, m) => setOf(k).add(m), srem: (k, m) => setOf(k).delete(m), has: (k, m) => setOf(k).has(m),
      });
    }
    const [op, key, ...rest] = args;
    if (op === 'MGET') return [key, ...rest].map((k) => (kv.has(k) ? kv.get(k) : null));
    if (op === 'SISMEMBER') return setOf(key).has(rest[0]) ? 1 : 0;
    throw new Error(`unsupported ${op}`);
  };
  return { kv, setOf, commands, cmd };
}
const rec = (o) => JSON.stringify({
  email: 'x@example.com', sends: 1, delivered: 1, opens: 0, source: 'csv', ...o,
});
const writes = (r) => r.commands.filter((c) => c[0] === 'EVAL');
const inspect = (r, h) => classifyProspectConsistency({
  recordRaw: r.kv.get(prospectKey(h)) ?? null,
  ledgerRaw: r.kv.get(blockedKey(h)) ?? null,
  inActive: r.setOf(ACTIVE_INDEX).has(h),
  inEngaged: r.setOf(ENGAGED_INDEX).has(h),
  inBlocked: r.setOf(BLOCKED_INDEX).has(h),
}, { env: {} });

test('SUPPRESSED で台帳なし・送信候補に残る → 台帳を作り、抑止索引へ入れ、送信候補から外す（レコード不変）', async () => {
  const r = fakeRedis();
  const h = H('a');
  const raw = rec({ state: 'SUPPRESSED', suppressedReason: 'dropped', suppressedAt: '2026-09-20T10:01:09.206Z' });
  r.kv.set(prospectKey(h), raw);
  r.setOf(ACTIVE_INDEX).add(h);
  const store = createProspectStore({ cmd: r.cmd });

  const dry = await store.reconcileBlockedByHash([h]);
  assert.deepEqual(dry.planned[0].changes, ['ledger_create', 'blocked_index_add', 'active_remove']);
  assert.equal(writes(r).length, 0, '下見は書かない');
  assert.equal(r.kv.has(blockedKey(h)), false);

  const res = await store.reconcileBlockedByHash([h], { apply: true });
  assert.equal(res.applied, 1);
  assert.equal(r.kv.get(prospectKey(h)), raw, 'レコードは 1 文字も変えない');
  const led = JSON.parse(r.kv.get(blockedKey(h)));
  assert.equal(led.kind, 'suppressed');
  assert.equal(led.reason, 'dropped');
  assert.equal(led.at, '2026-09-20T10:01:09.206Z');
  assert.equal(JSON.stringify(led).includes('@'), false, '台帳にアドレスを書かない');
  assert.equal(r.setOf(BLOCKED_INDEX).has(h), true);
  assert.equal(r.setOf(ACTIVE_INDEX).has(h), false);
  assert.deepEqual(inspect(r, h).codes, [], '直した後は監査で異常 0');
});

test('台帳はあるが抑止索引に居ない → 索引へ入れる', async () => {
  const r = fakeRedis();
  const h = H('b');
  r.kv.set(prospectKey(h), rec({ state: 'SUPPRESSED', suppressedReason: 'dropped', suppressedAt: '2026-09-21T10:00:48.417Z' }));
  r.kv.set(blockedKey(h), JSON.stringify({ hash: h, kind: 'suppressed', reason: 'dropped', at: '2026-09-21T10:00:48.417Z' }));
  const store = createProspectStore({ cmd: r.cmd });
  const res = await store.reconcileBlockedByHash([h], { apply: true });
  assert.deepEqual(res.planned[0].changes, ['blocked_index_add']);
  assert.equal(res.applied, 1);
  assert.deepEqual(inspect(r, h).codes, []);
});

test('送信候補・反応済み・レコード無し・揃っている相手には何もしない', async () => {
  const r = fakeRedis();
  const send = H('c'); const eng = H('d'); const none = H('e'); const fine = H('f');
  r.kv.set(prospectKey(send), rec({ state: 'SENDING' }));
  r.kv.set(prospectKey(eng), rec({ state: 'ENGAGED', opens: 1 }));
  r.kv.set(prospectKey(fine), rec({ state: 'EXHAUSTED', delivered: 10 }));
  r.kv.set(blockedKey(fine), JSON.stringify({ hash: fine, kind: 'exhausted' }));
  r.setOf(BLOCKED_INDEX).add(fine);
  const store = createProspectStore({ cmd: r.cmd });
  const res = await store.reconcileBlockedByHash([send, eng, none, fine], { apply: true });
  assert.equal(res.applied, 0);
  assert.equal(writes(r).length, 0);
  const reasons = Object.fromEntries(res.skipped.map((s) => [s.hash, s.reason]));
  assert.equal(reasons[send], 'not_block_state');
  assert.equal(reasons[eng], 'not_block_state');
  assert.equal(reasons[none], 'no_record');
  assert.equal(reasons[fine], 'already_consistent');
});

test('読んだ後に書き込みが入っていれば触らない（比較して書く）', async () => {
  const r = fakeRedis();
  const h = H('9');
  r.kv.set(prospectKey(h), rec({ state: 'SUPPRESSED' }));
  const store = createProspectStore({
    cmd: async (args) => {
      if (isProspectCasEval(args)) r.kv.set(prospectKey(h), rec({ state: 'SUPPRESSED', sends: 2 }));
      return r.cmd(args);
    },
  });
  const res = await store.reconcileBlockedByHash([h], { apply: true });
  assert.equal(res.applied, 0);
  assert.equal(res.skipped[0].reason, 'changed_concurrently');
  assert.equal(r.kv.has(blockedKey(h)), false);
});

test('管理 API: 既定は下見・確認文字列必須・10 件まで', () => {
  const fn = readFileSync(fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');
  assert.match(fn, /action === 'prospectLedgerRepair'\) return await handleProspectLedgerRepair/);
  const body = fn.slice(fn.indexOf('async function handleProspectLedgerRepair'));
  const src = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.match(src, /req\.apply === true && confirmed/);
  assert.match(src, /INDEX_REPAIR_MAX/);
  assert.match(fn, /LEDGER_REPAIR_CONFIRM = 'REPAIR PROSPECT LEDGER'/);
  assert.equal(/purge|recordSend|sendgrid|airtable/i.test(src), false);
});
