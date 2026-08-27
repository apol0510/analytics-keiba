/**
 * prospectQueueIdempotency.test.mjs — **queue の前に予約する**ことを固定する
 *   node --test src/lib/marketing/prospectQueueIdempotency.test.mjs
 *
 * ## 直した不具合（2026-08-27）
 *
 * 以前は prospect を queue した**あと**に Redis へ記録していた。この順序だと
 *
 *   queue 成功 → Redis 記録失敗 → 次の tick で未送信扱い → **二重 queue**
 *
 * が起きる。prospect は `CampaignDeliveries` に行を作らないので、
 * Redis の集合だけが冪等性の根拠であり、そこが落ちた瞬間に「送っていない人」に戻る。
 *
 * ## 直し方
 *
 * `SADD` の戻り値（0/1）で **鍵ごとに 1 回だけ**所有権を渡し、
 * 取れた鍵だけを queue する。`SADD` は atomic なので、
 * **並行 tick が同じ鍵を取ることは構造的に起きない**。
 * queue できなかった鍵は `releaseClaims()` で戻す（戻さないと二度と送られない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createDeliveryKeyStore, DeliveryKeyStoreError, buildDeliveredSetKey,
} from './deliveryKeyStore.js';
import { buildProspect, applyDelivered, applySend } from './prospectPolicy.js';
import { prospectEngagementStats } from './prospectEngagement.js';

const SCOPE = { brand: 'analytics-keiba', campaignId: 'idem-test', version: 1 };
/** `DeliveryKey` の形（sha256 hex 64 桁）に合わせたテスト用の鍵 */
const K = (i) => `${'a'.repeat(56)}${i.toString(16).padStart(8, '0')}`;

/** 1 個の集合だけを持つ fake Redis（SADD / SREM / SMISMEMBER） */
function fakeRedis({ failOn = null } = {}) {
  const sets = new Map();
  const calls = [];
  const of = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    calls.push(op);
    if (failOn === op || failOn === 'ALL') throw new Error('redis down');
    const set = of(args[1]);
    if (op === 'SADD') {
      let added = 0;
      for (const m of args.slice(2)) if (!set.has(m)) { set.add(m); added += 1; }
      return added;
    }
    if (op === 'SREM') {
      let removed = 0;
      for (const m of args.slice(2)) if (set.delete(m)) removed += 1;
      return removed;
    }
    if (op === 'SMISMEMBER') return args.slice(2).map((m) => (set.has(m) ? 1 : 0));
    if (op === 'SCARD') return set.size;
    return 'OK';
  };
  const pipeline = async (commands) => {
    if (failOn === 'PIPELINE' || failOn === 'ALL') throw new Error('redis down');
    const out = [];
    for (const c of commands) out.push(await cmd(c));
    return out;
  };
  return { cmd, pipeline, sets, calls };
}

/* ── 予約は鍵ごとに 1 回だけ ───────────────────────────────── */

test('claimDelivered は鍵ごとに 1 回だけ所有権を渡す', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });
  const keys = [K(1), K(2), K(3)];

  const first = await store.claimDelivered({ ...SCOPE, keys });
  assert.deepEqual(first.claimed.sort(), keys.sort());
  assert.deepEqual(first.already, []);

  // 2 回目は 1 件も取れない（＝既に積んだ／送った）
  const second = await store.claimDelivered({ ...SCOPE, keys });
  assert.deepEqual(second.claimed, []);
  assert.deepEqual(second.already.sort(), keys.sort());
});

test('【要件】同一 DeliveryKey の並行 tick → enqueue は最大 1 回', async () => {
  const r = fakeRedis();
  const a = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });
  const b = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });
  const keys = [K(1), K(2), K(3), K(4), K(5)];

  const [ra, rb] = await Promise.all([
    a.claimDelivered({ ...SCOPE, keys }),
    b.claimDelivered({ ...SCOPE, keys }),
  ]);
  const total = ra.claimed.length + rb.claimed.length;
  assert.equal(total, keys.length, '合計が鍵の数を超えている＝二重 queue');
  // 同じ鍵を両方が取っていないこと
  const overlap = ra.claimed.filter((k) => rb.claimed.includes(k));
  assert.deepEqual(overlap, [], `${overlap.length} 件を両方の tick が取っている`);
});

