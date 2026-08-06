/**
 * automationStore.test.mjs — 永続化・排他・冪等・突合・ゲートを固定する
 *   node --test src/lib/marketing/automationStore.test.mjs
 *
 * ⚠️ **Redis 本体へは 1 コマンドも送らない。** `cmd` を注入した fake で検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createAutomationStore, autoKey, emailHash, assertNoPii,
  AUTO_ROOT, FOREIGN_PREFIXES, AutomationStoreError, STORE_FAIL,
  DEF_FIELDS, RUN_FIELDS,
} from './automationStore.js';
import {
  selectDueAutomations, isDue, detectDrift, buildEnqueuePlan,
  recheckBeforeDispatch, reconcileRun, RECONCILE, DRIFT, SKIP_TICK,
  MAX_AUTOMATIONS_PER_TICK,
} from './automationScheduler.js';
import { AUTO_SKIP } from './automationEligibility.js';
import {
  buildJobId, buildJobNotes, buildScheduledEmailFields, assertOnlyScheduledFields,
  validateAutomationContext, SCHEDULED_ALLOWED_FIELDS,
} from './marketingEnqueueContract.js';

const NOW = Date.parse('2026-08-06T03:00:00.000Z');   // JST 12:00
const ISO = new Date(NOW).toISOString();

/** 手動クロック付き Redis fake（EVAL は意味論を JS で再現） */
function fakeRedis() {
  const store = new Map();
  const state = { fail: null, unknown: false, fence: 0 };
  const cmd = async (args) => {
    if (state.fail) throw new Error(state.fail);
    if (state.unknown) return undefined;
    const [op, key] = args;
    if (op === 'INCR') { state.fence += 1; store.set(key, String(state.fence)); return state.fence; }
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'SADD') { const s = store.get(key) || new Set(); s.add(args[2]); store.set(key, s); return 1; }
    if (op === 'SREM') { const s = store.get(key); if (s) s.delete(args[2]); return 1; }
    if (op === 'SMEMBERS') { const s = store.get(key); return s ? [...s] : []; }
    if (op === 'SET') {
      const nx = args.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, args[2]);
      return 'OK';
    }
    if (op === 'EVAL') {
      const script = args[1]; const n = Number(args[2]);
      const keys = args.slice(3, 3 + n); const argv = args.slice(3 + n);
      if (script.includes('configVersion')) {           // CAS
        const cur = store.get(keys[0]);
        if (!cur) { if (argv[1] === '') { store.set(keys[0], argv[0]); return 'OK'; } return 'MISSING'; }
        const m = /"configVersion":(\d+)/.exec(cur);
        if (!m || m[1] !== argv[1]) return 'CONFLICT';
        store.set(keys[0], argv[0]); return 'OK';
      }
      if (script.includes("redis.call('DEL', KEYS[1])")) {   // release
        const cur = store.get(keys[0]);
        if (!cur) return 'LOST';
        if (cur !== argv[0]) return 'STOLEN';
        store.delete(keys[0]); return 'OK';
      }
      const cur = store.get(keys[0]);                        // verify
      if (!cur) return 'LOST';
      return cur === argv[0] ? 'OK' : 'STOLEN';
    }
    throw new Error('unsupported ' + op);
  };
  return { cmd, state, store };
}

const def = (over = {}) => ({
  automationId: 'expiry-d7', presetId: 'expiry-d7', name: '期限 7 日前',
  status: 'ACTIVE', enabled: true, campaignId: 'premium-renewal', campaignVersion: 3,
  schedule: 'daily', timezone: 'Asia/Tokyo', quietHours: { start: 21, end: 8 },
  maxRecipients: 200, trigger: { kind: 'days_before_expiry', days: 7 }, audience: {},
  createdAt: ISO, updatedAt: ISO, configVersion: 1, lastRunAt: null, nextRunAt: null,
  ...over,
});

// ── 名前空間 ──────────────────────────────────────────────────

test('鍵はすべて AK 専用 prefix 配下', () => {
  assert.equal(AUTO_ROOT, 'ak:marketing-automation:');
  for (const k of [autoKey.def('a'), autoKey.run('r'), autoKey.lock('a'),
    autoKey.recipient('r', 'h'), autoKey.activeIndex(), autoKey.fence()]) {
    assert.ok(k.startsWith(AUTO_ROOT), `${k} が prefix 外`);
  }
});

