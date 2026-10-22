import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PUBLIC_JS_VERSION, publicJsSrc } from './publicJsVersion.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

test('版は public/js の実ファイルの sha256 先頭 10 桁と一致する（中身を変えたら版も更新）', () => {
  for (const [name, v] of Object.entries(PUBLIC_JS_VERSION)) {
    const hash = createHash('sha256').update(readFileSync(`${root}public/js/${name}.js`)).digest('hex').slice(0, 10);
    assert.equal(v, hash, `public/js/${name}.js changed: set PUBLIC_JS_VERSION['${name}'] = '${hash}'`);
  }
});

test('publicJsSrc は ?v= 付きの URL を返し、未登録名は例外', () => {
  assert.equal(publicJsSrc('funnel-analytics'), `/js/funnel-analytics.js?v=${PUBLIC_JS_VERSION['funnel-analytics']}`);
  assert.throws(() => publicJsSrc('nope'));
});

test('ページは /js/*.js を版なしの固定 URL で読み込まない', () => {
  for (const p of ['src/layouts/BaseLayout.astro', 'src/pages/premium-plus-v2.astro']) {
    const src = read(p);
    assert.doesNotMatch(src, /src="\/js\/[a-z-]+\.js"/, `${p} loads /js/*.js without ?v=`);
  }
});

test('/js/* は長期キャッシュにしない（長期は hash 付きの /_astro/* だけ）', () => {
  const toml = read('netlify.toml');
  assert.doesNotMatch(toml, /for = "\/\*\.js"/);
  assert.doesNotMatch(toml, /for = "\/\*\.css"/);
  assert.match(toml, /for = "\/js\/\*"[\s\S]*?Cache-Control = "public, max-age=300, must-revalidate"/);
  assert.match(toml, /for = "\/_astro\/\*"[\s\S]*?Cache-Control = "public, max-age=31536000, immutable"/);
});
