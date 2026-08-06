/**
 * automationRunIndex.test.mjs — B-4（索引の原子性）と B-5（run の保持期間）を固定する
 *   node --test src/lib/marketing/automationRunIndex.test.mjs
 *
 * ⚠️ 実 Redis / 実 Airtable / 実送信は一切行わない（fake だけ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createAutomationStore, autoKey, AUTO_ROOT,
  RUN_TTL_SEC, CLAIM_TTL_SEC, LOCK_TTL_SEC, AutomationStoreError, STORE_FAIL,
} from './automationStore.js';
import { RUNS_HISTORY_DAYS, RUNS_HISTORY_MAX_DAYS } from './automationAdminApi.js';
import { transition, AUTOMATION_STATUS } from './automationModel.js';
import { isDue } from './automationScheduler.js';

const CRON = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8');

const NOW = Date.parse('2026-08-10T01:00:00.000Z');
const ACTIVE_INDEX = autoKey.activeIndex();

/**
 * Lua を意味論で再現する fake。**EVAL は 1 回の呼び出しで全部やるか、何もしないか**。
 * `failAfter` を指定すると、指定回数を超えたコマンドで落とす（途中失敗の再現）。
 */
function fakeRedis(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  const state = { failAfter: null, failOps: null };
  const cmd = async (a) => {
    calls.push(a);
    const op = String(a[0]).toUpperCase();
    if (state.failOps && state.failOps.includes(op)) throw new Error(`fake_fail_${op}`);
    if (state.failAfter !== null && calls.length > state.failAfter) throw new Error('fake_fail');
    const key = a[1];
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'SET') {
      if (a.includes('NX') && store.has(key)) return null;
      store.set(key, a[2]); return 'OK';
    }
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'SADD') { const s = store.get(key) || new Set(); s.add(a[2]); store.set(key, s); return 1; }
    if (op === 'SREM') { const s = store.get(key); if (s) s.delete(a[2]); return 1; }
    if (op === 'SMEMBERS') { const s = store.get(key); return s ? [...s] : []; }
    if (op === 'INCR') { const v = Number(store.get(key) || 0) + 1; store.set(key, String(v)); return v; }
    if (op === 'EVAL') {
      const n = Number(a[2]);
      const keys = a.slice(3, 3 + n); const argv = a.slice(3 + n);
      // CAS + 索引（KEYS 2 本）
      if (n === 2) {
        const cur = store.get(keys[0]);
        if (cur) {
          const m = /"configVersion":(\d+)/.exec(cur);
          if (!m || m[1] !== argv[1]) return 'CONFLICT';
        } else if (argv[1] !== '') return 'MISSING';
        // ⚠️ ここから下は**まとめて反映**（Lua の原子性）
        store.set(keys[0], argv[0]);
        const idx = store.get(keys[1]) || new Set();
        if (argv[3] === '1') idx.add(argv[2]); else idx.delete(argv[2]);
        store.set(keys[1], idx);
        return 'OK';
      }
      // 旧 CAS（KEYS 1 本）
      const cur = store.get(keys[0]);
      if (!cur) { if (argv[1] === '') { store.set(keys[0], argv[0]); return 'OK'; } return 'MISSING'; }
      const m = /"configVersion":(\d+)/.exec(cur);
      if (!m || m[1] !== argv[1]) return 'CONFLICT';
      store.set(keys[0], argv[0]); return 'OK';
    }
    return 'OK';
  };
  return { cmd, store, calls, state };
}

const def = (over = {}) => ({
  automationId: 'expiry-d7', presetId: 'expiry-d7', name: 'n', status: 'DRAFT',
  campaignId: 'premium-renewal', campaignVersion: '2', shellVersion: '1', contentHash: 'h',
  schedule: 'daily', timezone: 'Asia/Tokyo', quietHours: { start: 21, end: 8 },
  maxRecipients: 10, trigger: { kind: 'days_before_expiry', days: 7 }, audience: {},
  createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  configVersion: 1, lastRunAt: null, nextRunAt: null,
  snapshotFingerprint: 'fp', snapshotCount: 2, snapshotOccurrenceDate: '2026-08-10',
  ...over,
});

const run = (over = {}) => ({
  runId: 'expiry-d7#2026-08-10', automationId: 'expiry-d7',
  operationId: 'expiry-d7#2026-08-10#001', status: 'PLANNED',
  snapshotCount: 0, queued: 0, excluded: 0, failed: 0,
  startedAt: '2026-08-10T01:00:00.000Z', ...over,
});

// ══ B-4: 本体と索引を原子的に更新する ══════════════════════════

