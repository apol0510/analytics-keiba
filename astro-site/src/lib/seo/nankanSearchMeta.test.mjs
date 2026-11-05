/**
 * 南関東競馬の検索語がタイトルと説明に残っていることを固定する。
 * 実績表示の文言は fixedMarketingStats.test.mjs が固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const VENUES = ['大井', '船橋', '川崎', '浦和'];

const titleOf = (page) => read(page).match(/title=(?:"|\{`)([^"`]*)/)?.[1] ?? '';

for (const page of ['src/pages/free-prediction/nankan.astro', 'src/pages/free/nankan.astro']) {
  test(`${page}: 南関東競馬と 4 場を title に含む`, () => {
    const title = titleOf(page);
    assert.match(title, /南関東競馬/);
    for (const v of VENUES) assert.ok(title.includes(v), v);
  });
}

test('トップ: title に 4 場、説明に南関東を含む（語順は seoTechnical.test.mjs が固定）', () => {
  const page = 'src/pages/index.astro';
  for (const v of VENUES) assert.ok(titleOf(page).includes(v), v);
  assert.match(read(page), /<BaseLayout title="[^"]*" description="[^"]*南関東4場/);
});

test('BaseLayout: 組織名の別表記を構造化データで示す', () => {
  const s = read('src/layouts/BaseLayout.astro');
  assert.match(s, /"@type": "Organization"/);
  assert.match(s, /"南関アナリティクス"/);
});
