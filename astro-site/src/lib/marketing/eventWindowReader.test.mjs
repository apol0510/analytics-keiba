/**
 * eventWindowReader.test.mjs — 「日全体の blob 数」で fail closed していた事故を固定する
 *
 * 2026-08-18 の本番事故: 旧実装は `list({prefix})`（**その UTC 日全体**）の件数を
 * `MAX_EVENT_BLOBS=200` と比べ、**バッチ窓で絞る前に** null を返していた。
 * 送るほど当日の blob が増えるので健全性を永久に読めず、
 * `batch_stats_unreadable` で自動停止した（実測: 日合計 523 blob）。
 *
 * ここで固定するのは 2 つ:
 *   1. 上限は「**実際に読む候補**」へ当てる（日全体ではない）
 *   2. 窓外の blob は **get しない**（Function 時間を増やさない）
 * かつ、**本物の読み取り失敗は今までどおり null**（fail closed）であること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readEventWindow, isBlobInWindow, parseBlobKeyReceivedAtMs,
  MAX_EVENT_BLOBS, RECEIVE_CLOCK_SKEW_MS, KEY_TIME_GRANULARITY_MS,
} from './eventWindowReader.js';
import { buildBatchBlobKey } from '../webhooks/emailEventBlobStore.js';

const CAMPAIGN = 'light-trial-to-premium-sequence';
const DAY = Date.UTC(2026, 7, 18);
const p2 = (n) => String(n).padStart(2, '0');

/** 実物の writer と同じ鍵を作る（形がズレたテストにしない） */
const keyAt = (ms, i = 0) => buildBatchBlobKey({
  receivedAtMs: ms, batchHash: `abcdef${p2(i % 100)}0000${p2(i % 100)}`,
});

/** NDJSON 1 本ぶん */
const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

const ev = (over = {}) => ({
  eventKey: `ek-${Math.random()}`,
  eventType: 'spamreport',
  eventAtMs: DAY + 12 * 3600_000,
  campaignId: CAMPAIGN,
  campaignVersion: 1,
  deliveryKey: 'a'.repeat(64),
  providerEventId: `pe-${Math.random()}`,
  ...over,
});

/**
 * 偽 blob store。**get されたキーを記録する**ので
 * 「窓外を読んでいない」ことを直接確かめられる。
 */
function fakeStore({ blobs, listThrows = false, getThrows = false, extraListFields = null }) {
  const got = [];
  const store = {
    async list({ prefix }) {
      if (listThrows) throw new Error('list boom');
      const hit = Object.keys(blobs).filter((k) => k.startsWith(prefix)).map((k) => ({ key: k }));
      return { blobs: hit, directories: [], ...(extraListFields || {}) };
    },
    async get(key) {
      if (getThrows) throw new Error('get boom');
      got.push(key);
      return blobs[key];
    },
  };
  return { store, got, impl: () => store };
}

// ── 1. 同日 500 件超でも、窓内が上限以下なら読める（事故の再発防止）──────
test('【重要】同日 blob が 500 件超でも、バッチ窓内が 200 以下なら正常に読める', async () => {
  const since = DAY + 12 * 3600_000;          // 12:00 にバッチ開始
  const until = since + 5 * 60_000;           // 5 分の窓
  const blobs = {};
  // 当日 0:00〜11:00 に 520 件（**窓よりずっと前**。skew 15 分より前）
  for (let i = 0; i < 520; i += 1) {
    blobs[keyAt(DAY + i * 60_000, i)] = ndjson([ev({ eventAtMs: DAY + i * 60_000 })]);
  }
  // 窓の中に 2 件
  blobs[keyAt(since + 60_000, 900)] = ndjson([ev({ eventAtMs: since + 60_000 })]);
  blobs[keyAt(since + 120_000, 901)] = ndjson([ev({
    eventAtMs: since + 120_000, eventType: 'unsubscribe',
  })]);
  assert.ok(Object.keys(blobs).length > 500, '前提: 同日 500 件超');

  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: until, campaignId: CAMPAIGN,
    deliveryKeys: new Set(['a'.repeat(64)]), getStoreImpl: f.impl,
  });
  assert.notEqual(res, null, '日全体の件数で null にしてはいけない');
  assert.equal(res.complaints, 1);
  assert.equal(res.unsubscribes, 1);
  assert.equal(res.blobsListed > 500, true, '日全体は list している');
  assert.ok(res.blobsScanned <= 5, `読んだ blob が多すぎる: ${res.blobsScanned}`);
});

