/**
 * 旧 /prediction/[slug] は有料の馬単買い目を認可なしで表示していた（2026-10-03 本番で検出）。
 * 予想データを読み込まず、無料予想への 301 か 404 だけを返すことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const page = readFileSync(`${ROOT}src/pages/prediction/[slug].astro`, 'utf8');
const code = page.replace(/\/\*\*[\s\S]*?\*\//, '');

test('/prediction/[slug] は予想データ・買い目を読まない（有料内容を出さない）', () => {
  for (const banned of ['readFileSync', 'existsSync', 'src/data', 'bettingLines', 'AIBettingSection', 'BaseLayout', 'horses']) {
    assert.equal(code.includes(banned), false, banned);
  }
});

test('旧 URL は同じ日付の無料予想へ 301・それ以外は 404', () => {
  assert.match(code, /Astro\.redirect\(to, 301\)/);
  assert.match(code, /status: 404/);
  assert.match(code, /\^\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)-\(ooi\|kawasaki\|funabashi\|urawa\)\$/);
  assert.match(code, /`\/free-prediction\/nankan\/\$\{m\[1\]\}\/`/);
});
