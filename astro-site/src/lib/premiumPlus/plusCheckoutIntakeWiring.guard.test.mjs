/**
 * plusCheckoutIntakeWiring.guard.test.mjs — 決済開始の計測が**実際に発火する場所**に
 * 配線され続けることを強制する
 *   node --test src/lib/premiumPlus/plusCheckoutIntakeWiring.guard.test.mjs
 *
 * ## なぜ必要か（2026-08-17 に本番で発見した事故）
 *
 * `bank-transfer-application.js` には決済開始の計測が確かに書かれていた。
 * ところがその呼び出しは
 *
 *     if (!productName.includes('Premium Plus')) {   // ← Plus を除外するブロック
 *        ...
 *        if (/Premium Plus/i.test(productName)) {    // ← Plus だけを対象にする条件
 *          await recordPlusCheckoutStart(...)
 *        }
 *     }
 *
 * という**互いに排他な二重条件**の中にあり、**一度も実行され得なかった**。
 * 「関数もテストも存在し、grep でも見つかる」のに本番の記録は永久に 0 件になる。
 * 配線ガード（`premiumPlusPurchaseFunnel.test.mjs`）も「呼び出しが書いてあること」しか
 * 見ていなかったため素通りしていた。
 *
 * ここで固定するのは **到達可能性**（書いてあるか、ではなく、動くか）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isPremiumPlusProductName, buildSaleProductName } from './premiumPlusSaleDate.js';
import { createFunnelStore, FUNNEL_EVENT, FUNNEL_KEY, DEDUPE_MS } from './premiumPlusFunnelStore.js';
import { recordPlusCheckoutStart } from './premiumPlusFunnelServer.js';

const APPLY = readFileSync(
  new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url), 'utf8',
);

// ══════════════════════════════════════════════════════════════
//  到達可能性 — 排他条件の中に閉じ込められていないこと
// ══════════════════════════════════════════════════════════════

test('【重要】決済開始の計測は「Plus を除外するブロック」より前にある', () => {
  const iMetric = APPLY.indexOf('recordPlusCheckoutStart({');
  const iExclude = APPLY.indexOf('if (!isPremiumPlusProductName(productName)) {');
  assert.ok(iMetric > 0, '決済開始の計測が無い');
  assert.ok(iExclude > 0, 'Plus 除外ブロックの形が変わった（このガードを更新すること）');
  assert.ok(
    iMetric < iExclude,
    'Plus 限定の計測が「Plus 以外」のブロックの中にある＝永久に発火しない',
  );
});

test('【重要】Plus を除外するブロックの中に計測を書き戻していない', () => {
  const iExclude = APPLY.indexOf('if (!isPremiumPlusProductName(productName)) {');
  const tail = APPLY.slice(iExclude);
  assert.ok(
    !/recordPlusCheckoutStart\(\{/.test(tail),
    'Plus 以外のブロックの中で決済開始を計測している（発火しない）',
  );
});

test('【重要】recordId が確定してからだけ記録する（推測の id を作らない）', () => {
  const seg = APPLY.slice(APPLY.indexOf('決済開始の計測（Premium Plus のみ'), APPLY.indexOf('Airtable登録（Premium Plus以外'));
  assert.match(seg, /if \(plusCustomerRecordId\)/, 'recordId 未確定でも記録しようとしている');
  assert.match(seg, /recordId: plusCustomerRecordId/);
  // 引けなかったときは記録しない（フォームの email などで代用しない）
  assert.ok(!/recordId: email/.test(seg), 'email を recordId の代わりに使っている');
});

test('【重要】計測の失敗で申込を失敗扱い・rollback しない', () => {
  const seg = APPLY.slice(APPLY.indexOf('決済開始の計測（Premium Plus のみ'), APPLY.indexOf('Airtable登録（Premium Plus以外'));
  assert.match(seg, /try \{/);
  assert.match(seg, /catch \(metricError\)/);
  // 計測区間で申込を止める分岐を作らない
  assert.ok(!/return \{[\s\S]{0,200}statusCode: [45]\d\d/.test(seg), '計測失敗で 4xx/5xx を返している');
  assert.ok(!/throw /.test(seg), '計測区間で例外を投げている');
});

test('Plus 判定は単一源を使う（大小区別ありの includes を残さない）', () => {
  assert.ok(
    !/productName\.includes\('Premium Plus'\)/.test(APPLY),
    "大小を区別する productName.includes('Premium Plus') が残っている（表記揺れで分岐がねじれる）",
  );
});

// ══════════════════════════════════════════════════════════════
//  商品名判定の単一源
// ══════════════════════════════════════════════════════════════

test('Premium Plus の商品名を表記揺れごと拾う', () => {
  for (const name of [
    'Premium Plus (¥68,000)',
    buildSaleProductName('8月18日分', 68000),
    'premium plus',
    'PREMIUM PLUS 8月18日分 (¥68,000)',
    'Premium  Plus',
  ]) {
    assert.equal(isPremiumPlusProductName(name), true, `Plus と判定されない: ${name}`);
  }
});

test('Plus 以外を Plus と誤判定しない', () => {
  for (const name of [
    'Premium Annual (¥68,000/年)', 'Premium Lifetime', 'Light Monthly',
    'Premium Sanrenpuku', '', null, undefined,
  ]) {
    assert.equal(isPremiumPlusProductName(name), false, `誤って Plus と判定: ${name}`);
  }
});

// ══════════════════════════════════════════════════════════════
//  記録の中身 — 新規に recordId が確定した場合も既存と同じ契約
// ══════════════════════════════════════════════════════════════

function memRedis() {
  const db = new Map();
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  const cmd = async ([op, key, a, b]) => {
    if (op === 'HGET') return db.get(`${key}|${a}`) ?? null;
    if (op === 'HSET') { db.set(`${key}|${a}`, b); return 1; }
    if (op === 'HSETNX') { const k = `${key}|${a}`; if (db.has(k)) return 0; db.set(k, b); return 1; }
    if (op === 'HINCRBY') { const k = `${key}|${a}`; const n = num(db.get(k)) + Number(b); db.set(k, String(n)); return n; }
    return null;
  };
  const read = (key, id) => { const v = db.get(`${key}|${id}`); return v ? JSON.parse(v) : null; };
  return { cmd, read };
}

const ID = 'recNEWCUSTOMER001';
const T0 = Date.parse('2026-08-17T05:00:00Z');

test('recordId 確定後に呼べば、既存会員と同じ契約で記録される', async () => {
  const { cmd, read } = memRedis();
  const out = await recordPlusCheckoutStart({
    recordId: ID, redisCmd: cmd, nowMs: T0, source: 'sanrenpuku',
  });
  assert.equal(out.counted, true);
  const v = read(FUNNEL_KEY.CHECKOUT, ID);
  assert.equal(v.count, 1);
  assert.equal(v.bySource.sanrenpuku.count, 1, '導線が記録されていない');
});

test('【重要】再送しても二重計上しない（冪等）', async () => {
  const { cmd, read } = memRedis();
  await recordPlusCheckoutStart({ recordId: ID, redisCmd: cmd, nowMs: T0, source: 'dashboard' });
  const again = await recordPlusCheckoutStart({
    recordId: ID, redisCmd: cmd, nowMs: T0 + 1000, source: 'dashboard',
  });
  assert.equal(again.counted, false, '同じ申込の再送が 2 回数えられた');
  assert.equal(read(FUNNEL_KEY.CHECKOUT, ID).count, 1);

  // 重複除外の窓を越えた別の申込は数える
  const later = await recordPlusCheckoutStart({
    recordId: ID, redisCmd: cmd, nowMs: T0 + DEDUPE_MS + 1000, source: 'dashboard',
  });
  assert.equal(later.counted, true, '別日の再購入が数えられていない');
});

test('【重要】URL 由来の source は allow-list を通す（plus_page を名乗らせない）', async () => {
  const { cmd, read } = memRedis();
  await recordPlusCheckoutStart({ recordId: ID, redisCmd: cmd, nowMs: T0, source: 'plus_page' });
  const v = read(FUNNEL_KEY.CHECKOUT, ID);
  assert.ok(!v.bySource || !v.bySource.plus_page, '商品ページ内を流入導線として保存した');
  assert.equal(v.noSource.count, 1, '導線なしとして数えられていない');
});

test('計測不能でも例外にしない（申込を止めない）', async () => {
  const out = await recordPlusCheckoutStart({ recordId: ID, redisCmd: null, nowMs: T0 });
  assert.equal(out.counted, false);
  assert.equal(out.reason, 'measurement_unavailable');

  const broken = await recordPlusCheckoutStart({
    recordId: ID, nowMs: T0, redisCmd: async () => { throw new Error('redis down'); },
  });
  assert.equal(broken.counted, false, 'Redis 障害で counted:true になっている');
});

test('不正な recordId は記録しない', async () => {
  const { cmd } = memRedis();
  for (const bad of ['', 'not-a-record-id', null, undefined]) {
    // eslint-disable-next-line no-await-in-loop -- 順に確認する
    const out = await recordPlusCheckoutStart({ recordId: bad, redisCmd: cmd, nowMs: T0 });
    assert.equal(out.counted, false, `不正な recordId が記録された: ${bad}`);
  }
});

test('記録するのは決済開始だけ（購入完了を勝手に立てない）', async () => {
  const { cmd, read } = memRedis();
  await recordPlusCheckoutStart({ recordId: ID, redisCmd: cmd, nowMs: T0, source: 'dashboard' });
  assert.equal(read(FUNNEL_KEY.PURCHASE, ID), null, '申込だけで購入完了が立っている');
  assert.equal(FUNNEL_EVENT.CHECKOUT_START, 'checkout_start');
});

// ══════════════════════════════════════════════════════════════
//  他イベントの経路を壊していないこと
// ══════════════════════════════════════════════════════════════

test('決済開始はブラウザ API からは受け付けない（サーバー側専用のまま）', () => {
  const api = readFileSync(new URL('../../pages/api/pp-funnel.json.js', import.meta.url), 'utf8');
  const line = api.split('\n').find((l) => l.includes('ALLOWED_EVENTS'));
  assert.ok(line, 'ALLOWED_EVENTS が無い');
  assert.ok(
    !/CHECKOUT_START|PURCHASE/.test(line),
    '客が決済開始・購入完了を自称できるようになっている',
  );
});
