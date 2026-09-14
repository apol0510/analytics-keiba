/**
 * prospectDeliveryPipeline.test.mjs — **prospect にも実際に送れて、反応が数えられる**
 *   node --test src/lib/marketing/prospectDeliveryPipeline.test.mjs
 *
 * ## この任務の完成条件（2026-09-14 MK 確定）
 *
 * CSV 由来を中心とする約 15,000 件へ通常マーケティングメールを**自動配信**し、
 * **delivered 10 通で open / click / 購入 / ログインの反応が一度も無い**宛先を
 * 以後の通常マーケティング配信から**自動で除外**する。
 *
 * 個別キャンペーンの 2 通・3 通だけを配り切って終わりにしない。
 * **複数キャンペーンを通じて選別が続く**ことが要件。
 *
 * ## ここで固定すること
 *
 *   1. prospect の 1 通は **Airtable の配信行が無くても** custom_args を組める
 *   2. その `DeliveryKey` は **enqueue 時の値**（送信側で作り直さない）
 *   3. 同じ job を 2 回起動しても prospect へ 2 通目を送らない
 *   4. `delivered` を**数える**（数えないと打ち切りの分母が 0 のまま）
 *   5. **delivered 10 通・無反応**で EXHAUSTED になり、以後の配信対象から外れる
 *   6. 反応（open / click）があれば打ち切られない
 *   7. 打ち切りは**キャンペーンをまたいで**効く（1 本の 3 通では届かない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  buildDescriptorEntries, toProspectDelivery, createJobDeliveryStore,
  JOB_DELIVERY_ROOT, JOB_SENT_ROOT, isSafeJobKey,
} from './prospectDeliveryDescriptor.js';
import { buildCampaignCustomArgs, CUSTOM_ARG_KEYS, AUDIENCE } from './campaignCustomArgs.js';
import { buildProspectDispatchRows, loadProspectDispatchContext, PROSPECT_CTX_FAIL } from './prospectDispatchContext.js';
import {
  classifyEvent, applyDelivered, applyEngagement, buildProspect, PROSPECT_STATE,
} from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { resolveProspectCutoff } from './prospectEngagement.js';

const NOW = Date.UTC(2026, 8, 14, 3, 0);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const hashOf = (e) => createHash('sha256').update(String(e), 'utf8').digest('hex').slice(0, 32);

/** ごく小さな偽 Redis（HASH / SET だけ） */
function fakeRedis() {
  const store = new Map();
  const cmd = async (args) => {
    const [op, key, ...rest] = args;
    if (op === 'HSET') {
      const h = store.get(key) instanceof Map ? store.get(key) : new Map();
      for (let i = 0; i + 1 < rest.length; i += 2) h.set(rest[i], rest[i + 1]);
      store.set(key, h);
      return rest.length / 2;
    }
    if (op === 'HGETALL') {
      const h = store.get(key);
      if (!(h instanceof Map)) return [];
      const out = [];
      for (const [k, v] of h) out.push(k, v);
      return out;
    }
    if (op === 'SADD') {
      const s = store.get(key) instanceof Set ? store.get(key) : new Set();
      for (const m of rest) s.add(m);
      store.set(key, s);
      return rest.length;
    }
    if (op === 'SMEMBERS') {
      const s = store.get(key);
      return s instanceof Set ? [...s] : [];
    }
    if (op === 'EXPIRE') return 1;
    return null;
  };
  return { cmd, store };
}

// ── 1. Airtable の行が無くても身分証を組める ────────────────────────
test('【要件】prospect は Airtable の配信行が無くても custom_args を組める', () => {
  const delivery = toProspectDelivery({
    deliveryKey: KEY_A, campaignId: 'campaign-discount-free', campaignVersion: '1',
  });
  assert.ok(delivery, '記述子を作れない');
  const r = buildCampaignCustomArgs({
    delivery, campaignId: 'campaign-discount-free', campaignVersion: '1',
  });
  assert.equal(r.ok, true, `送れない: ${r.reason}`);
  assert.equal(r.customArgs[CUSTOM_ARG_KEYS.DELIVERY_KEY], KEY_A);
  assert.equal(r.customArgs[CUSTOM_ARG_KEYS.AUDIENCE], AUDIENCE.PROSPECT);
  // Airtable の recordId は**持たせない**（存在しないものを捏造しない）
  assert.equal(r.customArgs[CUSTOM_ARG_KEYS.CAMPAIGN_DELIVERY_ID], undefined);
  assert.equal(r.customArgs[CUSTOM_ARG_KEYS.CUSTOMER_RECORD_ID], undefined);
});

