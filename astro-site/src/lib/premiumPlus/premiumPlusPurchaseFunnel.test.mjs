/**
 * premiumPlusPurchaseFunnel.test.mjs — 決済開始・購入完了までの計測を固定する
 *   node --test src/lib/premiumPlus/premiumPlusPurchaseFunnel.test.mjs
 *
 * ## 守る一線
 *
 * 1. **購入完了はサーバー側の確定イベントだけ**で記録する。
 *    画面の成功表示では記録しない（客が見た画面は「確定」ではない）。
 * 2. **同じ注文を二度数えない**。Airtable Automation の再実行・Webhook 再送・
 *    再読込で何度呼ばれても 1 回。
 * 3. **導線を推測しない**。決済開始の記録から引き継ぎ、決められないなら
 *    `ambiguous` に置く（dashboard へ寄せない）。
 * 4. **PII を Redis へ入れない**。日次カウンタは recordId すら持たない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FUNNEL_EVENT, FUNNEL_KEY, FUNNEL_SOURCE_AMBIGUOUS, DEDUPE_MS,
  DAILY_RETENTION_DAYS, FUNNEL_WINDOW_DAYS,
  createFunnelStore, attributePurchaseSource, funnelDayKey, dailyField, recentDayKeys,
  normalizeHgetall, normalizeEntrySource,
} from './premiumPlusFunnelStore.js';
import {
  summarizePurchaseBySource, PURCHASE_ENTRY_ONLY_NOTE,
} from './premiumPlusFunnelAnalytics.js';

const ID = 'recPURCHASETEST01';
const UA = 'Mozilla/5.0 (Macintosh) Safari/605.1';
const T0 = Date.parse('2026-08-13T05:00:00Z');

/** 実 Redis を使わない store */
function memStore() {
  const db = new Map();
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  const store = createFunnelStore({
    redisCmd: async (cmd) => {
      const [op, key, a, b] = cmd;
      if (op === 'HGET') return db.get(`${key}|${a}`) ?? null;
      if (op === 'HSET') { db.set(`${key}|${a}`, b); return 1; }
      if (op === 'HSETNX') { const k = `${key}|${a}`; if (db.has(k)) return 0; db.set(k, b); return 1; }
      if (op === 'HINCRBY') { const k = `${key}|${a}`; const n = num(db.get(k)) + Number(b); db.set(k, String(n)); return n; }
      if (op === 'HDEL') { db.delete(`${key}|${a}`); return 1; }
      if (op === 'HGETALL') {
        const out = {};
        for (const [k, v] of db) { if (k.startsWith(`${key}|`)) out[k.slice(key.length + 1)] = v; }
        return out;
      }
      return null;
    },
  });
  const read = (key, id) => { const v = db.get(`${key}|${id}`); return v ? JSON.parse(v) : null; };
  return { store, read, db };
}

const checkout = (store, at, source) => store.record({
  recordId: ID, event: FUNNEL_EVENT.CHECKOUT_START, nowMs: at, userAgent: UA, authenticated: true, source,
});

// ── 購入完了はサーバー確定イベントのみ ──────────────────────────
test('【重要】購入完了はサーバー側の確定イベントで記録される', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'dashboard');
  const r = await store.record_purchase({ recordId: ID, nowMs: T0 + 60000, orderKey: 'ord-1' });
  assert.equal(r.counted, true);
  const v = read(FUNNEL_KEY.PURCHASE, ID);
  assert.equal(v.count, 1);
  assert.ok(v.orders['ord-1'], '注文キーが記録されていない');
});

test('【重要】記録 API（クライアント経路）は購入完了を受け付けない', () => {
  const api = readFileSync(new URL('../../pages/api/pp-funnel.json.js', import.meta.url), 'utf8');
  const allowed = /const ALLOWED_EVENTS = new Set\(\[([^\]]*)\]\)/.exec(api);
  assert.ok(allowed, 'ALLOWED_EVENTS を読めない');
  assert.ok(!/PURCHASE/.test(allowed[1]), 'クライアント経路が購入完了を受け付けている');
  assert.ok(!/CHECKOUT_START/.test(allowed[1]), 'クライアント経路が決済開始を受け付けている');
  // 受け付けるのは既存の 3 種別だけ
  assert.match(allowed[1], /CTA_VIEW/);
  assert.match(allowed[1], /CTA_CLICK/);
  assert.match(allowed[1], /PAGE_VIEW/);
});