test('B-4: ACTIVE 化は本体と索引を 1 回の EVAL で揃える', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const t = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-10T01:00:00.000Z' });
  const res = await s.saveDefinition({ definition: t.definition, expectedVersion: '' });

  assert.equal(res.ok, true);
  assert.equal(res.indexed, true);
  assert.deepEqual(await s.listActive(), ['expiry-d7']);

  // ⚠️ 索引更新のための **別コマンド（SADD）を打っていない**
  assert.equal(r.calls.filter((c) => c[0] === 'SADD').length, 0, '索引更新が別コマンドになっている');
  const evals = r.calls.filter((c) => c[0] === 'EVAL');
  assert.equal(evals.length, 1);
  assert.equal(evals[0][2], '2', 'KEYS が 2 本でない（索引を含んでいない）');
});

test('B-4: PAUSED / CANCELLED も同じ EVAL で索引から外れる', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const active = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-10T01:00:00.000Z' }).definition;
  await s.saveDefinition({ definition: active, expectedVersion: '' });
  assert.deepEqual(await s.listActive(), ['expiry-d7']);

  for (const to of [AUTOMATION_STATUS.PAUSED, AUTOMATION_STATUS.ACTIVE, AUTOMATION_STATUS.CANCELLED]) {
    const cur = await s.loadDefinition('expiry-d7');
    const next = transition({ definition: cur, to, nowIso: '2026-08-10T02:00:00.000Z' }).definition;
    await s.saveDefinition({
      definition: { ...next, configVersion: Number(cur.configVersion) + 1 },
      expectedVersion: String(cur.configVersion),
    });
    const inIndex = (await s.listActive()).includes('expiry-d7');
    assert.equal(inIndex, to === AUTOMATION_STATUS.ACTIVE, `${to} の索引が合っていない`);
  }
});

test('B-4: EVAL が落ちたら本体も索引も変わらない（片方だけ進まない）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const active = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-10T01:00:00.000Z' }).definition;

  r.state.failOps = ['EVAL'];
  await assert.rejects(() => s.saveDefinition({ definition: active, expectedVersion: '' }),
    (e) => e instanceof AutomationStoreError);
  r.state.failOps = null;

  assert.equal(await s.loadDefinition('expiry-d7'), null, '本体だけ書かれた');
  assert.deepEqual(await s.listActive(), [], '索引だけ書かれた');
});

test('B-4: 再実行で必ず収束する（同じ保存を 2 回流しても結果は同じ）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const active = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-10T01:00:00.000Z' }).definition;
  await s.saveDefinition({ definition: active, expectedVersion: '' });

  // 2 回目は CAS が弾く（版が進んでいない）。索引は壊れない
  await assert.rejects(() => s.saveDefinition({ definition: active, expectedVersion: '' }),
    (e) => e instanceof AutomationStoreError && e.code === STORE_FAIL.CAS_CONFLICT);
  assert.deepEqual(await s.listActive(), ['expiry-d7']);

  // 版を合わせた再実行は通り、索引も同じ
  const cur = await s.loadDefinition('expiry-d7');
  await s.saveDefinition({
    definition: { ...cur, configVersion: Number(cur.configVersion) + 1 },
    expectedVersion: String(cur.configVersion),
  });
  assert.deepEqual(await s.listActive(), ['expiry-d7']);
});

test('B-4: 同時実行では片方だけが勝ち、索引は勝った側と一致する', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def(), expectedVersion: '' });   // DRAFT / v1
  const cur = await s.loadDefinition('expiry-d7');

  const toActive = transition({ definition: cur, to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-10T01:00:00.000Z' }).definition;
  const toCancel = transition({ definition: cur, to: AUTOMATION_STATUS.CANCELLED, nowIso: '2026-08-10T01:00:00.000Z' }).definition;

  const results = await Promise.allSettled([
    s.saveDefinition({ definition: { ...toActive, configVersion: 2 }, expectedVersion: '1' }),
    s.saveDefinition({ definition: { ...toCancel, configVersion: 2 }, expectedVersion: '1' }),
  ]);
  const won = results.filter((x) => x.status === 'fulfilled');
  assert.equal(won.length, 1, '両方が勝った（CAS が効いていない）');

  const saved = await s.loadDefinition('expiry-d7');
  const inIndex = (await s.listActive()).includes('expiry-d7');
  assert.equal(inIndex, saved.status === 'ACTIVE', '索引が保存内容と食い違う');
});