test('他用途の鍵空間へ触れない（payment-email / customer-import / KMA）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  for (const p of FOREIGN_PREFIXES) {
    assert.throws(() => s.assertKey(`${p}anything`),
      (e) => e instanceof AutomationStoreError && e.code === STORE_FAIL.OUT_OF_NAMESPACE, `${p} を許可している`);
  }
  for (const bad of ['payemail:dispatch', 'customer-import:lock:global', 'kma:tenant:1', 'other']) {
    assert.throws(() => s.assertKey(bad), (e) => e instanceof AutomationStoreError);
  }
  assert.equal(r.store.size, 0, 'guard を抜けて書き込んだ');
});

// ── PII を保存しない ──────────────────────────────────────────

test('受信者は sha256 だけを鍵に使う（アドレスを保存しない）', () => {
  const h = emailHash('User@Example.invalid');
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(h, emailHash('  user@example.invalid '), '正規化されていない');
  assert.equal(autoKey.recipient('run', h).includes('@'), false, '鍵にアドレスが入っている');
});

test('PII が混ざった Definition / Run は保存しない', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  assert.equal(assertNoPii({ name: '期限 7 日前' }), true, '表示名まで拒否している');
  assert.equal(assertNoPii({ Email: 'a@b.invalid' }), false);
  assert.equal(assertNoPii({ nested: { recipients: ['x'] } }), false);
  assert.equal(assertNoPii({ note: 'contact a@b.invalid' }), false, '文字列中のアドレスを見逃す');
  // 二重の防御: ① 許可外の項目は保存前に落ちる ② 許可項目の中に紛れた PII は拒否する
  await s.saveDefinition({ definition: { ...def(), Email: 'a@b.invalid' }, expectedVersion: '' });
  const saved = await s.loadDefinition('expiry-d7');
  assert.equal('Email' in saved, false, '許可外の Email が保存された');

  await assert.rejects(
    () => s.saveDefinition({ definition: def({ name: '担当 a@b.invalid', configVersion: 2 }), expectedVersion: '1' }),
    (e) => e instanceof AutomationStoreError && e.code === STORE_FAIL.PII_DETECTED,
    '許可項目に紛れた PII を保存してしまう',
  );
});

test('保存する項目は仕様どおり（余計なものを持ち込まない）', () => {
  for (const f of ['automationId', 'presetId', 'name', 'status', 'campaignId', 'campaignVersion',
    'schedule', 'timezone', 'quietHours', 'maxRecipients', 'trigger', 'audience',
    'createdAt', 'updatedAt', 'configVersion', 'lastRunAt', 'nextRunAt']) {
    assert.ok(DEF_FIELDS.includes(f), `Definition に ${f} が無い`);
  }
  for (const f of ['runId', 'automationId', 'operationId', 'status', 'snapshotFingerprint', 'snapshotCount',
    'queued', 'excluded', 'failed', 'startedAt', 'finishedAt', 'configurationVersion',
    'campaignVersion', 'contentHash', 'errorCode', 'reconciliation']) {
    assert.ok(RUN_FIELDS.includes(f), `Run に ${f} が無い`);
  }
});

test('許可外の項目は保存されない（絞り込まれる）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: { ...def(), 勝手な項目: 'x' }, expectedVersion: '' });
  const back = await s.loadDefinition('expiry-d7');
  assert.equal('勝手な項目' in back, false, '許可外が保存された');
});

// ── CAS（lost-update 対策）────────────────────────────────────

test('Definition 更新は version 付き CAS。競合したら書かない', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def({ configVersion: 1 }), expectedVersion: '' });

  // 別の管理者が先に 2 へ上げた
  await s.saveDefinition({ definition: def({ configVersion: 2, name: '先勝ち' }), expectedVersion: '1' });

  // こちらは 1 のつもりで書こうとする → CONFLICT
  await assert.rejects(
    () => s.saveDefinition({ definition: def({ configVersion: 2, name: '後追い' }), expectedVersion: '1' }),
    (e) => e instanceof AutomationStoreError && e.code === STORE_FAIL.CAS_CONFLICT,
  );
  assert.equal((await s.loadDefinition('expiry-d7')).name, '先勝ち', '上書きされた');
});