// ── 冪等性 ───────────────────────────────────────────────────
test('【重要】同じ orderKey の再送は計上しない（Webhook 再送・再実行）', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'dashboard');
  const first = await store.record_purchase({ recordId: ID, nowMs: T0 + 60000, orderKey: 'ord-1' });
  const retry = await store.record_purchase({ recordId: ID, nowMs: T0 + 120000, orderKey: 'ord-1' });
  const retry2 = await store.record_purchase({ recordId: ID, nowMs: T0 + 99999999, orderKey: 'ord-1' });
  assert.equal(first.counted, true);
  assert.equal(retry.counted, false);
  assert.equal(retry.reason, 'already_counted');
  assert.equal(retry2.counted, false, '時間が経てば数えてしまっている');
  assert.equal(read(FUNNEL_KEY.PURCHASE, ID).count, 1);
});

test('【重要】orderKey が無ければ recordId につき 1 回だけ', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'dashboard');
  await store.record_purchase({ recordId: ID, nowMs: T0 + 1000 });
  const again = await store.record_purchase({ recordId: ID, nowMs: T0 + 2000 });
  assert.equal(again.counted, false);
  assert.equal(read(FUNNEL_KEY.PURCHASE, ID).count, 1);
});

test('別の orderKey なら計上する（再購入）', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'dashboard');
  await store.record_purchase({ recordId: ID, nowMs: T0 + 1000, orderKey: 'ord-1' });
  const second = await store.record_purchase({ recordId: ID, nowMs: T0 + 86400000, orderKey: 'ord-2' });
  assert.equal(second.counted, true);
  assert.equal(read(FUNNEL_KEY.PURCHASE, ID).count, 2);
});

test('不正な recordId では記録しない', async () => {
  const { store } = memStore();
  for (const bad of ['', 'x', 'recSHORT', null]) {
    // eslint-disable-next-line no-await-in-loop -- 順に確認する
    const r = await store.record_purchase({ recordId: bad, nowMs: T0 });
    assert.equal(r.counted, false);
  }
});

test('【重要】決済開始は 30 分・source 単位で重複除外', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'dashboard');
  const same = await checkout(store, T0 + 60000, 'dashboard');
  const other = await checkout(store, T0 + 60000, 'sanrenpuku');
  assert.equal(same.counted, false, '同一導線の連打を数えている');
  assert.equal(other.counted, true, '別導線の決済開始が消えている');
  const v = read(FUNNEL_KEY.CHECKOUT, ID);
  assert.equal(v.bySource.dashboard.count, 1);
  assert.equal(v.bySource.sanrenpuku.count, 1);
});

// ── 導線の帰属（推測しない）──────────────────────────────────
test('【重要】決済開始が 1 導線だけなら購入をその導線へ', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'sanrenpuku');
  const r = await store.record_purchase({ recordId: ID, nowMs: T0 + 60000, orderKey: 'o' });
  assert.equal(r.source, 'sanrenpuku');
  assert.equal(read(FUNNEL_KEY.PURCHASE, ID).bySource.sanrenpuku.count, 1);
});

test('【重要】決済開始が複数導線なら ambiguous（どちらへも寄せない）', async () => {
  const { store, read } = memStore();
  await checkout(store, T0, 'dashboard');
  await checkout(store, T0 + 60000, 'sanrenpuku');
  const r = await store.record_purchase({ recordId: ID, nowMs: T0 + 120000, orderKey: 'o' });
  assert.equal(r.source, FUNNEL_SOURCE_AMBIGUOUS);
  const v = read(FUNNEL_KEY.PURCHASE, ID);
  assert.ok(!v.bySource, 'どちらかの導線へ寄せている');
  assert.equal(v.ambiguous.count, 1);
});