test('予約を戻すと、もう一度取れる（queue 失敗時の復旧）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });
  await store.claimDelivered({ ...SCOPE, keys: [K(1)] });
  assert.deepEqual((await store.claimDelivered({ ...SCOPE, keys: [K(1)] })).claimed, []);
  await store.releaseClaims({ ...SCOPE, keys: [K(1)] });
  assert.deepEqual((await store.claimDelivered({ ...SCOPE, keys: [K(1)] })).claimed, [K(1)]);
});

/* ── Redis が使えない / 応答が読めない ────────────────────────── */

test('【要件】Redis unavailable → 予約できない（＝prospect enqueue 0）', async () => {
  const r = fakeRedis({ failOn: 'ALL' });
  const store = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });
  await assert.rejects(
    () => store.claimDelivered({ ...SCOPE, keys: [K(1)] }),
    (e) => e instanceof DeliveryKeyStoreError,
    '⚠️ 例外にならず「未送信」として通ると二重送信になる',
  );
});

test('【要件】記録・確認の応答が読めない → 二重送信不能（throw）', async () => {
  // pipeline が配列以外を返す（＝どの鍵を取れたか分からない）
  const store = createDeliveryKeyStore({
    redisCmd: async () => 1,
    redisPipeline: async () => 'OK',
  });
  await assert.rejects(() => store.claimDelivered({ ...SCOPE, keys: [K(1)] }));

  // 0/1 以外が返る（解釈しない）
  const store2 = createDeliveryKeyStore({
    redisCmd: async () => 'maybe',
    redisPipeline: async (cmds) => cmds.map(() => 'maybe'),
  });
  await assert.rejects(() => store2.claimDelivered({ ...SCOPE, keys: [K(1)] }));

  // 件数が合わない（部分応答）
  const store3 = createDeliveryKeyStore({
    redisCmd: async () => 1,
    redisPipeline: async () => [1],
  });
  await assert.rejects(() => store3.claimDelivered({ ...SCOPE, keys: [K(1), K(2)] }));
});

test('予約を戻せなければ黙らない（throw して呼び出し側が記録する）', async () => {
  const r = fakeRedis({ failOn: 'SREM' });
  const store = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });
  await store.claimDelivered({ ...SCOPE, keys: [K(1)] });
  await assert.rejects(() => store.releaseClaims({ ...SCOPE, keys: [K(1)] }));
});

test('pipeline が無くても鍵ごとに判定できる（退避経路）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });   // pipeline なし
  const first = await store.claimDelivered({ ...SCOPE, keys: [K(1), K(2)] });
  assert.equal(first.claimed.length, 2);
  const second = await store.claimDelivered({ ...SCOPE, keys: [K(1), K(2)] });
  assert.equal(second.claimed.length, 0);
});

test('集合の鍵に PII を入れない（campaign と brand だけ）', () => {
  const k = buildDeliveredSetKey(SCOPE);
  assert.equal(k, 'ak:mkt:delivered:analytics-keiba:idem-test:v1');
  assert.equal(k.includes('@'), false);
});

/* ── 予約と delivered 実績を混同しない ──────────────────────── */

test('【要件】queue だけでは delivered が増えない（打ち切りの分母を汚さない）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd, redisPipeline: r.pipeline });

  let p = buildProspect({ email: 'a@example.com', nowMs: 0, batchId: 'b1', source: 'csv' });
  // queue に相当する操作（予約 + 送信試行）を 30 回繰り返しても…
  for (let i = 1; i <= 30; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.claimDelivered({ ...SCOPE, keys: [K(i)] });
    p = applySend({ prospect: p, nowMs: i * 86400000, runId: `r${i}` });
  }
  assert.equal(prospectEngagementStats(p).delivered, 0, '⚠️ 予約や試行で delivered が増えている');
  assert.equal(p.delivered, 0);

  // delivered が増えるのは確定経路（applyDelivered）だけ
  p = applyDelivered({ prospect: p, nowMs: 0 }).prospect;
  assert.equal(p.delivered, 1);
});

/* ── Function 側の配線（guard）──────────────────────────────── */

const cronSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)), 'utf8');
const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');

const before = (src, a, b) => {
  const i = src.indexOf(a); const j = src.indexOf(b);
  return i > 0 && j > 0 && i < j;
};

