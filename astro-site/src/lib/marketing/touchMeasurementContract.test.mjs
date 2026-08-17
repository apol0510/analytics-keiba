/**
 * touchMeasurementContract.test.mjs — 読み手（consumer）との約束を固定する
 *   node --test src/lib/marketing/touchMeasurementContract.test.mjs
 *
 * ── 背景 ──────────────────────────────────────────────────────
 * `action=touchMeasurement` は昔から「**全体の集計**」を返す約束だった。
 * ページ化にあたって、同じ action が 1 ページ分を同じ形で返すと、
 * 読み手（runbook の curl / 将来の画面）が**一部を全体として読む**。
 *
 * そこで:
 *   `touchMeasurement`     … 数え切れたときだけ数を返す（`complete: true` / `schemaVersion: 2`）
 *   `touchMeasurementPage` … 1 ページ（必ず `partial` と `scan.cursor` を持つ）
 *
 * ここでは「壊れた読み方ができない形になっているか」を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildInlineMeasurementResult, MEASUREMENT_INLINE_MAX_PAGES, MEASUREMENT_INCOMPLETE,
  scanAllTouchPages,
} from './touchMeasurementScan.js';
import { summarizeByTouch } from './touchMeasurement.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASTRO_ROOT = join(HERE, '..', '..', '..');

/** 配信行 N 件（step 1 / 2 を交互に） */
function page(n, { startAt = 0, pageIndex = 0, cursor = null } = {}) {
  const deliveries = [];
  const stepByDeliveryKey = new Map();
  const byKey = new Map();
  for (let i = startAt; i < startAt + n; i += 1) {
    const key = `dk-${i}`;
    deliveries.push({
      fields: {
        DeliveryKey: key,
        CampaignType: 'light-trial-to-premium-sequence:v1',
        Status: 'sent',
        SentAt: '2026-08-17T04:40:00.000Z',
        RecipientEmail: `u${i}@example.com`,
      },
    });
    stepByDeliveryKey.set(key, (i % 2) + 1);
    byKey.set(key, { deliveredAtMs: 1, firstOpenAtMs: i % 3 === 0 ? 2 : null });
  }
  return {
    ...summarizeByTouch({ deliveries, stepByDeliveryKey, index: { ok: true, byKey } }),
    scan: { pageIndex, pageSize: n, rows: n, cursor, done: !cursor },
    partial: !!cursor,
  };
}

async function inlineScan(pages) {
  let i = 0;
  const scan = await scanAllTouchPages({
    maxPages: MEASUREMENT_INLINE_MAX_PAGES,
    fetchPage: async () => { const p = pages[i]; i += 1; return p || null; },
  });
  return buildInlineMeasurementResult({ scan });
}

// ── 数え切れないときは「数を返さない」──────────────────────────────

test('【重要】数え切れないとき touches / totals を返さない（部分を全体と誤読させない）', async () => {
  const pages = [
    page(200, { startAt: 0, pageIndex: 0, cursor: 'c1' }),
    page(200, { startAt: 200, pageIndex: 1, cursor: 'c2' }),
    page(200, { startAt: 400, pageIndex: 2, cursor: null }),
  ];
  const r = await inlineScan(pages);
  assert.equal(r.ok, false, '予算内で終わっていないのに数を返している');
  assert.equal(r.body.complete, false);
  assert.equal(r.body.code, MEASUREMENT_INCOMPLETE);
  assert.equal('touches' in r.body, false, '部分集計の touches を返している');
  assert.equal('totals' in r.body, false, '部分集計の totals を返している');
  assert.equal('measurementAvailable' in r.body, false, '部分結果を計測済みとして返している');
  // 何ページ見たかは正直に出す（黙って打ち切らない）
  assert.equal(r.body.scannedPages, MEASUREMENT_INLINE_MAX_PAGES);
  assert.equal(r.body.budgetPages, MEASUREMENT_INLINE_MAX_PAGES);
});

