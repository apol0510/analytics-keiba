/**
 * touchMeasurementScan.test.mjs — touch 別実績を件数が増えても数え切れるか
 *   node --test src/lib/marketing/touchMeasurementScan.test.mjs
 *
 * 2026-08-17: 配信行 610 で `action=touchMeasurement` が **504**。
 * 全件一括走査をやめ、1 リクエスト 1 ページ（cursor）＋ 合算に変えた。
 * ここでは「境界・多ページ・重複 0・15,000 件規模・timeout を前提にしない構造」を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyTouchScan, mergeTouchPage, finalizeTouchScan, scanAllTouchPages,
  resolveScanPageSize, TOUCH_SCAN_DEFAULT_PAGE, TOUCH_SCAN_MAX_PAGE,
} from './touchMeasurementScan.js';
import { summarizeByTouch } from './touchMeasurement.js';
import { MAX_READ_KEYS } from '../webhooks/deliveryEventIndex.js';

/** 配信行を N 件作る（step は 1 と 2 を交互に） */
function rows(n, { openedEvery = 3, startAt = 0 } = {}) {
  const deliveries = [];
  const stepByDeliveryKey = new Map();
  const byKey = new Map();
  for (let i = startAt; i < startAt + n; i += 1) {
    const key = `dk-${i}`;
    const step = (i % 2) + 1;
    deliveries.push({
      fields: {
        DeliveryKey: key,
        CampaignType: 'light-trial-to-premium-sequence:v1',
        Status: 'sent',
        SentAt: '2026-08-17T04:40:00.000Z',
        RecipientEmail: `u${i}@example.com`,
      },
    });
    stepByDeliveryKey.set(key, step);
    byKey.set(key, {
      deliveredAtMs: Date.parse('2026-08-17T04:41:00.000Z'),
      firstOpenAtMs: i % openedEvery === 0 ? Date.parse('2026-08-17T05:00:00.000Z') : null,
    });
  }
  return { deliveries, stepByDeliveryKey, index: { ok: true, byKey } };
}

/** 全件を「1 ページ N 件」に割って、Function の応答と同じ形にする */
function pagesOf(total, pageSize) {
  const out = [];
  for (let start = 0, i = 0; start < total; start += pageSize, i += 1) {
    const n = Math.min(pageSize, total - start);
    const { deliveries, stepByDeliveryKey, index } = rows(n, { startAt: start });
    const summary = summarizeByTouch({ deliveries, stepByDeliveryKey, index });
    const done = start + n >= total;
    out.push({
      ...summary,
      scan: { pageIndex: i, pageSize, rows: n, cursor: done ? null : `off-${i + 1}`, done },
    });
  }
  return out;
}

/** ページ列を歩いて合算する（本番の script と同じ経路） */
async function scanPages(pages) {
  let n = 0;
  return scanAllTouchPages({
    fetchPage: async () => {
      const p = pages[n];
      n += 1;
      return p || null;
    },
    maxPages: 1000,
  });
}

// ── 境界（499 / 500 / 501 / 610）────────────────────────────────

for (const total of [499, 500, 501, 610]) {
  test(`【重要】${total} 件を数え切れる（504 になった規模を含む）`, async () => {
    const r = await scanPages(pagesOf(total, TOUCH_SCAN_DEFAULT_PAGE));
    assert.equal(r.complete, true, '全ページを辿り切れていない');
    assert.equal(r.totals.sent, total, `sent 合計が ${r.totals.sent}（期待 ${total}）`);
    assert.equal(r.scan.rows, total);
    assert.equal(r.measurementAvailable, true);
    // 1 ページで読む行数は必ず上限以下（＝ 1 リクエストの仕事量が増えない）
    assert.ok(TOUCH_SCAN_DEFAULT_PAGE <= TOUCH_SCAN_MAX_PAGE);
    assert.ok(TOUCH_SCAN_MAX_PAGE <= MAX_READ_KEYS, '1 ページが索引の bounded read 上限を超える');
  });
}

test('【重要】1 ページに収まる件数でも複数ページでも合計は同じ', async () => {
  const one = await scanPages(pagesOf(499, 500));
  const many = await scanPages(pagesOf(499, 100));
  assert.equal(one.totals.sent, many.totals.sent);
  assert.equal(one.totals.opened, many.totals.opened);
  assert.equal(one.totals.delivered, many.totals.delivered);
  assert.ok(many.scan.pages > one.scan.pages, '分割しても 1 ページ扱いになっている');
});

// ── 二重集計 0 ──────────────────────────────────────────────────

test('【重要】同じページを 2 回足しても増えない（再試行で数が膨らまない）', () => {
  const pages = pagesOf(300, 100);
  let acc = emptyTouchScan();
  for (const p of pages) {
    acc = mergeTouchPage(acc, { pageIndex: p.scan.pageIndex, touches: p.touches, rows: p.scan.rows });
  }
  const once = finalizeTouchScan(acc);
  // 全ページをもう一度足す
  for (const p of pages) {
    acc = mergeTouchPage(acc, { pageIndex: p.scan.pageIndex, touches: p.touches, rows: p.scan.rows });
  }
  const twice = finalizeTouchScan(acc);
  assert.deepEqual(twice.totals, once.totals, 'ページが二重集計されている');
  assert.equal(twice.scan.pages, 3);
});

