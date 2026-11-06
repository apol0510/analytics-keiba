import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiEvaluationIndex, AI_EVALUATION_BASE } from './aiEvaluationIndex.js';

const race = (gap) => [{ role: '本命', pt: 50 + gap }, { role: '対抗', pt: 50 }, { role: '単穴', pt: 40 }];

test('評価差が中央値のレースは基準の 150、上位 25% の水準は 160', () => {
  assert.equal(aiEvaluationIndex(race(13), { cat: 'nankan' }), AI_EVALUATION_BASE);
  assert.equal(aiEvaluationIndex(race(22), { cat: 'nankan' }), 160);
  assert.equal(aiEvaluationIndex(race(7), { cat: 'jra' }), AI_EVALUATION_BASE);
  assert.equal(aiEvaluationIndex(race(17), { cat: 'jra' }), 160);
});

test('120〜180 に収め、本命がいなければ null', () => {
  assert.equal(aiEvaluationIndex(race(500), { cat: 'jra' }), 180);
  assert.equal(aiEvaluationIndex(race(-500), { cat: 'jra' }), 120);
  assert.equal(aiEvaluationIndex([{ role: '対抗', pt: 10 }]), null);
});

test('入力は馬の評価だけで、結果の項目を変えても値が変わらない', () => {
  const horses = race(13);
  const withResult = horses.map((h) => ({ ...h, payout: 99999, isHit: true, odds: 1.1 }));
  assert.equal(aiEvaluationIndex(withResult), aiEvaluationIndex(horses));
  const src = readFileSync(new URL('./aiEvaluationIndex.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /payout|isHit|odds|legacySimulation/);
});
