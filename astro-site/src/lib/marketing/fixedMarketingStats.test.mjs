// fixedMarketingStats.test.mjs — 固定マーケティング表示の代表値（MK 確定 2026-10-06）
// 正本 docs/spec.md「固定マーケティング表示の代表値は 的中率 70%」「回収率の公式算定方式は未確定」
// 2026-11-06 MK 指示で回収率は一時非表示（src/lib/results/recoveryVisibility.js）。
// 再表示は新方式の実装と同じ PR で行う。#870 の revert では戻さない（73% / 173% が復活する）。
//
// 対象: トップ・カード・CTA・バナー・料金導線・無料ページ・Light / Premium 導線・ブログの CTA・共通レイアウト等に
//       ハードコードされている「代表値・平均値・訴求値」。
// 対象外: 日別・月別・年別・レース別など実データから都度計算する実績（src/lib/results/aiBetPoints.js が単一源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicRate, RECOVERY_RATE_PUBLIC } from '../results/recoveryVisibility.js';

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

test('回収率の一時非表示中は 73% / 173% の成績を出さず、的中率 70% は残す（2026-11-06 MK 指示）', () => {
  assert.equal(RECOVERY_RATE_PUBLIC, false);
  assert.equal(publicRate(73), null);
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

test('回収率を前提に書いた入門講座は非表示の間だけ転送し、スイッチで戻せる', () => {
  for (const n of ['01', '02', '04', '05', '06', '07']) {
    assert.match(read(`src/pages/beginner/lesson-${n}.astro`), /if \(!RECOVERY_RATE_PUBLIC\) return Astro\.redirect\('\/beginner\/', 302\);/);
  }
  assert.doesNotMatch(read('src/pages/beginner/lesson-03.astro'), /Astro\.redirect/);
});

test('非採用の回収率方式の名称・数値を公開面に出さない（docs/BET_POINT_LOGIC.md「回収率の算定方式の状態」）', () => {
  const BEGINNER = walk('src/pages/beginner').filter((p) => p.endsWith('.astro'));
  const STATIC = walk('public').filter((p) => p.endsWith('.html'));
  const NAMES = /現金回収率|AI選定回収率|AI算定指標|ak-select/;
  const RATES = /回収率\s*(<[^>]+>|[:：])?\s*(66\.8|76\.2|71\.8|66\.5|118\.6|127\.3)\s*%/;
  const BACKDOOR = /87,400|累計収支|TOTAL PROFIT/; // 120 レース × 1,000 円で回収率 173% と同じ意味になる
  for (const p of [...PUBLIC_UI, ...BEGINNER, ...STATIC]) {
    const s = strip(read(p));
    assert.doesNotMatch(s, NAMES, `${p}: 非採用の方式の名称`);
    assert.doesNotMatch(s, RATES, `${p}: 非採用の回収率`);
    assert.doesNotMatch(s, BACKDOOR, `${p}: 回収率に換算できる収支の訴求`);
  }
  // 入門講座は転送中で本文に例があるので、公開中のページだけ見る
  for (const p of [...PUBLIC_UI, ...STATIC]) {
    assert.doesNotMatch(strip(read(p)), /回収率\s*100%\s*(超|以上|を超)|回収率\s*150%|回収率\s*(211\.5|193\.7)\s*%/, `${p}: 回収率の数値目標`);
  }
});

test('旧方式のシミュレーションを公開面へ接続しない', () => {
  const SURFACES = [...PUBLIC_UI, ...walk('src/pages').filter((p) => p.endsWith('.astro')),
    ...walk('netlify/functions').filter((p) => /\.m?js$/.test(p)), 'src/lib/email-templates.js'];
  for (const p of SURFACES) assert.doesNotMatch(read(p), /from\s+['"][^'"]*legacySimulation/, `${p}: legacySimulation の import`);
});

test('正本が公式の回収率を未確定とし、revert や true への切替を再表示の手順にしない', () => {
  const spec = readFileSync(join(root, '..', 'docs', 'spec.md'), 'utf8');
  assert.match(spec, /回収率の公式算定方式は未確定/);
  assert.doesNotMatch(spec, /PR を revert して戻す/);
  assert.doesNotMatch(spec, /代表値は 回収率 73%|\*\*回収率 73% \/ 的中率 70%\*\*/);
  assert.match(read('docs/BET_POINT_LOGIC.md'), /## 回収率の算定方式の状態/);
  assert.doesNotMatch(read('src/lib/results/recoveryVisibility.js'), /再表示するときは true にする/);
});

test('固定値は小数表記にしない（カウントアップも整数で表示）', () => {
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
