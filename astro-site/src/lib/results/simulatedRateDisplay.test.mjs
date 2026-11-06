import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIMULATED_RATE_LABEL, SIMULATED_RATE_NOTE, SIMULATED_RATE_NOTE_SHORT, simulatedRateOf, simulatedRateSummary } from './simulatedRateDisplay.js';
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
  assert.match(SIMULATED_RATE_NOTE, /結果確定後/);
  assert.match(SIMULATED_RATE_NOTE, /実際に購入した場合の回収率ではなく/);
  assert.match(SIMULATED_RATE_NOTE, /表示の購入点数とも異なります/);
  assert.match(SIMULATED_RATE_NOTE, /将来の結果を保証するものではありません/);
  assert.match(SIMULATED_RATE_NOTE_SHORT, /実際の購入の回収率ではありません/);
});

test('非採用の値が出るスイッチは閉じたまま', () => {
  assert.equal(RECOVERY_RATE_PUBLIC, false);
});

test('値は v2 の計算そのもので、上書きしない', () => {
  const day = { date: '2026-01-01', totalRaces: 2, races: [{ isHit: true, umatan: { payout: 20000 } }, { isHit: false }] };
  assert.equal(simulatedRateOf([day]), summarizeSimulationV2([day]).weightedRate);
  assert.equal(simulatedRateOf([]), null);
  assert.equal(simulatedRateSummary([]), null);
  assert.equal(simulatedRateSummary([day]).overall, 294.1);
});

test('数値を出す画面は名称と説明を同じファイルに持つ', () => {
  const users = SURFACES.filter((p) => /simulatedRate\b|simulatedRateOf|simulatedRateSummary/.test(read(p)));
  assert.ok(users.length >= 10, `接続先 ${users.length}`);
  for (const p of users) {
    assert.match(read(p), /<SimulatedRate\b|SIMULATED_RATE_NOTE_SHORT/, `${p}: 説明なしの表示`);
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

test('メールと配信文面に算定値を入れない', () => {
  for (const p of [...walk('netlify/functions'), ...walk('src/lib/marketing'), ...walk('src/lib/newsletter')].filter((x) => /\.m?js$/.test(x) && !/\.test\./.test(x))) {
    assert.doesNotMatch(read(p), /simulatedRate/, `${p}: 配信に算定値`);
  }
});
