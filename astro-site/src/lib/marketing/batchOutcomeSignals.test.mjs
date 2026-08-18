/**
 * batchOutcomeSignals.test.mjs — 健全性の入力は「前バッチで**起きたイベント**」だけ
 *   node --test src/lib/marketing/batchOutcomeSignals.test.mjs
 *
 * 入力ソースを 3 度間違えた記録:
 *   1 度目 … `byStopReason`（いま候補を除外する理由 ＝ 現在状態）の**累積**を苦情として渡し、
 *            コホートに元から居る停止リスト該当者 1 名で**永久停止**
 *   2 度目 … その**差分**にしたが、展開は 1 バッチ 500 名ずつ母集団が増えるので、
 *            以前から該当していた人が母集団へ入るだけで差分が増える
 *   3 度目（未遂）… `EmailBlacklist` を数えようとした。あれは**アドレス 1 行の upsert 台帳**で、
 *            既存行は `BounceCount+1` の PATCH・`AddedAt` 据え置き ＝ 1 イベント 1 行ではない
 *
 * 正本は**配信イベント台帳**（Blob の NDJSON・1 行 1 イベント）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureOutcomeSnapshot, diffOutcomeSnapshot, hasOutcomeBaseline, toStoredOutcome,
  OUTCOME_FIELDS, WINDOW_FIELDS,
} from './batchOutcomeSignals.js';
import { summarizeEventWindow, classifyEvent, windowDates } from './batchEventWindow.js';
import { readEventWindow, MAX_EVENT_BLOBS } from './eventWindowReader.js';
import { readBatchDeliveryKeys } from './batchDeliveryKeys.js';
import { canStartNextBatch, BATCH_STOP } from './batchHealth.js';
import { normalizeRolloutState, planRolloutTick, ROLLOUT_STAGE, ROLLOUT_BLOCK } from './rolloutPlan.js';

const CAMPAIGN = 'light-trial-to-premium-sequence';
const BATCH_START = Date.UTC(2026, 7, 18, 10, 0, 0);
const NOW = BATCH_START + 15 * 60_000;

let seq = 0;
/** 台帳 1 行（NDJSON の 1 行に相当） */
const ev = (over = {}) => {
  seq += 1;
  return {
    eventKey: `k-${seq}`,
    eventType: 'delivered',
    eventAtMs: BATCH_START + 60_000,
    campaignId: CAMPAIGN,
    campaignVersion: 1,
    deliveryKey: 'a'.repeat(64),
    providerEventId: `p-${seq}`,
    ...over,
  };
};

const summarize = (records, over = {}) => summarizeEventWindow({
  records, campaignId: CAMPAIGN, sinceMs: BATCH_START, ...over,
});

function judge({
  events, sent = 500, failed = 0, duplicates = 0,
  previousOutstanding = 0, suppressionReadable = true,
}) {
  const baseline = toStoredOutcome(captureOutcomeSnapshot({
    jobsSent: 610, jobsFailed: 0, duplicates: 0,
    events: { complaints: 0, unsubscribes: 0, bounces: 0 },
  }), BATCH_START);
  const current = captureOutcomeSnapshot({
    jobsSent: 610 + sent, jobsFailed: failed, duplicates, events,
  });
  const d = diffOutcomeSnapshot(baseline, current);
  return canStartNextBatch({
    sent: d.counts.sent, failed: d.counts.failed, duplicates: d.counts.duplicates,
    bounces: d.counts.bounces, complaints: d.counts.complaints,
    unsubscribes: d.counts.unsubscribes,
    previousOutstanding, suppressionReadable,
  });
}

// ── 1 イベント = 1 件 ───────────────────────────────────────────

test('【重要】同じ人の複数イベントを失わない（1 イベント 1 件）', () => {
  const same = 'b'.repeat(64);
  const s = summarize([
    ev({ eventType: 'bounce', bounceClass: 'hard', deliveryKey: same }),
    ev({ eventType: 'spamreport', deliveryKey: same }),
    ev({ eventType: 'unsubscribe', deliveryKey: same }),
  ]);
  assert.equal(s.bounces, 1);
  assert.equal(s.complaints, 1);
  assert.equal(s.unsubscribes, 1);
  assert.equal(s.counted, 3, '同一人の複数イベントを 1 件に潰している');
});

