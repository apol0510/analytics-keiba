/**
 * emailEventOpenClick.fixture.test.mjs — 設定変更後に**届くはずのもの**を先に固定する
 *   node --test src/lib/webhooks/emailEventOpenClick.fixture.test.mjs
 *
 * ── なぜ fixture が要るか ──────────────────────────────────────
 * 開封・クリックを台帳へ入れる作業は、配信基盤側の設定を変えて実際にメールを送るまで
 * 「入るかどうか」を確かめられない。だが**入ったときに何が起きるべきか**は先に固定できる。
 * このテストは、実際に届く形（2026-08-04 のマーケ配信 `comeback-light-30d-granted:v2` と
 * 同じ custom_args の綴り）の open / click イベントを流し込み、
 *
 *   - `resolved` になること（メールアドレスでは紐付けない）
 *   - **クリック URL の token が保存されないこと**
 *   - 同じ人の複数回の開封が**別行として残る**こと
 *
 * を確認する。テスト送信の期待結果はこの fixture が正本で、
 * 実際の `EmailEvents` の行と突き合わせる（手順は `docs/DELIVERY_MEASUREMENT.md`）。
 *
 * ⚠️ ネットワークも Airtable も使わない（純粋関数のみ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  EVENT_TYPE, RESOLUTION, buildLedgerBatch, assertOnlyLedgerFields,
} from './emailEventLedger.js';
import { buildDeliveryIndex } from './emailEventDeliveryIndex.js';
import { CUSTOM_ARG_KEYS, MARKETING_PURPOSE } from '../marketing/campaignCustomArgs.js';

const hashFn = (s) => createHash('sha256').update(String(s)).digest('hex');
const RECEIVED_AT = Date.UTC(2026, 7, 5, 1, 0, 0);
const SENT_AT_SEC = Math.floor(Date.UTC(2026, 7, 5, 0, 30, 0) / 1000);

/** enqueue 済みの配信 1 行（CampaignDeliveries の実際の形） */
const DELIVERY_RECORD = {
  id: 'recDelivery0001',
  fields: {
    DeliveryKey: '96b0ea97406a4d2f9b1c',
    CustomerRecordId: 'recCustomer00001',
    CampaignType: 'comeback-light-30d-granted:v2',
    EmailType: 'campaign',
    Status: 'sent',
  },
};

/** provider から届く 1 イベント（custom_args は最上位キーとして届く） */
const providerEvent = (over = {}) => ({
  email: 'someone@example.com',
  timestamp: SENT_AT_SEC,
  event: EVENT_TYPE.OPEN,
  sg_event_id: 'evt-open-0001',
  sg_message_id: 'GoKM8rWITy.filter0001.16648.0',
  [CUSTOM_ARG_KEYS.DELIVERY_KEY]: DELIVERY_RECORD.fields.DeliveryKey,
  [CUSTOM_ARG_KEYS.CAMPAIGN_DELIVERY_ID]: DELIVERY_RECORD.id,
  [CUSTOM_ARG_KEYS.CUSTOMER_RECORD_ID]: DELIVERY_RECORD.fields.CustomerRecordId,
  [CUSTOM_ARG_KEYS.CAMPAIGN_ID]: 'comeback-light-30d-granted',
  [CUSTOM_ARG_KEYS.CAMPAIGN_VERSION]: '2',
  [CUSTOM_ARG_KEYS.PURPOSE]: MARKETING_PURPOSE,
  ...over,
});

const runBatch = (rawEvents) => buildLedgerBatch({
  rawEvents,
  deliveryIndex: buildDeliveryIndex([DELIVERY_RECORD]),
  receivedAtMs: RECEIVED_AT,
  hashFn,
  verification: 'verified',
  createdBy: 'sendgrid-webhook',
});

