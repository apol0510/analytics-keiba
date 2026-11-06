import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIMULATED_RATE_LABEL, SIMULATED_RATE_NOTE_SHORT, SIMULATED_CARD_NOTE, SIMULATED_METHOD_PATH, SIMULATED_PARAMS, simulatedRateOf, simulatedMonthRate } from './simulatedRateDisplay.js';
import { summarizeSimulationV2 } from './simulatedRecoveryV2.js';
import { RECOVERY_RATE_PUBLIC } from './recoveryVisibility.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const walk = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const p = join(dir, n);
  return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
});
const SURFACES = [...walk('src/pages'), ...walk('src/components'), ...walk('src/layouts')].filter((p) => p.endsWith('.astro'));

test('名称と説明が事後の試算であることを示す', () => {
  assert.match(SIMULATED_RATE_LABEL, /事後シミュレーション/);
  assert.doesNotMatch(SIMULATED_RATE_LABEL, /回収率/);
  assert.match(SIMULATED_RATE_NOTE_SHORT, /実際の購入の回収率ではありません/);
});

test('非採用の値が出るスイッチは閉じたまま', () => {
  assert.equal(RECOVERY_RATE_PUBLIC, false);
});

test('値は v2 の計算そのもので、上書きしない', () => {
  const day = { date: '2026-01-01', totalRaces: 2, races: [{ isHit: true, umatan: { payout: 20000 } }, { isHit: false }] };
  assert.equal(simulatedRateOf([day]), summarizeSimulationV2([day]).weightedRate);
  assert.equal(simulatedRateOf([]), null);
  assert.equal(simulatedRateOf([day]), 294.1);
});

test('数値を出す画面は名称と説明を同じファイルに持つ', () => {
  const users = SURFACES.filter((p) => /simulatedRate\b|simulatedRateOf|simulatedMonthRate/.test(read(p)));
  assert.equal(users.length, 6, `接続先 ${users.join(', ')}`);
  for (const p of users) {
    assert.match(read(p), /<SimulatedCardNote\b|SIMULATED_RATE_NOTE_SHORT/, `${p}: 説明なしの表示`);
  }
});

test('画面は v2 を直接使わず、title・meta に数値を入れず、利益の色を付けない', () => {
  for (const p of SURFACES) {
    const s = read(p);
    assert.doesNotMatch(s, /simulatedRecoveryV2/, `${p}: 直接 import`);
    for (const line of s.split('\n')) {
      if (/pageDesc|pageDescription|pageTitle|description=|<title|og:|ld\+json/.test(line)) {
        assert.doesNotMatch(line, /[sS]imulated/, `${p}: title / meta に算定値`);
      }
      if (/simulatedRate/.test(line)) assert.doesNotMatch(line, /profit|回収率/, `${p}: ${line.trim()}`);
    }
  }
});

const MONTH_CARD_PAGES = [
  'src/pages/archive/jra/index.astro', 'src/pages/archive/jra/[year]/index.astro', 'src/pages/archive/jra/[year]/[month]/index.astro',
  'src/pages/archive/nankan/[year]/index.astro', 'src/pages/archive/nankan/[year]/[month]/index.astro',
];

test('月別カードは的中率の隣に「回収率（試算）」を出す（2026-11-06 MK 確定）', () => {
  for (const p of MONTH_CARD_PAGES) {
    const s = read(p);
    assert.match(s, /回収率<span class="sim-suffix">（試算）<\/span>/, `${p}: 見出し`);
    assert.match(s, /\.sim-suffix \{ font-size: 0\.72em; \}/, `${p}: 小さい文字`);
    assert.match(s, /<SimulatedCardNote \/>/, `${p}: 注記`);
    const sim = s.indexOf('回収率<span class="sim-suffix">');
    const hit = s.lastIndexOf('的中率</div>', sim);
    assert.ok(hit >= 0 && hit < sim && sim - hit < 400, `${p}: 的中率の隣ではない`);
    assert.match(s, /simulatedMonthRate\(/, `${p}: 当該月の値を使っていない`);
  }
});

test('見出しの「回収率」は必ず（試算）付きで、値は当該月の v2 の計算', () => {
  const day = (date, payout) => ({ date, totalRaces: 1, races: [{ isHit: true, umatan: { payout } }] });
  assert.equal(simulatedMonthRate([day('2026-01-01', 1500)]), '150.0');
  assert.equal(simulatedMonthRate([day('2026-01-01', 1500)]), summarizeSimulationV2([day('2026-01-01', 1500)]).weightedRate.toFixed(1));
  assert.equal(simulatedMonthRate([]), null);
  for (const p of MONTH_CARD_PAGES) {
    assert.doesNotMatch(read(p), /simulated[^\n]*\n[^\n]*label">回収率<\/div>/i, `${p}: （試算）なし`);
  }
});

test('カードの注記と算定方法のページ', () => {
  assert.equal(SIMULATED_CARD_NOTE, '※ 過去の払戻をもとに、結果確定後に想定点数を設定した試算です。実際の購入成績とは異なります。');
  assert.equal(SIMULATED_METHOD_PATH, '/archive/simulation-method/');
  assert.match(read('src/components/SimulatedCardNote.astro'), /算定方法を見る/);
  const page = read('src/pages/archive/simulation-method.astro');
  assert.match(page, /SIMULATED_PARAMS/);
  assert.match(page, /実際に購入した場合の回収率ではなく/);
  assert.match(page, /全組より少なく/);
  assert.deepEqual([...SIMULATED_PARAMS.tiers], [10, 18, 26, 34]);
  assert.equal(SIMULATED_PARAMS.floorPercent, 125);
});

test('入口ページと索引・年別に独立した算定値を出さない（2026-11-06 MK 指示）', () => {
  const ENTRY = ['src/components/HomeResultsShowcasePreview.astro', 'src/pages/index.astro', 'src/pages/results-showcase/jra.astro', 'src/pages/results-showcase/nankan.astro'];
  for (const p of ENTRY) assert.doesNotMatch(read(p), /simulated|事後シミュレーション|SimulatedRate/i, p);
  for (const p of ['src/pages/archive/jra/index.astro', 'src/pages/archive/nankan/index.astro', 'src/pages/archive/jra/[year]/index.astro', 'src/pages/archive/nankan/[year]/index.astro']) {
    assert.doesNotMatch(read(p), /<SimulatedRate\b|simulatedRateOf|事後シミュレーション/, p);
  }
});

test('メールと配信文面に算定値を入れない', () => {
  for (const p of [...walk('netlify/functions'), ...walk('src/lib/marketing'), ...walk('src/lib/newsletter')].filter((x) => /\.m?js$/.test(x) && !/\.test\./.test(x))) {
    assert.doesNotMatch(read(p), /simulatedRate/, `${p}: 配信に算定値`);
  }
});
