/**
 * prospectPool.test.mjs — 見込み客プールの規約を固定する
 *   node --test src/lib/marketing/prospectPool.test.mjs
 *
 * ⚠️ 実 Redis / 実 Airtable / 実送信は一切行わない（fake だけ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PROSPECT_STATE, SUPPRESS_REASON, SKIP_REASON, ENGAGEMENT_KIND,
  MAX_SENDS_WITHOUT_ENGAGEMENT, MIN_DAYS_BETWEEN_SENDS,
  buildProspect, classifyEvent, evaluateProspectForSend, applySend,
  applyEngagement, applySuppression, applyPromotion, evaluateForPromotion,
  planProspectIntake, summarizeProspects,
} from './prospectPolicy.js';
import {
  createProspectStore, emailHash, prospectKey, blockedKey, PROSPECT_ROOT,
  ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX, PROSPECT_FIELDS, BLOCKED_FIELDS,
  ProspectStoreError, ttlForState, BLOCK_KIND,
} from './prospectStore.js';
import {
  createSnapshotStore, evaluateSnapshot, buildChunks, SnapshotError,
  SNAPSHOT_FAIL, SNAPSHOT_ROOT, META_KEY,
} from './customerSnapshotCache.js';
import {
  buildProspectAudience, mergeAudiences, planPromotions, planProspectEventUpdates,
} from './prospectPipeline.js';
import { createProspectAdminApi, isProspectWriteEnabled, INTAKE_MAX_ROWS } from './prospectAdminApi.js';
import { planTickDelivery, TICK_ABORT } from './automationTickPlan.js';

const FN = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing-prospect.js', import.meta.url)), 'utf8');
const HOOK = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url)), 'utf8');

const NOW = Date.parse('2026-08-10T01:00:00.000Z');   // JST 10:00
const day = (n) => NOW + n * 86400000;

function fakeRedis(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  const cmd = async (a) => {
    calls.push(a);
    const [op, key] = a;
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'SET') { store.set(key, a[2]); return 'OK'; }
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'SADD') { const s = store.get(key) || new Set(); s.add(a[2]); store.set(key, s); return 1; }
    if (op === 'SREM') { const s = store.get(key); if (s) s.delete(a[2]); return 1; }
    if (op === 'SMEMBERS') { const s = store.get(key); return s ? [...s] : []; }
    if (op === 'SCARD') { const s = store.get(key); return s ? s.size : 0; }
    if (op === 'MGET') return a.slice(1).map((k) => (store.has(k) ? store.get(k) : null));
    return 'OK';
  };
  return { cmd, store, calls };
}

// ── 状態機械 ──────────────────────────────────────────────────

test('反応が無いまま上限回数を送ったら EXHAUSTED になり、以後送らない', () => {
  let p = buildProspect({ email: 'a@example.invalid', nowMs: NOW });
  assert.equal(p.state, PROSPECT_STATE.NEW);

  for (let i = 1; i <= MAX_SENDS_WITHOUT_ENGAGEMENT; i += 1) {
    const v = evaluateProspectForSend({ prospect: p, nowMs: day(i * MIN_DAYS_BETWEEN_SENDS), isCustomer: false });
    assert.equal(v.send, true, `${i} 回目が送れない`);
    p = applySend({ prospect: p, nowMs: day(i * MIN_DAYS_BETWEEN_SENDS), runId: `r${i}` });
  }
  assert.equal(p.sends, MAX_SENDS_WITHOUT_ENGAGEMENT);
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED);

  const after = evaluateProspectForSend({ prospect: p, nowMs: day(99), isCustomer: false });
  assert.equal(after.send, false);
  assert.equal(after.reason, SKIP_REASON.EXHAUSTED);
});

test('1 回でも反応したら ENGAGED になり、昇格対象になる', () => {
  let p = buildProspect({ email: 'a@example.invalid', nowMs: NOW });
  p = applySend({ prospect: p, nowMs: NOW, runId: 'r1' });
  const r = applyEngagement({ prospect: p, nowMs: day(1), kind: ENGAGEMENT_KIND.OPEN });
  assert.equal(r.changed, true);
  assert.equal(r.prospect.state, PROSPECT_STATE.ENGAGED);
  assert.equal(evaluateForPromotion({ prospect: r.prospect, isCustomer: false }).promote, true);
  // 反応済みは prospect としては送らない（昇格後に Customers 側で送る）
  assert.equal(evaluateProspectForSend({ prospect: r.prospect, nowMs: day(9) }).send, false);
});

test('除外は即時で、反応より優先され、あとから復活しない', () => {
  let p = buildProspect({ email: 'a@example.invalid', nowMs: NOW });
  p = applySuppression({ prospect: p, nowMs: NOW, reason: SUPPRESS_REASON.COMPLAINT }).prospect;
  assert.equal(p.state, PROSPECT_STATE.SUPPRESSED);
  assert.equal(p.suppressedReason, SUPPRESS_REASON.COMPLAINT);

  // 苦情の後に開封しても戻らない
  const e = applyEngagement({ prospect: p, nowMs: day(1), kind: ENGAGEMENT_KIND.OPEN });
  assert.equal(e.changed, false);
  assert.equal(e.prospect.state, PROSPECT_STATE.SUPPRESSED);
  assert.equal(evaluateProspectForSend({ prospect: p, nowMs: day(9) }).reason, SKIP_REASON.SUPPRESSED);
  assert.equal(evaluateForPromotion({ prospect: p, isCustomer: false }).reason, SKIP_REASON.SUPPRESSED);
});

test('連続で送らない（最小間隔）', () => {
  let p = buildProspect({ email: 'a@example.invalid', nowMs: NOW });
  p = applySend({ prospect: p, nowMs: NOW, runId: 'r1' });
  assert.equal(evaluateProspectForSend({ prospect: p, nowMs: day(1) }).reason, SKIP_REASON.TOO_SOON);
  assert.equal(evaluateProspectForSend({ prospect: p, nowMs: day(MIN_DAYS_BETWEEN_SENDS) }).send, true);
});

test('SendGrid のイベント種別の翻訳（知らないものは無視）', () => {
  assert.equal(classifyEvent('open').engagement, ENGAGEMENT_KIND.OPEN);
  assert.equal(classifyEvent('click').engagement, ENGAGEMENT_KIND.CLICK);
  for (const [t, r] of [['bounce', SUPPRESS_REASON.BOUNCE], ['blocked', SUPPRESS_REASON.BOUNCE],
    ['dropped', SUPPRESS_REASON.DROPPED], ['spamreport', SUPPRESS_REASON.COMPLAINT],
    ['unsubscribe', SUPPRESS_REASON.UNSUBSCRIBE], ['group_unsubscribe', SUPPRESS_REASON.UNSUBSCRIBE]]) {
    assert.equal(classifyEvent(t).kind, 'suppress', t);
    assert.equal(classifyEvent(t).reason, r, t);
  }
  // 配信成功は反応ではない
  for (const t of ['delivered', 'processed', 'deferred', '', null, 'unknown']) {
    assert.equal(classifyEvent(t).kind, 'ignore', String(t));
  }
});

// ── 重複登録・二重送信の防止 ──────────────────────────────────

test('既存 Customers のアドレスは prospect にしない', () => {
  const plan = planProspectIntake({
    rows: [{ email: 'A@Example.invalid' }, { email: 'b@example.invalid' }],
    customerEmails: new Set(['a@example.invalid']),
    existingEmails: new Set(), blacklistEmails: new Set(), nowMs: NOW, batchId: 'b1',
  });
  assert.equal(plan.add.length, 1);
  assert.equal(plan.add[0].email, 'b@example.invalid');
  assert.equal(plan.skipped[SKIP_REASON.ALREADY_CUSTOMER], 1);
});

test('取り込みは入力内の重複・既存 prospect・配信停止・不正アドレスを弾く', () => {
  const plan = planProspectIntake({
    rows: [
      { email: 'dup@example.invalid' }, { email: 'dup@example.invalid' },
      { email: 'known@example.invalid' }, { email: 'stop@example.invalid' },
      { email: 'bad' }, { email: '' },
    ],
    customerEmails: new Set(),
    existingEmails: new Set(['known@example.invalid']),
    blacklistEmails: new Set(['stop@example.invalid']),
    nowMs: NOW, batchId: 'b1',
  });
  assert.equal(plan.add.length, 1);
  assert.equal(plan.skipped.duplicate_in_input, 1);
  assert.equal(plan.skipped.already_prospect, 1);
  assert.equal(plan.skipped[SUPPRESS_REASON.UNSUBSCRIBE], 1);
  assert.equal(plan.skipped.invalid_address, 2);
});

test('Customers と prospect に同じ人が居たら Customers を優先して二重送信しない', () => {
  const merged = mergeAudiences({
    customerRecipients: [{ email: 'a@example.invalid' }, { email: 'b@example.invalid' }],
    prospectRecipients: [{ email: 'A@example.invalid' }, { email: 'c@example.invalid' }],
  });
  assert.equal(merged.recipients.length, 3);
  assert.equal(merged.dropped.prospect_duplicate_of_customer, 1);
  assert.equal(merged.counts.customer, 2);
  assert.equal(merged.counts.prospect, 1);
  assert.equal(merged.recipients.filter((r) => r.email === 'a@example.invalid').length, 1);
});

test('同じ配信回で同じ相手を 2 回入れない', () => {
  const p = { ...buildProspect({ email: 'a@example.invalid', nowMs: NOW }) };
  const res = buildProspectAudience({
    prospects: [p, { ...p }], customerEmails: new Set(), blacklistEmails: new Set(),
    nowMs: NOW, runId: 'r1', buildKey: (e) => `r1:${e}`,
  });
  assert.equal(res.recipients.length, 1);
  assert.equal(res.skipped[SKIP_REASON.ALREADY_SENT_THIS_RUN], 1);
});

test('配信停止リストは Redis の状態より優先して即除外', () => {
  const p = buildProspect({ email: 'stop@example.invalid', nowMs: NOW });
  const res = buildProspectAudience({
    prospects: [p], customerEmails: new Set(),
    blacklistEmails: new Set(['stop@example.invalid']),
    nowMs: NOW, runId: 'r1',
  });
  assert.equal(res.recipients.length, 0);
  assert.equal(res.skipped[SKIP_REASON.SUPPRESSED], 1);
});

// ── 昇格（Airtable へは反応した人だけ）──────────────────────────

test('昇格するのは反応済みだけ。既存顧客は昇格しない', () => {
  const engaged = applyEngagement({
    prospect: buildProspect({ email: 'e@example.invalid', nowMs: NOW }), nowMs: NOW, kind: 'open',
  }).prospect;
  const plan = planPromotions({
    prospects: [
      engaged,
      buildProspect({ email: 'new@example.invalid', nowMs: NOW }),                 // 未反応
      applySuppression({ prospect: buildProspect({ email: 's@example.invalid', nowMs: NOW }), nowMs: NOW, reason: 'bounce' }).prospect,
      { ...engaged, email: 'dup@example.invalid' },                                 // 既存顧客
    ],
    customerEmails: new Set(['dup@example.invalid']),
    nowIso: '2026-08-10T01:00:00.000Z', batchId: 'prospect-2026-08-10',
  });
  assert.equal(plan.promote.length, 1);
  assert.equal(plan.promote[0].email, 'e@example.invalid');
  assert.equal(plan.skipped[SKIP_REASON.NOT_ELIGIBLE], 1);
  assert.equal(plan.skipped[SKIP_REASON.SUPPRESSED], 1);
  assert.equal(plan.skipped[SKIP_REASON.ALREADY_CUSTOMER], 1);
});

test('昇格で書く列は取り込みと同じ allow-list（課金・権利列を含まない）', () => {
  const engaged = applyEngagement({
    prospect: buildProspect({ email: 'e@example.invalid', nowMs: NOW }), nowMs: NOW, kind: 'open',
  }).prospect;
  const plan = planPromotions({
    prospects: [engaged], customerEmails: new Set(),
    nowIso: '2026-08-10T01:00:00.000Z', batchId: 'prospect-2026-08-10',
  });
  const keys = Object.keys(plan.promote[0].fields);
  assert.deepEqual(keys.sort(), ['Email', 'Source', 'ポイント', 'プラン'].sort());
  for (const forbidden of ['PlanType', 'Status', '有効期限', 'PaymentConfirmed',
    'LifetimeSanrenpuku', 'UnsubscribedAnalyticsKeiba']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} を書こうとしている`);
  }
  assert.equal(plan.promote[0].fields['プラン'], 'Free');
});

test('昇格後は送信候補から外れる', () => {
  const promoted = applyPromotion({
    prospect: applyEngagement({
      prospect: buildProspect({ email: 'e@example.invalid', nowMs: NOW }), nowMs: NOW, kind: 'open',
    }).prospect,
    nowMs: NOW,
  });
  assert.equal(promoted.state, PROSPECT_STATE.PROMOTED);
  assert.equal(evaluateProspectForSend({ prospect: promoted, nowMs: day(9) }).reason, SKIP_REASON.PROMOTED);
  assert.equal(evaluateForPromotion({ prospect: promoted }).reason, SKIP_REASON.PROMOTED);
});

// ── webhook のイベント反映 ────────────────────────────────────

test('同じ相手に反応と除外が来たら除外に倒す', () => {
  const { updates, counts } = planProspectEventUpdates({
    events: [
      { email: 'a@example.invalid', event: 'open' },
      { email: 'a@example.invalid', event: 'spamreport' },
      { email: 'b@example.invalid', event: 'click' },
      { email: 'c@example.invalid', event: 'delivered' },
    ],
    classify: classifyEvent,
  });
  assert.equal(updates.length, 2);
  assert.equal(counts.除外, 1);
  assert.equal(counts.反応, 1);
  const a = updates.find((u) => u.email === 'a@example.invalid');
  assert.equal(a.action, 'suppress');
  assert.equal(a.reason, SUPPRESS_REASON.COMPLAINT);
});

// ── ストア ────────────────────────────────────────────────────

test('キーは sha256 でアドレスを含まない / 名前空間の外は拒否', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const h = emailHash('a@example.invalid');
  assert.equal(prospectKey(h).includes('a@example.invalid'), false);
  assert.match(prospectKey(h), new RegExp(`^${PROSPECT_ROOT}p:[a-f0-9]{64}$`));
  for (const k of ['ak:marketing-automation:def:x', 'payemail:x', 'customer-import:lock:global', 'kma:t']) {
    assert.throws(() => s.assertKey(k), (e) => e instanceof ProspectStoreError);
  }
  assert.equal(s.assertKey(ACTIVE_INDEX), ACTIVE_INDEX);
});

test('保存項目は allow-list のみ / prospect レコードに TTL を付けない', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  await s.addIfAbsent({ ...buildProspect({ email: 'a@example.invalid', nowMs: NOW }), 余計な列: 'x' });
  const saved = JSON.parse(r.store.get(prospectKey(emailHash('a@example.invalid'))));
  for (const k of Object.keys(saved)) assert.ok(PROSPECT_FIELDS.includes(k), `${k} を保存している`);
  assert.equal(saved['余計な列'], undefined);

  // ⚠️ TTL で消すと CSV 再取り込みで復活する。**どの状態でも TTL は付けない**
  for (const st of Object.values(PROSPECT_STATE)) assert.equal(ttlForState(st), null, st);
  const setCalls = r.calls.filter((c) => c[0] === 'SET' && String(c[1]).includes(':p:'));
  for (const c of setCalls) assert.equal(c.includes('EX'), false, 'prospect に TTL を付けている');
});

test('索引は状態と必ず揃う（送信候補・反応済み）', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const email = 'a@example.invalid';
  const h = emailHash(email);
  await s.addIfAbsent(buildProspect({ email, nowMs: NOW }));
  assert.deepEqual(await s.activeHashes(), [h]);
  assert.deepEqual(await s.engagedHashes(), []);

  await s.recordEngagement({ email, nowMs: NOW, kind: 'open' });
  assert.deepEqual(await s.activeHashes(), [], '反応済みが送信候補に残っている');
  assert.deepEqual(await s.engagedHashes(), [h]);

  await s.recordPromotion({ email, nowMs: NOW });
  assert.deepEqual(await s.engagedHashes(), [], '昇格済みが昇格待ちに残っている');
  assert.deepEqual(await s.activeHashes(), []);
});

test('既にある prospect を取り込みで上書きしない（送信回数・除外を消さない）', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const email = 'a@example.invalid';
  await s.addIfAbsent(buildProspect({ email, nowMs: NOW }));
  await s.recordSend({ email, nowMs: NOW, runId: 'r1' });
  const again = await s.addIfAbsent(buildProspect({ email, nowMs: day(1) }));
  assert.equal(again.added, false);
  assert.equal((await s.load(email)).sends, 1, '送信回数が消えた');
});

test('索引の応答が配列でなければ fail-closed', async () => {
  const s = createProspectStore({ cmd: async (a) => (a[0] === 'SMEMBERS' ? 'nope' : 'OK') });
  await assert.rejects(() => s.activeHashes(), (e) => e instanceof ProspectStoreError);
});

// ── 管理 API ──────────────────────────────────────────────────

function makeApi({ redis, env = { MARKETING_PROSPECT_WRITE_ENABLED: 'true' },
  customers = new Set(), blacklist = new Set(), created } = {}) {
  return createProspectAdminApi({
    store: createProspectStore({ cmd: redis.cmd }), env, now: () => NOW,
    loadCustomerEmails: async () => customers,
    loadBlacklist: async () => blacklist,
    createCustomers: created || (async (list) => ({ created: list.length, okIndexes: new Set(list.map((_, i) => i)) })),
    availableFields: null,
  });
}

test('status / preview は書き込まず、アドレスを返さない', async () => {
  const r = fakeRedis();
  const api = makeApi({ redis: r });
  await api.intake({ rows: [{ email: 'a@example.invalid' }], batchId: 'b1' });

  const st = await api.status();
  assert.equal(st.ok, true);
  assert.equal(st.件数.送信候補, 1);
  assert.equal(JSON.stringify(st).includes('@example.invalid'), false, 'アドレスを返している');

  const pv = await api.preview({ runId: 'r1' });
  assert.equal(pv.dryRun, true);
  assert.equal(pv.sideEffects, 'none');
  assert.equal(pv.件数.対象, 1);
  assert.equal(JSON.stringify(pv).includes('@example.invalid'), false);
});

test('取り込み → 反応 → 昇格の一連が通り、Customers へは 1 件だけ作る', async () => {
  const r = fakeRedis();
  const createdCalls = [];
  const api = makeApi({
    redis: r,
    created: async (list) => { createdCalls.push(list); return { created: list.length, okIndexes: new Set(list.map((_, i) => i)) }; },
  });
  await api.intake({ rows: [{ email: 'a@example.invalid' }, { email: 'b@example.invalid' }], batchId: 'b1' });

  // a だけ反応
  const s = createProspectStore({ cmd: r.cmd });
  await s.recordEngagement({ email: 'a@example.invalid', nowMs: NOW, kind: 'open' });

  const pp = await api.promotionPreview({ batchId: 'b1' });
  assert.equal(pp.件数.登録予定, 1);

  const res = await api.promote({ batchId: 'b1', confirmCount: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.作成, 1);
  assert.equal(createdCalls.length, 1);
  assert.equal(createdCalls[0].length, 1);
  assert.equal(createdCalls[0][0].Email, 'a@example.invalid');
  assert.equal((await s.load('a@example.invalid')).state, PROSPECT_STATE.PROMOTED);
  // 無反応の b は登録されない
  assert.equal((await s.load('b@example.invalid')).state, PROSPECT_STATE.NEW);
});

test('下見と件数が食い違ったら昇格しない（TOCTOU）', async () => {
  const r = fakeRedis();
  let called = 0;
  const api = makeApi({ redis: r, created: async (l) => { called += 1; return { created: l.length, okIndexes: new Set() }; } });
  await api.intake({ rows: [{ email: 'a@example.invalid' }], batchId: 'b1' });
  await createProspectStore({ cmd: r.cmd }).recordEngagement({ email: 'a@example.invalid', nowMs: NOW, kind: 'open' });

  const res = await api.promote({ batchId: 'b1', confirmCount: 5 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'count_mismatch');
  assert.equal(called, 0, '不一致なのに Airtable へ書いた');
});

test('取り込みは 1 回の上限を超えたら受け付けない', async () => {
  const r = fakeRedis();
  const api = makeApi({ redis: r });
  const rows = Array.from({ length: INTAKE_MAX_ROWS + 1 }, (_, i) => ({ email: `x${i}@example.invalid` }));
  const res = await api.intake({ rows, batchId: 'b1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'too_many_rows');
});

test('write ゲートの判定', () => {
  assert.equal(isProspectWriteEnabled({ MARKETING_PROSPECT_WRITE_ENABLED: 'true' }), true);
  for (const env of [{}, null, { MARKETING_PROSPECT_WRITE_ENABLED: 'false' },
    { MARKETING_PROSPECT_WRITE_ENABLED: '1' }]) {
    assert.equal(isProspectWriteEnabled(env), false);
  }
});

// ── tick の計画 ───────────────────────────────────────────────

const DEF = {
  automationId: 'expiry-d7', campaignId: 'premium-renewal', campaignVersion: '2',
  shellVersion: '1', contentHash: 'hash', snapshotFingerprint: 'fp',
  snapshotCount: 2, snapshotOccurrenceDate: '2026-08-10',
};

test('承認した対象と違えば tick は何もしない', () => {
  const r = planTickDelivery({
    definition: DEF, occurrenceDate: '2026-08-10', runId: 'expiry-d7#2026-08-10',
    currentFingerprint: 'CHANGED', currentCount: 2,
    customerRecipients: [{ email: 'a@example.invalid' }], prospectRecipients: [],
    nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.abort, TICK_ABORT.SNAPSHOT_DRIFT);
});

test('上限を超えたら切り捨てず中止する', () => {
  const r = planTickDelivery({
    definition: DEF, occurrenceDate: '2026-08-10', runId: 'expiry-d7#2026-08-10',
    currentFingerprint: 'fp', currentCount: 2,
    customerRecipients: [{ email: 'a@example.invalid' }, { email: 'b@example.invalid' }],
    prospectRecipients: [], maxRecipients: 1, nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.abort, TICK_ABORT.OVER_MAX);
});

test('計画は customer と prospect を 1 本にし、prospect の送信記録対象を分けて返す', () => {
  const r = planTickDelivery({
    definition: DEF, occurrenceDate: '2026-08-10', runId: 'expiry-d7#2026-08-10',
    currentFingerprint: 'fp', currentCount: 2,
    customerRecipients: [{ email: 'a@example.invalid' }],
    prospectRecipients: [{ email: 'p@example.invalid' }, { email: 'A@example.invalid' }],
    nowMs: NOW,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.counts.合計, 2);
  assert.deepEqual(r.plan.prospectEmailsToRecord, ['p@example.invalid']);
  assert.equal(r.plan.dropped.prospect_duplicate_of_customer, 1);
  assert.match(r.plan.jobId, /^mkt-/);
  assert.equal(r.plan.context.snapshotFingerprint, 'fp');
});

// ── 構造 guard ────────────────────────────────────────────────

test('guard: prospect Function はメールを送らず Customers を更新しない', () => {
  const code = FN.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const bad of ['sendgrid', 'mail/send', 'api.sendgrid.com']) {
    assert.equal(code.toLowerCase().includes(bad), false, `${bad} を呼んでいる`);
  }
  // Airtable は GET と CREATE(POST) のみ。PATCH / DELETE を持たない
  assert.equal(/method:\s*'PATCH'/.test(code), false, 'Customers を更新している');
  assert.equal(/method:\s*'DELETE'/.test(code), false, 'Customers を削除している');
  assert.match(code, /method:\s*'POST'/);
});

test('guard: write ゲートは Redis / Airtable 初期化より前', () => {
  const gateAt = FN.indexOf('PROSPECT_WRITE_ACTIONS.includes(action)');
  const redisAt = FN.indexOf('createProspectStore({ cmd: redisCmd })');
  const airtableAt = FN.indexOf('const KEY = process.env.AIRTABLE_API_KEY');
  assert.ok(gateAt > -1 && gateAt < redisAt && gateAt < airtableAt, 'ゲートが後ろにある');
});

test('guard: webhook の prospect 反映は既定 OFF で、失敗しても 200 を返す', () => {
  assert.match(HOOK, /MARKETING_PROSPECT_EVENTS_ENABLED !== 'true'\) return out/);
  assert.match(HOOK, /prospect = await applyProspectEvents/);
  // 例外を握って全体を落とさない
  const at = HOOK.indexOf('prospect = await applyProspectEvents');
  assert.match(HOOK.slice(at, at + 200), /catch/);
});

test('guard: prospect のアドレスは prospect 名前空間の外へ出ない', () => {
  const store = readFileSync(fileURLToPath(new URL('./prospectStore.js', import.meta.url)), 'utf8');
  // 他の名前空間の接頭辞を書かない
  for (const ns of ['ak:marketing-automation:', 'payemail:', 'customer-import:', 'kma:']) {
    assert.equal(store.includes(`'${ns}`), false, `${ns} を参照している`);
  }
  assert.match(store, /PROSPECT_ROOT = 'ak:prospect:'/);
});

test('summarizeProspects はアドレスを含まない', () => {
  const s = summarizeProspects([
    buildProspect({ email: 'a@example.invalid', nowMs: NOW }),
    applyEngagement({ prospect: buildProspect({ email: 'b@example.invalid', nowMs: NOW }), nowMs: NOW, kind: 'open' }).prospect,
  ]);
  assert.equal(JSON.stringify(s).includes('@'), false);
  assert.equal(s.合計, 2);
  assert.equal(s.反応済み, 1);
});


// ── 永続抑止台帳（最優先修正）────────────────────────────────

test('除外・打ち切りは TTL で消えず、台帳へ hash と理由・日時が残る', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const email = 'a@example.invalid';
  const h = emailHash(email);

  await s.addIfAbsent(buildProspect({ email, nowMs: NOW }));
  await s.recordSuppression({ email, nowMs: NOW, reason: SUPPRESS_REASON.COMPLAINT });

  const entry = await s.loadBlocked(h);
  assert.ok(entry, '台帳に載っていない');
  assert.equal(entry.hash, h);
  assert.equal(entry.kind, BLOCK_KIND.SUPPRESSED);
  assert.equal(entry.reason, SUPPRESS_REASON.COMPLAINT);
  assert.ok(entry.at, '日時が無い');
  // ⚠️ 台帳にアドレスを持たない
  for (const k of Object.keys(entry)) assert.ok(BLOCKED_FIELDS.includes(k), `${k} を保存している`);
  assert.equal(JSON.stringify(entry).includes('@'), false, '台帳にアドレスが入っている');
  // ⚠️ 台帳キーに TTL を付けない
  const setCall = r.calls.find((c) => c[0] === 'SET' && c[1] === blockedKey(h));
  assert.equal(setCall.includes('EX'), false, '台帳に TTL を付けている');
});

test('無反応 3 回の打ち切りも台帳へ載る', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const email = 'a@example.invalid';
  await s.addIfAbsent(buildProspect({ email, nowMs: NOW }));
  for (let i = 1; i <= MAX_SENDS_WITHOUT_ENGAGEMENT; i += 1) {
    await s.recordSend({ email, nowMs: day(i * 3), runId: `r${i}` });
  }
  const entry = await s.loadBlocked(emailHash(email));
  assert.equal(entry.kind, BLOCK_KIND.EXHAUSTED);
  assert.equal(entry.sends, MAX_SENDS_WITHOUT_ENGAGEMENT);
  assert.equal(await s.isBlocked(emailHash(email)), true);
});

test('CSV を入れ直しても台帳に載っている相手は復活しない', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const email = 'a@example.invalid';
  await s.addIfAbsent(buildProspect({ email, nowMs: NOW }));
  await s.recordSuppression({ email, nowMs: NOW, reason: SUPPRESS_REASON.BOUNCE });
  // レコードごと消しても（生アドレスを削除しても）台帳は残る
  await s.purge(emailHash(email));
  assert.equal(await s.load(email), null, 'レコードが残っている');
  assert.equal(await s.isBlocked(emailHash(email)), true, '台帳が消えた');

  const again = await s.addIfAbsent(buildProspect({ email, nowMs: day(30) }));
  assert.equal(again.added, false, '再取り込みで復活した');
  assert.equal(again.blocked, true);
  assert.deepEqual(await s.activeHashes(), [], '送信候補へ戻った');
});

test('取り込み計画も台帳（hash）と突き合わせる', () => {
  const blockedHashes = new Set([emailHash('blocked@example.invalid')]);
  const plan = planProspectIntake({
    rows: [{ email: 'blocked@example.invalid' }, { email: 'ok@example.invalid' }],
    customerEmails: new Set(), existingEmails: new Set(), blacklistEmails: new Set(),
    blockedHashes, hashFn: emailHash, nowMs: NOW, batchId: 'b2',
  });
  assert.equal(plan.add.length, 1);
  assert.equal(plan.add[0].email, 'ok@example.invalid');
  assert.equal(plan.skipped.permanently_blocked, 1);
});

test('生アドレスを持つのは配信中のレコードだけ。除外後は削除できる', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  const email = 'a@example.invalid';
  await s.addIfAbsent(buildProspect({ email, nowMs: NOW }));
  assert.ok(JSON.stringify(r.store.get(prospectKey(emailHash(email)))).includes(email));

  // 抑止前は削除できない（配信中のものを消さない）
  assert.equal((await s.purge(emailHash(email))).purged, false);

  await s.recordSuppression({ email, nowMs: NOW, reason: 'manual' });
  assert.equal((await s.purge(emailHash(email))).purged, true);
  assert.equal(r.store.has(prospectKey(emailHash(email))), false, '生アドレスが残っている');
  assert.equal(r.store.has(blockedKey(emailHash(email))), true, '台帳まで消えた');
});

test('件数に永久除外が出る', async () => {
  const r = fakeRedis();
  const s = createProspectStore({ cmd: r.cmd });
  await s.addIfAbsent(buildProspect({ email: 'a@example.invalid', nowMs: NOW }));
  await s.addIfAbsent(buildProspect({ email: 'b@example.invalid', nowMs: NOW }));
  await s.recordSuppression({ email: 'b@example.invalid', nowMs: NOW, reason: 'bounce' });
  const c = await s.counts();
  assert.deepEqual(c, { 送信候補: 1, 反応済み未登録: 0, 永久除外: 1 });
});

// ── C-2: 顧客一覧の写し ───────────────────────────────────────

test('写しは chunk へ分けて保存し、meta を最後に更新する', async () => {
  const r = fakeRedis();
  const s = createSnapshotStore({ cmd: r.cmd });
  const emails = Array.from({ length: 4500 }, (_, i) => `u${i}@example.invalid`);
  const meta = await s.save({ emails, nowMs: NOW, generation: 'g1' });
  assert.equal(meta.count, 4500);
  assert.equal(meta.chunks, 3);        // 2000 件ずつ
  // meta の SET は最後
  const setKeys = r.calls.filter((c) => c[0] === 'SET').map((c) => c[1]);
  assert.equal(setKeys[setKeys.length - 1], META_KEY, 'meta を先に書いている');

  const set = await s.loadEmailSet({ nowMs: NOW });
  assert.equal(set.size, 4500);
  assert.equal(set.has('u0@example.invalid'), true);
});

test('写しが無い / 古い / 壊れていれば使わせない（fail-closed）', async () => {
  assert.equal(evaluateSnapshot({ meta: null, nowMs: NOW }).reason, SNAPSHOT_FAIL.MISSING);
  assert.equal(evaluateSnapshot({ meta: { builtAt: 'x', count: 1, chunks: 1 }, nowMs: NOW }).reason,
    SNAPSHOT_FAIL.CORRUPT);
  assert.equal(evaluateSnapshot({
    meta: { builtAt: new Date(NOW - 7 * 3600 * 1000).toISOString(), count: 1, chunks: 1 }, nowMs: NOW,
  }).reason, SNAPSHOT_FAIL.STALE);
  assert.equal(evaluateSnapshot({
    meta: { builtAt: new Date(NOW - 60 * 1000).toISOString(), count: 1, chunks: 1 }, nowMs: NOW,
  }).ok, true);

  const r = fakeRedis();
  const s = createSnapshotStore({ cmd: r.cmd });
  await assert.rejects(() => s.loadEmailSet({ nowMs: NOW }),
    (e) => e instanceof SnapshotError && e.code === SNAPSHOT_FAIL.MISSING);
});

test('写しの名前空間の外は拒否 / chunk は重複を畳んで並べる', () => {
  const s = createSnapshotStore({ cmd: async () => 'OK' });
  assert.throws(() => s.assertKey('ak:prospect:p:x'), (e) => e instanceof SnapshotError);
  assert.equal(s.assertKey(`${SNAPSHOT_ROOT}meta`), `${SNAPSHOT_ROOT}meta`);
  const { chunks, count } = buildChunks(['B@x.invalid', 'a@x.invalid', 'A@X.invalid']);
  assert.equal(count, 2);
  assert.deepEqual(chunks[0], ['a@x.invalid', 'b@x.invalid']);
});

test('件数が meta と合わなければ壊れているとみなす', async () => {
  const r = fakeRedis();
  const s = createSnapshotStore({ cmd: r.cmd });
  await s.save({ emails: ['a@x.invalid', 'b@x.invalid'], nowMs: NOW, generation: 'g1' });
  // meta の count だけ書き換える
  const meta = JSON.parse(r.store.get(META_KEY));
  r.store.set(META_KEY, JSON.stringify({ ...meta, count: 99 }));
  await assert.rejects(() => s.loadEmailSet({ nowMs: NOW }),
    (e) => e instanceof SnapshotError && e.code === SNAPSHOT_FAIL.CORRUPT);
});

// ── cron の配線 ───────────────────────────────────────────────

test('guard: cron の enqueue は専用 env が開くまで動かない', () => {
  const CRON = readFileSync(fileURLToPath(
    new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8');
  assert.match(CRON, /MARKETING_AUTOMATION_ENQUEUE_ENABLED === 'true'/);
  // 送信回数の記録は enqueue の後
  const enqAt = CRON.indexOf('const res = await fetch(`https://api.airtable.com');
  const recAt = CRON.indexOf('prospectStore.recordSend');
  assert.ok(enqAt > -1 && recAt > enqAt, '送信回数を enqueue より先に数えている');
  // 写しが使えなければ計画を作らない
  assert.match(CRON, /SnapshotError/);
});

test('guard: 管理画面に見込み客パネルがあり、保存系は初期 disabled', () => {
  const UI2 = readFileSync(fileURLToPath(
    new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
  // CSV 取込 / 件数 / 下見 / 反応 / 昇格 / 除外 / 履歴（状態）の入口がある
  for (const id of ['prCsv', 'prStatus', 'prPreview', 'prPromoPreview', 'prLookupBtn',
    'prIntake', 'prPromote', 'prSuppress', 'prPurge', 'prSnapshot']) {
    assert.ok(UI2.includes(`id="${id}"`), `${id} が無い`);
  }
  for (const id of ['prIntake', 'prPromote', 'prSuppress', 'prPurge']) {
    assert.match(UI2, new RegExp(`id="${id}"[^>]*disabled`), `${id} が初期 disabled でない`);
  }
  assert.match(UI2, /function prApplyGate\(enabled\)/);
  assert.match(UI2, /data\.code === 'prospect_write_blocked'\) prApplyGate\(false\)/);
  // 昇格は下見の件数を渡す（TOCTOU）
  assert.match(UI2, /action: 'promote', confirmCount: n/);
});