// ── lock / fencing token ──────────────────────────────────────

test('claim は 1 つだけ通る（scheduler 二重起動）', async () => {
  const r = fakeRedis();
  const a = createAutomationStore({ cmd: r.cmd });
  const b = createAutomationStore({ cmd: r.cmd });
  const c1 = await a.claim({ automationId: 'expiry-d7' });
  const c2 = await b.claim({ automationId: 'expiry-d7' });
  assert.equal(c1.ok, true);
  assert.equal(c2.ok, false);
  assert.equal(c2.reason, 'locked');
});

test('fencing token は単調増加する', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const t1 = await s.nextFencingToken();
  const t2 = await s.nextFencingToken();
  assert.ok(Number(t2) > Number(t1));
});

test('stale scheduler は enqueue できない（所有権の再検証で落ちる）', async () => {
  const r = fakeRedis();
  const a = createAutomationStore({ cmd: r.cmd });
  const b = createAutomationStore({ cmd: r.cmd });
  const old = await a.claim({ automationId: 'expiry-d7' });
  await a.releaseClaim({ automationId: 'expiry-d7', token: old.token });   // 失効を模擬
  const fresh = await b.claim({ automationId: 'expiry-d7' });
  assert.equal(fresh.ok, true);

  const v = await a.verifyClaim({ automationId: 'expiry-d7', token: old.token });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'stolen');
  // 古い token では解放もできない
  assert.equal((await a.releaseClaim({ automationId: 'expiry-d7', token: old.token })).ok, false);
});

test('lock が消えていれば LOST（enqueue しない）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const c = await s.claim({ automationId: 'expiry-d7' });
  await s.releaseClaim({ automationId: 'expiry-d7', token: c.token });
  assert.equal((await s.verifyClaim({ automationId: 'expiry-d7', token: c.token })).reason, 'lost');
});

// ── run の二重開始・recipient claim ───────────────────────────

test('同一 runId の二重開始を atomic に拒否する', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const run = { runId: 'auto:expiry-d7:2026-08-06', automationId: 'expiry-d7', operationId: 'op', status: 'PLANNED' };
  assert.equal((await s.createRun(run)).created, true);
  const again = await s.createRun(run);
  assert.equal(again.created, false);
  assert.equal(again.reason, 'duplicate_run');
});

test('recipient claim は runId + メール hash で一意（二重登録を防ぐ）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const runId = 'auto:expiry-d7:2026-08-06';
  const first = await s.claimRecipients({ runId, emails: ['a@e.invalid', 'b@e.invalid'] });
  assert.equal(first.won.length, 2);
  const second = await s.claimRecipients({ runId, emails: ['A@E.invalid', 'b@e.invalid'] });
  assert.equal(second.won.length, 0, '同じ相手を二度 claim できた');
  assert.equal(second.taken.length, 2);
  // 別の配信回なら取れる
  const other = await s.claimRecipients({ runId: 'auto:expiry-d7:2026-08-07', emails: ['a@e.invalid'] });
  assert.equal(other.won.length, 1);
});

test('claim の戻り値にアドレスを含めない（hash のみ）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const out = await s.claimRecipients({ runId: 'run', emails: ['a@e.invalid'] });
  assert.equal(out.won[0].includes('@'), false);
  assert.match(out.won[0], /^[a-f0-9]{64}$/);
});

// ── fail-closed ───────────────────────────────────────────────

test('Redis 到達不能は例外で伝播する（新規実行に倒さない）', async () => {
  const r = fakeRedis();
  r.state.fail = 'ETIMEDOUT';
  const s = createAutomationStore({ cmd: r.cmd });
  await assert.rejects(() => s.loadDefinition('x'), (e) => e instanceof AutomationStoreError);
  await assert.rejects(() => s.claim({ automationId: 'x' }), (e) => e instanceof AutomationStoreError);
});