test('【安全装置】Customers 由来で recordId が欠けているのは従来どおり弾く（不具合だから）', () => {
  const r = buildCampaignCustomArgs({
    delivery: {
      deliveryKey: KEY_A, campaignType: 'campaign-discount-free:v1', status: 'queued',
      recordId: '', customerRecordId: '',
    },
    campaignId: 'campaign-discount-free', campaignVersion: '1',
  });
  assert.equal(r.ok, false, 'Customers 経路まで緩めている');
});

test('【安全装置】キャンペーンが食い違う身分証では送らない', () => {
  const delivery = toProspectDelivery({ deliveryKey: KEY_A, campaignId: 'camp-a', campaignVersion: '1' });
  const r = buildCampaignCustomArgs({ delivery, campaignId: 'camp-b', campaignVersion: '1' });
  assert.equal(r.ok, false);
});

test('【安全装置】鍵が sha256 hex でなければ作らない（再計算もしない）', () => {
  assert.equal(toProspectDelivery({ deliveryKey: 'short', campaignId: 'c', campaignVersion: '1' }), null);
  assert.equal(toProspectDelivery({ deliveryKey: KEY_A, campaignId: '', campaignVersion: '1' }), null);
});

// ── 2. 鍵は enqueue 時の値を持ち回る ────────────────────────────────
test('【要件】対応表には prospect の鍵だけを、enqueue 時の値のまま入れる', () => {
  const { entries, dropped } = buildDescriptorEntries({
    recipients: [
      { email: 'p1@example.invalid', deliveryKey: KEY_A, 出所: 'prospect' },
      { email: 'c1@example.invalid', deliveryKey: KEY_B, 出所: 'customer' },
    ],
    hashFn: hashOf,
  });
  assert.equal(entries.length, 1, 'customer まで入れている');
  assert.equal(entries[0].deliveryKey, KEY_A);
  assert.equal(entries[0].emailHash, hashOf('p1@example.invalid'));
  assert.equal(dropped, 0);
});

test('【安全装置】鍵が壊れている prospect は落として数える（黙って通さない）', () => {
  const { entries, dropped } = buildDescriptorEntries({
    recipients: [
      { email: 'p1@example.invalid', deliveryKey: 'broken', 出所: 'prospect' },
      { email: '', deliveryKey: KEY_A, 出所: 'prospect' },
    ],
    hashFn: hashOf,
  });
  assert.equal(entries.length, 0);
  assert.equal(dropped, 2);
});

test('対応表は Redis へ保存して読み戻せる（鍵は変わらない）', async () => {
  const r = fakeRedis();
  const store = createJobDeliveryStore({ redisCmd: r.cmd });
  const jobId = 'mkt-campaign-discount-free-v1-abc-1';
  assert.equal(await store.save({ jobId, entries: [{ emailHash: hashOf('p1@example.invalid'), deliveryKey: KEY_A }] }), true);
  const loaded = await store.load({ jobId });
  assert.equal(loaded.get(hashOf('p1@example.invalid')), KEY_A);
  assert.ok([...r.store.keys()].some((k) => k.startsWith(JOB_DELIVERY_ROOT)));
  // 生アドレスを置かない
  assert.equal(JSON.stringify([...r.store.keys()]).includes('p1@example.invalid'), false);
});

test('【安全装置】Redis が無ければ保存も読み出しもできない（読めない＝ null）', async () => {
  const store = createJobDeliveryStore({});
  assert.equal(store.usable, false);
  assert.equal(await store.save({ jobId: 'mkt-a-1', entries: [{ emailHash: hashOf('x@y.invalid'), deliveryKey: KEY_A }] }), false);
  assert.equal(await store.load({ jobId: 'mkt-a-1' }), null, '読めないのに空を返している');
});

test('危険な jobId は鍵にしない', () => {
  assert.equal(isSafeJobKey('mkt-a_1'), true);
  for (const bad of ['', 'a b', 'a\nb', 'a*b', 'x'.repeat(300)]) {
    assert.equal(isSafeJobKey(bad), false, bad.slice(0, 10));
  }
});

