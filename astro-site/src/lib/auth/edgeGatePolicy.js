/**
 * edgeGatePolicy.js — EDGE_GATE_ENABLED の解決（PR-C 用の設計メモ / 純粋関数）
 *
 * PR-A ではロジックとテストだけを固定する。Edge Function 本体・環境変数読取は PR-C。
 * `if (!enabled) return next()` のような素通りは禁止。必ずこの関数で 3 値に解決する。
 *
 *   本番 (production):
 *     - 未設定            → fail-closed（全拒否）
 *     - "true"            → enabled（Cookie 検証）
 *     - "false"（緊急解除）→ pass-through（素通り）
 *     - それ以外          → fail-closed
 *
 *   Deploy Preview (deploy-preview) / その他 (dev 等):
 *     - "true"            → enabled
 *     - "false"           → pass-through
 *     - 未設定            → enabled（ゲート有効。本番同等の保護。素通りは明示 "false" のみ）
 *     - それ以外          → fail-closed
 *
 * 環境判定は呼び出し側が Netlify の CONTEXT（'production' / 'deploy-preview' / 'branch-deploy' / 'dev'）
 * を渡す。ここでは env を直接読まない。
 */

import { EDGE_GATE_MODE } from './constants.js';

/**
 * @param {{ context?: string, rawValue?: unknown }} input
 *   context: Netlify CONTEXT 相当（'production' で本番扱い、それ以外は非本番扱い）
 *   rawValue: EDGE_GATE_ENABLED の生値（未設定は undefined/null）
 * @returns {'enabled'|'pass-through'|'fail-closed'}
 */
export function resolveEdgeGateMode(input = {}) {
  const raw = input.rawValue;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  const isProduction = input.context === 'production';

  if (isProduction) {
    if (value === 'true') return EDGE_GATE_MODE.ENABLED;
    if (value === 'false') return EDGE_GATE_MODE.PASS_THROUGH;
    // 未設定・不正値はすべて安全側
    return EDGE_GATE_MODE.FAIL_CLOSED;
  }

  // 非本番（Deploy Preview / branch / dev）
  if (value === 'true') return EDGE_GATE_MODE.ENABLED;
  if (value === 'false') return EDGE_GATE_MODE.PASS_THROUGH;
  if (raw === undefined || raw === null || value === '') return EDGE_GATE_MODE.ENABLED;
  return EDGE_GATE_MODE.FAIL_CLOSED;
}