test('【重要】同じ cursor が返り続けても無限ループしない', async () => {
  let calls = 0;
  const r = await scanAllTouchPages({
    fetchPage: async () => {
      calls += 1;
      const { deliveries, stepByDeliveryKey, index } = rows(10);
      return {
        ...summarizeByTouch({ deliveries, stepByDeliveryKey, index }),
        scan: { pageIndex: 0, pageSize: 10, rows: 10, cursor: 'stuck', done: false },
      };
    },
    maxPages: 50,
  });
  assert.ok(calls <= 2, `${calls} 回呼んでいる（同じ cursor で回り続けている）`);
  assert.equal(r.complete, false, '辿り切れていないのに完了と言っている');
});

// ── 15,000 件規模 ───────────────────────────────────────────────

test('【重要】15,000 件規模でも 1 リクエストの仕事量が増えない', async () => {
  const TOTAL = 15_000;
  const pages = pagesOf(TOTAL, TOUCH_SCAN_MAX_PAGE);
  const maxRowsPerPage = Math.max(...pages.map((p) => p.scan.rows));
  assert.equal(maxRowsPerPage, TOUCH_SCAN_MAX_PAGE, '1 ページの行数が上限を超えている');
  assert.equal(pages.length, TOTAL / TOUCH_SCAN_MAX_PAGE);
  const r = await scanPages(pages);
  assert.equal(r.complete, true);
  assert.equal(r.totals.sent, TOTAL);
  assert.equal(r.scan.rows, TOTAL);
  // 接点は 2 種類（step 1 / 2）で、合計は全体と一致する
  assert.equal(r.touches.reduce((a, x) => a + x.sent, 0), TOTAL);
});

// ── 既存契約の維持 ──────────────────────────────────────────────

test('【重要】率は合計してから 1 回だけ計算する（ページごとの平均にしない）', async () => {
  // 1 ページ目は全員開封、2 ページ目は誰も開かない → 平均だと 50% になってしまう
  const a = rows(100, { openedEvery: 1, startAt: 0 });
  const b = rows(300, { openedEvery: 10_000, startAt: 100 });
  const pa = { ...summarizeByTouch(a), scan: { pageIndex: 0, rows: 100, cursor: 'x', done: false } };
  const pb = { ...summarizeByTouch(b), scan: { pageIndex: 1, rows: 300, cursor: null, done: true } };
  const r = await scanPages([pa, pb]);
  assert.equal(r.totals.opened, 100);
  assert.equal(r.totals.delivered, 400);
  assert.equal(r.totals.openRate, 100 / 400, '率をページ平均で出している');
  assert.deepEqual(r.totals.rateBasis, { deliveryRate: 'sent', openRate: 'delivered' });
});

test('【重要】索引を読めなかったページが 1 つでもあれば未計測扱い（0 件にしない）', async () => {
  const { deliveries, stepByDeliveryKey } = rows(100);
  const broken = {
    ...summarizeByTouch({ deliveries, stepByDeliveryKey, index: { ok: false, byKey: new Map() } }),
    scan: { pageIndex: 0, rows: 100, cursor: 'x', done: false },
  };
  const okPage = { ...summarizeByTouch(rows(100, { startAt: 100 })), scan: { pageIndex: 1, rows: 100, cursor: null, done: true } };
  const r = await scanPages([broken, okPage]);
  assert.equal(r.measurementAvailable, false, '読めなかったページを計測済みとして通している');
  assert.equal(r.totals.unknown >= 100, true, '未計測を 0 件に丸めている');
});

test('click は計測していない（0 と書かない）', async () => {
  const r = await scanPages(pagesOf(10, 100));
  assert.equal(r.clickMeasured, false);
  assert.equal('clicked' in r.totals, false, 'click を数えたことにしている');
});

test('ページ行数は安全な範囲へ丸める（黙って全件にしない）', () => {
  assert.equal(resolveScanPageSize(undefined), TOUCH_SCAN_DEFAULT_PAGE);
  assert.equal(resolveScanPageSize(0), TOUCH_SCAN_DEFAULT_PAGE);
  assert.equal(resolveScanPageSize(-5), TOUCH_SCAN_DEFAULT_PAGE);
  assert.equal(resolveScanPageSize(50), 50);
  assert.equal(resolveScanPageSize(15_000), TOUCH_SCAN_MAX_PAGE, '要求どおり全件読もうとしている');
});

test('集計結果に PII を混ぜない', async () => {
  const r = await scanPages(pagesOf(200, 100));
  const dump = JSON.stringify(r);
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false, 'メールアドレスが混ざっている');
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false, 'recordId が混ざっている');
});