// ── 2. 窓外 blob は get しない ──────────────────────────────────
test('【重要】窓外の blob は get しない（日全体を全 get しない）', async () => {
  const since = DAY + 12 * 3600_000;
  const blobs = {};
  const oldKeys = [];
  for (let i = 0; i < 300; i += 1) {
    const k = keyAt(DAY + i * 60_000, i);        // 0:00〜5:00
    oldKeys.push(k);
    blobs[k] = ndjson([ev({ eventAtMs: DAY + i * 60_000 })]);
  }
  const inKey = keyAt(since + 30_000, 999);
  blobs[inKey] = ndjson([ev({ eventAtMs: since + 30_000 })]);

  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN,
    deliveryKeys: new Set(['a'.repeat(64)]), getStoreImpl: f.impl,
  });
  assert.notEqual(res, null);
  assert.deepEqual(f.got, [inKey], '窓内の 1 件だけを読むべき');
  for (const k of oldKeys) assert.equal(f.got.includes(k), false, '窓外を読んでいる');
});

// ── 3. 窓内が上限超過なら null（fail closed は残す）─────────────────
test('【重要】バッチ窓内の候補が上限を超えたら null（0 と言わない）', async () => {
  const since = DAY + 12 * 3600_000;
  const blobs = {};
  for (let i = 0; i <= MAX_EVENT_BLOBS; i += 1) {
    blobs[keyAt(since + i * 1000, i)] = ndjson([ev({ eventAtMs: since + i * 1000 })]);
  }
  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 3600_000, campaignId: CAMPAIGN, getStoreImpl: f.impl,
  });
  assert.equal(res, null);
  assert.equal(f.got.length, 0, '上限超過なら 1 件も読まない');
});

// ── 4〜7. 厳密 scope / 重複排除 / soft bounce は維持 ──────────────────
test('【重要】DeliveryKey 外・他 campaign・窓外 eventAtMs を混ぜない', async () => {
  const since = DAY + 12 * 3600_000;
  const mine = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const blobs = {
    [keyAt(since + 1000, 1)]: ndjson([
      ev({ eventAtMs: since + 1000, deliveryKey: mine }),                       // ✅ 数える
      ev({ eventAtMs: since + 1000, deliveryKey: other }),                      // ❌ 別バッチ
      ev({ eventAtMs: since + 1000, campaignId: 'other-campaign', deliveryKey: mine }), // ❌ 別 campaign
      ev({ eventAtMs: since - 60_000, deliveryKey: mine }),                     // ❌ 窓より前
    ]),
  };
  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN,
    deliveryKeys: new Set([mine]), getStoreImpl: f.impl,
  });
  assert.equal(res.complaints, 1, '混ざっている');
  assert.equal(res.skipped.otherBatch, 1);
  assert.equal(res.skipped.otherCampaign, 1);
  assert.equal(res.skipped.beforeWindow, 1);
});

test('【重要】providerEventId の再送を二重に数えない', async () => {
  const since = DAY + 12 * 3600_000;
  const mine = 'a'.repeat(64);
  const dup = ev({ eventAtMs: since + 1000, deliveryKey: mine, providerEventId: 'same-id' });
  // 同じイベントが**別の blob**（webhook 再送）に入る
  const blobs = {
    [keyAt(since + 1000, 1)]: ndjson([dup]),
    [keyAt(since + 2000, 2)]: ndjson([{ ...dup, eventKey: 'other-ek' }]),
  };
  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN,
    deliveryKeys: new Set([mine]), getStoreImpl: f.impl,
  });
  assert.equal(res.complaints, 1, '再送を二重に数えている');
  assert.equal(f.got.length, 2, '両方の blob は読む（重複排除は中身で行う）');
});

test('【重要】soft bounce を hard bounce として数えない', async () => {
  const since = DAY + 12 * 3600_000;
  const mine = 'a'.repeat(64);
  const blobs = {
    [keyAt(since + 1000, 1)]: ndjson([
      ev({ eventAtMs: since + 1000, deliveryKey: mine, eventType: 'bounce', bounceClass: 'soft' }),
      ev({ eventAtMs: since + 1000, deliveryKey: mine, eventType: 'bounce', bounceClass: 'hard' }),
    ]),
  };
  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN,
    deliveryKeys: new Set([mine]), getStoreImpl: f.impl,
  });
  assert.equal(res.bounces, 1);
  assert.equal(res.softBounces, 1);
});

// ── 8. 本物の読み取り失敗は今までどおり null ──────────────────────
test('【重要】本物の read failure は fail closed（list が落ちる）', async () => {
  const f = fakeStore({ blobs: {}, listThrows: true });
  const res = await readEventWindow({
    sinceMs: DAY, untilMs: DAY + 60_000, campaignId: CAMPAIGN, getStoreImpl: f.impl,
  });
  assert.equal(res, null);
});

