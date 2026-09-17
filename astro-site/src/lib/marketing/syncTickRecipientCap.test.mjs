/**
 * syncTickRecipientCap.test.mjs — **同期 tick で積める人数の安全上限**
 *   node --test src/lib/marketing/syncTickRecipientCap.test.mjs
 *
 * ## なぜ要るか（2026-09-17 の構造解析）
 *
 * 「正本では 1 tick 500 名が本来の設計」だが、**同期の scheduled function には入らない**。
 * キュー登録は**逐次**で、Airtable の往復回数が人数にほぼ比例する:
 *
 * | 人数 | ジョブ POST | 配信行 PATCH | 読み戻し | 逐次往復 | 予測所要 |
 * |---|---|---|---|---|---|
 * | 50  | 1  | 5  | 3  | 9  | 23 秒 ✅ |
 * | 75  | 2  | 8  | 4  | 14 | 29 秒 ✅ |
 * | 100 | 2  | 10 | 5  | 17 | 32 秒 ❌ |
 * | 500 | 10 | 50 | 25 | 85 | 107 秒 ❌❌ |
 *
 * 予測式は「読み取り 13 秒 ＋ 書き込み 10 秒 ×（往復比）」。
 * 13 / 23 秒は本番実測（下見 13 秒・live 23 秒）で、この live 値は
 * 7 tick 連続で run / no-run を的中させたモデル値。
 *
 * ⚠️ **打ち切りは「遅くなる」では済まない。** 予約（`claimDelivered`）はキュー登録の
 *    **前**に取るので、途中で殺されると鍵だけが配信済み集合に残り
 *    **その人へは二度と送られない**（送信漏れ）。人数を上げるほどこの窓が広がる。
 *
 * ⚠️ 500 を使いたいなら Background function（15 分）へ移すこと。
 *    **env だけ上げてはいけない** — それを構造的に防ぐのがこのテスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMaxRecipientsPerTick, SYNC_TICK_MAX_RECIPIENTS, MAX_RECIPIENTS_PER_TICK,
} from './sequenceAutomation.js';
import {
  TICK_HARD_LIMIT_MS, MAX_CAMPAIGN_MS, HARD_LIMIT_SAFETY_MARGIN_MS,
} from './sequenceTickRotation.js';
import { RECIPIENTS_PER_JOB } from './campaignSend.js';
import { DEFAULT_CONCURRENCY } from './boundedBatchWrite.js';

const S = 1000;

/** 実装準拠の分割サイズ（変わったら予測が狂うので固定する） */
const DELIVERY_UPSERT_CHUNK = 10;   // cron: deliveryRecords.slice(i, i + 10) を逐次
const READBACK_CHUNK = 20;          // marketingTargetedLoad.chunkList の既定

/** 人数 → 逐次 Airtable 往復回数 */
function roundTrips(n) {
  return Math.ceil(n / RECIPIENTS_PER_JOB)
    + Math.ceil(n / DELIVERY_UPSERT_CHUNK)
    + Math.ceil(n / READBACK_CHUNK);
}

/**
 * 本番実測に基づく所要時間の予測（ミリ秒）。
 *
 * ⚠️ **2026-09-17 に upsert を上限つき並行へ変更したので式も更新した。**
 *    ジョブ作成と読み戻しは逐次のまま、配信行 upsert だけ並行度ぶん縮む。
 *    Airtable の 5 req/秒 を超えては速くならないので、**rate 下限と遅い方**を採る。
 */
const READ_MS = 13 * S;             // 読み取り phase の実測
const RTT_MS = 1.1 * S;             // 1 往復の実測
const AIRTABLE_RPS = 5;             // Airtable の 1 base あたり上限
function predictMs(n) {
  const job = Math.ceil(n / RECIPIENTS_PER_JOB);
  const del = Math.ceil(n / DELIVERY_UPSERT_CHUNK);
  const rb = Math.ceil(n / READBACK_CHUNK);
  const parallel = READ_MS + (job + rb) * RTT_MS + (del * RTT_MS) / DEFAULT_CONCURRENCY;
  const rateFloor = READ_MS + ((job + del + rb) / AIRTABLE_RPS) * S;
  return Math.max(parallel, rateFloor);
}

// ══════════════════════════════════════════════════════════════════
//  ① 上限が契約と整合している
// ══════════════════════════════════════════════════════════════════

