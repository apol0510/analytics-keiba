/**
 * queueDeliveryOutcome.test.mjs — 「ジョブだけ作れて配信行が作れない」を成功にしない
 *
 * ── 2026-08-18 の本番事故 ──────────────────────────────────────
 * キュー登録は「ScheduledEmails ジョブ行を作る → CampaignDeliveries を upsert」の順で、
 * **1 つの取引になっていない**。2 で落ちると**配信行の無い orphan PENDING**が残る。
 * （この故障形は `admin-marketing.js` の重複確認コメントに既に明記されている。）
 *
 * 本番実測: ジョブ 1 件（宛先 100）が作られ、`CampaignDeliveries` は
 * 12:00Z 以降 **どの CampaignType にも 0 行**。dispatcher は配信行が無い宛先へ送らないので
 * （`delivery_not_found`）、この PENDING ジョブは起動しても永久に送れない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyQueueOutcome, collectDeliveryKeys, QUEUE_FAIL,
} from './queueDeliveryOutcome.js';

/** 宛先 n 件（アドレスは example.com のみ） */
const R = (n) => Array.from({ length: n }, (_, i) => ({
  email: `u${i}@example.com`, deliveryKey: `k${i}`, recordId: `rec${i}`,
}));
const keysOf = (n) => Array.from({ length: n }, (_, i) => `k${i}`);

// ── 完全成功のときだけ handoff を確定してよい ────────────────────────
test('【重要】完全成功（組み立て・書き込み・読み戻しが全部一致）だけ ok', () => {
  const r = classifyQueueOutcome({ recipients: R(5), builtCount: 5, verifiedKeys: keysOf(5) });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.deepEqual(
    { expected: r.expected, built: r.built, verified: r.verified, missing: r.missing },
    { expected: 5, built: 5, verified: 5, missing: 0 },
  );
});