test('【重要】古い停止リスト登録者の**新しい**イベントも数える', () => {
  // 台帳はアドレスの登録状態ではなくイベントを持つので、いつ登録された人でも新イベントは 1 行
  const s = summarize([ev({ eventType: 'spamreport' })]);
  assert.equal(s.complaints, 1, '古い登録者の新イベントを取り逃がしている');
});

test('【重要】provider の再送を二重に数えない（providerEventId で冪等）', () => {
  const s = summarize([
    ev({ eventType: 'spamreport', providerEventId: 'dup-1' }),
    ev({ eventType: 'spamreport', providerEventId: 'dup-1' }),
  ]);
  assert.equal(s.complaints, 1, '同じイベントを 2 回数えている');
});

// ── scope ───────────────────────────────────────────────────────

test('【重要】他 campaign のイベントを前バッチへ混ぜない', () => {
  const s = summarize([
    ev({ eventType: 'spamreport', campaignId: 'dormant-reactivation' }),
    ev({ eventType: 'spamreport' }),
  ]);
  assert.equal(s.complaints, 1);
  assert.equal(s.skipped.otherCampaign, 1);
});

test('【重要】バッチ開始より前のイベントを数えない', () => {
  const s = summarize([
    ev({ eventType: 'spamreport', eventAtMs: BATCH_START - 60_000 }),
    ev({ eventType: 'spamreport' }),
  ]);
  assert.equal(s.complaints, 1);
  assert.equal(s.skipped.beforeWindow, 1);
});

test('【重要】DeliveryKey を渡せば直前バッチの通だけへ厳密に scope する', () => {
  const mine = 'c'.repeat(64);
  const other = 'd'.repeat(64);
  const s = summarize([
    ev({ eventType: 'spamreport', deliveryKey: mine }),
    ev({ eventType: 'spamreport', deliveryKey: other }),
  ], { deliveryKeys: new Set([mine]) });
  assert.equal(s.complaints, 1);
  assert.equal(s.skipped.otherBatch, 1);
});

// ── 分類 ────────────────────────────────────────────────────────

test('【重要】soft bounce を hard bounce として数えない', () => {
  assert.equal(classifyEvent({ eventType: 'bounce', bounceClass: 'soft' }), 'softBounces');
  assert.equal(classifyEvent({ eventType: 'bounce', bounceClass: 'hard' }), 'bounces');
  assert.equal(classifyEvent({ eventType: 'dropped' }), 'bounces');
  assert.equal(classifyEvent({ eventType: 'spamreport' }), 'complaints');
  assert.equal(classifyEvent({ eventType: 'unsubscribe' }), 'unsubscribes');
  assert.equal(classifyEvent({ eventType: 'group_unsubscribe' }), 'unsubscribes');
  // 配信・開封は健全性に数えない
  assert.equal(classifyEvent({ eventType: 'delivered' }), null);
  assert.equal(classifyEvent({ eventType: 'open' }), null);
  const s = summarize([
    ev({ eventType: 'bounce', bounceClass: 'soft' }),
    ev({ eventType: 'bounce', bounceClass: 'soft' }),
    ev({ eventType: 'bounce', bounceClass: 'hard' }),
  ]);
  assert.equal(s.bounces, 1);
  assert.equal(s.softBounces, 2);
});

// ── しきい値（既存契約は変更しない）──────────────────────────────

test('【重要】本当の spam complaint 1 件で停止', () => {
  const h = judge({ events: summarize([ev({ eventType: 'spamreport' })]) });
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.COMPLAINTS);
});

test('【重要】unsubscribe は前バッチ送信数を分母に率で判定（2%）', () => {
  const under = summarize(Array.from({ length: 9 }, () => ev({ eventType: 'unsubscribe' })));
  const over = summarize(Array.from({ length: 11 }, () => ev({ eventType: 'unsubscribe' })));
  assert.equal(judge({ events: under, sent: 500 }).ok, true);      // 9/500 = 1.8%
  const h = judge({ events: over, sent: 500 });                     // 11/500 = 2.2%
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.UNSUBSCRIBE_RATE);
});

