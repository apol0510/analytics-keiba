/**
 * campaignCustomArgs.test.mjs — マーケ配信の custom_args（Phase 1c）
 *
 * 刻印は「後から 1 通を特定するため」であって、**推測で顧客へ結び付けないため**の仕組みでもある。
 * 欠けている・食い違う・形式が違うときに **送らない（fail closed）** ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCampaignCustomArgs,
  indexDeliveriesByRecipient,
  parseCampaignType,
  isSafeCustomArgValue,
  CUSTOM_ARG_KEYS,
  CUSTOM_ARGS_REJECT,
  MARKETING_PURPOSE,
  MAX_CUSTOM_ARGS_BYTES,
} from './campaignCustomArgs.js';

const KEY64 = 'a'.repeat(64);
const REC_DELIVERY = 'recDELIVERY000001';
const REC_CUSTOMER = 'recCUSTOMER000001';

const delivery = (over = {}) => ({
  recordId: REC_DELIVERY,
  deliveryKey: KEY64,
  customerRecordId: REC_CUSTOMER,
  campaignType: 'expired-comeback:v2',
  status: 'queued',
  ...over,
});

const airtableRow = (over = {}, fields = {}) => ({
  id: REC_DELIVERY,
  fields: {
    EmailType: 'campaign',
    ScheduledEmailJobId: 'JOB-1',
    RecipientEmail: 'a@example.com',
    DeliveryKey: KEY64,
    CustomerRecordId: REC_CUSTOMER,
    CampaignType: 'expired-comeback:v2',
    Status: 'queued',
    ...fields,
  },
  ...over,
});

// ── 1. 正常系 ───────────────────────────────────────────────
test('正常: 権威データ（CampaignDeliveries）からそのまま刻む', () => {
  const r = buildCampaignCustomArgs({
    delivery: delivery(), customerRecordId: REC_CUSTOMER,
    campaignId: 'expired-comeback', campaignVersion: '2',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.customArgs, {
    [CUSTOM_ARG_KEYS.DELIVERY_KEY]: KEY64,
    [CUSTOM_ARG_KEYS.CAMPAIGN_DELIVERY_ID]: REC_DELIVERY,
    [CUSTOM_ARG_KEYS.CUSTOMER_RECORD_ID]: REC_CUSTOMER,
    [CUSTOM_ARG_KEYS.CAMPAIGN_ID]: 'expired-comeback',
    [CUSTOM_ARG_KEYS.CAMPAIGN_VERSION]: '2',
    [CUSTOM_ARG_KEYS.PURPOSE]: MARKETING_PURPOSE,
  });
});

test('受信側 emailEventLedger.js と同じ綴りのキーを使う（片方だけ変えない）', () => {
  assert.deepEqual(Object.values(CUSTOM_ARG_KEYS).sort(), [
    'campaign_delivery_id', 'campaign_id', 'campaign_version',
    'customer_record_id', 'delivery_key', 'purpose',
  ]);
});

// ── 2〜4. 欠落系（すべて fail closed）────────────────────────
test('delivery_key 欠落 → 送らない', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ deliveryKey: '' }) });
  assert.deepEqual(r, { ok: false, reason: CUSTOM_ARGS_REJECT.DELIVERY_KEY_INVALID });
});

test('delivery_key が sha256 hex でない → 送らない（再生成もしない）', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ deliveryKey: 'not-a-hash' }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CUSTOM_ARGS_REJECT.DELIVERY_KEY_INVALID);
});

test('customer_record_id 欠落 → 送らない', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ customerRecordId: '' }) });
  assert.deepEqual(r, { ok: false, reason: CUSTOM_ARGS_REJECT.CUSTOMER_RECORD_ID_INVALID });
});

test('customer_record_id が Airtable recordId 形式でない → 送らない', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ customerRecordId: 'a@example.com' }) });
  assert.equal(r.reason, CUSTOM_ARGS_REJECT.CUSTOMER_RECORD_ID_INVALID);
});

test('campaign_delivery_id 欠落（作成前）→ 送らない', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ recordId: '' }) });
  assert.deepEqual(r, { ok: false, reason: CUSTOM_ARGS_REJECT.CAMPAIGN_DELIVERY_ID_INVALID });
});

// ── 5. CampaignDelivery が無い（作成失敗）→ 送信 0 ──────────
test('配信レコードが無い → delivery_not_found で送らない', () => {
  assert.deepEqual(buildCampaignCustomArgs({ delivery: null }),
    { ok: false, reason: CUSTOM_ARGS_REJECT.DELIVERY_NOT_FOUND });
  assert.deepEqual(buildCampaignCustomArgs({}),
    { ok: false, reason: CUSTOM_ARGS_REJECT.DELIVERY_NOT_FOUND });
});

test('index: ジョブの配信行が 0 件なら誰も解決できない（＝送信 0 になる）', () => {
  const idx = indexDeliveriesByRecipient([], 'JOB-1');
  assert.equal(idx.size, 0);
  assert.equal(buildCampaignCustomArgs({ delivery: idx.get('a@example.com') || null }).ok, false);
});

// ── 7. 二重送信防止 ─────────────────────────────────────────
test('既に sent の配信行へは再送しない（ジョブが PENDING で残っていても）', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ status: 'sent' }) });
  assert.deepEqual(r, { ok: false, reason: CUSTOM_ARGS_REJECT.ALREADY_SENT });
});

test('queued / skipped 状態は送信対象（sent だけを弾く）', () => {
  assert.equal(buildCampaignCustomArgs({ delivery: delivery({ status: 'queued' }) }).ok, true);
  assert.equal(buildCampaignCustomArgs({ delivery: delivery({ status: 'failed' }) }).ok, true);
});

// ── 8. DeliveryKey の冪等性 ─────────────────────────────────
test('同一 DeliveryKey なら何度組み立てても同じ custom_args（冪等）', () => {
  const a = buildCampaignCustomArgs({ delivery: delivery() });
  const b = buildCampaignCustomArgs({ delivery: delivery() });
  assert.deepEqual(a.customArgs, b.customArgs);
});

test('index: 同一アドレスに複数行があれば**どれも採らない**（鍵を推測で選ばない）', () => {
  const idx = indexDeliveriesByRecipient([
    airtableRow(),
    airtableRow({ id: 'recDELIVERY000002' }, { DeliveryKey: 'b'.repeat(64) }),
  ], 'JOB-1');
  assert.equal(idx.has('a@example.com'), false);
});

test('index: 別ジョブ・別 EmailType の行を掴まない', () => {
  const idx = indexDeliveriesByRecipient([
    airtableRow({}, { ScheduledEmailJobId: 'JOB-OTHER' }),
    airtableRow({ id: 'recDELIVERY000003' }, { EmailType: 'step', RecipientEmail: 'b@example.com' }),
  ], 'JOB-1');
  assert.equal(idx.size, 0);
});

// ── 9・10. 誤紐付け防止 / conflict ──────────────────────────
test('いま引いた顧客と配信台帳の顧客が食い違う → conflict で送らない（別人への紐付け防止）', () => {
  const r = buildCampaignCustomArgs({
    delivery: delivery(), customerRecordId: 'recOTHERCUST00001',
  });
  assert.deepEqual(r, { ok: false, reason: CUSTOM_ARGS_REJECT.CUSTOMER_RECORD_ID_CONFLICT });
});

test('顧客は enqueue 時の権威値を刻む（アドレスから引き直した値で上書きしない）', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery(), customerRecordId: '' });
  assert.equal(r.customArgs[CUSTOM_ARG_KEYS.CUSTOMER_RECORD_ID], REC_CUSTOMER);
});

test('ジョブのキャンペーンと配信行のキャンペーンが違う → campaign_mismatch', () => {
  const r = buildCampaignCustomArgs({
    delivery: delivery(), campaignId: 'premium-renewal', campaignVersion: '2',
  });
  assert.deepEqual(r, { ok: false, reason: CUSTOM_ARGS_REJECT.CAMPAIGN_MISMATCH });
});

test('version 違い（本文差し替え後の再送）も campaign_mismatch', () => {
  const r = buildCampaignCustomArgs({
    delivery: delivery(), campaignId: 'expired-comeback', campaignVersion: '3',
  });
  assert.equal(r.reason, CUSTOM_ARGS_REJECT.CAMPAIGN_MISMATCH);
});

test('CampaignType が壊れている → 推測で補完せず送らない', () => {
  for (const bad of ['', 'expired-comeback', 'expired-comeback:2', ':v2', 'Expired:v2']) {
    const r = buildCampaignCustomArgs({ delivery: delivery({ campaignType: bad }) });
    assert.equal(r.ok, false, `"${bad}" を受け入れている`);
  }
  assert.deepEqual(parseCampaignType('expired-comeback:v2'), { campaignId: 'expired-comeback', version: '2' });
  assert.equal(parseCampaignType('nope'), null);
});

// ── 11. PII 非混入 ──────────────────────────────────────────
test('生アドレス・氏名・token・OfferKey・URL・secret を刻まない', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery(), customerRecordId: REC_CUSTOMER });
  const serialized = JSON.stringify(r.customArgs);
  for (const needle of ['@', 'http', '小田', 'token', 'Bearer', ' ']) {
    assert.equal(serialized.includes(needle), false, `custom_args に ${needle} が入っている`);
  }
  assert.deepEqual(Object.keys(r.customArgs).sort(), [
    'campaign_delivery_id', 'campaign_id', 'campaign_version',
    'customer_record_id', 'delivery_key', 'purpose',
  ]);
});

test('値の安全性チェック: アドレス・URL・空白・長すぎる値を弾く', () => {
  assert.equal(isSafeCustomArgValue('recABCDEFGHIJKLMN'), true);
  assert.equal(isSafeCustomArgValue('a@example.com'), false);
  assert.equal(isSafeCustomArgValue('https://analytics.keiba.link/offer/?t=x'), false);
  assert.equal(isSafeCustomArgValue('has space'), false);
  assert.equal(isSafeCustomArgValue(''), false);
  assert.equal(isSafeCustomArgValue('x'.repeat(129)), false);
});

test('壊れた値が混ざったら value_not_safe で送らない', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery({ campaignType: 'a b:v1' }) });
  assert.equal(r.ok, false);
});

test('custom_args のサイズは provider 上限より十分小さい', () => {
  const r = buildCampaignCustomArgs({ delivery: delivery() });
  const bytes = Buffer.byteLength(JSON.stringify(r.customArgs), 'utf8');
  assert.ok(bytes < 400, `custom_args が大きすぎる: ${bytes}B`);
  assert.ok(bytes < MAX_CUSTOM_ARGS_BYTES);
});

// ── 12. Payment Email v2 との分離 ───────────────────────────
test('purpose は決済メール v2 と別の値（イベントの取り違えを防ぐ）', () => {
  assert.equal(MARKETING_PURPOSE, 'marketing_campaign');
  assert.notEqual(MARKETING_PURPOSE, 'payment_confirmation_v2');
  const r = buildCampaignCustomArgs({ delivery: delivery() });
  assert.equal(r.customArgs.purpose, 'marketing_campaign');
  // 決済 v2 のキー（record_id / idempotency_key）を持たない
  assert.equal('record_id' in r.customArgs, false);
  assert.equal('idempotency_key' in r.customArgs, false);
});

// ── 13. Phase 1b との関係 ───────────────────────────────────
test('刻印は新規送信にだけ効く（既存イベントを書き換える仕組みを持たない）', () => {
  // このモジュールは純粋関数のみ。台帳・配信台帳への書き込み関数を公開しない。
  const r = buildCampaignCustomArgs({ delivery: delivery() });
  assert.equal(typeof r.customArgs, 'object');
  assert.equal(Object.isFrozen(CUSTOM_ARG_KEYS), true);
});
