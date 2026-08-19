import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeJoinKey,
  hasKnownPrefix,
  buildJoinIndex,
  joinRaceHorses,
  summarizeJoin,
} from './horseHistoryJoin.js';

const hist = (name, extra = {}) => ({ horseName: name, ...extra });
const idx = (...names) => buildJoinIndex({ horses: Object.fromEntries(names.map((n, i) => [`id${i}`, hist(n)])) });
const race = (...names) => names.map((n) => ({ horseName: n }));

// ─── 接頭辞の除去（結合キーのみ）───────────────────────────────

test('(地)ホース は結合キー上で ホース になる', () => {
  assert.equal(normalizeJoinKey('(地)ホース'), 'ホース');
  assert.equal(normalizeJoinKey('（地）ホース'), 'ホース');
  assert.equal(hasKnownPrefix('(地)ホース'), true);
});

test('(外)ホース は結合キー上で ホース になる', () => {
  assert.equal(normalizeJoinKey('(外)ホース'), 'ホース');
  assert.equal(normalizeJoinKey('（外）ホース'), 'ホース');
});

test('未知の括弧書きは外さない（想定外の文字列で別馬へ寄せない）', () => {
  assert.equal(normalizeJoinKey('(新)ホース'), '(新)ホース');
  assert.equal(hasKnownPrefix('(新)ホース'), false);
});

test('馬名の途中の括弧は外さない', () => {
  assert.equal(normalizeJoinKey('ホース(地)'), 'ホース(地)');
});

test('空・空白・非文字列は空キー', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(normalizeJoinKey(v), '');
  }
});

// ─── 完全一致を優先 ───────────────────────────────────────────

test('完全一致が最優先で使われる（via=exact）', () => {
  const r = joinRaceHorses(race('ホース'), idx('ホース'));
  assert.equal(r[0].matched, true);
  assert.equal(r[0].via, 'exact');
});

test('完全一致する馬がいるとき、正規化一致でその履歴を奪わない', () => {
  // 履歴には「ホース」1件だけ。レースには「ホース」と「(地)ホース」の2頭。
  const r = joinRaceHorses(race('ホース', '(地)ホース'), idx('ホース'));
  assert.equal(r[0].matched, true);
  assert.equal(r[0].via, 'exact');
  assert.equal(r[1].matched, false, '別馬へ誤結合してはいけない');
  assert.equal(r[1].reason, 'already-taken');
});

test('完全一致しない馬だけが正規化で救われる（via=normalized）', () => {
  const r = joinRaceHorses(race('(外)ホース', 'ウマ'), idx('ホース', 'ウマ'));
  assert.equal(r[0].matched, true);
  assert.equal(r[0].via, 'normalized');
  assert.equal(r[1].via, 'exact');
});

// ─── 衝突は結合しない（fail closed）─────────────────────────

test('正規化後にレース内で衝突したら、どちらも結合しない', () => {
  const r = joinRaceHorses(race('(地)ホース', '(外)ホース'), idx('ホース'));
  assert.deepEqual(r.map((x) => x.matched), [false, false]);
  assert.deepEqual(r.map((x) => x.reason), ['ambiguous-in-race', 'ambiguous-in-race']);
});

test('履歴側に同じ正規化キーが複数あるときは結合しない', () => {
  const r = joinRaceHorses(race('(地)ホース'), idx('ホース', '(外)ホース'));
  assert.equal(r[0].matched, false);
  assert.equal(r[0].reason, 'ambiguous-in-history');
});

test('候補が無いときは未照合（no-candidate）', () => {
  const r = joinRaceHorses(race('(地)ホース'), idx('ベツウマ'));
  assert.equal(r[0].matched, false);
  assert.equal(r[0].reason, 'no-candidate');
});

test('1頭が2つの履歴を取ることはない', () => {
  const index = idx('ホース');
  const r = joinRaceHorses(race('ホース', 'ホース'), index);
  assert.equal(r.filter((x) => x.matched).length, 1, '同じ履歴を2頭が使ってはいけない');
});

// ─── 壊れたデータ ─────────────────────────────────────────────

test('空馬名は常に未照合（empty-name）', () => {
  const r = joinRaceHorses([{ horseName: '' }, { horseName: '   ' }, {}], idx('ホース'));
  assert.deepEqual(r.map((x) => x.matched), [false, false, false]);
  assert.deepEqual(r.map((x) => x.reason), ['empty-name', 'empty-name', 'empty-name']);
});

test('空馬名が複数あっても衝突扱いにしない', () => {
  const r = joinRaceHorses([{ horseName: '' }, { horseName: '' }], idx('ホース'));
  for (const x of r) assert.equal(x.reason, 'empty-name');
});

test('履歴側の空馬名は索引に入らない', () => {
  const index = buildJoinIndex({ horses: { a: hist(''), b: hist('  '), c: hist('ホース') } });
  assert.equal(index.exact.size, 1);
  assert.equal(index.exact.has('ホース'), true);
});

test('履歴が空・不正でも落ちない', () => {
  for (const v of [null, undefined, {}, { horses: null }, 'x']) {
    const index = buildJoinIndex(v);
    const r = joinRaceHorses(race('ホース'), index);
    assert.equal(r[0].matched, false);
  }
  assert.deepEqual(joinRaceHorses(null, idx('ホース')), []);
});

// ─── 表示名は変更しない ───────────────────────────────────────

test('結合しても入力の馬名オブジェクトを書き換えない', () => {
  const horses = race('(地)ホース');
  const before = JSON.stringify(horses);
  joinRaceHorses(horses, idx('ホース'));
  assert.equal(JSON.stringify(horses), before, '表示用の馬名を変えてはいけない');
  assert.equal(horses[0].horseName, '(地)ホース');
});

// ─── 要約 ─────────────────────────────────────────────────────

test('summarizeJoin が照合率と fail closed 件数を返す', () => {
  const r = joinRaceHorses(
    race('ホース', '(地)ウマ', '(地)カブト', '(外)カブト', ''),
    idx('ホース', 'ウマ'),
  );
  const s = summarizeJoin(r);
  assert.equal(s.total, 5);
  assert.equal(s.matched, 2);
  assert.equal(s.failClosed, 2, 'カブト 2 頭は衝突で fail closed');
  assert.equal(s.byReason['ambiguous-in-race'], 2);
  assert.equal(s.byReason['empty-name'], 1);
  assert.ok(Math.abs(s.coverage - 0.4) < 1e-9);
});

// ─── 馬名の取り出し方を差し替えられる（ページ経路の差を吸収）───────

test('nameOf で horse.name 経路にも同じ規則を適用できる', () => {
  const horses = [{ name: '(地)ホース' }, { name: 'ウマ' }];
  const r = joinRaceHorses(horses, idx('ホース', 'ウマ'), { nameOf: (h) => h.name });
  assert.equal(r[0].matched, true);
  assert.equal(r[0].via, 'normalized');
  assert.equal(r[1].via, 'exact');
  assert.equal(horses[0].name, '(地)ホース', '表示名は変えない');
});

test('nameOf 未指定なら horseName を見る（既定の後方互換）', () => {
  const r = joinRaceHorses([{ name: 'ホース' }], idx('ホース'));
  assert.equal(r[0].matched, false, 'horseName が無ければ照合しない');
});