test('fixture: open イベントは配信 1 通へ確定して台帳に入る', () => {
  const batch = runBatch([providerEvent()]);
  assert.equal(batch.rows.length, 1, 'open が台帳行になっていない');
  const f = batch.rows[0].fields;
  assert.equal(f.EventType, EVENT_TYPE.OPEN);
  assert.equal(f.ResolutionStatus, RESOLUTION.RESOLVED, 'open を顧客へ結び付けられていない');
  assert.equal(f.CustomerRecordId, 'recCustomer00001');
  assert.equal(f.CampaignId, 'comeback-light-30d-granted');
  assert.equal(f.CampaignVersion, '2');
  assert.equal(f.VerificationStatus, 'verified');
  // 生アドレスは保存しない
  assert.equal(JSON.stringify(f).includes('someone@example.com'), false, '生アドレスを保存している');
  assert.ok(assertOnlyLedgerFields(f), '許可外の列を書こうとしている');
});

test('fixture: click イベントは token を保存せず分類だけ残す', () => {
  const batch = runBatch([providerEvent({
    event: EVENT_TYPE.CLICK,
    sg_event_id: 'evt-click-0001',
    url: 'https://analytics.keiba.link/offer/?t=SIGNED_TOKEN_VALUE_DO_NOT_STORE',
  })]);
  assert.equal(batch.rows.length, 1);
  const f = batch.rows[0].fields;
  assert.equal(f.EventType, EVENT_TYPE.CLICK);
  assert.equal(f.ResolutionStatus, RESOLUTION.RESOLVED);
  assert.equal(f.UrlCategory, 'offer', 'クリック先の分類が入っていない');
  assert.equal(f.UrlPath, '/offer');
  const dumped = JSON.stringify(f);
  assert.equal(dumped.includes('SIGNED_TOKEN_VALUE_DO_NOT_STORE'), false, 'token を台帳へ保存している');
  assert.equal(dumped.includes('?t='), false, 'クエリを台帳へ保存している');
});

test('fixture: 同じ人の 2 回目の開封は別行として残る', () => {
  const batch = runBatch([
    providerEvent({ sg_event_id: 'evt-open-0001', timestamp: SENT_AT_SEC }),
    providerEvent({ sg_event_id: 'evt-open-0002', timestamp: SENT_AT_SEC + 3600 }),
  ]);
  assert.equal(batch.rows.length, 2, '複数回の開封を 1 行に潰している');
  const keys = new Set(batch.rows.map((r) => r.fields.EventKey));
  assert.equal(keys.size, 2, 'EventKey が重複している（upsert で消える）');
});

test('fixture: 刻印の無い open は保存しても顧客へ結び付けない', () => {
  // 設定変更後は、custom_args を刻んでいない経路（ログインメール等）の open も届く。
  // それを誰かの反応として数えないことを固定する。
  const bare = {
    email: 'someone@example.com', timestamp: SENT_AT_SEC,
    event: EVENT_TYPE.OPEN, sg_event_id: 'evt-open-bare', sg_message_id: 'X.filter1.1.0',
  };
  const batch = runBatch([bare]);
  assert.equal(batch.rows.length, 1, '事実として保存していない');
  const f = batch.rows[0].fields;
  assert.equal(f.ResolutionStatus, RESOLUTION.UNRESOLVED);
  assert.equal(f.CustomerRecordId ?? '', '', '推測で顧客へ結び付けている');
  assert.equal(f.ResolutionReason, 'no_custom_args');
});

test('fixture: 別人の recordId を刻んだ open は conflict として採らない', () => {
  const batch = runBatch([providerEvent({
    sg_event_id: 'evt-open-conflict',
    [CUSTOM_ARG_KEYS.CUSTOMER_RECORD_ID]: 'recSomeoneElse01',
  })]);
  const f = batch.rows[0].fields;
  assert.equal(f.ResolutionStatus, RESOLUTION.CONFLICT, '食い違いを採用している');
  assert.equal(f.CustomerRecordId ?? '', '');
});