// ── 3. 同じ job を 2 回起動しても 2 通目を送らない ───────────────────
test('【要件】送信済みを記録し、同じ job の再起動では送らない', async () => {
  const r = fakeRedis();
  const store = createJobDeliveryStore({ redisCmd: r.cmd });
  const jobId = 'mkt-campaign-discount-free-v1-abc-1';
  const h = hashOf('p1@example.invalid');
  assert.equal((await store.loadSent({ jobId })).size, 0, '最初から送信済みになっている');
  assert.equal(await store.markSent({ jobId, emailHashes: [h] }), true);
  const sent = await store.loadSent({ jobId });
  assert.equal(sent.has(h), true);
  assert.ok([...r.store.keys()].some((k) => k.startsWith(JOB_SENT_ROOT)));
});

test('【安全装置】送信済みを記録できなければ送らない（記録が唯一の証拠）', async () => {
  const store = createJobDeliveryStore({});
  assert.equal(await store.markSent({ jobId: 'mkt-a-1', emailHashes: [hashOf('x@y.invalid')] }), false);
});

// ── 4. delivered を数える ───────────────────────────────────────────
test('【要件】`delivered` を数える（数えないと打ち切りの分母が 0 のまま）', () => {
  assert.equal(classifyEvent('delivered').kind, 'delivered');
  const { updates } = planProspectEventUpdates({
    events: [{ email: 'p1@example.invalid', event: 'delivered' }], classify: classifyEvent,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].action, 'delivered');
});

test('配信成功は「反応」に数えない（開封とクリックだけが反応）', () => {
  const p = buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' });
  const after = applyDelivered({ prospect: p, nowMs: NOW }).prospect;
  assert.equal(after.state, PROSPECT_STATE.SENDING, '配信成功で反応済みになっている');
  assert.equal(after.delivered, 1);
});

// ── 5. delivered 10 通・無反応で除外される ──────────────────────────
test('【要件】delivered が閾値に達し無反応なら EXHAUSTED（以後送らない）', () => {
  const threshold = resolveProspectCutoff({}).delivered;
  let p = buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' });
  for (let i = 1; i <= threshold; i += 1) {
    const r = applyDelivered({ prospect: p, nowMs: NOW + i, env: {} });
    p = r.prospect;
    if (i < threshold) {
      assert.notEqual(p.state, PROSPECT_STATE.EXHAUSTED, `${i} 通目で打ち切っている（早すぎる）`);
    }
  }
  assert.equal(p.delivered, threshold);
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED, `${threshold} 通 delivered でも打ち切られていない`);
});

test('【要件】閾値は 10（`engagementPolicy.js` が単一源）', () => {
  assert.equal(resolveProspectCutoff({}).delivered, 10);
  assert.equal(resolveProspectCutoff({}).basis, 'delivered', '送信回数で数えている');
});

test('【要件】除外された人は配信の対象から外れる（送信側の入口で落ちる）', () => {
  const exhausted = {
    ...buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' }),
    hash: 'f'.repeat(64),
    state: PROSPECT_STATE.EXHAUSTED,
  };
  const out = buildProspectDispatchRows({ prospects: [exhausted], nowMs: NOW });
  assert.equal(out.rows.length, 0, '打ち切った相手を送信対象にしている');
  assert.equal(out.suppressed.has('p1@example.invalid'), true, '送信直前の再検証でも弾けていない');
});

// ── 6. 反応があれば打ち切られない ───────────────────────────────────
test('【要件】開封があれば、その後 delivered が積まれても打ち切らない', () => {
  let p = buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' });
  p = applyEngagement({ prospect: p, nowMs: NOW, kind: 'open' }).prospect;
  assert.equal(p.state, PROSPECT_STATE.ENGAGED);
  for (let i = 0; i < 20; i += 1) p = applyDelivered({ prospect: p, nowMs: NOW + i, env: {} }).prospect;
  assert.equal(p.state, PROSPECT_STATE.ENGAGED, '反応済みを打ち切っている');
});

test('【要件】クリックも反応として扱う', () => {
  const p = buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' });
  const after = applyEngagement({ prospect: p, nowMs: NOW, kind: 'click' }).prospect;
  assert.equal(after.state, PROSPECT_STATE.ENGAGED);
});

