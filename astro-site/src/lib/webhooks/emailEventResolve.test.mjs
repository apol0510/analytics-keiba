/**
 * emailEventResolve.test.mjs — 受信側の紐付け（Phase 1d）
 *
 * `resolved` は「誰のどの配信か**確定した**」という宣言。確定していないものを resolved にすると、
 * 顧客カルテに他人の反応が出る。**3 点完全一致以外はすべて unresolved / conflict** を固定する。
 */
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  resolveAttribution,
  normalizeEvent,
  buildLedgerBatch,
  summarizeCustomerEventsFromLedger,
  RESOLUTION,
} from './emailEventLedger.js';
import {
  fetchDeliveryIndex,
  buildDeliveryIndex,
  collectDeliveryKeys,
  buildDeliveryFilterFormula,
  splitCampaignType,
  INDEX_FIELDS,
  INDEX_CHUNK_SIZE,
} from './emailEventDeliveryIndex.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const REC_DEL = 'recDELIVERY000001';
const REC_CUST = 'recCUSTOMER000001';

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

const row = (over = {}) => ({
  id: REC_DEL,
  fields: {
    DeliveryKey: KEY_A,
    CustomerRecordId: REC_CUST,
    CampaignType: 'expired-comeback:v2',
    Status: 'sent',
    ...over,
  },
});

const event = (args = {}) => normalizeEvent({
  event: 'open', timestamp: 1785000000, email: 'a@example.com', sg_event_id: 'EV1', sg_message_id: 'MSG1', ...args,
}).event;

const full = { delivery_key: KEY_A, campaign_delivery_id: REC_DEL, customer_record_id: REC_CUST };

// ── 索引づくり ──────────────────────────────────────────────
test('索引は DeliveryKey と recordId の両方から引ける', () => {
  const idx = buildDeliveryIndex([row()]);
  assert.equal(idx.get(KEY_A).recordId, REC_DEL);
  assert.equal(idx.get(REC_DEL).deliveryKey, KEY_A);
  assert.equal(idx.get(KEY_A).campaignId, 'expired-comeback');
  assert.equal(idx.get(KEY_A).campaignVersion, '2');
});

test('同一 DeliveryKey に複数レコードがあれば索引に載せない（どれか 1 つを選ばない）', () => {
  const idx = buildDeliveryIndex([row(), { id: 'recDELIVERY000002', fields: { DeliveryKey: KEY_A, CustomerRecordId: 'recCUSTOMER000002' } }]);
  assert.equal(idx.has(KEY_A), false);
});

test('索引に生メールアドレスを載せない', () => {
  const idx = buildDeliveryIndex([row({ RecipientEmail: 'a@example.com' })]);
  const serialized = JSON.stringify([...idx.values()]);
  assert.equal(serialized.includes('@'), false);
  assert.equal(INDEX_FIELDS.includes('RecipientEmail'), false, '索引が宛先アドレスを取得している');
});

test('CampaignType が壊れていればキャンペーンは空（推測しない）', () => {
  assert.deepEqual(splitCampaignType('nope'), { campaignId: '', campaignVersion: '' });
  assert.deepEqual(splitCampaignType('expired-comeback:v2'), { campaignId: 'expired-comeback', campaignVersion: '2' });
});

// ── 3 点完全一致 ────────────────────────────────────────────
test('3 点完全一致だけが resolved', () => {
  const idx = buildDeliveryIndex([row()]);
  const a = resolveAttribution({ event: event(full), deliveryIndex: idx });
  assert.equal(a.status, RESOLUTION.RESOLVED);
  assert.equal(a.deliveryKey, KEY_A);
  assert.equal(a.campaignDeliveryId, REC_DEL);
  assert.equal(a.customerRecordId, REC_CUST);
});

for (const [missing, label] of [['delivery_key', '鍵'], ['campaign_delivery_id', '配信 recordId'], ['customer_record_id', '顧客 recordId']]) {
  test(`${label}が欠けていれば unresolved（incomplete_custom_args）`, () => {
    const idx = buildDeliveryIndex([row()]);
    const args = { ...full };
    delete args[missing];
    const a = resolveAttribution({ event: event(args), deliveryIndex: idx });
    assert.equal(a.status, RESOLUTION.UNRESOLVED);
    assert.equal(a.reason, 'incomplete_custom_args');
    assert.equal(a.customerRecordId, '');
    assert.equal(a.campaignDeliveryId, '');
  });
}

