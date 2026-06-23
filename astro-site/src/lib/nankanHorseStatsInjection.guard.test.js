/**
 * nankanHorseStatsInjection.guard.test.js (analytics-keiba)
 *
 * 南関 horseStats 近走 fallback の「配線が外れる退行」を静的に検知する guard（Node標準 assert）。
 * getDisplayRecentRacesForNankan が horseStats を採用できるのは、各ページ/アダプタが
 * horse.horseStatsNankan を注入している前提。注入呼び出しが削除されると resolver の
 * horseStats 分岐は無音で死ぬ（racebook 4走へ退行）ため、注入サイトの存在を固定する。
 *
 * 重い Astro レンダーは行わず、ソースの静的 import/呼び出し確認 + resolver 分岐の存在確認のみ。
 *
 * 実行: node src/lib/nankanHorseStatsInjection.guard.test.js （astro-site 直下から）
 */
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const read = (rel) => readFileSync(join(process.cwd(), rel), 'utf-8');

// free / premium: pickLatestNankanVenuesAndAdapt が horseStats を注入する。
t('adaptLatestPrediction が injectHorseStatsNankan を注入（free/premium経路）', () => {
  const src = read('src/lib/adaptLatestPrediction.js');
  assert.ok(/injectHorseStatsNankan/.test(src), 'adaptLatestPrediction.js から injectHorseStatsNankan 注入が消えている');
});

// light: light-predictions.astro が直接 horseStats を注入する。
t('light-predictions.astro が injectHorseStatsNankan を注入（light経路）', () => {
  const src = read('src/pages/light-predictions.astro');
  assert.ok(/injectHorseStatsNankan/.test(src), 'light-predictions.astro から injectHorseStatsNankan 注入が消えている');
});

// resolver: horseStats 分岐（horseStatsNankan.recentRacesDetailed）が存在し、legacy より前にある。
t('resolver に horseStats 分岐が存在し legacy(recentRaces素通し)より前にある', () => {
  const src = read('src/lib/getDisplayRecentRacesForNankan.js');
  assert.ok(/horseStatsNankan/.test(src) && /recentRacesDetailed/.test(src), 'resolver の horseStats 参照が消えている');
  const idxHs = src.indexOf('horseStatsRecentRacesNankan(horse)');
  const idxLegacy = src.indexOf('Array.isArray(horse.recentRaces)');
  assert.ok(idxHs > -1, 'horseStats fallback 呼び出しが消えている');
  assert.ok(idxLegacy > -1, 'legacy 素通しが見つからない');
  assert.ok(idxHs < idxLegacy, 'horseStats fallback が legacy 素通しより後ろにある（順序退行）');
});

console.log(`\nnankanHorseStatsInjection.guard (AK): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