// ── 7. 打ち切りはキャンペーンをまたいで効く ─────────────────────────
test('【要件】delivered はキャンペーン単位ではなく**その人**に積まれる', () => {
  // 1 本のキャンペーンが 3 通でも、複数本を通じて 10 通に到達すれば打ち切られる
  let p = buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' });
  for (let camp = 0; camp < 4; camp += 1) {
    for (let step = 0; step < 3; step += 1) {
      p = applyDelivered({ prospect: p, nowMs: NOW, env: {} }).prospect;
    }
  }
  assert.equal(p.delivered, 12);
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED, 'キャンペーンをまたいだ積み上げで打ち切られていない');
});

// ── 送信直前の材料（Customers に居ない人を復元する）────────────────
test('prospect を Customers 経路と同じ形へ復元する', () => {
  const p = { ...buildProspect({ email: 'p1@example.invalid', nowMs: NOW, batchId: 'b1' }), hash: 'f'.repeat(64) };
  const out = buildProspectDispatchRows({ prospects: [p], nowMs: NOW });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].fields.Email, 'p1@example.invalid');
  assert.equal(out.rows[0].marketing.sendable, true);
  assert.match(out.rows[0].recordId, /^prospect:/);
});

test('【安全装置】読めなければ `ok:false`（0 件と区別する）', async () => {
  const r1 = await loadProspectDispatchContext({
    store: null, emails: ['p1@example.invalid'], nowMs: NOW, hashFn: hashOf,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, PROSPECT_CTX_FAIL.STORE_UNAVAILABLE);

  const r2 = await loadProspectDispatchContext({
    store: { loadMany: async () => { throw new Error('boom'); } },
    emails: ['p1@example.invalid'], nowMs: NOW, hashFn: hashOf,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, PROSPECT_CTX_FAIL.READ_FAILED);
});

test('宛先が 0 件なら読みにいかない（空振りで外部 I/O を出さない）', async () => {
  let called = 0;
  const r = await loadProspectDispatchContext({
    store: { loadMany: async () => { called += 1; return []; } },
    emails: [], nowMs: NOW, hashFn: hashOf,
  });
  assert.equal(r.ok, true);
  assert.equal(called, 0);
});

// ── 配線（判定モジュールが通るだけでは意味が無い）────────────────────
test('【配線】dispatcher が prospect の身分証と送信済みを実際に読んでいる', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/marketing-campaign-dispatch.js', import.meta.url)),
    'utf8',
  );
  assert.match(src, /loadProspectDispatchContext\(/, 'prospect の材料を読んでいない');
  assert.match(src, /jobDeliveryStore\.load\(\{ jobId \}\)/, '身分証を読んでいない');
  assert.match(src, /jobDeliveryStore\.loadSent\(\{ jobId \}\)/, '送信済みを読んでいない');
  assert.match(src, /jobDeliveryStore\.markSent\(/, '送信済みを記録していない');
  assert.match(src, /toProspectDelivery\(/, '身分証を組み立てていない');
  // 記録できなければ送らない（順序: markSent → sendOne）
  const iMark = src.indexOf('jobDeliveryStore.markSent(');
  const iSend = src.indexOf('const ok = await sendOne(');
  assert.ok(iMark > 0 && iSend > iMark, '送信より後に記録している（再起動で二重送信になる）');
});

test('【配線】キュー登録が身分証を**ジョブを作る前に**置いている', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
    'utf8',
  );
  assert.match(src, /buildDescriptorEntries\(/);
  assert.match(src, /jobDeliveryStore\.save\(\{ jobId, entries \}\)/);
  const iSave = src.indexOf('jobDeliveryStore.save(');
  const iCreate = src.indexOf('method: \'POST\',\n      headers: { ...auth(KEY)');
  assert.ok(iSave > 0, '身分証を保存していない');
  assert.ok(iCreate === -1 || iSave < iCreate, 'ジョブを作った後に保存している');
});

test('【配線】webhook が delivered を prospect へ反映している', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url)),
    'utf8',
  );
  assert.match(src, /store\.recordDelivered\(/, 'delivered を数えていない（打ち切りが発火しない）');
  assert.match(src, /PROSPECT_STATE\.EXHAUSTED/, '打ち切りを観測できていない');
});