test('応答不明を成功扱いにしない', async () => {
  const r = fakeRedis();
  r.state.unknown = true;
  const s = createAutomationStore({ cmd: r.cmd });
  await assert.rejects(() => s.loadDefinition('x'),
    (e) => e instanceof AutomationStoreError && e.code === STORE_FAIL.UNKNOWN_RESULT);
});

test('壊れた JSON は data_corrupt で止める', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  r.store.set(autoKey.def('x'), '{not json');
  await assert.rejects(() => s.loadDefinition('x'),
    (e) => e instanceof AutomationStoreError && e.code === STORE_FAIL.DATA_CORRUPT);
});

// ── scheduler ─────────────────────────────────────────────────

test('due 判定: ACTIVE でない / quiet hours / 同日実行済みは見送る', () => {
  assert.equal(isDue({ definition: def({ status: 'PAUSED' }), nowMs: NOW }).reason, SKIP_TICK.NOT_ACTIVE);
  assert.equal(isDue({ definition: def({ enabled: false }), nowMs: NOW }).reason, SKIP_TICK.NOT_ACTIVE);
  assert.equal(isDue({ definition: def(), nowMs: Date.parse('2026-08-06T13:00:00Z') }).reason, SKIP_TICK.QUIET_HOURS);
  assert.equal(isDue({ definition: def({ lastRunAt: ISO }), nowMs: NOW }).reason, SKIP_TICK.ALREADY_RAN_TODAY);
  const ok = isDue({ definition: def(), nowMs: NOW });
  assert.equal(ok.due, true);
  assert.equal(ok.occurrenceDate, '2026-08-06');
});

test('1 tick で扱う automation 数に上限がある', () => {
  const defs = Array.from({ length: 10 }, (_, i) => def({ automationId: `a${i}` }));
  const { due, skipped } = selectDueAutomations({ definitions: defs, nowMs: NOW });
  assert.equal(due.length, MAX_AUTOMATIONS_PER_TICK);
  assert.equal(skipped[SKIP_TICK.TICK_LIMIT], 10 - MAX_AUTOMATIONS_PER_TICK);
});

test('同一 JST 日の runId は決定的（重複起動でも 1 つ）', () => {
  const defs = [def()];
  const a = selectDueAutomations({ definitions: defs, nowMs: NOW }).due[0].runId;
  const b = selectDueAutomations({ definitions: defs, nowMs: NOW + 3600_000 }).due[0].runId;
  assert.equal(a, b);
  assert.equal(a, 'auto:expiry-d7:2026-08-06');
});

test('quiet hours 境界（JST 20:59 は可 / 21:00 は不可）', () => {
  const at = (iso) => isDue({ definition: def(), nowMs: Date.parse(iso) }).due;
  assert.equal(at('2026-08-06T11:59:00Z'), true);   // JST 20:59
  assert.equal(at('2026-08-06T12:00:00Z'), false);  // JST 21:00
  assert.equal(at('2026-08-05T22:59:00Z'), false);  // JST 07:59
  assert.equal(at('2026-08-05T23:00:00Z'), true);   // JST 08:00
});

test('timezone は固定オフセットで判定する（DST に依存しない）', () => {
  // 1 月と 8 月で同じ UTC 時刻 → 同じ JST 時刻として扱われる
  const jan = isDue({ definition: def(), nowMs: Date.parse('2026-01-06T12:00:00Z') }).due;
  const aug = isDue({ definition: def(), nowMs: Date.parse('2026-08-06T12:00:00Z') }).due;
  assert.equal(jan, aug, 'DST で判定が変わっている');
});

// ── drift 検知 ────────────────────────────────────────────────

test('snapshot 増加 / campaignVersion 変更 / contentHash 変更を検知する', () => {
  // ⚠️ 承認済み snapshot（指紋 + 件数）が無いと件数比較へ進まない仕様なので、指紋を持たせる
  const base = { snapshotFingerprint: 'fp', snapshotCount: 10, campaignVersion: '3', contentHash: 'abc' };
  assert.equal(detectDrift({ dryRun: base, current: base }).ok, true);
  assert.deepEqual(detectDrift({ dryRun: base, current: { ...base, snapshotCount: 11 } }).drifts, [DRIFT.SNAPSHOT_GREW]);
  assert.deepEqual(detectDrift({ dryRun: base, current: { ...base, campaignVersion: '4' } }).drifts, [DRIFT.CAMPAIGN_VERSION_CHANGED]);
  assert.deepEqual(detectDrift({ dryRun: base, current: { ...base, contentHash: 'zzz' } }).drifts, [DRIFT.CONTENT_HASH_CHANGED]);
  // 減っているのは安全側（drift ではない）
  assert.equal(detectDrift({ dryRun: base, current: { ...base, snapshotCount: 8 } }).ok, true);
});

