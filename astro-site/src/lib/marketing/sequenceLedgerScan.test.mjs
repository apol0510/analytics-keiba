/**
 * sequenceLedgerScan.test.mjs — 15,000 名超でも複数 tick で全員が完走する
 *   node --test src/lib/marketing/sequenceLedgerScan.test.mjs
 *
 * ## 何を守るテストか（2026-08-26 に本番で見つけた欠陥）
 *
 * 1 通目を 15,491 通送ったことで配信台帳が **4,000 行の読み取り上限**を超え、
 * 連続配信の tick が例外で止まり **2 通目が 1 通も送れない**状態だった。
 *
 * 「先頭 N ページだけ読む」で打ち切るのは**間違い**。Airtable のページ順は安定しているので
 * 毎回同じ人しか見えず、後ろの人が永久に進まない。そこで
 * **前回の続き（offset）を保存して次の tick が続きから読む**形にした。
 *
 * ここでは 16,000 名ぶんの台帳を用意し、tick を重ねて
 *   - **全員がちょうど 1 通ずつ**受け取る（取りこぼし 0・重複 0）
 *   - 1 tick の読み取りページ数と送信人数の上限を守る
 * ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextScanCursor, createSequenceScanStore, resolvePagesPerTick,
  DEFAULT_PAGES_PER_TICK, scanCursorKey,
} from './sequenceLedgerScan.js';

// ── カーソルの進み方 ──────────────────────────────────────────
test('続きがあれば同じ周回のまま位置だけ進む', () => {
  const c = nextScanCursor({ offset: 'itr123', pass: 2 });
  assert.deepEqual(c, { offset: 'itr123', pass: 2, completedPass: false });
});

test('読み切ったら次は先頭から（周回が 1 つ進む）', () => {
  const c = nextScanCursor({ offset: null, pass: 2 });
  assert.deepEqual(c, { offset: null, pass: 3, completedPass: true });
  assert.deepEqual(nextScanCursor({ offset: '  ', pass: 0 }), { offset: null, pass: 1, completedPass: true });
});

test('1 tick のページ数は env で変えられる（壊れた値は既定へ）', () => {
  assert.equal(resolvePagesPerTick({ MARKETING_SEQUENCE_SCAN_PAGES: '5' }), 5);
  for (const bad of ['0', '-3', 'abc', '', undefined, '1000']) {
    assert.equal(resolvePagesPerTick({ MARKETING_SEQUENCE_SCAN_PAGES: bad }), DEFAULT_PAGES_PER_TICK, String(bad));
  }
});

test('カーソルはキャンペーンごとに分かれる（別キャンペーンの位置を壊さない）', () => {
  assert.notEqual(scanCursorKey('campaign-discount-free:v1'), scanCursorKey('campaign-discount-light:v1'));
});

test('Redis が無ければ毎回先頭から（進まないだけで誤送信にはしない）', async () => {
  const s = createSequenceScanStore({});
  assert.equal(s.usable, false);
  assert.deepEqual(await s.read('x'), { offset: null, pass: 0 });
  assert.equal((await s.write('x', { offset: 'a', pass: 1 })).ok, false);
});

test('壊れた保存値は先頭から読み直す（推測で進めない）', async () => {
  const s = createSequenceScanStore({ redisCmd: async () => 'not json' });
  assert.deepEqual(await s.read('x'), { offset: null, pass: 0 });
});

// ── 本番規模の完走シミュレーション ────────────────────────────
/**
 * 台帳とカーソルを持つ最小の模擬環境で tick を回す。
 * ページ順は安定（本番の Airtable と同じ前提）。
 */
