/**
 * emailEventLedger.test.mjs — 配信反応の恒久台帳（正規化・冪等性・紐付け・PII 最小化）
 *   node --test src/lib/webhooks/emailEventLedger.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  normalizeEvent,
  buildEventKey,
  resolveAttribution,
  buildLedgerFields,
  buildLedgerBatch,
  assertOnlyLedgerFields,
  summarizeCustomerEvents,
  classifyUrl,
  parseEventTime,
  isLedgerWriteEnabled,
  EVENT_TYPE,
  RESOLUTION,
  REJECT,
  LEDGER_FORBIDDEN_FIELDS,
} from './emailEventLedger.js';

const hashFn = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const NOW = Date.parse('2026-08-01T07:00:00.000Z');
const SEC = Math.floor(Date.parse('2026-08-01T06:00:00.000Z') / 1000);

/** provider が送ってくる形（実際の Event Webhook ペイロードに合わせた fixture） */
const rawEvent = (over = {}) => ({
  email: 'Member@Example.com ',
  timestamp: SEC,
  event: 'open',
  sg_event_id: 'evt_abc123',
  sg_message_id: 'msg_xyz.filter0001.16648.0',
  ip: '203.0.113.10',
  useragent: 'Mozilla/5.0 (iPhone)',
  ...over,
});

// =========================================================================
// 正規化（推測しない）
// =========================================================================

test('既知イベントを正規化し、メールは小文字 trim する', () => {
  const r = normalizeEvent(rawEvent());
  assert.equal(r.ok, true);
  assert.equal(r.event.type, EVENT_TYPE.OPEN);
  assert.equal(r.event.email, 'member@example.com');
  assert.equal(r.event.atMs, SEC * 1000);
  assert.equal(r.event.providerEventId, 'evt_abc123');
});

