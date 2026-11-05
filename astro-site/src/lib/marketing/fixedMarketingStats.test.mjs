// fixedMarketingStats.test.mjs — 固定マーケティング表示の代表値（MK 確定 2026-10-06）
// 正本 docs/spec.md 冒頭「固定マーケティング表示の代表値は 回収率 73% / 的中率 70%」
// 2026-11-06: 固定の回収率は出さない。計算値は現金回収率と AI算定指標に分けて出す（src/lib/results/recoveryVisibility.js）。
//
// 対象: トップ・カード・CTA・バナー・料金導線・無料ページ・Light / Premium 導線・ブログの CTA・共通レイアウト等に
//       ハードコードされている「代表値・平均値・訴求値」。
// 対象外: 日別・月別・年別・レース別など実データから都度計算する実績（src/lib/results/aiBetPoints.js が単一源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_RECOVERY_LESSONS_PUBLIC, publicRate, RECOVERY_RATE_PUBLIC } from '../results/recoveryVisibility.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const p = join(dir, name);
    return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
  });
}

/**
 * 公開マーケティング UI。管理画面と、表示用ではない学習コンテンツ（数値どうしが連動した分析記事。
 * 73% / 70% へ数字だけ置換すると記事内の数値が矛盾するため MK の内容判断待ち・progress に記録）は除く。
 */
const PUBLIC_UI = [...walk('src/pages'), ...walk('src/components'), ...walk('src/layouts')]
  .filter((p) => p.endsWith('.astro'))
  .filter((p) => !/\/admin[/-]|\/admin\.astro|\/beginner\/|\/about\.astro$/.test(p));

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\/\/|\*).*$/gm, '');

test('公開マーケティング UI に旧固定 156% が残らない', () => {
  for (const p of PUBLIC_UI) {
    const s = strip(read(p));
    assert.doesNotMatch(s, /(?<![\d.])156(\.0)?\s*%|data-target="156"/, `${p}: 旧固定 156%`);
  }
});

test('公開マーケティング UI に旧固定 176% が残らない', () => {
  for (const p of PUBLIC_UI) assert.doesNotMatch(strip(read(p)), /(?<![\d.])176(\.0)?\s*%/, `${p}: 旧固定 176%`);
});

test('管理画面ニュースレター / メール配信テンプレートに旧固定回収率 156% / 176% が残らない', () => {
  const MAIL = ['src/pages/admin-newsletter-simple.astro', 'src/lib/email-templates.js',
    ...walk('netlify/functions').filter((p) => /\.(m?js)$/.test(p) && !/\.test\./.test(p))];
  for (const p of MAIL) {
    const s = strip(read(p));
    assert.doesNotMatch(s, /(?<![\d.])(156|176)(\.\d)?\s*%/, `${p}: 旧固定回収率`);
  }
  assert.doesNotMatch(read('src/pages/admin-newsletter-simple.astro'), /回収率73%/);
});

test('旧固定の代表値（87% / 87.3% / 72% / 78% / 89% / 203% / 265% / 平均回収率 120%）が訴求箇所に残らない', () => {
  const legacy = [
    /的中率\s*(<[^>]+>)?\s*(87|72|78)(\.\d)?%/,
    /回収率\s*(<[^>]+>)?\s*(203|176|156)(\.\d)?%/,
    /期待リターン\s*(<[^>]+>)?\s*265%/,
    /馬連率\s*約89%/,
    />\s*(87\.3|156\.0|203|265)%\s*</,
    /data-target="87\.3"/,
    /trust-value">120%</,
  ];
  for (const p of PUBLIC_UI) {
    const s = strip(read(p));
    for (const re of legacy) assert.doesNotMatch(s, re, `${p}: ${re}`);
  }
});