test('【重要】決済開始が無ければ noSource（dashboard へ推測しない）', async () => {
  const { store, read } = memStore();
  const r = await store.record_purchase({ recordId: ID, nowMs: T0, orderKey: 'o' });
  assert.equal(r.source, null);
  const v = read(FUNNEL_KEY.PURCHASE, ID);
  assert.ok(!v.bySource);
  assert.equal(v.noSource.count, 1);
});

test('attributePurchaseSource は単体でも同じ判定', () => {
  assert.equal(attributePurchaseSource(null), null);
  assert.equal(attributePurchaseSource({ bySource: {} }), null);
  assert.equal(attributePurchaseSource({ bySource: { dashboard: { count: 2 } } }), 'dashboard');
  assert.equal(attributePurchaseSource({ bySource: { dashboard: { count: 1 }, sanrenpuku: { count: 1 } } }),
    FUNNEL_SOURCE_AMBIGUOUS);
  // count 0 は「あった」ことにしない
  assert.equal(attributePurchaseSource({ bySource: { dashboard: { count: 0 } } }), null);
});

// ── 期間集計 ─────────────────────────────────────────────────
test('【重要】日次カウンタに recordId・PII を入れない', async () => {
  const { store, db } = memStore();
  await checkout(store, T0, 'dashboard');
  await store.record_purchase({ recordId: ID, nowMs: T0 + 1000, orderKey: 'o' });
  const dailyFields = [...db.keys()].filter((k) => k.startsWith(`${FUNNEL_KEY.DAILY}|`));
  assert.ok(dailyFields.length > 0, '日次カウンタが書かれていない');
  for (const f of dailyFields) {
    assert.ok(!f.includes(ID), `日次カウンタに recordId が入っている: ${f}`);
    assert.match(f.split('|').slice(1).join('|'), /^\d{8}\|[a-z_]+\|[a-z]+$/);
  }
});

test('今日 / 7 日 / 30 日で件数を切り出せる', async () => {
  const { store } = memStore();
  // ⚠️ 古い順に記録する。時間を逆行させると重複除外（now - lastAt が負）に当たる
  await checkout(store, T0 - 20 * 86400000, 'dashboard');   // 20 日前
  await checkout(store, T0 - 3 * 86400000, 'dashboard');    // 3 日前
  await checkout(store, T0, 'dashboard');                   // 今日
  const out = await store.readDaily({ nowMs: T0 });
  assert.equal(out.available, true);
  const sum = (days) => {
    const keys = new Set(recentDayKeys(T0, days));
    return Object.entries(out.entries)
      .filter(([f]) => keys.has(f.split('|')[0]) && f.includes(FUNNEL_EVENT.CHECKOUT_START))
      .reduce((n, [, v]) => n + Number(v), 0);
  };
  assert.equal(sum(1), 1, '今日ぶんが合わない');
  assert.equal(sum(7), 2, '7 日ぶんが合わない');
  assert.equal(sum(30), 3, '30 日ぶんが合わない');
});

test('範囲外の日は含まない', () => {
  const keys = recentDayKeys(T0, 7);
  assert.equal(keys.length, 7);
  assert.ok(!keys.includes(funnelDayKey(T0 - 8 * 86400000)));
  assert.equal(keys[0], funnelDayKey(T0), '今日が先頭に無い');
});

test('【重要】保持期間より古い日次フィールドを掃除する', async () => {
  const { store, db } = memStore();
  const staleDay = funnelDayKey(T0 - DAILY_RETENTION_DAYS * 86400000);
  const staleField = `${FUNNEL_KEY.DAILY}|${dailyField(staleDay, FUNNEL_EVENT.CHECKOUT_START, 'dashboard')}`;
  db.set(staleField, '5');
  await checkout(store, T0, 'dashboard');
  assert.ok(!db.has(staleField), '保持期間より古いフィールドが残っている');
});

test('窓の既定は 今日 / 7 日 / 30 日', () => {
  assert.deepEqual([...FUNNEL_WINDOW_DAYS], [1, 7, 30]);
});