test('未知イベントは成功扱いにしない（隔離する）', () => {
  const r = normalizeEvent(rawEvent({ event: 'brand_new_event' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.UNKNOWN_EVENT_TYPE);
  assert.equal(r.eventType, 'brand_new_event');
});

test('timestamp / 種別 / 識別子が無ければ取り込まない', () => {
  assert.equal(normalizeEvent(rawEvent({ timestamp: undefined })).reason, REJECT.NO_TIMESTAMP);
  assert.equal(normalizeEvent(rawEvent({ event: '' })).reason, REJECT.NO_EVENT_TYPE);
  assert.equal(normalizeEvent({ event: 'open', timestamp: SEC }).reason, REJECT.NO_IDENTITY);
  assert.equal(normalizeEvent(null).reason, REJECT.NOT_OBJECT);
  assert.equal(normalizeEvent([]).reason, REJECT.NOT_OBJECT);
});

test('timestamp は UNIX 秒 / ISO の両方を読む（読めなければ null）', () => {
  assert.equal(parseEventTime(SEC), SEC * 1000);
  assert.equal(parseEventTime('2026-08-01T06:00:00.000Z'), SEC * 1000);
  assert.equal(parseEventTime('not-a-date'), null);
  assert.equal(parseEventTime(undefined), null);
});

// =========================================================================
// 冪等性
// =========================================================================

test('provider のイベント ID があれば、それが一意キー（再受信で同じ値）', () => {
  const e1 = normalizeEvent(rawEvent()).event;
  const e2 = normalizeEvent(rawEvent()).event;
  assert.equal(buildEventKey({ event: e1, hashFn }), buildEventKey({ event: e2, hashFn }));
  assert.match(buildEventKey({ event: e1, hashFn }), /^sg:evt_abc123$/);
});

test('イベント ID が無ければ メッセージ+種別+時刻+宛先ハッシュ で合成する', () => {
  const e = normalizeEvent(rawEvent({ sg_event_id: '' })).event;
  const key = buildEventKey({ event: e, hashFn });
  assert.match(key, /^c:msg_xyz\.filter0001\.16648\.0:open:\d+:[0-9a-f]{16}$/);
  // 生アドレスをキーに含めない
  assert.equal(key.includes('member@example.com'), false);
});

test('open / click の複数回発生は別イベントとして残る（集計と履歴を混同しない）', () => {
  const first = normalizeEvent(rawEvent({ sg_event_id: '', timestamp: SEC })).event;
  const second = normalizeEvent(rawEvent({ sg_event_id: '', timestamp: SEC + 60 })).event;
  assert.notEqual(buildEventKey({ event: first, hashFn }), buildEventKey({ event: second, hashFn }));
});

test('同一バッチ内の重複は 1 行に畳む', () => {
  const batch = buildLedgerBatch({
    rawEvents: [rawEvent(), rawEvent(), rawEvent({ sg_event_id: 'evt_other' })],
    receivedAtMs: NOW, hashFn,
  });
  assert.equal(batch.received, 3);
  assert.equal(batch.accepted, 2, '同一 EventKey を 2 行書こうとしている');
});

test('順不同・後追いイベント（delivered の後に bounce）を両方残す', () => {
  const batch = buildLedgerBatch({
    rawEvents: [
      rawEvent({ event: 'bounce', sg_event_id: 'e2', timestamp: SEC + 10, reason: '550 5.1.1 unknown', type: 'blocked' }),
      rawEvent({ event: 'delivered', sg_event_id: 'e1', timestamp: SEC }),
    ],
    receivedAtMs: NOW, hashFn,
  });
  assert.equal(batch.accepted, 2);
  const types = batch.rows.map((r) => r.fields.EventType).sort();
  assert.deepEqual(types, ['bounce', 'delivered']);
  const bounce = batch.rows.find((r) => r.fields.EventType === 'bounce');
  assert.equal(bounce.fields.BounceClass, 'blocked');
  assert.match(bounce.fields.ReasonText, /550/);
});

// =========================================================================
// 紐付け（誤紐付け防止）
// =========================================================================

const delivery = { recordId: 'recDEL1', deliveryKey: 'dk_1', customerRecordId: 'recCUST1', campaignId: 'expired-comeback', campaignVersion: '2' };
const index = new Map([['dk_1', delivery], ['recDEL1', delivery]]);

test('custom_args が無ければ unresolved（メールだけで顧客へ結び付けない）', () => {
  const e = normalizeEvent(rawEvent()).event;
  const a = resolveAttribution({ event: e, deliveryIndex: index });
  assert.equal(a.status, RESOLUTION.UNRESOLVED);
  assert.equal(a.reason, 'no_custom_args');
  assert.equal(a.customerRecordId, '', 'メールから顧客を推測している');
  assert.equal(a.campaignDeliveryId, '');
});

test('delivery_key があり台帳に一致すれば resolved', () => {
  const e = normalizeEvent(rawEvent({ delivery_key: 'dk_1' })).event;
  const a = resolveAttribution({ event: e, deliveryIndex: index });
  assert.equal(a.status, RESOLUTION.RESOLVED);
  assert.equal(a.campaignDeliveryId, 'recDEL1');
  assert.equal(a.customerRecordId, 'recCUST1');
  assert.equal(a.campaignId, 'expired-comeback');
});

test('delivery_key があっても台帳に無ければ unresolved（作らない）', () => {
  const e = normalizeEvent(rawEvent({ delivery_key: 'dk_unknown' })).event;
  const a = resolveAttribution({ event: e, deliveryIndex: index });
  assert.equal(a.status, RESOLUTION.UNRESOLVED);
  assert.equal(a.reason, 'delivery_not_found');
  assert.equal(a.campaignDeliveryId, '');
});

test('custom_args の顧客と台帳の顧客が食い違えば conflict（どちらも採らない）', () => {
  const e = normalizeEvent(rawEvent({ delivery_key: 'dk_1', customer_record_id: 'recOTHER' })).event;
  const a = resolveAttribution({ event: e, deliveryIndex: index });
  assert.equal(a.status, RESOLUTION.CONFLICT);
  assert.equal(a.reason, 'customer_mismatch');
  assert.equal(a.customerRecordId, '', '食い違うのに顧客を結び付けている');
});

test('複数の配信候補が食い違えば conflict', () => {
  const other = { recordId: 'recDEL2', deliveryKey: 'dk_1', customerRecordId: 'recCUST2' };
  const idx = new Map([['dk_1', delivery], ['recDEL9', other]]);
  const e = normalizeEvent(rawEvent({ delivery_key: 'dk_1', campaign_delivery_id: 'recDEL9' })).event;
  const a = resolveAttribution({ event: e, deliveryIndex: idx });
  assert.equal(a.status, RESOLUTION.CONFLICT);
  assert.equal(a.reason, 'multiple_deliveries');
});

// =========================================================================
// 個人情報の最小化
// =========================================================================

test('IP / User-Agent / 生メール / 生 URL を台帳へ書かない', () => {
  const batch = buildLedgerBatch({
    rawEvents: [rawEvent({ event: 'click', url: 'https://analytics.keiba.link/offer/?t=SECRET_TOKEN_VALUE' })],
    receivedAtMs: NOW, hashFn,
  });
  const dump = JSON.stringify(batch.rows[0].fields);
  for (const banned of ['203.0.113.10', 'Mozilla', 'member@example.com', 'SECRET_TOKEN_VALUE', '?t=']) {
    assert.equal(dump.includes(banned), false, `${banned} を台帳へ書いている`);
  }
  assert.equal(batch.rows[0].fields.UrlCategory, 'offer');
  assert.equal(batch.rows[0].fields.UrlPath, '/offer');
  assert.match(batch.rows[0].fields.EmailHash, /^[0-9a-f]{32}$/);
});

test('URL 分類は token を落としてカテゴリだけ残す', () => {
  assert.deepEqual(classifyUrl('https://analytics.keiba.link/offer/?t=abc'), { category: 'offer', path: '/offer' });
  assert.equal(classifyUrl('https://analytics.keiba.link/pricing/').category, 'pricing');
  assert.equal(classifyUrl('https://analytics.keiba.link/').category, 'top');
  assert.equal(classifyUrl('https://example.com/whatever').category, 'other');
  assert.equal(classifyUrl('').category, 'none');
});

test('許可列以外を書こうとしたら弾く', () => {
  const ok = buildLedgerFields({
    event: normalizeEvent(rawEvent()).event,
    attribution: { status: RESOLUTION.UNRESOLVED, reason: 'no_custom_args', deliveryKey: '', campaignDeliveryId: '', customerRecordId: '', campaignId: '', campaignVersion: '' },
    eventKey: 'sg:evt_abc123', receivedAtMs: NOW, hashFn,
  });
  assert.equal(assertOnlyLedgerFields(ok), true);
  for (const bad of LEDGER_FORBIDDEN_FIELDS) {
    assert.equal(assertOnlyLedgerFields({ ...ok, [bad]: 'x' }), false, `${bad} を通している`);
  }
  assert.equal(assertOnlyLedgerFields({}), false);
});

// =========================================================================
// 集計（不明と 0 を区別）
// =========================================================================

const row = (type, at, cat) => ({ fields: { EventType: type, EventAt: at, UrlCategory: cat } });

test('台帳が無い期間は 0 ではなく不明として返す', () => {
  const s = summarizeCustomerEvents({ ledgerRows: [], ledgerAvailable: false });
  assert.equal(s.available, false);
  assert.equal(s.opens, null, '取得不能を 0 と表示しようとしている');
  assert.equal(s.clicks, null);
  assert.equal(s.firstOpenAt, null);
});

test('台帳があれば 初回/最終/回数/クリック分類 を出す', () => {
  const s = summarizeCustomerEvents({
    ledgerAvailable: true,
    ledgerRows: [
      row('delivered', '2026-08-01T00:00:00.000Z'),
      row('open', '2026-08-01T01:00:00.000Z'),
      row('open', '2026-08-01T03:00:00.000Z'),
      row('click', '2026-08-01T02:00:00.000Z', 'offer'),
      row('bounce', '2026-07-30T00:00:00.000Z'),
      row('unsubscribe', '2026-07-31T00:00:00.000Z'),
    ],
  });
  assert.equal(s.available, true);
  assert.equal(s.delivered, 1);
  assert.equal(s.opens, 2);
  assert.equal(s.clicks, 1);
  assert.equal(s.firstOpenAt, '2026-08-01T01:00:00.000Z');
  assert.equal(s.lastOpenAt, '2026-08-01T03:00:00.000Z');
  assert.equal(s.firstClickAt, '2026-08-01T02:00:00.000Z');
  assert.equal(s.bounced, 1);
  assert.equal(s.unsubscribed, 1);
  assert.deepEqual(s.clickCategories, ['offer']);
});

test('台帳ありで反応が無ければ 0（不明ではない）', () => {
  const s = summarizeCustomerEvents({ ledgerAvailable: true, ledgerRows: [row('delivered', '2026-08-01T00:00:00.000Z')] });
  assert.equal(s.opens, 0, '「未開封」を不明にしている');
  assert.equal(s.clicks, 0);
  assert.equal(s.firstOpenAt, null);
});

// =========================================================================
// 既定 OFF
// =========================================================================

test('台帳書き込みは env が true のときだけ有効（既定 OFF）', () => {
  assert.equal(isLedgerWriteEnabled({}), false);
  assert.equal(isLedgerWriteEnabled({ EMAIL_EVENT_LEDGER_ENABLED: '' }), false);
  assert.equal(isLedgerWriteEnabled({ EMAIL_EVENT_LEDGER_ENABLED: 'false' }), false);
  assert.equal(isLedgerWriteEnabled({ EMAIL_EVENT_LEDGER_ENABLED: '1' }), false, '曖昧な値で有効化している');
  assert.equal(isLedgerWriteEnabled({ EMAIL_EVENT_LEDGER_ENABLED: 'true' }), true);
});

test('バッチは取り込めなかった理由を数える（黙って落とさない）', () => {
  const batch = buildLedgerBatch({
    rawEvents: [rawEvent(), rawEvent({ event: 'weird' }), { event: 'open' }, null],
    receivedAtMs: NOW, hashFn,
  });
  assert.equal(batch.accepted, 1);
  assert.equal(batch.rejected[REJECT.UNKNOWN_EVENT_TYPE], 1);
  assert.equal(batch.rejected[REJECT.NO_TIMESTAMP], 1);
  assert.equal(batch.rejected[REJECT.NOT_OBJECT], 1);
  assert.equal(batch.byResolution[RESOLUTION.UNRESOLVED], 1);
});