test('⚠️ guard: cron は queue の前に予約している', () => {
  assert.match(cronSrc, /claimDelivered\(/, 'cron が予約していない');
  assert.ok(
    before(cronSrc, 'claimDelivered(', '// 7) キュー登録'),
    '予約より先にジョブを作っている（記録失敗で二重 queue になる）',
  );
});

test('⚠️ guard: cron は queue のあとに prospect 台帳を記録していない', () => {
  assert.doesNotMatch(cronSrc, /台帳を確認できません/, '旧: 記録失敗をログだけで済ませる経路が残っている');
  assert.match(cronSrc, /releaseClaims\(/, 'queue 失敗時に予約を戻していない');
});

test('⚠️ guard: cron は予約できなければ prospect を 1 人も queue しない', () => {
  assert.match(cronSrc, /claimedProspectTargets/);
  assert.match(cronSrc, /selected: \[\.\.\.customerTargets, \.\.\.claimedProspectTargets\]/,
    '予約が取れていない prospect も送信計画に載せている');
});

test('⚠️ guard: cron は prospect を読めなくても Customers を止めない（既存挙動）', () => {
  assert.match(cronSrc, /prospectDegraded = prospectInputs\.reason/);
  assert.doesNotMatch(cronSrc, /abort: prospectInputs\.reason/, 'prospect の失敗で tick 全体を止めている');
});

test('⚠️ guard: admin も queue の前に予約し、失敗なら 1 行も書かない', () => {
  assert.match(adminSrc, /claimDelivered\(/);
  assert.ok(
    before(adminSrc, 'claimDelivered(', '1) ScheduledEmails に PENDING ジョブを作る'),
    '予約より先にジョブを作っている',
  );
  assert.match(adminSrc, /prospect_ledger_unavailable/);
  assert.match(adminSrc, /releaseProspectClaims\(/);
});

test('⚠️ guard: 巻き戻し時に prospect の予約を戻している', () => {
  assert.match(adminSrc, /await releaseProspectClaims\(prospectClaimed\)/);
});

test('⚠️ guard: prospect は CampaignDeliveries へ行を作らない（両経路）', () => {
  assert.match(cronSrc, /recipients: airtableRecipients/);
  assert.match(adminSrc, /recipients: airtableRecipients, jobIdByEmail/);
});

/* ── Customers 経路の回帰が無いこと ──────────────────────────── */

import { partitionRecipientsForLedger, RECIPIENT_SOURCE } from './deliveryKeySource.js';
import { tagRecipientSources } from './prospectAudienceSource.js';

test('【要件】prospect が 0 人なら Customers 経路は従来と完全に同じ', () => {
  const recipients = [
    { email: 'c1@example.com', deliveryKey: K(1) },
    { email: 'c2@example.com', deliveryKey: K(2) },
  ];
  const tagged = tagRecipientSources({ recipients, prospectEmails: new Set() });
  // 全員 customer 扱い＝Airtable へ従来どおり全件書く
  assert.equal(tagged.filter((r) => r['出所'] === RECIPIENT_SOURCE.PROSPECT).length, 0);
  for (const mode of ['airtable', 'dual', 'redis']) {
    const split = partitionRecipientsForLedger({ mode, recipients: tagged });
    const expectAirtable = mode === 'redis' ? 0 : recipients.length;
    assert.equal(split.airtableKeys.length, expectAirtable, `mode=${mode} で customer の扱いが変わっている`);
  }
});

test('【要件】prospect が居ても Customers の配信行は減らない', () => {
  const recipients = [
    { email: 'c1@example.com', deliveryKey: K(1) },
    { email: 'p1@example.com', deliveryKey: K(2) },
    { email: 'c2@example.com', deliveryKey: K(3) },
  ];
  const tagged = tagRecipientSources({ recipients, prospectEmails: new Set(['p1@example.com']) });
  const split = partitionRecipientsForLedger({ mode: 'dual', recipients: tagged });
  assert.deepEqual(split.airtableKeys.sort(), [K(1), K(3)].sort(), 'customer の行が欠けている');
  assert.equal(split.airtableKeys.includes(K(2)), false, 'prospect の行が Airtable に混ざっている');
});

test('【要件】prospect 経路では Airtable CampaignDeliveries が 1 行も増えない', () => {
  const recipients = Array.from({ length: 6308 }, (_, i) => ({
    email: `p${i}@example.com`, deliveryKey: K(i),
  }));
  const tagged = tagRecipientSources({
    recipients, prospectEmails: new Set(recipients.map((r) => r.email)),
  });
  const split = partitionRecipientsForLedger({ mode: 'dual', recipients: tagged });
  assert.equal(split.airtableKeys.length, 0, '8/31 の 2 通目で Airtable の行が増えている');
  assert.equal(split.redisKeys.length, 6308);
});
