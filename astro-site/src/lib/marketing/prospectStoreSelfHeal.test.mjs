/**
 * prospectStoreSelfHeal.test.mjs — **再実行するだけで索引が直る**
 *   node --test src/lib/marketing/prospectStoreSelfHeal.test.mjs
 *
 * ## 何を守るか（2026-08-27 の事故）
 *
 * `write()` は `SET`（レコード）→ `SADD`（索引）の **別往復**。途中で落ちると
 * **レコードはあるのに索引に居ない**人が残る。次の実行では `existed` 扱いになり、
 * 以前は**索引を張り直さずに素通り**していたため、永久に送信候補へ戻らなかった。
 *
 * 本番で 1 件発生（investment 11,976 に対し active 11,975）。
 *
 * 守る条件:
 *   1. `existed` でも state に合わせて索引を張り直す（**再実行で直る**）
 *   2. **レコードは絶対に上書きしない**（送信回数・除外を消さない）
 *   3. 抑止台帳に載っている相手は復活させない
 *   4. 往復数を増やさない（504 の再発を防ぐ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createProspectStore, emailHash, prospectKey,
  ACTIVE_INDEX, ENGAGED_INDEX, isSendableState,
} from './prospectStore.js';
import { buildProspect, PROSPECT_STATE } from './prospectPolicy.js';

const NOW = Date.UTC(2026, 7, 27);
const BATCH = 'imp-2026-08-09-001';

/** Redis の代わり。集合とレコードだけ持つ最小実装 */
function fakeRedis() {
  const kv = new Map();
  const sets = new Map();
  const commands = [];
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const cmd = async (args) => {
    commands.push(args);
    const [op, key, ...rest] = args;
    if (op === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (op === 'SET') { kv.set(key, rest[0]); return 'OK'; }
    if (op === 'DEL') { kv.delete(key); return 1; }
    if (op === 'EXISTS') return kv.has(key) ? 1 : 0;
    if (op === 'MGET') return [key, ...rest].map((k) => (kv.has(k) ? kv.get(k) : null));
    if (op === 'SADD') { const s = setOf(key); let n = 0; for (const m of rest) if (!s.has(m)) { s.add(m); n += 1; } return n; }
    if (op === 'SREM') { const s = setOf(key); let n = 0; for (const m of rest) if (s.delete(m)) n += 1; return n; }
    if (op === 'SMEMBERS') return [...setOf(key)];
    if (op === 'SCARD') return setOf(key).size;
    if (op === 'SISMEMBER') return setOf(key).has(rest[0]) ? 1 : 0;
    throw new Error(`unsupported ${op}`);
  };
  const pipeline = async (list) => { const out = []; for (const a of list) out.push(await cmd(a)); return out; };
  return {
    kv, sets, commands, cmd, pipeline, setOf,
    active: () => setOf(ACTIVE_INDEX),
    engaged: () => setOf(ENGAGED_INDEX),
  };
}

const mk = (email, over = {}) => ({
  ...buildProspect({ email, nowMs: NOW, batchId: BATCH, source: 'csv' }), ...over,
});

/** ⚠️ 事故の再現: レコードは書けたが索引を張る前に落ちた */
function seedOrphanRecord(r, prospect) {
  const hash = emailHash(prospect.email);
  r.kv.set(prospectKey(hash), JSON.stringify(prospect));   // SET だけ（SADD しない）
  return hash;
}

/* ── 1. 再実行だけで直る ───────────────────────────────────── */

test('【要件】まとめ投入: レコードはあるのに索引に居ない人が、再実行で送信候補へ戻る', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const p = mk('orphan@example.com', { state: PROSPECT_STATE.SENDING, sends: 2, delivered: 2 });
  const hash = seedOrphanRecord(r, p);
  assert.equal(r.active().has(hash), false, '前提: 索引に居ない');

  const out = await store.addManyIfAbsent([p]);

  assert.equal(out.existed, 1);
  assert.equal(out.added, 0);
  assert.equal(out.reindexed, 1, '⚠️ 索引を張り直していない（再実行しても直らない）');
  assert.equal(r.active().has(hash), true, '⚠️ 送信候補へ戻っていない');
});

test('【要件】1 件投入でも同じく直る', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const p = mk('orphan2@example.com', { state: PROSPECT_STATE.SENDING });
  const hash = seedOrphanRecord(r, p);

  const out = await store.addIfAbsent(p);

  assert.equal(out.added, false);
  assert.equal(out.reindexed, 1);
  assert.equal(r.active().has(hash), true);
});

test('【要件】本番と同じ形: 89 件中 1 件だけ索引に居ない → 再実行で 89 件すべて候補になる', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const list = Array.from({ length: 89 }, (_, i) => mk(`p${i}@example.com`, { state: PROSPECT_STATE.SENDING }));
  // 88 件は SET + SADD 済み、1 件は SET だけで落ちた
  list.forEach((p, i) => {
    const h = seedOrphanRecord(r, p);
    if (i !== 88) r.active().add(h);
  });
  assert.equal(r.active().size, 88, '前提: 1 件足りない');

  const out = await store.addManyIfAbsent(list);

  assert.equal(out.existed, 89);
  assert.equal(out.added, 0);
  assert.equal(out.reindexed, 1, '直した件数は 1 件だけ（既に揃っている 88 件は数えない）');
  assert.equal(r.active().size, 89, '⚠️ 11,976 に戻らない形になっている');
});