test('【重要】数え切れたときだけ従来どおりの形で返す', async () => {
  const r = await inlineScan([
    page(200, { startAt: 0, pageIndex: 0, cursor: 'c1' }),
    page(120, { startAt: 200, pageIndex: 1, cursor: null }),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.body.complete, true);
  assert.equal(r.body.totals.sent, 320, '合計が全ページぶんになっていない');
  assert.ok(Array.isArray(r.body.touches));
  assert.deepEqual(r.body.totals.rateBasis, { deliveryRate: 'sent', openRate: 'delivered' });
  assert.equal(r.body.clickMeasured, false);
  assert.equal(r.body.measurementAvailable, true);
});

test('【重要】予算を増やして全件走査へ戻していない', () => {
  assert.ok(MEASUREMENT_INLINE_MAX_PAGES <= 2, `1 回の呼び出しで ${MEASUREMENT_INLINE_MAX_PAGES} ページ歩いている`);
});

test('壊れた入力を「数え切れた」と言わない', () => {
  for (const bad of [null, undefined, {}, { complete: false }]) {
    const r = buildInlineMeasurementResult({ scan: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} を成功にしている`);
    assert.equal('totals' in r.body, false);
  }
});

// ── consumer の実在確認（「居ない」を根拠つきで固定する）──────────────

/** 指定ディレクトリのファイルを再帰的に読む（テスト用・件数は小さい） */
function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|ts|astro|jsx|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test('【重要】`touchMeasurement` を呼ぶ実装は Function 本体と scan script 以外に無い', () => {
  const files = [
    ...walk(join(ASTRO_ROOT, 'netlify', 'functions')),
    ...walk(join(ASTRO_ROOT, 'src', 'pages')),
    ...walk(join(ASTRO_ROOT, 'src', 'components')),
    ...walk(join(ASTRO_ROOT, 'src', 'lib')),
    ...walk(join(ASTRO_ROOT, 'scripts')),
  ];
  const callers = [];
  for (const f of files) {
    const body = readFileSync(f, 'utf8');
    // 「action として touchMeasurement を投げている」呼び出しだけを拾う
    if (/action:\s*['"`]touchMeasurement(Page)?['"`]/.test(body)) callers.push(f);
  }
  const rel = callers.map((f) => f.slice(ASTRO_ROOT.length + 1)).sort();
  // ⚠️ 呼び出し元は **scan script だけ**。管理画面も他 Function も呼んでいない
  //    （全体版は同じプロセス内で 1 ページ版の関数を直接呼ぶので action 文字列を持たない）。
  //    ここが増えたら、その読み手が `complete` / `partial` を見ているか確認すること。
  assert.deepEqual(rel, [
    'scripts/touch-measurement-scan.mjs',         // cursor を辿る唯一の読み手
  ], `未知の呼び出し元がある: ${rel.join(', ')}`);
});

test('【重要】1 ページ版の応答は必ず partial / cursor を持つ（全体と見分けられる）', () => {
  const p = page(200, { pageIndex: 0, cursor: 'c1' });
  assert.equal(p.partial, true);
  assert.equal(p.scan.cursor, 'c1');
  assert.equal(p.scan.done, false);
  const last = page(20, { pageIndex: 1, cursor: null });
  assert.equal(last.partial, false);
  assert.equal(last.scan.done, true);
});

test('全体版と 1 ページ版が同じ action 名を共有していない（契約を混ぜない）', () => {
  const src = readFileSync(join(ASTRO_ROOT, 'netlify', 'functions', 'admin-marketing.js'), 'utf8');
  assert.ok(src.includes("action === 'touchMeasurement'"), '全体版の入口が無い');
  assert.ok(src.includes("action === 'touchMeasurementPage'"), 'ページ版の入口が無い');
  assert.ok(src.includes('schemaVersion: 2'), '契約が変わったことを応答で示していない');
});
