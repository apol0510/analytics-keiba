/**
 * originPolicy.test.mjs — refresh-session の Origin 認可（本番 fail-closed）
 *   node --test src/lib/auth/originPolicy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideRefreshOrigin,
  isProductionContext,
  ORIGIN_DECISION,
} from './originPolicy.js';

const PROD_ORIGIN = 'https://analytics.keiba.link';

// 1. production + 正しい Origin → 続行
test('#1 production + 正しい Origin → allow', () => {
  assert.equal(
    decideRefreshOrigin({ origin: PROD_ORIGIN, context: 'production' }),
    ORIGIN_DECISION.ALLOW,
  );
});

// 2. production + 不正 Origin → 403
test('#2 production + 不正 Origin → deny', () => {
  assert.equal(
    decideRefreshOrigin({ origin: 'https://evil.example', context: 'production' }),
    ORIGIN_DECISION.DENY,
  );
});

// 3. production + Origin 欠落 → 403
test('#3 production + Origin 欠落 → deny', () => {
  assert.equal(decideRefreshOrigin({ origin: undefined, context: 'production' }), ORIGIN_DECISION.DENY);
  assert.equal(decideRefreshOrigin({ origin: '', context: 'production' }), ORIGIN_DECISION.DENY);
  assert.equal(decideRefreshOrigin({ origin: null, context: 'production' }), ORIGIN_DECISION.DENY);
});

// 4. production + 複数 Origin 相当 → 403
test('#4 production + 複数/不正形式 Origin → deny', () => {
  assert.equal(
    decideRefreshOrigin({ origin: `${PROD_ORIGIN}, https://evil.example`, context: 'production' }),
    ORIGIN_DECISION.DENY,
  );
  // 末尾空白・配列風など完全一致しない値
  assert.equal(decideRefreshOrigin({ origin: `${PROD_ORIGIN} `, context: 'production' }), ORIGIN_DECISION.DENY);
  assert.equal(decideRefreshOrigin({ origin: [PROD_ORIGIN], context: 'production' }), ORIGIN_DECISION.DENY);
});

// 5. context 未設定 + Origin 欠落 → 403（本番相当・fail closed）
test('#5 context 未設定/未知 + Origin 欠落 → deny（本番相当）', () => {
  assert.equal(decideRefreshOrigin({ origin: undefined, context: undefined }), ORIGIN_DECISION.DENY);
  assert.equal(decideRefreshOrigin({ origin: undefined, context: '' }), ORIGIN_DECISION.DENY);
  assert.equal(decideRefreshOrigin({ origin: undefined, context: 'weird-unknown' }), ORIGIN_DECISION.DENY);
  // context 未設定でも正しい Origin なら通る
  assert.equal(decideRefreshOrigin({ origin: PROD_ORIGIN, context: undefined }), ORIGIN_DECISION.ALLOW);
});

// 6. 明示された test/非本番環境での許可条件
test('#6 非本番 context は Origin 欠落を許容し、localhost も許可', () => {
  for (const ctx of ['dev', 'deploy-preview', 'branch-deploy']) {
    assert.equal(decideRefreshOrigin({ origin: undefined, context: ctx }), ORIGIN_DECISION.ALLOW, `${ctx} 欠落許容`);
    assert.equal(decideRefreshOrigin({ origin: 'http://localhost:4321', context: ctx }), ORIGIN_DECISION.ALLOW);
  }
  // 非本番でも不正 Origin は拒否（欠落だけを許すのであって何でも許すのではない）
  assert.equal(decideRefreshOrigin({ origin: 'https://evil.example', context: 'dev' }), ORIGIN_DECISION.DENY);
  // localhost は本番では拒否
  assert.equal(decideRefreshOrigin({ origin: 'http://localhost:4321', context: 'production' }), ORIGIN_DECISION.DENY);
});

test('isProductionContext: 非本番値のみ false、未設定/未知は true', () => {
  assert.equal(isProductionContext('production'), true);
  assert.equal(isProductionContext(undefined), true);
  assert.equal(isProductionContext(''), true);
  assert.equal(isProductionContext('unknown'), true);
  assert.equal(isProductionContext('dev'), false);
  assert.equal(isProductionContext('deploy-preview'), false);
  assert.equal(isProductionContext('branch-deploy'), false);
});