test('【重要】hard bounce も率で判定（soft は分子に入らない）', () => {
  const mixed = summarize([
    ...Array.from({ length: 11 }, () => ev({ eventType: 'bounce', bounceClass: 'hard' })),
    ...Array.from({ length: 50 }, () => ev({ eventType: 'bounce', bounceClass: 'soft' })),
  ]);
  const h = judge({ events: mixed, sent: 500 });                    // hard 11/500 = 2.2%
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.BOUNCE_RATE);
  const softOnly = summarize(Array.from({ length: 50 }, () => ev({ eventType: 'bounce', bounceClass: 'soft' })));
  assert.equal(judge({ events: softOnly, sent: 500 }).ok, true, 'soft を hard として数えている');
});

test('【重要】failed / duplicate / previousOutstanding / suppression の既存契約は維持', () => {
  const none = summarize([]);
  assert.equal(judge({ events: none, failed: 30 }).reason, BATCH_STOP.FAILED_RATE);
  assert.equal(judge({ events: none, duplicates: 1 }).reason, BATCH_STOP.DUPLICATES);
  assert.equal(judge({ events: none, previousOutstanding: 120 }).reason, BATCH_STOP.OUTSTANDING);
  assert.equal(judge({ events: none, suppressionReadable: false }).reason, BATCH_STOP.SUPPRESSION_UNREADABLE);
  assert.equal(judge({ events: none }).ok, true);
});

// ── 読めないときは 0 にしない ───────────────────────────────────

test('【重要】台帳を読めなければ fail closed（0 件にしない）', () => {
  assert.equal(summarizeEventWindow({ records: null, campaignId: CAMPAIGN, sinceMs: BATCH_START }), null);
  const snap = captureOutcomeSnapshot({ jobsSent: 1_110, jobsFailed: 0, duplicates: 0, events: null });
  assert.equal(snap.complaints, null, '読めないものを 0 と書いている');
  const h = judge({ events: null });
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.UNREADABLE);
});

test('窓が長すぎる / 逆転しているときは数え切れないとする', () => {
  assert.equal(windowDates(BATCH_START, BATCH_START - 1), null, '逆転した窓を通している');
  assert.equal(windowDates(BATCH_START, BATCH_START + 10 * 86400_000), null, '長すぎる窓を通している');
  assert.deepEqual(windowDates(BATCH_START, NOW), ['2026-08-18']);
});

test('【重要】窓の件数は差分を取らない（同一人の複数イベントを落とさない）', () => {
  const baseline = toStoredOutcome(captureOutcomeSnapshot({
    jobsSent: 610, jobsFailed: 0, duplicates: 0,
    events: { complaints: 3, unsubscribes: 0, bounces: 0 },
  }), BATCH_START);
  const current = captureOutcomeSnapshot({
    jobsSent: 1_110, jobsFailed: 0, duplicates: 0,
    events: { complaints: 1, unsubscribes: 0, bounces: 0 },
  });
  const d = diffOutcomeSnapshot(baseline, current);
  assert.equal(d.counts.complaints, 1, '窓の件数を差分にして苦情を消している');
  assert.equal(d.counts.sent, 500, '累計項目が差分になっていない');
  assert.deepEqual([...WINDOW_FIELDS], ['complaints', 'unsubscribes', 'bounces']);
});

// ── 実装の配線（回帰を止める）──────────────────────────────────

test('【重要】運転手は現在状態（byStopReason / EmailBlacklist）を健全性へ渡さない', () => {
  const src = readRel('netlify/functions/cron-marketing-rollout.js');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.equal(/byStopReason/.test(code), false, '現在状態の停止理由を参照している');
  assert.equal(/EmailBlacklist/.test(code), false, 'upsert 台帳をイベント数に使っている');
  assert.ok(src.includes('readEventWindow'), 'イベント台帳を読んでいない');
  const call = src.slice(src.indexOf('const health = canStartNextBatch({'), src.indexOf('if (!health.ok)'));
  for (const f of ['sent', 'failed', 'duplicates', 'bounces', 'complaints', 'unsubscribes']) {
    const line = call.split('\n').find((l) => l.trim().startsWith(`${f}:`)) || '';
    assert.ok(/delta\.counts\./.test(line), `${f} が前バッチの実績になっていない: ${line.trim()}`);
  }
});