test('【重要】本物の read failure は fail closed（get が落ちる）', async () => {
  const since = DAY + 12 * 3600_000;
  const blobs = { [keyAt(since + 1000, 1)]: ndjson([ev({ eventAtMs: since + 1000 })]) };
  const f = fakeStore({ blobs, getThrows: true });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN, getStoreImpl: f.impl,
  });
  assert.equal(res, null);
});

test('【重要】list の形が不完全（cursor 残り）なら成功扱いにしない', async () => {
  const since = DAY + 12 * 3600_000;
  const blobs = { [keyAt(since + 1000, 1)]: ndjson([ev({ eventAtMs: since + 1000 })]) };
  for (const extra of [{ next_cursor: 'abc' }, { cursor: 'abc' }]) {
    const f = fakeStore({ blobs, extraListFields: extra });
    // eslint-disable-next-line no-await-in-loop
    const res = await readEventWindow({
      sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN, getStoreImpl: f.impl,
    });
    assert.equal(res, null, `${JSON.stringify(extra)} を完全な一覧として扱ってはいけない`);
    assert.equal(f.got.length, 0);
  }
});

test('【重要】list が blobs 配列を返さないときも fail closed', async () => {
  const store = { async list() { return {}; }, async get() { return null; } };
  const res = await readEventWindow({
    sinceMs: DAY, untilMs: DAY + 60_000, campaignId: CAMPAIGN, getStoreImpl: () => store,
  });
  assert.equal(res, null);
});

test('store が使えないときは null', async () => {
  assert.equal(await readEventWindow({
    sinceMs: DAY, untilMs: DAY + 60_000, campaignId: CAMPAIGN, getStoreImpl: () => null,
  }), null);
  assert.equal(await readEventWindow({
    sinceMs: DAY, untilMs: DAY + 60_000, campaignId: CAMPAIGN,
    getStoreImpl: () => { throw new Error('no store'); },
  }), null);
});

// ── 事前除外の境界（推測で捨てない）──────────────────────────────
test('鍵から受信時刻を復元できる（実物の buildBatchBlobKey と往復）', () => {
  for (const t of [DAY, DAY + 3661_000, DAY + 86399_000]) {
    const k = buildBatchBlobKey({ receivedAtMs: t, batchHash: 'abcdef0123456789' });
    assert.equal(parseBlobKeyReceivedAtMs(k), Math.floor(t / 1000) * 1000);
  }
  assert.equal(parseBlobKeyReceivedAtMs('ak/email-events/2026/08/18/bad.ndjson'), null);
  assert.equal(parseBlobKeyReceivedAtMs(''), null);
  // 範囲外の時刻は繰り上げずに null
  assert.equal(parseBlobKeyReceivedAtMs('ak/email-events/2026/13/18/000000-abcdef012345.ndjson'), null);
});

test('【重要】鍵を読めない blob は捨てない（証明できない境界を推測で捨てない）', async () => {
  const since = DAY + 12 * 3600_000;
  const mine = 'a'.repeat(64);
  const weird = 'ak/email-events/2026/08/18/legacy-blob.ndjson';
  const blobs = { [weird]: ndjson([ev({ eventAtMs: since + 1000, deliveryKey: mine })]) };
  const f = fakeStore({ blobs });
  const res = await readEventWindow({
    sinceMs: since, untilMs: since + 60_000, campaignId: CAMPAIGN,
    deliveryKeys: new Set([mine]), getStoreImpl: f.impl,
  });
  assert.deepEqual(f.got, [weird], '鍵を読めない blob を読み飛ばしてはいけない');
  assert.equal(res.complaints, 1);
});

test('事前除外は「古すぎる」側だけ。skew ぶんは安全側に残す', () => {
  const since = DAY + 12 * 3600_000;
  const margin = KEY_TIME_GRANULARITY_MS + RECEIVE_CLOCK_SKEW_MS;
  // 窓のちょうど skew 手前 → **残す**（provider 時計が進んでいる可能性）
  assert.equal(isBlobInWindow({ key: keyAt(since - margin + 1000, 1), sinceMs: since }), true);
  // 明確に古い → 捨てる
  assert.equal(isBlobInWindow({ key: keyAt(since - margin - 60_000, 2), sinceMs: since }), false);
  // 受信が窓より後（provider の遅延で古いイベントを含み得る）→ **残す**
  assert.equal(isBlobInWindow({ key: keyAt(since + 3600_000, 3), sinceMs: since }), true);
  // sinceMs 不明なら絞らない
  assert.equal(isBlobInWindow({ key: keyAt(DAY, 4), sinceMs: null }), true);
});