function simulate({ audience, pagesPerTick, maxRecipientsPerTick }) {
  const PAGE = 100;
  // step1 の配信行（= シーケンスに入っている人）。1 人 1 行
  const ledger = audience.map((email) => ({ email, step: 1 }));
  const sentStep2 = new Set();      // DeliveryKey 相当（campaign × version × step × 受信者）
  const mem = new Map();
  const redisCmd = async ([op, key, val]) => {
    if (op === 'GET') return mem.get(key) ?? null;
    if (op === 'SET') { mem.set(key, val); return 'OK'; }
    throw new Error('unexpected');
  };
  const store = createSequenceScanStore({ redisCmd });
  const TYPE = 'campaign-discount-free:v1';

  let ticks = 0;
  let enqueuedTotal = 0;
  const maxTicks = 500;
  while (ticks < maxTicks && sentStep2.size < audience.length) {
    ticks += 1;
    // 1) 続きから決まったページ数だけ読む。
    //    カーソルは「読み始める行番号」を表す（本番の Airtable offset 相当）
    const cursor = mem.get(scanCursorKey(TYPE)) ? JSON.parse(mem.get(scanCursorKey(TYPE))) : { offset: null, pass: 0 };
    const start = cursor.offset ? Number(cursor.offset) : 0;
    const end = Math.min(start + pagesPerTick * PAGE, ledger.length);
    const window = ledger.slice(start, end);
    const nextOffset = end < ledger.length ? String(end) : null;
    mem.set(scanCursorKey(TYPE), JSON.stringify(nextScanCursor({ offset: nextOffset, pass: cursor.pass })));

    // 2) その窓の中から「step2 をまだ受け取っていない人」を上限まで送る
    const due = window.map((r) => r.email).filter((e) => !sentStep2.has(e));
    const take = due.slice(0, maxRecipientsPerTick);
    for (const e of take) {
      // DeliveryKey 相当の重複チェック（本番と同じ保証）
      assert.equal(sentStep2.has(e), false, `${e} へ二度送ろうとした`);
      sentStep2.add(e);
    }
    enqueuedTotal += take.length;
    assert.ok(take.length <= maxRecipientsPerTick, '1 tick の送信上限を超えた');
    assert.ok(window.length <= pagesPerTick * PAGE, '1 tick の読み取り上限を超えた');
  }
  return { ticks, sent: sentStep2, enqueuedTotal, store };
}

test('【要件】16,000 名でも複数 tick で全員がちょうど 1 通ずつ受け取る', () => {
  const audience = Array.from({ length: 16000 }, (_, i) => `u${i}@example.invalid`);
  const r = simulate({ audience, pagesPerTick: DEFAULT_PAGES_PER_TICK, maxRecipientsPerTick: 500 });

  assert.equal(r.sent.size, 16000, '取りこぼしがある（全員に届いていない）');
  assert.equal(r.enqueuedTotal, 16000, '重複して送っている');
  for (const e of audience) assert.ok(r.sent.has(e), `${e} が取り残された`);
  // 10 分間隔なら 1 日 144 tick。それより十分少ない回数で終わること
  assert.ok(r.ticks <= 144, `${r.ticks} tick かかる（同じ日に終わらない）`);
});

test('【要件】1 tick のページ数を絞っても、周回を重ねれば必ず完走する', () => {
  const audience = Array.from({ length: 15945 }, (_, i) => `v${i}@example.invalid`);
  const r = simulate({ audience, pagesPerTick: 5, maxRecipientsPerTick: 200 });
  assert.equal(r.sent.size, 15945, '取りこぼしがある');
  assert.equal(r.enqueuedTotal, 15945, '重複して送っている');
});

test('【要件】先頭ページだけを毎回読む実装では完走しない（退行の検知）', () => {
  // カーソルを進めない（＝以前の「先頭 N ページで打ち切る」実装）を模擬する
  const audience = Array.from({ length: 16000 }, (_, i) => `w${i}@example.invalid`);
  const PAGE = 100; const pagesPerTick = 20;
  const sent = new Set();
  for (let t = 0; t < 50; t += 1) {
    const window = audience.slice(0, pagesPerTick * PAGE); // いつも先頭だけ
    for (const e of window.filter((x) => !sent.has(x)).slice(0, 500)) sent.add(e);
  }
  assert.ok(sent.size < audience.length,
    '先頭固定でも完走してしまった（このテストの前提が壊れている）');
  assert.equal(sent.size, pagesPerTick * PAGE, '先頭の窓の人しか送れないことを示す');
});
