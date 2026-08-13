/**
 * premiumPlusFunnelAdmin.test.mjs — 管理画面が
 * **未計測を 0 と言わず / 一覧を往復で潰さず / 名指しで探せる**こと
 *   node --test src/lib/premiumPlus/premiumPlusFunnelAdmin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFunnelStore, describeFunnelCell, describeFunnelRow, funnelJst,
  FUNNEL_EVENT, READ_CHUNK,
} from './premiumPlusFunnelStore.js';
import {
  buildLookupFormula, normalizeSearchQuery, escapeFormulaText, looksLikeEmail,
  MIN_QUERY_LENGTH,
} from './premiumPlusAdminSearch.js';

const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const T0 = Date.parse('2026-08-13T04:00:00Z');
const A = 'recAAAAAAAAAAAAAA';
const B = 'recBBBBBBBBBBBBBB';

function fakeRedis(counter) {
  const store = new Map();
  return async (args) => {
    if (counter) counter.calls += 1;
    const [op, key, field, value] = args;
    const h = () => store.get(key) || store.set(key, new Map()).get(key);
    if (op === 'HSET') { h().set(field, value); return 1; }
    if (op === 'HSETNX') { if (h().has(field)) return 0; h().set(field, value); return 1; }
    if (op === 'HGET') { const m = store.get(key); return m ? (m.get(field) ?? null) : null; }
    if (op === 'HMGET') return args.slice(2).map((f) => (store.get(key)?.get(f) ?? null));
    throw new Error(`unexpected op ${op}`);
  };
}

// ── 「未確認」と「0 回」を混ぜない ────────────────────────────
test('【重要】記録が無い人は「未確認」。0 回とは書かない', () => {
  const c = describeFunnelCell(null, { available: true, startedAtMs: T0 });
  assert.equal(c.text, '未確認');
  assert.equal(c.measured, false);
  assert.match(c.note, /確認できません/);
  assert.doesNotMatch(c.text, /0/);
});

test('【重要】計測開始より前は「確認できない」と明記する', () => {
  const c = describeFunnelCell({ count: null }, { available: true, startedAtMs: T0 });
  assert.match(c.note, new RegExp(funnelJst(T0)), '計測開始時刻が書かれていない');
  assert.match(c.note, /それ以前に見たかどうかは確認できません/);
});

test('【重要】計測記録が 1 件も無いときも「確認できない」と言う', () => {
  const c = describeFunnelCell(null, { available: true, startedAtMs: null });
  assert.match(c.note, /過去に見たかどうかは確認できません/);
});

test('【重要】読み取れないときは「未確認」（0 回にしない）', () => {
  const row = describeFunnelRow(null, { available: false });
  assert.equal(row.available, false);
  assert.equal(row.cta.text, '未確認');
  assert.match(row.cta.note, /0 回という意味ではありません/);
  assert.equal(row.anyMeasured, false);
});

test('記録がある人は回数と初回・最終を出す', () => {
  const c = describeFunnelCell({ count: 3, firstAtMs: T0, lastAtMs: T0 + 86400000 }, { available: true, startedAtMs: T0 });
  assert.equal(c.text, '3 回');
  assert.equal(c.measured, true);
  assert.match(c.note, /初回 2026-08-13 13:00/); // JST 表記
});

// ── 一覧のまとめ読み ───────────────────────────────────────
test('【重要】一覧は行数ぶん往復しない（種別ごとにまとめて読む）', async () => {
  const counter = { calls: 0 };
  const store = createFunnelStore({ redisCmd: fakeRedis(counter) });
  await store.record({ recordId: A, event: FUNNEL_EVENT.CTA_VIEW, nowMs: T0, userAgent: UA, authenticated: true });
  counter.calls = 0;

  const ids = Array.from({ length: 50 }, (_, i) => `rec${String(i).padStart(14, '0')}`).concat([A, B]);
  const out = await store.readMany({ recordIds: ids });
  assert.equal(out.available, true);
  // META 1 + 種別 3 = 4 回（52 件でも変わらない）
  assert.equal(counter.calls, 4, `往復が多すぎる: ${counter.calls}`);
  assert.equal(out.rows.get(A).cta.count, 1);
  assert.equal(out.rows.get(B).cta.count, null, '記録が無い人を 0 にしている');
});

test('まとめ読みは件数が多いと分割する（1 コマンドを肥大させない）', async () => {
  const counter = { calls: 0 };
  const store = createFunnelStore({ redisCmd: fakeRedis(counter) });
  const ids = Array.from({ length: READ_CHUNK * 2 + 1 }, (_, i) => `rec${String(i).padStart(14, '0')}`);
  await store.readMany({ recordIds: ids });
  // META 1 + 3 チャンク × 3 種別 = 10
  assert.equal(counter.calls, 10);
});

test('まとめ読みが落ちたら available:false（全員 0 回にしない）', async () => {
  const store = createFunnelStore({ redisCmd: async () => { throw new Error('down'); } });
  const out = await store.readMany({ recordIds: [A] });
  assert.equal(out.available, false);
  assert.equal(out.rows, null);
});

test('形式外の recordId はまとめ読みの鍵にしない', async () => {
  const store = createFunnelStore({ redisCmd: fakeRedis() });
  const out = await store.readMany({ recordIds: ['', null, 'abc', "rec'; DROP"] });
  assert.equal(out.available, true);
  assert.equal(out.rows.size, 0);
});

// ── 個別検索（Daniel / 0510apolone / tori）──────────────────
test('【重要】氏名の一部・アドレスの一部で引ける', () => {
  for (const q of ['Daniel', '0510apolone', 'tori']) {
    const b = buildLookupFormula(q);
    assert.equal(b.ok, true, `検索できない: ${q}`);
    assert.equal(b.exactEmail, false);
    // Email と 氏名 の両方を見る
    assert.match(b.formula, /FIND\('.+', LOWER\(\{Email\} & ''\)\)/);
    assert.match(b.formula, /FIND\('.+', LOWER\(\{氏名\} & ''\)\)/);
    // 大文字小文字を無視するため小文字化して比較する
    assert.ok(b.formula.includes(q.toLowerCase()), `検索語が式に入っていない: ${q}`);
  }
});

test('完全なアドレスは完全一致で引く（同姓同名を巻き込まない）', () => {
  const b = buildLookupFormula('Apolone_BKM@Yahoo.co.jp');
  assert.equal(b.exactEmail, true);
  assert.equal(b.formula, "LOWER(TRIM({Email})) = 'apolone_bkm@yahoo.co.jp'");
  assert.equal(looksLikeEmail('apolone_bkm@yahoo.co.jp'), true);
  assert.equal(looksLikeEmail('0510apolone'), false);
});

test('短すぎる語・空は実行しない（全件に近い一致を出さない）', () => {
  assert.equal(buildLookupFormula('').ok, false);
  assert.equal(buildLookupFormula('   ').reason, 'empty');
  assert.equal(buildLookupFormula('a').reason, 'too_short');
  assert.equal(normalizeSearchQuery('　あ　').reason, 'too_short');
  assert.equal(MIN_QUERY_LENGTH >= 2, true);
});

test('【重要】検索語で formula を壊さない（式が壊れると全件一致にも 0 件にも化ける）', () => {
  assert.equal(escapeFormulaText("O'Brien"), "O\\'Brien");
  assert.equal(escapeFormulaText('back\\slash'), 'back\\\\slash');
  const b = buildLookupFormula("O'Brien");
  assert.equal(b.ok, true);
  assert.ok(b.formula.includes("o\\'brien"), '検索語のクォートがエスケープされていない');
  // 文字列リテラルが閉じていること（エスケープを除いたクォートが偶数）
  const quotes = (b.formula.replace(/\\'/g, '').match(/'/g) || []).length;
  assert.equal(quotes % 2, 0, `式が閉じていない: ${b.formula}`);
});
