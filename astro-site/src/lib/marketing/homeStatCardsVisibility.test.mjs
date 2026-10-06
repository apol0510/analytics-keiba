// homeStatCardsVisibility.test.mjs — トップの 4 つの実績カード（62% / 126% / 10,000+ / 50+）が JS に依存せず見えること
// 原因: BaseLayout が DOMContentLoaded で .stats-card を opacity:0 にし、IntersectionObserver でだけ 1 に戻していた。
//       非表示タブ・prerender・クローラ・スクリプト失敗では IO / rAF が走らず、カードが opacity:0・「0%」のまま残った。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('BaseLayout のフェードイン（opacity:0 で隠す対象）に .stats-card を含めない', () => {
  const s = read('src/layouts/BaseLayout.astro');
  const m = s.match(/querySelectorAll\(([^)]*)\)\.forEach\(el => \{\s*el\.style\.opacity = '0'/);
  assert.ok(m, 'フェードイン対象のセレクタが見つからない');
  assert.doesNotMatch(m[1], /stats-card/);
});

test('トップの実績カードは SSR で最終値を出す（JS 前・JS 失敗時も 0% にならない）', () => {
  const s = read('src/pages/index.astro');
  for (const [t, suf, v] of [['62', '%', '62%'], ['126', '%', '126%'], ['10000', '\\+', '10,000\\+'], ['50', '\\+', '50\\+']]) {
    assert.match(s, new RegExp(`data-target="${t}" data-suffix="${suf}"[^>]*>\\s*${v}\\s*</div>`), `${t}: SSR 値`);
  }
  assert.doesNotMatch(s, /class="stats-number"[^>]*>\s*0[%+]\s*</);
});

test('カウントアップは表示中のタブでだけ始める（非表示では rAF が止まり途中値で固まる）', () => {
  assert.match(read('src/pages/index.astro'), /isIntersecting&&!e\.target\.hasAttribute\("data-animated"\)&&document\.visibilityState==="visible"/);
  assert.match(read('src/layouts/BaseLayout.astro'), /isIntersecting && !entry\.target\.hasAttribute\('data-animated'\) && document\.visibilityState === 'visible'/);
});