test('B-4: 旧データの食い違いは reconcile で収束する（送る側へ倒さない）', async () => {
  // ACTIVE でないのに索引に居る / 本体が無いのに索引に居る、という古い状態
  const r = fakeRedis({
    [autoKey.def('paused-one')]: JSON.stringify(def({ automationId: 'paused-one', status: 'PAUSED' })),
    [autoKey.def('active-one')]: JSON.stringify(def({ automationId: 'active-one', status: 'ACTIVE' })),
    [ACTIVE_INDEX]: new Set(['paused-one', 'active-one', 'ghost']),
  });
  const s = createAutomationStore({ cmd: r.cmd });

  const rec = await s.reconcileActiveIndex();
  assert.deepEqual(rec, { checked: 3, removed: 1, kept: 1, missing: 1 });
  assert.deepEqual((await s.listActive()).sort(), ['active-one']);

  // ⚠️ 索引へ足す方向はしない（送る側へ倒さない）
  assert.equal(r.calls.filter((c) => c[0] === 'SADD').length, 0, '索引へ足している');

  // 何度流しても同じ
  const again = await s.reconcileActiveIndex();
  assert.deepEqual(again, { checked: 1, removed: 0, kept: 1, missing: 0 });
});

test('B-4: ACTIVE なのに索引に無い状態も、次の保存で自動的に入る', async () => {
  const r = fakeRedis({
    [autoKey.def('expiry-d7')]: JSON.stringify(def({ status: 'ACTIVE', enabled: true })),
    [ACTIVE_INDEX]: new Set(),
  });
  const s = createAutomationStore({ cmd: r.cmd });
  assert.deepEqual(await s.listActive(), [], '前提が違う');

  const cur = await s.loadDefinition('expiry-d7');
  await s.saveDefinition({
    definition: { ...cur, configVersion: Number(cur.configVersion) + 1 },
    expectedVersion: String(cur.configVersion),
  });
  assert.deepEqual(await s.listActive(), ['expiry-d7']);
});

test('B-4: guard — 索引更新が saveDefinition と別コマンドに戻っていない', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./automationStore.js', import.meta.url)), 'utf8');
  // saveDefinition の**本体だけ**を切り出す（後続の markActive 定義を巻き込まない）
  const start = SRC.indexOf('async saveDefinition(');
  const body = SRC.slice(start, SRC.indexOf('\n    },', start));
  assert.equal(/markActive\(/.test(body), false, 'saveDefinition の中で markActive を呼んでいる');
  assert.equal(/'SADD'/.test(body), false, 'saveDefinition が別コマンドで索引を触っている');
  assert.match(SRC, /CAS_WITH_INDEX_LUA/);
  assert.match(SRC, /redis\.call\('SADD', KEYS\[2\]/);
  assert.match(SRC, /redis\.call\('SREM', KEYS\[2\]/);
});

test('B-4: tick が索引を掃除する（送る前に収束させる）', () => {
  assert.match(CRON, /reconcileActiveIndex\(\)/);
  const at = CRON.indexOf('reconcileActiveIndex()');
  const listAt = CRON.indexOf('store.listActive()');
  assert.ok(at > -1 && at < listAt, '掃除が listActive より後にある');
  // 掃除が失敗しても tick 全体は落とさない
  assert.match(CRON.slice(at, at + 220), /catch/);
});

// ══ B-5: run の保持期間と二重開始の防止 ════════════════════════

test('B-5: run 本体に TTL が付き、表示期間より十分長い', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.createRun(run());

  const setBody = r.calls.find((c) => c[0] === 'SET' && c[1] === autoKey.run('expiry-d7#2026-08-10'));
  assert.ok(setBody.includes('EX'), 'run 本体に TTL が無い');
  assert.equal(setBody[setBody.indexOf('EX') + 1], String(RUN_TTL_SEC));

  // ⚠️ 表示・監査に要る期間より短くしない
  const maxHistorySec = RUNS_HISTORY_MAX_DAYS * 24 * 3600;
  assert.ok(RUN_TTL_SEC > maxHistorySec, `TTL ${RUN_TTL_SEC} が表示上限 ${maxHistorySec} 以下`);
  assert.ok(RUNS_HISTORY_DAYS <= RUNS_HISTORY_MAX_DAYS);
  // 他の TTL との整合（lock < claim < run）
  assert.ok(LOCK_TTL_SEC < CLAIM_TTL_SEC, 'lock が claim 以上');
  assert.ok(CLAIM_TTL_SEC < RUN_TTL_SEC, 'claim が run 以上');
});

test('B-5: 更新のたびに保持期間を張り直す', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.createRun(run());
  r.calls.length = 0;
  await s.saveRun(run({ status: 'DONE', queued: 3 }));
  const setBody = r.calls.find((c) => c[0] === 'SET' && c[1] === autoKey.run('expiry-d7#2026-08-10'));
  assert.ok(setBody.includes('EX'), 'saveRun で TTL が落ちている');
  assert.equal(setBody[setBody.indexOf('EX') + 1], String(RUN_TTL_SEC));
});