test('HGETALL が配列で返ってもオブジェクトへ正規化する', () => {
  assert.deepEqual(normalizeHgetall(['a', '1', 'b', '2']), { a: '1', b: '2' });
  assert.deepEqual(normalizeHgetall({ a: '1' }), { a: '1' });
  assert.deepEqual(normalizeHgetall(null), {});
});

test('日次が読めなければ available:false（0 件と断定しない）', async () => {
  const store = createFunnelStore({ redisCmd: async () => { throw new Error('down'); } });
  const out = await store.readDaily({ nowMs: T0 });
  assert.equal(out.available, false);
  assert.equal(out.entries, null, '読めていないのに空の集計を返している');
});

// ── 後方互換 ─────────────────────────────────────────────────
test('【重要】既存 3 種別の記録は変わらない', async () => {
  const { store, read } = memStore();
  await store.record({
    recordId: ID, event: FUNNEL_EVENT.CTA_VIEW, nowMs: T0, userAgent: UA, authenticated: true, source: 'dashboard',
  });
  const v = read(FUNNEL_KEY.CTA, ID);
  assert.equal(v.count, 1);
  assert.equal(v.bySource.dashboard.count, 1);
  assert.equal(v.sv, 1);
});

test('購入の legacy 欄も既存と同じ考え方（sv 無しは全量 legacy）', async () => {
  const { store, read, db } = memStore();
  db.set(`${FUNNEL_KEY.PURCHASE}|${ID}`, JSON.stringify({ firstAt: T0 - 86400000, lastAt: T0 - 86400000, count: 1 }));
  await store.record_purchase({ recordId: ID, nowMs: T0, orderKey: 'new' });
  const v = read(FUNNEL_KEY.PURCHASE, ID);
  assert.equal(v.legacy, 1, '計測前の購入が legacy として保持されていない');
  assert.equal(v.count, 2);
});

// ══════════════════════════════════════════════════════════════
//  配線ガード — 記録してよい場所からしか呼ばれていないこと
// ══════════════════════════════════════════════════════════════
const readFile = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const CONFIRM = readFile('../../../netlify/functions/confirm-bank-payment.js');
const APPLY = readFile('../../../netlify/functions/bank-transfer-application.js');
const SERVER = readFile('./premiumPlusFunnelServer.js');

/** 関数 1 本の本体を取り出す（次の export の手前で止める） */
function fnBody(src, name) {
  const i = src.indexOf(`export async function ${name}`);
  assert.ok(i >= 0, `${name} が無い`);
  const after = src.slice(i + 10);
  const next = after.indexOf('\nexport ');
  return next < 0 ? after : after.slice(0, next);
}

