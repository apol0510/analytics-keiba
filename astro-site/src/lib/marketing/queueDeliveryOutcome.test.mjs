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
  classifyQueueOutcome, collectDeliveryKeys, summarizeRollback, QUEUE_FAIL,
} from './queueDeliveryOutcome.js';
import { buildCampaignPlan, computeCampaignDeliveryKey } from './campaignSend.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';

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
  assert.ok(/readDeliveryRows\(/.test(src), '読み戻し確認をしていない');
  assert.ok(/classifyQueueOutcome\(/.test(src), '判定の単一源を通していない');
  // 成功レスポンス（mode: 'queued'）より前に判定していること
  const idxOutcome = src.indexOf('const settled = await settleQueueWrite(');
  const idxQueued = src.indexOf("mode: 'queued'");
  assert.ok(idxOutcome > 0 && idxQueued > idxOutcome, '成功を返した後に判定している');
});

test('【重要】確認できないときは配信行ごと巻き戻している（ジョブだけ取り消さない）', () => {
  const src = readRel(ADMIN);
  assert.ok(/async function rollbackQueue\(/.test(src), '巻き戻しが無い');
  assert.ok(/buildJobCancelFields\(/.test(src), '既存のジョブ取消契約を使っていない');
  assert.ok(/buildDeliveryCancelFields\(/.test(src), '既存の配信行取消契約を使っていない');
  const block = src.slice(src.indexOf('async function rollbackQueue('), src.indexOf('async function upsertDeliveries('));
  // 配信行の取消を**実際に行っている**こと（ジョブだけ取り消すと 37 件が永久除外になる）
  assert.ok(/buildDeliveryCancelFields\(/.test(block), '配信行を取り消していない');
  assert.ok(/DELIVERY_CANCEL_WRITABLE_FIELDS/.test(block), '配信行取消の allow-list を通していない');
  assert.ok(/String\(v\.status\) === 'queued'/.test(block), 'queued の配信行を取消対象にしていない');
  assert.ok(/table: DELIVERIES_TABLE, recordId: id/.test(block), '配信行へ PATCH していない');
  assert.ok(/report\.deliveriesCancelled \+= 1/.test(block), '取消件数を数えていない');
  // 配信行 → ジョブ の順（handleCancelJob と同じ）
  assert.ok(block.indexOf('buildDeliveryCancelFields(') < block.indexOf('buildJobCancelFields('),
    '配信行より先にジョブを取り消している');
});

test('【重要】書き込み例外も同じ確定処理へ通している（投げっぱなしにしない）', () => {
  const src = readRel(ADMIN);
  const block = src.slice(src.indexOf('let writeError = null;'), src.indexOf("mode: 'queued'"));
  assert.ok(/catch \(e\) \{/.test(block), 'delivery 書き込みの例外を捕まえていない');
  assert.ok(/settleQueueWrite\(/.test(block), '例外時に確定処理を通していない');
  // 例外のまま 500 で終わらせていない
  assert.ok(block.indexOf('settleQueueWrite(') > block.indexOf('catch (e) {'),
    '例外を捕まえた後に確定処理を通していない');
});

test('【重要】不足ぶんだけ冪等に補完してから諦めている', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function settleQueueWrite('), src.indexOf('async function rollbackQueue('));
  assert.ok(/DELIVERY_COMPLETE_MAX_RETRY/.test(fn), '補完の再試行が無い');
  assert.ok(/const missing = deliveryRecords\.filter/.test(fn), '不足ぶんだけを補完していない');
  assert.ok(/upsertDeliveries\(/.test(fn), '補完に既存の冪等 upsert を使っていない');
});

test('【重要】巻き戻しは read-back で確かめ、確認できなければ成功と言わない', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function rollbackQueue('), src.indexOf('async function upsertDeliveries('));
  // `verified` は**読み戻した実測値から**決めていること（true 直書きを許さない）
  assert.equal(/report\.verified = true;/.test(fn), false, '取消を無条件に成功扱いしている');
  // 判定は純粋関数（`summarizeRollback`）が単一源。Function 側で別条件を再実装しない
  assert.ok(/const verdict = summarizeRollback\(report\);/.test(fn), '判定の単一源を通していない');
  assert.ok(/report\.verified = verdict\.verified;/.test(fn), '単一源の判定を採用していない');
  for (const needle of ['deliveriesStillActive', 'jobsStillPending']) {
    assert.ok(fn.includes(`report.${needle} =`), `${needle} を実測から埋めていない`);
  }
  assert.ok(/deliveriesStillActive/.test(fn), '配信行の残りを読み戻していない');
  assert.ok(/jobsStillPending/.test(fn), 'ジョブが PENDING でなくなったか読み戻していない');
  assert.ok(/readDeliveryRows\(/.test(fn), '取消後に配信行を読み戻していない');
  assert.ok(/\{Status\}='PENDING'/.test(fn), '取消後にジョブの PENDING を読み戻していない');
  const resp = src.slice(src.indexOf('const settled = await settleQueueWrite('), src.indexOf("mode: 'queued'"));
  assert.ok(/rolledBack: rb\.verified === true/.test(resp), '確認できていないのに取消成功と返している');
  assert.ok(/partial_unconfirmed/.test(resp), '未確認の状態を区別していない');
  assert.equal(/sideEffects: 'jobs_cancelled'/.test(src), false, '旧い「ジョブだけ取消」表記が残っている');
});

test('【重要】読み戻しが読めないときは 0 件扱いにしない', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function readDeliveryRows('),
    src.indexOf('function activeDeliveryKeys('));
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


// ══════════════════════════════════════════════════════════════════
//  再 queue 経路まで固定する（`already_delivered` の実判定を含む）
// ══════════════════════════════════════════════════════════════════

const BRAND = 'analytics-keiba';
const FROM = 'sender@example.com';   // 鍵の材料。テスト内で一貫していればよい
const NOW = Date.UTC(2026, 7, 19, 0, 0, 0);
const STEP1 = resolveSequenceStep(getCampaign('light-trial-to-premium-sequence', { includeDisabled: true }), 1);

/** 実経路と同じ形の候補（`marketing` は実物の `resolveCustomerMarketing`）*/
function cand(i) {
  const fields = {
    Email: `u${i}@example.com`,
    LightGrantedAt: new Date(NOW - 86400000).toISOString(),
    LightGrantUntil: new Date(NOW + 29 * 86400000).toISOString(),
    ComebackGrantSource: 'light-trial-autogrant',
    Source: 'customer-import:test',
  };
  return { recordId: `rec${i}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}
const keyOf = (i) => computeCampaignDeliveryKey({
  campaign: STEP1, recipientEmail: `u${i}@example.com`, brand: BRAND, fromEmail: FROM,
});
const planWith = (deliveredKeys, n) => buildCampaignPlan({
  campaign: STEP1,
  selected: Array.from({ length: n }, (_, i) => cand(i)),
  deliveredKeys: new Set(deliveredKeys),
  providerSuppressed: new Set(), softBounced: new Set(),
  brand: BRAND, fromEmail: FROM, nowMs: NOW,
});

test('【重要】`queued` の配信行は already_delivered として再 queue から外れる（既存契約）', () => {
  const all = planWith([], 5);
  assert.equal(all.ok, true);
  assert.equal(all.recipients.length, 5);
  const some = planWith([keyOf(0), keyOf(1)], 5);
  assert.equal(some.recipients.length, 3, '既送信 2 件が除外されていない');
  assert.equal(some.counts.byReason.already_delivered, 2);
});

test('【重要】部分成功でジョブだけ取り消すと、書けた 37 件が永久に取り残される', () => {
  // 100 名中 37 件だけ配信行が `queued` で残った状態
  const delivered = Array.from({ length: 37 }, (_, i) => keyOf(i));
  const plan = planWith(delivered, 100);
  assert.equal(plan.recipients.length, 63, '37 件が already_delivered で除外されている');
  assert.equal(plan.counts.byReason.already_delivered, 37);
  // → 「ジョブだけ取消」では 37 名が二度と対象に入らない。配信行も取り消す必要がある
});

test('【重要】配信行を `cancelled` にすれば 100 名全員が再 queue の対象へ戻る', () => {
  // `fetchDeliveredKeys` は `sent` / `queued` だけを既送信に数えるので、
  // 取消済みの鍵は `deliveredKeys` に入らない = 除外されない
  const plan = planWith([], 100);
  assert.equal(plan.recipients.length, 100, '巻き戻し後に全員を再 queue できない');
  assert.equal(plan.counts.byReason.already_delivered, undefined);
});

test('【重要】巻き戻し後の再 queue で DeliveryKey は増えない（同じ鍵に戻る）', () => {
  const first = planWith([], 10).recipients.map((r) => r.deliveryKey);
  const again = planWith([], 10).recipients.map((r) => r.deliveryKey);
  assert.deepEqual(first, again, '再実行で別の鍵になっている（二重行の原因）');
  assert.equal(new Set(first).size, 10, '鍵が重複している');
});

test('【重要】既送信に数える Status は sent / queued だけ（cancelled / failed を含めない）', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function fetchDeliveredKeys('),
    src.indexOf('async function fetchDeliveredKeys(') + 2500);
  assert.ok(/status !== 'sent' && status !== 'queued'/.test(fn), '既送信の判定が変わっている');
  // 巻き戻し側が書く Status と噛み合っていること
  assert.ok(/activeDeliveryKeys/.test(src), '同じ判定を確認側でも使っていない');
  const act = src.slice(src.indexOf('function activeDeliveryKeys('), src.indexOf('/** 不足ぶんだけ冪等に補完する回数'));
  assert.ok(/st === 'sent' \|\| st === 'queued'/.test(act), '確認側の判定が fetchDeliveredKeys と違う');
});

test('【重要】補完の再試行で ScheduledEmails を二重に作らない', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function settleQueueWrite('), src.indexOf('async function rollbackQueue('));
  assert.equal(/createRecord\(/.test(fn), false, '確定処理の中でジョブを作り直している');
  assert.equal(/buildScheduledEmailFields\(/.test(fn), false, 'ジョブ行を組み立て直している');
});

test('【重要】巻き戻しは削除を使わない（本番データを消さない）', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function rollbackQueue('), src.indexOf('async function upsertDeliveries('));
  assert.equal(/method: 'DELETE'/.test(fn), false, '削除している');
  assert.equal(/deleteRecord/.test(fn), false, '削除している');
  // 新しい Status を作っていない（既存の cancel 契約だけ）
  assert.equal(/Status: '(?!cancelled)/.test(fn), false, '新しい Status を直書きしている');
});

test('【重要】巻き戻しでも実送信は起きない（送信経路を呼ばない）', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function settleQueueWrite('), src.indexOf('async function upsertDeliveries('));
  for (const forbidden of ['sendgrid', 'dispatch-background', 'marketing-campaign-dispatch']) {
    assert.equal(fn.includes(forbidden), false, `確定処理が送信経路 ${forbidden} を呼んでいる`);
  }
});

// ══════════════════════════════════════════════════════════════════
//   巻き戻しの判定（`summarizeRollback`）
//   ⚠️ 「読めなかった」と「読めた結果 0 行」を混同しない
// ══════════════════════════════════════════════════════════════════

const RB = (over = {}) => ({
  deliveriesFailed: 0, deliveriesStillActive: 0, jobsFailed: 0, jobsStillPending: 0, ...over,
});

test('【重要】全部取り消せて読み戻しでも残っていなければ verified', () => {
  assert.deepEqual(summarizeRollback(RB()), { verified: true, reason: null });
});

test('【重要】まだ 1 行も書いていない段階（読めて 0 行）の巻き戻しも verified にできる', () => {
  // `delivery_records_dropped` はジョブしか作っていない。配信行は読めて 0 行。
  // これを「確認できない」にすると、安全な再 queue まで止めてしまう。
  assert.equal(summarizeRollback(RB({ deliveriesStillActive: 0 })).verified, true);
});

test('【重要】読み戻せない（null）は 0 件と読み替えず verified にしない', () => {
  assert.deepEqual(
    summarizeRollback(RB({ deliveriesStillActive: null })),
    { verified: false, reason: 'rollback_unverified' },
  );
  assert.deepEqual(
    summarizeRollback(RB({ jobsStillPending: null })),
    { verified: false, reason: 'rollback_unverified' },
  );
});

test('【重要】取消に 1 件でも失敗していれば成功扱いにしない', () => {
  assert.deepEqual(
    summarizeRollback(RB({ deliveriesFailed: 1 })),
    { verified: false, reason: 'rollback_failed' },
  );
  assert.deepEqual(
    summarizeRollback(RB({ jobsFailed: 2 })),
    { verified: false, reason: 'rollback_failed' },
  );
});

test('【重要】取消したつもりでも実状態が残っていれば成功扱いにしない', () => {
  assert.deepEqual(
    summarizeRollback(RB({ deliveriesStillActive: 3 })),
    { verified: false, reason: 'rollback_incomplete' },
  );
  assert.deepEqual(
    summarizeRollback(RB({ jobsStillPending: 1 })),
    { verified: false, reason: 'rollback_incomplete' },
  );
});

test('引数が壊れていても例外にせず成功扱いにしない', () => {
  assert.equal(summarizeRollback().verified, false);
  assert.equal(summarizeRollback({}).verified, false);
  assert.equal(summarizeRollback({ deliveriesFailed: 'x', jobsFailed: 0 }).verified, false);
});

test('【重要】Function 側も「読めて 0 行」と「読めない」を分けている', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function rollbackQueue('), src.indexOf('async function upsertDeliveries('));
  assert.ok(/rows instanceof Map && rows\.size === 0/.test(fn), '「読めて 0 行」を分けていない');
  assert.ok(/stillActive = new Set\(\);/.test(fn), '0 行のときに空集合として扱っていない');
  // rows === null（読めない）のときは read-back を「0 件」に丸めない
  assert.ok(/} else if \(rows instanceof Map\) \{/.test(fn), 'null と Map を分岐していない');
});