test('B-5: 墓標は TTL を付けず、PII を含まない', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.createRun(run());

  const markKey = autoKey.runMark('expiry-d7#2026-08-10');
  const setMark = r.calls.find((c) => c[0] === 'SET' && c[1] === markKey);
  assert.ok(setMark, '墓標を書いていない');
  assert.equal(setMark.includes('EX'), false, '墓標に TTL を付けている');
  assert.equal(setMark[2], '1', '墓標に余計な値を入れている');
  assert.equal(markKey.includes('@'), false);
  assert.ok(markKey.startsWith(`${AUTO_ROOT}run-mark:`));
});

test('B-5: TTL 切れで run 本体が消えても、同じ runId は二重開始できない', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });

  const first = await s.createRun(run());
  assert.equal(first.created, true);

  // ⚠️ TTL 切れを再現：**本体だけ**消す（墓標は残る）
  r.store.delete(autoKey.run('expiry-d7#2026-08-10'));
  assert.equal(await s.loadRun('expiry-d7#2026-08-10'), null);
  assert.equal(await s.runStarted('expiry-d7#2026-08-10'), true, '墓標まで消えている');

  const second = await s.createRun(run());
  assert.equal(second.created, false, 'TTL 切れで二重開始できてしまった');
  assert.equal(second.reason, 'duplicate_run');
  // 本体も作り直されない（enqueue の入口に入らない）
  assert.equal(await s.loadRun('expiry-d7#2026-08-10'), null);
});

test('B-5: 同一 runId の同時開始は 1 つだけ通る', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const results = await Promise.all([s.createRun(run()), s.createRun(run()), s.createRun(run())]);
  assert.equal(results.filter((x) => x.created).length, 1, '複数が開始できた');
  assert.equal(results.filter((x) => x.reason === 'duplicate_run').length, 2);
});

test('B-5: 既存の TTL 無し run データはそのまま読める（後方互換）', async () => {
  const legacy = run({ status: 'DONE', queued: 5 });
  const r = fakeRedis({
    // 旧実装が書いた形（TTL 無し・墓標も無い）
    [autoKey.run('expiry-d7#2026-08-01')]: JSON.stringify({ ...legacy, runId: 'expiry-d7#2026-08-01' }),
  });
  const s = createAutomationStore({ cmd: r.cmd });
  const loaded = await s.loadRun('expiry-d7#2026-08-01');
  assert.equal(loaded.queued, 5);
  assert.equal(loaded.runId, 'expiry-d7#2026-08-01');

  // 墓標が無い旧 run は「開始済み」と判定されない。
  // ⚠️ ただし runId は暦日を含むので、過去日の runId が再び due になることはない。
  assert.equal(await s.runStarted('expiry-d7#2026-08-01'), false);
  // 更新すれば TTL が付く（移行は自然に進む）
  await s.saveRun({ ...loaded, queued: 6 });
  const setBody = r.calls.filter((c) => c[0] === 'SET' && c[1] === autoKey.run('expiry-d7#2026-08-01')).pop();
  assert.ok(setBody.includes('EX'));
});

test('B-5: guard — 二重開始の判定が run 本体の NX に戻っていない', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./automationStore.js', import.meta.url)), 'utf8');
  const body = SRC.slice(SRC.indexOf('async createRun('), SRC.indexOf('async saveRun('));
  assert.match(body, /autoKey\.runMark\(run\.runId\)/);
  assert.match(body, /'NX'/);
  // 本体の SET に NX を付けない（TTL 切れ後に作り直せなくなるため）
  const bodySet = body.slice(body.indexOf('autoKey.run(run.runId)'));
  assert.equal(/'NX'/.test(bodySet), false, '本体の SET に NX が残っている');
  assert.match(body, /RUN_TTL_SEC/);
});

// ══ 既存契約を壊していない ════════════════════════════════════

test('既存の contract を壊していない（キー・schema・consumer）', async () => {
  // キーの形は変わらない
  assert.equal(autoKey.def('x'), `${AUTO_ROOT}def:x`);
  assert.equal(autoKey.run('x'), `${AUTO_ROOT}run:x`);
  assert.equal(autoKey.activeIndex(), `${AUTO_ROOT}index:active`);
  // 新キーも同じ名前空間
  assert.ok(autoKey.runMark('x').startsWith(AUTO_ROOT));

  // markActive / unmarkActive は残っており冪等
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.markActive('a'); await s.markActive('a');
  assert.deepEqual(await s.listActive(), ['a']);
  await s.unmarkActive('a'); await s.unmarkActive('a');
  assert.deepEqual(await s.listActive(), []);

  // 保存した Definition は従来どおり isDue へ渡せる
  const t = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-10T01:00:00.000Z' });
  await s.saveDefinition({ definition: t.definition, expectedVersion: '' });
  const back = await s.loadDefinition('expiry-d7');
  assert.equal(isDue({ definition: back, nowMs: NOW }).due, true);
});