test('上限超過は切り捨てず停止する（部分送信の曖昧さを作らない）', () => {
  const recipients = Array.from({ length: 300 }, (_, i) => ({ email: `u${i}@e.invalid` }));
  const over = buildEnqueuePlan({ recipients, maxRecipients: 200 });
  assert.equal(over.ok, false);
  assert.equal(over.plan.length, 0, '切り捨てて送ろうとしている');
  const tick = buildEnqueuePlan({ recipients, maxRecipients: 1000, tickBudget: 100 });
  assert.equal(tick.ok, false);
  assert.equal(tick.reason, SKIP_TICK.TICK_LIMIT);
  assert.equal(buildEnqueuePlan({ recipients: recipients.slice(0, 50), maxRecipients: 200 }).ok, true);
});

// ── 配信直前の再判定 ──────────────────────────────────────────

test('配信直前に有料化・配信停止・バウンスした相手は送らない', () => {
  const definition = { ...def(), audienceRule: { contracts: [], plans: ['free'], enforce: true },
    trigger: { kind: 'plan_state' }, minResendIntervalDays: 0 };
  const candidates = [
    { email: 'free@e.invalid', deliveryKey: 'k1' },
    { email: 'paid@e.invalid', deliveryKey: 'k2' },
    { email: 'stop@e.invalid', deliveryKey: 'k3' },
    { email: 'bounce@e.invalid', deliveryKey: 'k4' },
    { email: 'sent@e.invalid', deliveryKey: 'k5' },
  ];
  const recordsByEmail = {
    'free@e.invalid': { fields: { Email: 'free@e.invalid', 'プラン': 'Free' } },
    'paid@e.invalid': { fields: { Email: 'paid@e.invalid', 'プラン': 'Premium', Status: 'active', '有効期限': '2026-12-31' } },
    'stop@e.invalid': { fields: { Email: 'stop@e.invalid', 'プラン': 'Free', UnsubscribedAnalyticsKeiba: true } },
    'bounce@e.invalid': { fields: { Email: 'bounce@e.invalid', 'プラン': 'Free' } },
    'sent@e.invalid': { fields: { Email: 'sent@e.invalid', 'プラン': 'Free' } },
  };
  const out = recheckBeforeDispatch({
    candidates, recordsByEmail, definition, nowMs: NOW,
    blacklistEmails: new Set(['bounce@e.invalid']),
    sentDeliveryKeys: new Set(['k5']),
  });
  assert.deepEqual(out.send.map((c) => c.email), ['free@e.invalid']);
  assert.equal(out.drop.length, 4);
  assert.equal(out.reasons[AUTO_SKIP.AUDIENCE_MISMATCH], 1);   // 有料化
  assert.equal(out.reasons[AUTO_SKIP.SUPPRESSED], 2);          // 配信停止 + バウンス
  assert.equal(out.reasons[AUTO_SKIP.ALREADY_QUEUED], 1);      // 既送信
});

// ── 突合 ──────────────────────────────────────────────────────

test('4 系統が一致すれば OK・続行可', () => {
  const r = reconcileRun({
    run: { snapshotCount: 10, queued: 8, excluded: 2, failed: 0 },
    recipientClaims: 8, scheduledRecipientCount: 8, deliveryQueued: 8, deliverySent: 0, emailEventsAccepted: 0,
  });
  assert.equal(r.verdict, RECONCILE.OK);
  assert.equal(r.canContinue, true);
});