test('【重要】購入完了を記録するのは入金確認の Function だけ', () => {
  assert.match(CONFIRM, /recordPlusPurchase\(/);
  // クライアントから届く経路・画面には無いこと
  for (const [name, src] of [
    ['premium-plus-v2.astro', readFile('../../pages/premium-plus-v2.astro')],
    ['premium-plus.astro', readFile('../../pages/premium-plus.astro')],
    ['dashboard.astro', readFile('../../pages/dashboard.astro')],
    ['pp-funnel.json.js', readFile('../../pages/api/pp-funnel.json.js')],
  ]) {
    assert.ok(!/recordPlusPurchase/.test(src), `${name} が購入完了を記録している`);
  }
});

test('【重要】購入計測は昇格 PATCH が成功した後に呼ぶ', () => {
  const iPatch = CONFIRM.indexOf('Airtable update failed');
  const iMetric = CONFIRM.indexOf('recordPlusPurchase(');
  assert.ok(iPatch > 0 && iMetric > iPatch, 'PATCH 失敗の分岐より前に計測している');
});

test('【重要】購入計測の失敗で昇格を巻き戻さない', () => {
  const seg = CONFIRM.slice(CONFIRM.indexOf('recordPlusPurchase('));
  const around = CONFIRM.slice(CONFIRM.indexOf('購入完了の計測'), CONFIRM.indexOf('昇格完了'));
  assert.match(around, /try \{/);
  assert.match(around, /catch \(metricError\)/);
  assert.ok(!/return jsonResponse\(5\d\d/.test(seg.slice(0, 800)), '計測失敗で 5xx を返している');
});

test('【重要】orderKey は確定内容から作る（再送で同じ鍵になる）', () => {
  const seg = CONFIRM.slice(CONFIRM.indexOf('recordPlusPurchase('), CONFIRM.indexOf('昇格完了'));
  assert.match(seg, /orderKey:/);
  assert.match(seg, /recordId,/);
  // Date.now() や乱数を鍵に使わない（毎回違う鍵になって二重計上する）
  assert.ok(!/orderKey: \[[\s\S]{0,200}Date\.now\(\)/.test(seg), 'orderKey に現在時刻を使っている');
  assert.ok(!/orderKey:[\s\S]{0,200}Math\.random/.test(seg), 'orderKey に乱数を使っている');
});

test('【重要】決済開始は申込 Function（サーバー側）で記録する', () => {
  assert.match(APPLY, /recordPlusCheckoutStart\(/);
  // Premium Plus の申込だけを Plus のファネルへ数える
  assert.match(APPLY, /Premium Plus\/i\.test\(String\(productName/);
});

test('決済開始の計測失敗で申込処理を止めない', () => {
  assert.match(SERVER, /export async function recordPlusCheckoutStart/);
  const body = fnBody(SERVER, 'recordPlusCheckoutStart');
  assert.match(body, /catch/);
  assert.match(body, /return \{ counted: false, reason: 'record_failed' \}/);
});

test('【重要】source はサーバーの allow-list を通す（フォームの値をそのまま使わない）', () => {
  // ⚠️ この値は画面が `?from=` から拾ったもの＝**URL 由来**。誰でも付けられる。
  //    商品ページ内の導線（plus_page）を URL から名乗らせない。
  assert.match(fnBody(SERVER, 'recordPlusCheckoutStart'), /normalizeEntrySource\(source\)/);
  assert.ok(!/normalizeFunnelSource\(source\)/.test(fnBody(SERVER, 'recordPlusCheckoutStart')),
    '?from= が全 allow-list を受けている（plus_page を名乗れてしまう）');
});

test('【重要】決済開始は URL から plus_page を名乗れない', async () => {
  const { store, read } = memStore();
  await store.record({
    recordId: ID, event: FUNNEL_EVENT.CHECKOUT_START, nowMs: T0,
    userAgent: 'server', authenticated: true, source: normalizeEntrySource('plus_page'),
  });
  const v = read(FUNNEL_KEY.CHECKOUT, ID);
  assert.ok(!v.bySource || !v.bySource.plus_page, '商品ページ内が流入導線として保存されている');
  assert.ok(v.noSource && v.noSource.count >= 1, 'source なしとして数えていない');
  // 流入導線は従来どおり通る
  assert.equal(normalizeEntrySource('dashboard'), 'dashboard');
});

test('【重要】購入の帰属は流入導線だけを並べる（商品ページ内で退化させない）', () => {
  const rows = summarizePurchaseBySource([]);
  assert.deepEqual(rows.map((r) => r.source), ['dashboard', 'sanrenpuku'],
    '購入の帰属に商品ページ内が混じっている');
  // 買った人は全員が商品ページを通るので、並べても導線差が出ない。
  // 到達（分母）も作れないため「到達 0 なのに購入がある」行になる。
  assert.ok(!rows.some((r) => r.source === 'plus_page'));
  assert.match(PURCHASE_ENTRY_ONLY_NOTE, /流入導線だけ/);
  assert.match(PURCHASE_ENTRY_ONLY_NOTE, /0 件という意味ではありません/);
});

test('計測できないときは黙って 0 にしない', () => {
  for (const name of ['recordPlusCheckoutStart', 'recordPlusPurchase']) {
    assert.match(fnBody(SERVER, name), /measurement_unavailable/, `${name} が未計測を隠している`);
  }
});