test('計算値の表示を戻しても、固定の 73% / 173% の成績は出さず、的中率 70% は残す', () => {
  assert.equal(RECOVERY_RATE_PUBLIC, true);
  assert.equal(publicRate(73), 73);
  const STATIC = walk('public').filter((p) => p.endsWith('.html'));
  for (const p of [...PUBLIC_UI, ...STATIC]) {
    const s = strip(read(p));
    assert.doesNotMatch(s, /回収率\s*(<[^>]+>)?\s*(73|173)\s*%|(73|173)%(<[^>]+>|\s)*(平均)?回収率|0\.73倍|data-target="73"|期待リターン/, `${p}: 回収率の成績`);
  }
  const pair = '的中率70%（全レース実測）';
  assert.ok(read('src/layouts/BaseLayout.astro').includes(pair), 'BaseLayout の既定 description');
  const index = read('src/pages/index.astro');
  assert.equal(index.split(pair).length - 1, 2, 'トップの meta description と Hero');
  assert.match(index, /data-target="70" data-suffix="%"/);
  for (const p of ['src/pages/light-predictions.astro', 'src/pages/light-predictions-jra.astro']) {
    assert.match(read(p), /metric-value">70%<\/div>\s*<div class="metric-label">平均的中率/, `${p}: 平均的中率`);
  }
  assert.match(read('src/pages/pro-demo.astro'), /的中率<\/div>\s*<div class="value">70%/);
  assert.match(read('src/pages/service-description.astro'), /的中率：<\/strong>約70%/);
});

test('193.9% などを前提に書いた入門講座は、本文を直すまで転送したままにする', () => {
  assert.equal(LEGACY_RECOVERY_LESSONS_PUBLIC, false);
  for (const n of ['01', '02', '04', '05', '06', '07']) {
    assert.match(read(`src/pages/beginner/lesson-${n}.astro`), /if \(!LEGACY_RECOVERY_LESSONS_PUBLIC\) return Astro\.redirect\('\/beginner\/', 302\);/);
  }
  assert.doesNotMatch(read('src/pages/beginner/lesson-03.astro'), /Astro\.redirect/);
});

test('固定値は小数表記にしない（カウントアップも 73% / 70% のまま整数で表示）', () => {
  // コース統計の表（例: 複勝率 62.9%）は対象外。訴求ラベル付きの値と data-target だけを見る
  for (const p of PUBLIC_UI) {
    const t = strip(read(p));
    assert.doesNotMatch(t, /(的中率|回収率|精度|リターン)[^<\d]{0,10}(<[^>]+>)?\s*(126|62)\.\d+\s*%/, `${p}: 小数表記`);
    assert.doesNotMatch(t, /data-target="(126|62)\.\d+"/, `${p}: data-target の小数`);
  }
  assert.match(read('src/layouts/BaseLayout.astro'), /Number\.isInteger\(end\)/);
  assert.match(read('src/pages/index.astro'), /Number\.isInteger\(r\)/);
});

test('動的な日別 / 月別 / 年別 / レース別の実績は固定値へ置換しない（単一源で都度計算）', () => {
  const DYNAMIC = [
    'src/pages/results-showcase/jra.astro', 'src/pages/results-showcase/nankan.astro',
    'src/pages/archive/jra/index.astro', 'src/pages/archive/jra/[year]/index.astro', 'src/pages/archive/jra/[year]/[month]/index.astro',
    'src/pages/archive/nankan/[year]/index.astro', 'src/pages/archive/nankan/[year]/[month]/index.astro',
    'src/components/HomeResultsShowcasePreview.astro', 'src/components/ResultsShowcaseBanner.astro',
  ];
  for (const p of DYNAMIC) {
    const s = strip(read(p));
    assert.doesNotMatch(s, /(?<![\d.{])(126|62)\s*%/, `${p}: 動的実績に固定値が入っている`);
  }
  for (const p of DYNAMIC.filter((x) => !x.includes('components/')).concat(['src/lib/archive-utils.js'])) {
    assert.match(read(p), /aiBetPoints\.js|resultsShowcase/, `${p}: 実績の単一源を使っていない`);
  }
  // トップの「昨日の的中結果」も単一源（固定値ではない）
  const index = read('src/pages/index.astro');
  assert.match(index, /summarizeAiDay\(latestResult\)/);
  assert.match(index, /summarizeAiDay\(latestJraResult\)/);
  assert.match(index, /publicRate\(yesterdayResults\.recoveryRate\) != null/);
});

test('検証対象が空でない（走査漏れの防止）', () => {
  assert.ok(PUBLIC_UI.length > 100, `PUBLIC_UI ${PUBLIC_UI.length}`);
  assert.ok(PUBLIC_UI.some((p) => p.endsWith('light-predictions.astro')));
  assert.ok(PUBLIC_UI.some((p) => p.endsWith('BaseLayout.astro')));
});