test('件数が合わなければ BLOCKED（自動続行しない・再送しない）', () => {
  const r = reconcileRun({
    run: { snapshotCount: 10, queued: 8, excluded: 2, failed: 0 },
    recipientClaims: 5, scheduledRecipientCount: 8, deliveryQueued: 8, deliverySent: 0,
  });
  assert.equal(r.verdict, RECONCILE.BLOCKED);
  assert.equal(r.canContinue, false);
  assert.ok(r.failedChecks.includes('claims_match_queued'));
  assert.match(r.note, /送信済みは再送しません/);
});

test('失敗が残れば PARTIAL（続行しない）', () => {
  const r = reconcileRun({
    run: { snapshotCount: 10, queued: 7, excluded: 2, failed: 1 },
    recipientClaims: 7, scheduledRecipientCount: 7, deliveryQueued: 7, deliverySent: 0,
  });
  assert.equal(r.verdict, RECONCILE.PARTIAL);
  assert.equal(r.canContinue, false);
});

test('provider 受理は実配信と混同しない（queued を超えたら BLOCKED）', () => {
  const r = reconcileRun({
    run: { snapshotCount: 5, queued: 5, excluded: 0, failed: 0 },
    recipientClaims: 5, scheduledRecipientCount: 5, deliveryQueued: 0, deliverySent: 5, emailEventsAccepted: 6,
  });
  assert.equal(r.verdict, RECONCILE.BLOCKED);
  assert.ok(r.failedChecks.includes('events_within_queued'));
});

// ── enqueue 共通契約 ──────────────────────────────────────────

test('手動送信と自動配信が同じ関数で同じ形の行を作る', () => {
  const fields = buildScheduledEmailFields({
    subject: 'S', html: '<p>x</p>', emails: ['a@e.invalid', 'b@e.invalid'],
    scheduledAtIso: ISO, jobId: 'mkt-x-v1-abc-1', campaignId: 'x', notes: 'n',
  });
  assert.deepEqual(Object.keys(fields).sort(), [...SCHEDULED_ALLOWED_FIELDS].sort());
  assert.equal(fields.Status, 'PENDING');
  assert.equal(fields.CreatedBy, 'admin-marketing');
  assert.equal(fields.TargetPlan, 'campaign:x');
  assert.equal(fields.RecipientCount, 2);
  assert.equal(assertOnlyScheduledFields(fields), true);
});

test('許可外の列が混ざったら弾く', () => {
  assert.equal(assertOnlyScheduledFields({ Subject: 'a', PlanType: 'Annual' }), false);
  assert.equal(assertOnlyScheduledFields({}), false);
});

test('JobId は既存の mkt- 接頭辞を保ち、自動化では runId を含む', () => {
  const manual = buildJobId({ campaignId: 'c', version: 2, fingerprint: 'abcdef1234', index: 1 });
  assert.match(manual, /^mkt-c-v2-abcdef12-1$/);
  const auto = buildJobId({ campaignId: 'c', version: 2, index: 1, automationRunId: 'auto:expiry-d7:2026-08-06' });
  assert.ok(auto.startsWith('mkt-'), '既存 dispatcher の判定から外れる');
  assert.ok(auto.includes('auto-expiry-d7-2026-08-06'));
});

test('Notes に自動化の追跡情報を刻む（アドレスは入れない）', () => {
  const n = buildJobNotes({
    campaignId: 'c', campaignVersion: 2, shellVersionNote: 'shell:v1', contentHash: 'abcdef123456789',
    automationId: 'expiry-d7', automationRunId: 'auto:expiry-d7:2026-08-06',
    operationId: 'auto:expiry-d7:2026-08-06#001', snapshotFingerprint: 'fp1234567890ab',
  });
  assert.match(n, /auto:expiry-d7/);
  assert.match(n, /run:auto:expiry-d7:2026-08-06/);
  assert.match(n, /op:.*#001/);
  assert.match(n, /snap:fp1234567890/);
  assert.equal(n.includes('@'), false, 'アドレスが入っている');
});

test('自動化 enqueue では固定すべき文脈が欠けたら通さない', () => {
  const full = {
    automationId: 'a', automationRunId: 'r', operationId: 'o', recipientKey: 'k',
    campaignId: 'c', campaignVersion: 1, shellVersion: 'v1', contentHash: 'h',
    scheduledAt: ISO, eligibilityEvaluatedAt: ISO, snapshotFingerprint: 'f',
  };
  assert.equal(validateAutomationContext(full).ok, true);
  for (const k of Object.keys(full)) {
    const partial = { ...full, [k]: '' };
    const v = validateAutomationContext(partial);
    assert.equal(v.ok, false, `${k} が欠けても通ってしまう`);
    assert.ok(v.missing.includes(k));
  }
});

// ── scheduler Function のハードゲート ─────────────────────────

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8',
);