test('刻印が 1 つも無ければ no_custom_args（1c 以前のイベント）', () => {
  const a = resolveAttribution({ event: event(), deliveryIndex: buildDeliveryIndex([row()]) });
  assert.equal(a.status, RESOLUTION.UNRESOLVED);
  assert.equal(a.reason, 'no_custom_args');
});

test('鍵が台帳の値と違えば conflict（delivery_key_mismatch）', () => {
  // recordId からは引けるが、鍵が食い違う（偽装・取り違え）
  const idx = new Map([[REC_DEL, { recordId: REC_DEL, deliveryKey: KEY_B, customerRecordId: REC_CUST }]]);
  const a = resolveAttribution({ event: event(full), deliveryIndex: idx });
  assert.equal(a.status, RESOLUTION.CONFLICT);
  assert.equal(a.reason, 'delivery_key_mismatch');
});

test('配信 recordId が台帳と違えば conflict（campaign_delivery_mismatch）', () => {
  const idx = new Map([[KEY_A, { recordId: 'recDELIVERY000009', deliveryKey: KEY_A, customerRecordId: REC_CUST }]]);
  const a = resolveAttribution({ event: event(full), deliveryIndex: idx });
  assert.equal(a.status, RESOLUTION.CONFLICT);
  assert.equal(a.reason, 'campaign_delivery_mismatch');
});

test('顧客が台帳と違えば conflict（別人の反応にしない）', () => {
  const idx = buildDeliveryIndex([row()]);
  const a = resolveAttribution({ event: event({ ...full, customer_record_id: 'recCUSTOMER000009' }), deliveryIndex: idx });
  assert.equal(a.status, RESOLUTION.CONFLICT);
  assert.equal(a.reason, 'customer_mismatch');
  assert.equal(a.customerRecordId, '');
});

test('メールアドレスは紐付けに一切使わない', () => {
  const idx = buildDeliveryIndex([row()]);
  // 台帳には同じアドレスの配信があるが、刻印が無いので結び付けない
  const a = resolveAttribution({ event: event({ email: 'a@example.com' }), deliveryIndex: idx });
  assert.equal(a.status, RESOLUTION.UNRESOLVED);
  assert.equal(a.customerRecordId, '');
});

// ── バッチ全体 ──────────────────────────────────────────────
test('同一バッチで resolved と unresolved が混在しても取り違えない', () => {
  const idx = buildDeliveryIndex([row()]);
  const batch = buildLedgerBatch({
    rawEvents: [
      { event: 'open', timestamp: 1785000000, email: 'a@example.com', sg_event_id: 'E1', ...full },
      { event: 'open', timestamp: 1785000001, email: 'b@example.com', sg_event_id: 'E2' },
    ],
    deliveryIndex: idx, receivedAtMs: 1785000100000, hashFn: hash,
  });
  assert.equal(batch.accepted, 2);
  assert.equal(batch.byResolution.resolved, 1);
  assert.equal(batch.byResolution.unresolved, 1);
  const resolved = batch.rows.find((r) => r.fields.ResolutionStatus === 'resolved');
  const unresolved = batch.rows.find((r) => r.fields.ResolutionStatus === 'unresolved');
  assert.equal(resolved.fields.CustomerRecordId, REC_CUST);
  assert.equal('CustomerRecordId' in unresolved.fields, false, '未確定なのに顧客列を書いている');
});

// ── 索引の取得（read-only / bounded）────────────────────────
test('刻印を持つイベントが無ければ 1 リクエストも出さない', async () => {
  let calls = 0;
  const r = await fetchDeliveryIndex({
    rawEvents: [{ event: 'open', timestamp: 1, email: 'a@example.com' }],
    apiKey: 'k', baseId: 'b', fetchFn: async () => { calls += 1; return { ok: true, json: async () => ({ records: [] }) }; },
  });
  assert.equal(calls, 0);
  assert.equal(r.index.size, 0);
  assert.equal(r.requests, 0);
});

