// fixedMarketingStats.test.mjs — 固定マーケティング表示の代表値（MK 確定 2026-10-06）
// 正本 docs/spec.md 冒頭「固定マーケティング表示の代表値は 回収率 126% / 的中率 62%」
//
// 対象: トップ・カード・CTA・バナー・料金導線・無料ページ・Light / Premium 導線・ブログの CTA・共通レイアウト等に
//       ハードコードされている「代表値・平均値・訴求値」。
// 対象外: 日別・月別・年別・レース別など実データから都度計算する実績（src/lib/results/aiBetPoints.js が単一源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * 126% / 62% へ数字だけ置換すると記事内の数値が矛盾するため MK の内容判断待ち・progress に記録）は除く。
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

test('固定マーケティング回収率は 126%・的中率は 62%（同じカード・同じ行で両方そろう）', () => {
  const pair = '的中率62%、回収率126%を実現';
  assert.ok(read('src/layouts/BaseLayout.astro').includes(pair), 'BaseLayout の既定 description');
  const index = read('src/pages/index.astro');
  assert.equal(index.split(pair).length - 1, 2, 'トップの meta description と Hero');
  assert.match(index, /data-target="62" data-suffix="%"/);
  assert.match(index, /data-target="126" data-suffix="%"/);
  for (const p of ['src/pages/light-predictions.astro', 'src/pages/light-predictions-jra.astro']) {
    const s = read(p);
    assert.match(s, /metric-value">62%<\/div>\s*<div class="metric-label">平均的中率/, `${p}: 平均的中率`);
    assert.match(s, /metric-value">126%<\/div>\s*<div class="metric-label">平均回収率/, `${p}: 平均回収率`);
  }
  for (const p of ['src/pages/premium-predictions-funabashi.astro', 'src/pages/premium-predictions-urawa.astro',
    'src/pages/premium-prediction/nankan.astro']) {
    const s = read(p);
    assert.match(s, /📊 的中率62% 回収率126%/, `${p}: 実績訴求（Desktop）`);
    assert.match(s, /✅ 的中率62% 回収率126%/, `${p}: 実績訴求（リスト）`);
  }
  assert.match(read('src/pages/dashboard.astro'), /✅ 的中率62% 回収率126%/);
  const tech = read('src/pages/technology.astro');
  assert.match(tech, />62%<\/div>\s*<div[^>]*>総合精度/);
  assert.match(tech, />126%<\/div>\s*<div[^>]*>平均回収率/);
  // ブログのコース記事 CTA: バナー文言とカード（AIモデル精度・回収率）が同じ値
  const blogs = walk('src/pages/blog/course').filter((p) => read(p).includes('回収率126%を実現'));
  assert.ok(blogs.length >= 15, `ブログ CTA ${blogs.length} 件`);
  for (const p of blogs) {
    const s = read(p);
    assert.ok(s.includes(pair), `${p}: バナー`);
    if (/AIモデル精度/.test(s)) {
      assert.match(s, />62%<\/div>\s*<div[^>]*>AIモデル精度/, `${p}: AIモデル精度`);
      assert.match(s, />126%<\/div>\s*<div[^>]*>回収率/, `${p}: 回収率カード`);
    }
  }
  for (const p of ['src/pages/course.astro', ...walk('src/pages/blog/course')]) {
    const s = read(p);
    if (/trust-label">平均回収率/.test(s)) assert.match(s, /trust-value">126%<\/span>\s*<span class="trust-label">平均回収率/, `${p}: trust`);
  }
  const demo = read('src/pages/sanrenpuku-demo.astro');
  assert.match(demo, /perf-value">62%<\/div>\s*<div class="perf-label">的中率/);
  assert.match(demo, /perf-value">126%<\/div>\s*<div class="perf-label">平均回収率/);
  assert.match(read('src/pages/pro-demo.astro'), /的中率<\/div>\s*<div class="value">62%/);
  assert.match(read('src/pages/service-description.astro'), /的中率：<\/strong>約62%/);
});

test('固定値は小数表記にしない（カウントアップも 126% / 62% のまま整数で表示）', () => {
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
  assert.match(index, /\{yesterdayResults\.recoveryRate\}%/);
});

test('検証対象が空でない（走査漏れの防止）', () => {
  assert.ok(PUBLIC_UI.length > 100, `PUBLIC_UI ${PUBLIC_UI.length}`);
  assert.ok(PUBLIC_UI.some((p) => p.endsWith('light-predictions.astro')));
  assert.ok(PUBLIC_UI.some((p) => p.endsWith('BaseLayout.astro')));
});
