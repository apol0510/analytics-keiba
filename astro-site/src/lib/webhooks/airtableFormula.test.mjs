/**
 * airtableFormula.test.mjs — filterByFormula への外部入力エスケープ。
 * formula injection（任意レコードへの PATCH）を遮断できていることを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formulaString, equalsFormula } from './airtableFormula.js';

test('通常のメールアドレスはそのままリテラル化される', () => {
  assert.equal(formulaString('a@example.test'), '"a@example.test"');
});

test('ダブルクォートはエスケープされ formula 構造を壊さない', () => {
  // 攻撃入力: リテラルを閉じて別条件を注入しようとする
  const attack = 'x@example.test") , {Email}) , OR(1, SEARCH("';
  const out = formulaString(attack);

  assert.ok(out.startsWith('"') && out.endsWith('"'));
  // 中身に「エスケープされていない "」が残っていないこと
  const inner = out.slice(1, -1);
  assert.ok(!/(^|[^\\])"/.test(inner), 'エスケープされていないダブルクォートが残っている');
});

test('バックスラッシュはエスケープされる（エスケープ自体の回避を防ぐ）', () => {
  assert.equal(formulaString('a\\"b'), '"a\\\\\\"b"');
});

test('制御文字・改行は除去される', () => {
  const out = formulaString('a\n\rb\tc\u0000d\u007f');
  assert.equal(out, '"abcd"');
});

test('null / undefined は空文字リテラルになる（undefined 文字列化を防ぐ）', () => {
  assert.equal(formulaString(null), '""');
  assert.equal(formulaString(undefined), '""');
});

test('equalsFormula は部分一致 SEARCH ではなく完全一致を使う', () => {
  const f = equalsFormula('Email', 'a@example.test');
  assert.equal(f, '{Email}="a@example.test"');
  assert.ok(!/SEARCH/i.test(f), 'SEARCH（部分一致）を使っている');
});

test('equalsFormula にも注入入力を渡せる（エスケープされる）', () => {
  const f = equalsFormula('Email', '"} , OR(1,1) , {Email}="');
  assert.ok(f.startsWith('{Email}="'));
  const inner = f.slice('{Email}="'.length, -1);
  assert.ok(!/(^|[^\\])"/.test(inner), 'エスケープされていないダブルクォートが残っている');
});