test('【重要】イベント台帳は読むだけ・全件走査しない（新しい経路を作らない）', () => {
  const reader = readRel('src/lib/marketing/eventWindowReader.js');
  assert.equal(/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(reader), false, '書き込みをしている');
  assert.ok(reader.includes('MAX_EVENT_BLOBS'), '走査上限が無い');
  assert.ok(reader.includes('parseNdjson') && reader.includes('blobDatePrefix'), '既存の読み方を使っていない');
  assert.equal(typeof readEventWindow, 'function');
});

test('走査上限を超えたら数え切れないとして null', async () => {
  // ⚠️ 上限は `HARD_MAX_BATCH_SIZE × 4` から導く定数。**値をここに直書きしない**
  //    （直書きすると定数を変えたときにこの歯止めが黙って効かなくなる）
  const many = Array.from({ length: MAX_EVENT_BLOBS + 1 }, (_, i) => ({ key: `k${i}` }));
  const store = { list: async () => ({ blobs: many }), get: async () => '' };
  const r = await readEventWindow({
    sinceMs: BATCH_START, untilMs: NOW, campaignId: CAMPAIGN, getStoreImpl: () => store,
  });
  assert.equal(r, null, '数え切れていないのに数を返している');
});

test('台帳を読んで窓の件数を返す（NDJSON 経路の通し確認）', async () => {
  const line = JSON.stringify(ev({ eventType: 'spamreport' }));
  const store = {
    list: async () => ({ blobs: [{ key: 'ak/email-events/2026/08/18/100000-abc.ndjson' }] }),
    get: async () => line,
  };
  const r = await readEventWindow({
    sinceMs: BATCH_START, untilMs: NOW, campaignId: CAMPAIGN, getStoreImpl: () => store,
  });
  assert.equal(r.complaints, 1);
  assert.equal(r.blobsScanned, 1);
});

test('保存形に PII も secret も入らない', () => {
  const stored = toStoredOutcome(captureOutcomeSnapshot({
    jobsSent: 610, jobsFailed: 0, duplicates: 0,
    events: summarize([ev({ eventType: 'spamreport' })]),
  }), NOW);
  const dump = JSON.stringify(stored);
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false);
  assert.deepEqual(Object.keys(stored).sort(), [...OUTCOME_FIELDS, 'atMs'].sort());
  assert.equal(hasOutcomeBaseline(stored), true);
  assert.equal(hasOutcomeBaseline(null), false);
  assert.equal(normalizeRolloutState({ healthBaseline: stored }).healthBaseline.complaints, 1);
});