test('必要な鍵だけを GET で引く（write しない・全件走査しない）', async () => {
  const seen = [];
  const r = await fetchDeliveryIndex({
    rawEvents: [{ event: 'open', timestamp: 1, delivery_key: KEY_A }, { event: 'click', timestamp: 2, delivery_key: KEY_A }],
    apiKey: 'k', baseId: 'appTEST',
    fetchFn: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({ records: [row()] }) };
    },
  });
  assert.equal(seen.length, 1, '重複した鍵で 2 回引いている');
  assert.equal(seen[0].init.method, undefined, 'GET 以外で引いている');
  assert.ok(seen[0].url.includes('filterByFormula'), '全件走査している');
  assert.ok(seen[0].url.includes('CampaignDeliveries'));
  assert.equal(r.index.get(KEY_A).recordId, REC_DEL);
  assert.equal(r.ok, true);
});

test('索引を引けなければ空の索引を返し、イベントは unresolved のまま保存される', async () => {
  const r = await fetchDeliveryIndex({
    rawEvents: [{ event: 'open', timestamp: 1, delivery_key: KEY_A }],
    apiKey: 'k', baseId: 'b', fetchFn: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.index.size, 0);
  const a = resolveAttribution({ event: event(full), deliveryIndex: r.index });
  assert.equal(a.status, RESOLUTION.UNRESOLVED);
  assert.equal(a.reason, 'delivery_not_found');
});

test('鍵は sha256 hex のものだけ引く（injection・無駄打ちの遮断）', () => {
  const keys = collectDeliveryKeys([
    { delivery_key: KEY_A },
    { delivery_key: "') OR 1=1 --" },
    { delivery_key: 'short' },
  ]);
  assert.deepEqual(keys, [KEY_A]);
  assert.equal(buildDeliveryFilterFormula(["') OR 1=1 --"]), '');
  assert.equal(buildDeliveryFilterFormula([KEY_A]), `{DeliveryKey}='${KEY_A}'`);
  assert.ok(buildDeliveryFilterFormula([KEY_A, KEY_B]).startsWith('OR('));
});

test('鍵が多くてもチャンク分割して上限内に収める', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ delivery_key: (i % 16).toString(16).repeat(64).slice(0, 64) }));
  let calls = 0;
  await fetchDeliveryIndex({
    rawEvents: many, apiKey: 'k', baseId: 'b',
    fetchFn: async () => { calls += 1; return { ok: true, json: async () => ({ records: [] }) }; },
  });
  assert.ok(calls <= Math.ceil(16 / INDEX_CHUNK_SIZE) + 1, `リクエストが多すぎる: ${calls}`);
});

// ── 顧客カルテ用の集約（台帳が正本）─────────────────────────
test('カルテ集約は resolved の行だけを数える（unresolved は別枠）', () => {
  const evt = (type, status, cust) => ({
    fields: { EventType: type, EventAt: '2026-08-02T00:00:00.000Z', ResolutionStatus: status, CustomerRecordId: cust },
  });
  const s = summarizeCustomerEventsFromLedger({
    ledgerAvailable: true,
    customerRecordId: REC_CUST,
    ledgerRows: [
      evt('delivered', 'resolved', REC_CUST),
      evt('open', 'resolved', REC_CUST),
      evt('open', 'resolved', 'recCUSTOMER000009'), // 別人
      evt('click', 'unresolved', ''),
      evt('open', 'conflict', ''),
    ],
  });
  assert.equal(s.available, true);
  assert.equal(s.delivered, 1);
  assert.equal(s.opens, 1, '別人の反応を数えている');
  assert.equal(s.clicks, 0);
  assert.equal(s.unattributed, 1, '未確定の件数を別枠で出していない');
  assert.equal(s.conflicts, 1);
});

test('台帳が無い期間は 0 ではなく「不明」（未開封と取得不能を混同しない）', () => {
  const s = summarizeCustomerEventsFromLedger({ ledgerAvailable: false, customerRecordId: REC_CUST });
  assert.equal(s.available, false);
  assert.equal(s.opens, null);
  assert.equal(s.delivered, null);
});

test('顧客が指定されなければ集計しない（全件を誰かの反応にしない）', () => {
  const s = summarizeCustomerEventsFromLedger({ ledgerAvailable: true, customerRecordId: '', ledgerRows: [] });
  assert.equal(s.available, false);
});