test('guard: ゲート未設定なら Redis / Airtable へ接続しない', async () => {
  const { readGates, runScheduledTick, ARMED_ENV } = await import('../../../netlify/functions/cron-marketing-automation.js');
  const NOWMS = Date.parse('2026-08-06T05:00:00.000Z');
  const TODAY = '2026-08-06';
  assert.equal(readGates({}, NOWMS).allOpen, false);
  assert.equal(readGates({ MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true' }, NOWMS).allOpen, false);
  assert.equal(readGates({
    MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true',
    MARKETING_CAMPAIGN_ENABLED: 'true',
  }, NOWMS).allOpen, false, '2 つでも開いてしまう');
  // ⚠️ 既存 2 env は本番で既に true。**自動化専用の当日武装**が無ければ開かない
  assert.equal(readGates({
    MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true',
    MARKETING_CAMPAIGN_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  }, NOWMS).allOpen, false, '当日武装なしで開いてしまう');
  assert.equal(readGates({
    MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true',
    MARKETING_CAMPAIGN_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
    [ARMED_ENV]: TODAY,
  }, NOWMS).allOpen, true);

  // 実際に叩いても Redis へ 1 回も出ない
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  try {
    // ⚠️ Scheduled Function（v2）方式。scheduled 実行の本文（{ next_run }）で叩き、
    //    ゲートが閉じていることを確かめる
    const res = await runScheduledTick({
      payload: { next_run: '2026-08-07T01:00:00.000Z' },
      env: { MARKETING_CAMPAIGN_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' },
    });
    const body = res.body;
    assert.equal(res.statusCode, 200);
    assert.equal(body.ran, false);
    assert.equal(body.reason, 'gates_closed');
    assert.deepEqual(body.接続, { redis: false, airtable: false });
    assert.equal(calls, 0, 'ゲート閉なのに接続した');
  } finally { globalThis.fetch = prevFetch; }
});

test('guard: ゲート判定は store 初期化より前にある', () => {
  const gateAt = CRON.indexOf('if (!gates.allOpen)');
  const storeAt = CRON.indexOf('createAutomationStore({ cmd: redisCmd })');
  assert.ok(gateAt > -1 && gateAt < storeAt, 'ゲートが store 初期化より後ろ');
});

test('guard: scheduler はメールを送らず Customers も書かない', () => {
  // ⚠️ 2026-08-06: enqueue を配線したので Airtable への POST は**持つ**ようになった。
  //    ただし作ってよいのは **ScheduledEmails の PENDING 行だけ**で、
  //    送信 API を呼ばない・Customers を書かない・更新削除しない、は変わらない。
  for (const bad of ['mail/send', '@sendgrid/mail', "method: 'PATCH'", "method: 'DELETE'"]) {
    assert.equal(CRON.includes(bad), false, `${bad} を持っている`);
  }
  // Airtable へ触るのは ScheduledEmails のみ（**コメントではなく実コード**で判定）
  const code = CRON.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const tables = [...code.matchAll(/encodeURIComponent\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ['ScheduledEmails'], '他のテーブルを触っている');
  assert.equal(code.includes('Customers'), false, 'Customers を実コードで参照している');
  // enqueue は専用 env が開くまで動かない
  assert.match(CRON, /MARKETING_AUTOMATION_ENQUEUE_ENABLED === 'true'/);
});

test('guard: scheduler は AK 専用 prefix しか使わない', () => {
  assert.match(CRON, /AUTO_ROOT/);
  for (const bad of ['payemail:', 'customer-import:', 'kma:', 'tenant']) {
    assert.equal(CRON.includes(bad), false, `他用途の鍵空間を参照: ${bad}`);
  }
});
