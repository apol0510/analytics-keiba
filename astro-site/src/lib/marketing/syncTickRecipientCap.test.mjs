/**
 * syncTickRecipientCap.test.mjs — **同期 tick で積める人数の安全上限**
 *   node --test src/lib/marketing/syncTickRecipientCap.test.mjs
 *
 * ## ここで守ること（2026-09-17 に根拠を作り直した）
 *
 * ⚠️ **本番で安全が確認できている人数は `50` だけ。**
 *    それ以外は **live の full-index 実測が無い**ので、安全と扱ってはいけない。
 *
 * ### 一度 100 に上げて、取り下げた経緯
 *
 * 「並行化したから 100 名でも 24 秒」と見積もって上限を 100 にしたが、
 * その所要時間は **`sequenceTickPreview`（下見）の実測**で、**窓で切られていた**:
 *
 * | | 下見 | **live の tick** |
 * |---|---|---|
 * | prospect 索引 | `limit` 2,000 件 | **全件（約 11,800）** |
 * | 配信台帳 | `scanPages` 2 ページ | **最後まで** |
 * | 書き込み | **しない**（予約より手前で return）| する |
 *
 * **下見から live を見積もると必ず短く出る。**
 * 実際、下見ベースで「1 tick に 4〜5 本入る」と見積もったが本番は **3 本**だった
 * （2 サイクルで再現）。同じ誤りで出した「100 名 24 秒」「50 名 19 秒」も**未検証**。
 *
 * → **上限は live の full-index 実測でしか上げない。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveMaxRecipientsPerTick, SYNC_TICK_MAX_RECIPIENTS, MAX_RECIPIENTS_PER_TICK,
} from './sequenceAutomation.js';
import { RECIPIENTS_PER_JOB } from './campaignSend.js';

const SRC = readFileSync(
  fileURLToPath(new URL('./sequenceAutomation.js', import.meta.url)),
  'utf8',
);

/** 実装準拠の分割サイズ（変わったら往復回数＝所要時間が変わる） */
const DELIVERY_UPSERT_CHUNK = 10;   // cron: deliveryRecords.slice(i, i + 10)
const READBACK_CHUNK = 20;          // marketingTargetedLoad.chunkList の既定

/** 人数 → 逐次 Airtable 往復回数（**構造**。所要時間の予測ではない） */
function roundTrips(n) {
  return Math.ceil(n / RECIPIENTS_PER_JOB)
    + Math.ceil(n / DELIVERY_UPSERT_CHUNK)
    + Math.ceil(n / READBACK_CHUNK);
}

// ══════════════════════════════════════════════════════════════════
//  ① 上限は「本番で確認できた人数」だけ
// ══════════════════════════════════════════════════════════════════

test('【最重要】上限は本番実測のある 50（未検証の人数へ上げない）', () => {
  assert.equal(
    SYNC_TICK_MAX_RECIPIENTS, 50,
    '上限を変えるなら live の full-index 実測を添えること（下見の値は根拠にならない）',
  );
});

test('【最重要】現在の本番設定（50）は 1 ミリも変わらない', () => {
  assert.equal(resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: '50' }), 50);
});

test('【最重要】env に 100 / 500 を入れても上限で頭打ちになる', () => {
  for (const v of ['75', '100', '200', '500']) {
    assert.equal(
      resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: v }),
      SYNC_TICK_MAX_RECIPIENTS,
      `env=${v} が素通りしている（未検証の人数で live が打ち切られる → 送信漏れ）`,
    );
  }
});

test('【重要】未設定・壊れた値でも上限を超えない', () => {
  for (const v of [undefined, '', 'abc', '-5', '0', '99999']) {
    const got = resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: v });
    assert.ok(got > 0 && got <= SYNC_TICK_MAX_RECIPIENTS, `env=${v} で ${got}`);
  }
});

test('【重要】Background など 15 分枠を持つ経路だけ cap を明示して超えられる', () => {
  assert.equal(
    resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: '500' }, { cap: 500 }),
    500,
  );
});

test('【重要】正本の設計値 500 は据え置き（意味を変えない）', () => {
  assert.equal(MAX_RECIPIENTS_PER_TICK, 500);
  assert.ok(SYNC_TICK_MAX_RECIPIENTS < MAX_RECIPIENTS_PER_TICK,
    '同期の上限が正本の設計値に並んでいる（同期には入らない）');
});

// ══════════════════════════════════════════════════════════════════
//  ② 窓付き下見から全体性能を外挿しない（**これが再発防止の本体**）
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ 2026-09-17 に 3 回続けて見積りを外した原因はここ。
 *    「窓で切った下見の時間 × 比率」で live を語らない。
 */
test('【最重要】上限の根拠に「下見の所要時間」を書かない', () => {
  // 定数の説明に、下見ベースの秒数を安全根拠として置いていないこと
  const banned = [
    /100 名で約 24 秒[^（]*✅/,
    /安全に使える最大同期人数を\s*75\s*→\s*100/,
  ];
  for (const re of banned) {
    assert.equal(re.test(SRC), false, `下見ベースの未検証値が安全根拠として残っている: ${re}`);
  }
});

test('【最重要】上限を上げるには live の full-index 実測が要る、と明記されている', () => {
  assert.match(SRC, /full-index/, 'live full-index 実測の必要性が書かれていない');
  assert.match(SRC, /下見・窓・シミュレーションだけを根拠に上げてはいけない/,
    '外挿を禁じる記述が消えている');
});

test('【最重要】下見と live の違い（窓 / 全件 / 書き込みの有無）が明記されている', () => {
  for (const word of ['limit', 'scanPages', '全件']) {
    assert.ok(SRC.includes(word), `下見と live の違いの説明から「${word}」が消えている`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ③ 構造（往復回数）は変わらず観測できる — ただし時間の予測には使わない
// ══════════════════════════════════════════════════════════════════

test('【重要】往復回数は人数に比例して増える（一括ではない）', () => {
  assert.ok(roundTrips(500) > roundTrips(50) * 5, '往復が人数に比例していない（実装が変わった？）');
});

test('【重要】1 ジョブあたりの人数が変わったら往復回数も変わる', () => {
  assert.equal(RECIPIENTS_PER_JOB, 50, 'ジョブ分割が変わった（所要時間の前提が変わる）');
});

/**
 * ⚠️ **往復回数は「構造」であって「秒数」ではない。**
 *    秒数へ換算して安全上限を決めるには live の実測が要る。
 */
test('【最重要】往復回数から秒数を決め打ちしていない', () => {
  // 予測式（読み 13 秒 + 書き 10 秒 × 比率 など）を定数側に持ち込んでいないこと
  assert.equal(/13 \* S|WRITE_MS_AT_50|RTT_MS/.test(SRC), false,
    '所要時間の予測式が定数モジュールに入り込んでいる');
});