test('関所（前バッチ未処理）は計画側でも維持', () => {
  const plan = planRolloutTick({
    state: {
      ...normalizeRolloutState({}), stage: ROLLOUT_STAGE.SCALE,
      dailyLimit: 15_000, batchSize: 500, alwaysArmed: true,
    },
    nowMs: NOW, remainingCandidates: 13_900, previousOutstanding: 120, envEnabled: true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
});

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}

// ── 直前バッチへの厳密 scope（DeliveryKey 集合）─────────────────────

test('【重要】同一 campaign・同時間帯の**別バッチ**の spamreport を混ぜない', () => {
  const prev = 'e'.repeat(64);      // 直前バッチの通
  const older = 'f'.repeat(64);     // 前のバッチの通（遅れてイベントが届いた）
  const s = summarize([
    ev({ eventType: 'spamreport', deliveryKey: older }),
    ev({ eventType: 'spamreport', deliveryKey: prev }),
  ], { deliveryKeys: new Set([prev]) });
  assert.equal(s.complaints, 1, '別バッチのイベントを混ぜている');
  assert.equal(s.skipped.otherBatch, 1);
});

test('【重要】同一 campaign・同時間帯の**別 touch**のイベントを混ぜない', () => {
  // Step2〜24 の定期便は別の通 = 別 DeliveryKey。集合に入らないので数えない
  const step1 = '1'.repeat(64);
  const step7 = '7'.repeat(64);
  const s = summarize([
    ev({ eventType: 'unsubscribe', deliveryKey: step7 }),
    ev({ eventType: 'unsubscribe', deliveryKey: step1 }),
  ], { deliveryKeys: new Set([step1]) });
  assert.equal(s.unsubscribes, 1, '別 touch のイベントを混ぜている');
});

test('【重要】前バッチの spamreport 1 件は検知する（scope しても取り逃がさない）', () => {
  const mine = '2'.repeat(64);
  const s = summarize([ev({ eventType: 'spamreport', deliveryKey: mine })], {
    deliveryKeys: new Set([mine]),
  });
  assert.equal(s.complaints, 1);
  assert.equal(judge({ events: s }).reason, BATCH_STOP.COMPLAINTS);
});

test('【重要】500 名バッチ相当の DeliveryKey 集合で正しく数える', async () => {
  const keys = Array.from({ length: 500 }, (_, i) => String(i).padStart(64, '0'));
  const set = new Set(keys);
  const records = [
    // このバッチの通（数える）
    ...keys.slice(0, 3).map((k) => ev({ eventType: 'spamreport', deliveryKey: k })),
    // 別バッチの通（数えない）
    ...Array.from({ length: 20 }, (_, i) => ev({
      eventType: 'spamreport', deliveryKey: String(1000 + i).padStart(64, 'a'),
    })),
  ];
  const s = summarize(records, { deliveryKeys: set });
  assert.equal(s.complaints, 3);
  assert.equal(s.skipped.otherBatch, 20);
});

test('【重要】DeliveryKey 集合を取れなければ fail closed（推測 scope へ戻さない）', async () => {
  // jobIds が無い / 取り切れない → null
  assert.equal(await readBatchDeliveryKeys({ apiKey: 'k', baseId: 'b', jobIds: [] }), null);
  assert.equal(await readBatchDeliveryKeys({ jobIds: ['mkt-x-1'] }), null);
  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await readBatchDeliveryKeys({
    apiKey: 'k', baseId: 'b', jobIds: ['mkt-x-1'], fetchImpl: failing,
  }), null, 'HTTP 失敗で一部の鍵を返している');
  // ページ上限を超えたら null
  const endless = async () => ({
    ok: true,
    json: async () => ({ records: [{ fields: { DeliveryKey: '3'.repeat(64) } }], offset: 'more' }),
  });
  assert.equal(await readBatchDeliveryKeys({
    apiKey: 'k', baseId: 'b', jobIds: ['mkt-x-1'], fetchImpl: endless,
  }), null, '取り切れていないのに鍵を返している');

  // 集合が無いまま健全性を出さない（運転手の配線）
  const src = readRel('netlify/functions/cron-marketing-rollout.js');
  assert.ok(src.includes('deliveryKeys: batchKeys'), '直前バッチの鍵を渡していない');
  assert.ok(/batchKeys\s*&&/.test(src), '鍵が無いのにイベントを数えようとしている');
});

test('DeliveryKey 集合は鍵の形だけを受け取る（PII を持ち出さない）', async () => {
  const ok = async () => ({
    ok: true,
    json: async () => ({
      records: [
        { fields: { DeliveryKey: '4'.repeat(64) } },
        { fields: { DeliveryKey: 'not-a-key' } },
        { fields: {} },
      ],
    }),
  });
  const keys = await readBatchDeliveryKeys({
    apiKey: 'k', baseId: 'b', jobIds: ['mkt-x-1'], fetchImpl: ok,
  });
  assert.deepEqual([...keys], ['4'.repeat(64)], '鍵の形でない値を混ぜている');
  const reader = readRel('src/lib/marketing/batchDeliveryKeys.js');
  assert.equal(/fields\[\]',\s*'(RecipientEmail|Email)'/.test(reader), false, 'アドレスを取得している');
  assert.equal(/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(reader), false, '書き込みをしている');
});

test('【重要】バッチの jobIds を状態へ控えている（鍵の導出元）', () => {
  const src = readRel('netlify/functions/cron-marketing-rollout.js');
  assert.ok(src.includes('lastBatchJobIds: res.jobIds'), 'queue したジョブを控えていない');
  const st = normalizeRolloutState({ lastBatchJobIds: ['mkt-a-1', 'mkt-a-2'] });
  assert.deepEqual(st.lastBatchJobIds, ['mkt-a-1', 'mkt-a-2']);
  // PII は入らない
  assert.equal(/@/.test(JSON.stringify(st.lastBatchJobIds)), false);
});