// ── ジョブ成功 → 配信行 0 件 ────────────────────────────────────
test('【重要】ジョブは作れたが CampaignDeliveries が 0 件 → 成功にしない', () => {
  const r = classifyQueueOutcome({ recipients: R(100), builtCount: 100, verifiedKeys: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.INCOMPLETE);
  assert.equal(r.expected, 100);
  assert.equal(r.verified, 0);
  assert.equal(r.missing, 100, '不足件数を丸めている');
});

// ── 配信行が途中で失敗（部分成功）────────────────────────────────
test('【重要】CampaignDeliveries が一部だけ成功 → 成功にしない・件数を丸めない', () => {
  const r = classifyQueueOutcome({ recipients: R(100), builtCount: 100, verifiedKeys: keysOf(37) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.INCOMPLETE);
  assert.equal(r.verified, 37, '部分成功を 0 件へ丸めている');
  assert.equal(r.missing, 63, '部分成功を成功へ丸めている');
});

test('【重要】チャンク境界（10 件ごと）の途中失敗も部分成功として数える', () => {
  // 10 件ずつ upsert するので、3 チャンク目で落ちれば 20 件だけ書けている
  const r = classifyQueueOutcome({ recipients: R(35), builtCount: 35, verifiedKeys: keysOf(20) });
  assert.equal(r.ok, false);
  assert.equal(r.verified, 20);
  assert.equal(r.missing, 15);
});

// ── 組み立て段の黙った取りこぼし ──────────────────────────────────
test('【重要】組み立てで黙って落ちた（0 件）→ 書きにいく前に失敗', () => {
  const r = classifyQueueOutcome({ recipients: R(100), builtCount: 0, verifiedKeys: keysOf(100) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.RECORDS_DROPPED);
});

test('【重要】組み立てが 1 件でも足りなければ失敗', () => {
  const r = classifyQueueOutcome({ recipients: R(100), builtCount: 99, verifiedKeys: keysOf(100) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.RECORDS_DROPPED);
});

// ── 読み戻せない = 0 件と言わない（fail closed）──────────────────────
test('【重要】読み戻せないときは 0 件とも成功とも言わない', () => {
  const r = classifyQueueOutcome({ recipients: R(10), builtCount: 10, verifiedKeys: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.UNVERIFIED);
});

test('【重要】鍵が作れていない宛先があれば失敗（冪等の土台が無い）', () => {
  const recipients = [...R(2), { email: 'x@example.com' }];   // 3 件目に deliveryKey が無い
  const r = classifyQueueOutcome({ recipients, builtCount: 3, verifiedKeys: ['k0', 'k1'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.KEYS_MISSING);
});

test('宛先ゼロは成功にしない', () => {
  const r = classifyQueueOutcome({ recipients: [], builtCount: 0, verifiedKeys: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUEUE_FAIL.NO_RECIPIENTS);
});

test('引数が壊れていても例外にせず失敗側', () => {
  for (const input of [undefined, {}, { recipients: 'x' }, { recipients: R(1) }]) {
    const r = classifyQueueOutcome(input);
    assert.equal(r.ok, false, `${JSON.stringify(input)} を成功にしている`);
  }
});

// ── 再実行で二重にならない（DeliveryKey 冪等）────────────────────────
test('【重要】再実行しても同じ DeliveryKey なら二重にならない（鍵集合が増えない）', () => {
  const recipients = R(10);
  const first = collectDeliveryKeys(recipients);
  const again = collectDeliveryKeys([...recipients, ...recipients]);   // 同じ宛先をもう一度
  assert.equal(first.size, 10);
  assert.equal(again.size, 10, '同じ鍵が二重に数えられている');
  // 1 回目が部分成功 → 2 回目で残りが埋まれば成功になる（重複行は作らない）
  const partial = classifyQueueOutcome({ recipients, builtCount: 10, verifiedKeys: keysOf(4) });
  assert.equal(partial.ok, false);
  const retry = classifyQueueOutcome({ recipients, builtCount: 10, verifiedKeys: keysOf(10) });
  assert.equal(retry.ok, true, '再実行で確定できていない');
});

test('余分な鍵が台帳にあっても、期待した鍵が揃っていれば成功（他バッチを巻き込まない）', () => {
  const r = classifyQueueOutcome({
    recipients: R(3), builtCount: 3, verifiedKeys: [...keysOf(3), 'other-1', 'other-2'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, 3, '期待外の鍵まで数えている');
});

// ══════════════════════════════════════════════════════════════════
//  配線（`handlePlan` は巨大な Function なのでソースで固定する）
// ══════════════════════════════════════════════════════════════════

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
const ADMIN = 'netlify/functions/admin-marketing.js';

test('【重要】配信行を読み戻して確認してからキュー成功にしている', () => {
  const src = readRel(ADMIN);
  assert.ok(/readDeliveryKeysPresent\(/.test(src), '読み戻し確認をしていない');
  assert.ok(/classifyQueueOutcome\(/.test(src), '判定の単一源を通していない');
  // 成功レスポンス（mode: 'queued'）より前に判定していること
  const idxOutcome = src.indexOf('const outcome = classifyQueueOutcome(');
  const idxQueued = src.indexOf("mode: 'queued'");
  assert.ok(idxOutcome > 0 && idxQueued > idxOutcome, '成功を返した後に判定している');
});

test('【重要】確認できないときは orphan PENDING を残さず取り消している', () => {
  const src = readRel(ADMIN);
  assert.ok(/async function cancelOrphanJobs\(/.test(src), '補償の取消が無い');
  assert.ok(/buildJobCancelFields\(/.test(src), '既存の取消契約を使っていない');
  const block = src.slice(src.indexOf('if (!outcome.ok) {'), src.indexOf("mode: 'queued'"));
  assert.ok(/cancelOrphanJobs\(/.test(block), '失敗時に取消していない');
  assert.ok(/json\(500/.test(block), '失敗なのに 500 を返していない');
});

test('【重要】読み戻しが読めないときは 0 件扱いにしない', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function readDeliveryKeysPresent('),
    src.indexOf('async function cancelOrphanJobs('));
  assert.ok(/return null;/.test(fn), '読めないときに null を返していない');
  assert.equal(/return new Set\(\);/.test(fn), false, '読めないのに空集合を返している');
});

test('【重要】配信行の upsert は DeliveryKey 冪等のまま（再試行で二重にしない）', () => {
  const src = readRel(ADMIN);
  assert.ok(/performUpsert: \{ fieldsToMergeOn: \['DeliveryKey'\] \}/.test(src), '冪等な upsert でなくなっている');
});

test('【重要】upsert は 5rps を超えず、一過性だけ再試行する', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function upsertDeliveries('), src.indexOf('async function handleSegments('));
  assert.ok(/AIRTABLE_PACE_MS/.test(fn), '間隔を空けていない');
  assert.ok(/UPSERT_MAX_RETRY/.test(fn), '再試行が無い');
  // 4xx（429 以外）は再試行しない
  assert.ok(/res\.status !== 429 && res\.status < 500/.test(fn), '直らない 4xx を再試行している');
  assert.ok(/throw new Error/.test(fn), '最終的な失敗を投げていない');
});

test('【重要】既存の正常経路を二重化していない（送信経路は増やさない）', () => {
  const src = readRel(ADMIN);
  // 呼び出しは 1 か所のまま（定義行は数えない）
  assert.equal((src.match(/=> upsertDeliveries\(/g) || []).length, 1, 'upsert 経路が増えている');
  assert.equal((src.match(/await recordDelivered\(/g) || []).length, 1, '記録経路が増えている');
  assert.equal((src.match(/async function upsertDeliveries\(/g) || []).length, 1, 'upsert の実装が増えている');
});

test('【重要】orphan PENDING を捕まえる既存の重複確認契約を残している', () => {
  const src = readRel(ADMIN);
  assert.ok(/本当の orphan PENDING/.test(src), 'orphan 検知の契約が消えている');
  assert.ok(/pendingOverlap/.test(src), 'Recipients 側からの突き合わせが消えている');
});
