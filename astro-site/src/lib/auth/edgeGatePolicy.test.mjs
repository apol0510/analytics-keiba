/**
 * edgeGatePolicy.test.mjs — EDGE_GATE_ENABLED 解決（PR-C 設計）のテーブル駆動テスト
 *   node --test src/lib/auth/edgeGatePolicy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEdgeGateMode } from './edgeGatePolicy.js';
import { EDGE_GATE_MODE } from './constants.js';

const CASES = [
  // [context, rawValue, 期待]
  // --- 本番 ---
  ['production', undefined, EDGE_GATE_MODE.FAIL_CLOSED], // 未設定 → fail closed
  ['production', null, EDGE_GATE_MODE.FAIL_CLOSED],
  ['production', '', EDGE_GATE_MODE.FAIL_CLOSED],
  ['production', 'true', EDGE_GATE_MODE.ENABLED],
  ['production', 'TRUE', EDGE_GATE_MODE.ENABLED],
  ['production', ' true ', EDGE_GATE_MODE.ENABLED],
  ['production', 'false', EDGE_GATE_MODE.PASS_THROUGH], // 緊急解除
  ['production', 'yes', EDGE_GATE_MODE.FAIL_CLOSED], // 不正値
  ['production', '1', EDGE_GATE_MODE.FAIL_CLOSED],
  // --- Deploy Preview（明示に従う / 未設定は enabled で固定） ---
  ['deploy-preview', 'true', EDGE_GATE_MODE.ENABLED],
  ['deploy-preview', 'false', EDGE_GATE_MODE.PASS_THROUGH],
  ['deploy-preview', undefined, EDGE_GATE_MODE.ENABLED],
  ['deploy-preview', '', EDGE_GATE_MODE.ENABLED],
  ['deploy-preview', 'garbage', EDGE_GATE_MODE.FAIL_CLOSED],
  // --- branch / dev（非本番扱い、Deploy Preview と同じ） ---
  ['branch-deploy', undefined, EDGE_GATE_MODE.ENABLED],
  ['dev', 'false', EDGE_GATE_MODE.PASS_THROUGH],
];

for (const [context, rawValue, expected] of CASES) {
  test(`resolveEdgeGateMode(context=${context}, raw=${JSON.stringify(rawValue)}) === ${expected}`, () => {
    assert.equal(resolveEdgeGateMode({ context, rawValue }), expected);
  });
}

test('引数なしでも例外なく fail-closed 側に倒れる（本番未指定・値なし = 非本番未設定 = enabled）', () => {
  // context 未指定は非本番扱い・値未設定 → enabled（安全側の定義に従う）
  assert.equal(resolveEdgeGateMode(), EDGE_GATE_MODE.ENABLED);
  // 単なる素通り（pass-through）には明示 false が必要
  assert.notEqual(resolveEdgeGateMode(), EDGE_GATE_MODE.PASS_THROUGH);
});