test('【最重要】同期 tick の上限は 1 campaign 30 秒の契約に収まる', () => {
  assert.ok(
    predictMs(SYNC_TICK_MAX_RECIPIENTS) <= MAX_CAMPAIGN_MS,
    `${SYNC_TICK_MAX_RECIPIENTS} 名で ${(predictMs(SYNC_TICK_MAX_RECIPIENTS) / S).toFixed(0)}s`
    + ` — 契約 ${MAX_CAMPAIGN_MS / S}s を超える`,
  );
});

test('【最重要】1 つ上のキリの良い人数（150）は契約を超える（上限が甘くない）', () => {
  assert.ok(
    predictMs(150) > MAX_CAMPAIGN_MS,
    '150 名が契約に収まるなら上限を見直してよい（予測式ごと再検証すること）',
  );
});

/**
 * ⚠️ 計算上は 140 まで収まるが、そこでは余裕が 1 秒を切る。
 *    予測式には誤差があるので **余裕 5 秒以上**を残す（`HARD_LIMIT_SAFETY_MARGIN_MS` と同じ考え方）。
 */
test('【最重要】上限には契約に対する余裕が 5 秒以上ある', () => {
  const slack = MAX_CAMPAIGN_MS - predictMs(SYNC_TICK_MAX_RECIPIENTS);
  assert.ok(slack >= HARD_LIMIT_SAFETY_MARGIN_MS,
    `余裕が ${(slack / S).toFixed(1)}s しかない（${HARD_LIMIT_SAFETY_MARGIN_MS / S}s 以上が必要）`);
});

test('【重要】並行化しても Airtable の 5 req/秒 より速くはならない', () => {
  const n = 500;
  const trips = roundTrips(n);
  assert.ok(predictMs(n) >= READ_MS + (trips / AIRTABLE_RPS) * S,
    'rate 下限を下回る予測になっている（並行度を上げれば無限に速くなる、という式になっていないか）');
});

test('【最重要】正本の設計値 500 は並行化しても打ち切りを超える', () => {
  const ms = predictMs(500);
  assert.ok(ms > TICK_HARD_LIMIT_MS, `500 名が ${(ms / S).toFixed(0)}s で打ち切り内に収まっている`);
  // 予約後・キュー登録中に殺される = 送信漏れ。だから env だけ上げてはいけない
  assert.ok(MAX_RECIPIENTS_PER_TICK === 500, '正本の設計値が変わった（docs も直すこと）');
});

test('【重要】打ち切りと契約の関係は sequenceTickRotation と同じ前提', () => {
  assert.ok(MAX_CAMPAIGN_MS + HARD_LIMIT_SAFETY_MARGIN_MS <= TICK_HARD_LIMIT_MS);
});

// ══════════════════════════════════════════════════════════════════
//  ② env で上限を超えられない
// ══════════════════════════════════════════════════════════════════

test('【最重要】env に 500 を入れても同期 tick の上限で頭打ちになる', () => {
  assert.equal(
    resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: '500' }),
    SYNC_TICK_MAX_RECIPIENTS,
    'env だけで 500 名を積めてしまう（打ち切り → 送信漏れ）',
  );
});

test('【最重要】現在の本番設定（50）は 1 ミリも変わらない', () => {
  assert.equal(resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: '50' }), 50);
});

test('【重要】上限以下はそのまま通る', () => {
  for (const n of [1, 25, 50, SYNC_TICK_MAX_RECIPIENTS]) {
    assert.equal(resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: String(n) }), n);
  }
});

test('【重要】未設定・壊れた値でも上限を超えない', () => {
  for (const v of [undefined, '', 'abc', '-5', '0', '99999']) {
    const got = resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: v });
    assert.ok(got > 0 && got <= SYNC_TICK_MAX_RECIPIENTS, `env=${v} で ${got}`);
  }
});

test('【重要】Background など上限を自分で持つ経路は cap を渡して超えられる', () => {
  // ⚠️ 同期 tick は渡さない。渡せるのは 15 分枠を持つ呼び出しだけ
  assert.equal(
    resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: '500' }, { cap: 500 }),
    500,
  );
});

// ══════════════════════════════════════════════════════════════════
//  ③ 予測式の前提（分割サイズ）が変わったら気づく
// ══════════════════════════════════════════════════════════════════

test('【重要】1 ジョブあたりの人数が変わったら予測式を見直す', () => {
  assert.equal(RECIPIENTS_PER_JOB, 50, 'ジョブ分割が変わった（往復回数＝所要時間が変わる）');
});

test('【重要】往復回数は人数に比例して増える（一括ではない）', () => {
  // 一括登録なら往復は一定のはず。逐次である限り比例する
  assert.ok(roundTrips(500) > roundTrips(50) * 5, '往復が人数に比例していない（実装が変わった？）');
});