test('既に索引が揃っていれば何も変えない（正常時に騒がない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const p = mk('ok@example.com', { state: PROSPECT_STATE.SENDING });
  const hash = seedOrphanRecord(r, p);
  r.active().add(hash);

  const out = await store.addManyIfAbsent([p]);
  assert.equal(out.reindexed, 0);
  assert.equal(r.active().has(hash), true);
});

/* ── 2. state と索引を必ず揃える（送るべきでない人を復活させない）── */

/*
 * ⚠️ 取り込みが渡してくる prospect は必ず NEW / SENDING（それ以外は bulk 経路が弾く）。
 *    張り直しの判断は **渡された値ではなく、保存されているレコードの state** で行う。
 *    ここを取り違えると、送信を止めた人を「まっさらな NEW」で候補へ復活させてしまう。
 */
test('⚠️【要件】張り直しは 保存済みレコードの state で決める（渡された state ではない）', async () => {
  for (const state of [
    PROSPECT_STATE.EXHAUSTED, PROSPECT_STATE.SUPPRESSED, PROSPECT_STATE.PROMOTED,
  ]) {
    const r = fakeRedis();
    const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
    const email = `stop-${state}@example.com`;
    // 保存済みは「送信を止めた」状態。誤って候補に残っている
    const hash = seedOrphanRecord(r, mk(email, { state }));
    r.active().add(hash);

    // 取り込みは まっさらな NEW を渡してくる
    // eslint-disable-next-line no-await-in-loop
    const out = await store.addManyIfAbsent([mk(email, { state: PROSPECT_STATE.NEW })]);

    assert.equal(out.existed, 1);
    assert.equal(r.active().has(hash), false, `⚠️ ${state} を送信候補へ復活させた`);
    assert.equal(isSendableState(state), false);
  }
});

test('⚠️ 反応済みは engaged 索引へ寄せ、候補からは外す（保存済みの state で判断）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const email = 'eng@example.com';
  const hash = seedOrphanRecord(r, mk(email, { state: PROSPECT_STATE.ENGAGED }));
  r.active().add(hash);

  await store.addManyIfAbsent([mk(email, { state: PROSPECT_STATE.NEW })]);
  assert.equal(r.active().has(hash), false, '⚠️ 反応済みを送信候補に残している');
  assert.equal(r.engaged().has(hash), true);
});

/* ── 3. レコードは絶対に上書きしない ──────────────────────── */

test('⚠️【要件】既存レコードを上書きしない（送信回数・除外を消さない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const stored = mk('keep@example.com', {
    state: PROSPECT_STATE.SENDING, sends: 2, delivered: 2, lastSentAt: '2026-08-25T22:43:53.944Z',
  });
  const hash = seedOrphanRecord(r, stored);
  const before = r.kv.get(prospectKey(hash));

  // 取り込み側は「まっさら」な prospect を渡してくる
  await store.addManyIfAbsent([mk('keep@example.com', { state: PROSPECT_STATE.NEW })]);

  assert.equal(r.kv.get(prospectKey(hash)), before, '⚠️ レコードを上書きした（送信履歴が消える）');
  assert.equal(JSON.parse(r.kv.get(prospectKey(hash))).delivered, 2);
  assert.equal(r.active().has(hash), true);
});

test('⚠️ 既存に対して SET を 1 回も出していない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const p = mk('nosets@example.com', { state: PROSPECT_STATE.SENDING });
  const hash = seedOrphanRecord(r, p);
  r.commands.length = 0;

  await store.addManyIfAbsent([p]);

  const sets = r.commands.filter((c) => c[0] === 'SET' && c[1] === prospectKey(hash));
  assert.deepEqual(sets, [], '⚠️ 既存レコードへ SET を出している');
});

/* ── 4. 抑止台帳は最優先（復活させない）───────────────────── */

test('⚠️ 抑止台帳に載っている相手は索引を張り直さない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const p = mk('blocked@example.com', { state: PROSPECT_STATE.SENDING });
  const hash = seedOrphanRecord(r, p);
  r.kv.set(`ak:prospect:blocked:${hash}`, JSON.stringify({ hash, kind: 'suppressed' }));

  const out = await store.addManyIfAbsent([p]);
  assert.equal(out.blocked, 1);
  assert.equal(out.reindexed, 0);
  assert.equal(r.active().has(hash), false, '⚠️ 抑止済みを送信候補へ復活させた');
});

/* ── 5. 往復数を増やさない（504 の再発防止）──────────────── */

test('⚠️【要件】既存 500 件の張り直しでも索引コマンドは 4 つまで（往復を増やさない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const list = Array.from({ length: 500 }, (_, i) => mk(`b${i}@example.com`, { state: PROSPECT_STATE.SENDING }));
  list.forEach((p) => seedOrphanRecord(r, p));
  r.commands.length = 0;

  await store.addManyIfAbsent(list);

  const idx = r.commands.filter((c) => (c[0] === 'SADD' || c[0] === 'SREM')
    && (c[1] === ACTIVE_INDEX || c[1] === ENGAGED_INDEX));
  assert.ok(idx.length <= 4, `⚠️ 索引コマンドが ${idx.length} 回（1 件ずつ張り直している＝504 へ逆戻り）`);
  assert.equal(r.active().size, 500);
});

test('新規投入の挙動は変わらない（回帰）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const list = Array.from({ length: 3 }, (_, i) => mk(`n${i}@example.com`));
  const out = await store.addManyIfAbsent(list);
  assert.equal(out.added, 3);
  assert.equal(out.existed, 0);
  assert.equal(out.reindexed, 0);
  assert.equal(out.failed, 0);
  assert.equal(r.active().size, 3);
});
