/**
 * mediaAuth.test.mjs — 管理者 POST 認可（fail closed / production 限定 / Origin / timing-safe）
 *   node --test src/lib/premiumPlus/mediaAuth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdminWrite, timingSafeEqualString, ADMIN_WRITE, ADMIN_REJECT } from './mediaAuth.js';

const SECRET = 'admin-secret-32-characters-minimum-length!!';
const ORIGIN = 'https://analytics.keiba.link';
const allow = {
  method: 'POST', adminSecret: SECRET, providedSecret: SECRET, origin: ORIGIN, context: 'production',
};

test('全条件を満たす → ALLOW', async () => {
  const r = await decideAdminWrite(allow);
  assert.equal(r.decision, ADMIN_WRITE.ALLOW);
});

// #13 secret 欠落・不一致 → 拒否
test('#13 secret 欠落（env 未設定）→ 503 fail closed / 不一致 → 403', async () => {
  assert.equal((await decideAdminWrite({ ...allow, adminSecret: undefined })).reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
  assert.equal((await decideAdminWrite({ ...allow, adminSecret: 'short' })).reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
  const mismatch = await decideAdminWrite({ ...allow, providedSecret: 'wrong-but-long-enough-value-1234567890' });
  assert.equal(mismatch.reason, ADMIN_REJECT.FORBIDDEN);
  assert.equal(mismatch.status, 403);
});

// #14 timing-safe 比較
test('#14 timingSafeEqualString は一致/不一致/型不正を正しく判定', async () => {
  assert.equal(await timingSafeEqualString('abcdef', 'abcdef'), true);
  assert.equal(await timingSafeEqualString('abcdef', 'abcdeg'), false);
  assert.equal(await timingSafeEqualString('abc', 'abcdef'), false); // 長さ違い
  assert.equal(await timingSafeEqualString('x', 123), false);
  assert.equal(await timingSafeEqualString(undefined, 'x'), false);
});

// #15 Origin 欠落・不一致 → 拒否
test('#15 Origin 欠落 / 不一致 / 複数 → 拒否', async () => {
  assert.equal((await decideAdminWrite({ ...allow, origin: undefined })).reason, ADMIN_REJECT.ORIGIN);
  assert.equal((await decideAdminWrite({ ...allow, origin: 'https://evil.example' })).reason, ADMIN_REJECT.ORIGIN);
  assert.equal((await decideAdminWrite({ ...allow, origin: `${ORIGIN}, https://evil.example` })).reason, ADMIN_REJECT.ORIGIN);
  assert.equal((await decideAdminWrite({ ...allow, origin: `${ORIGIN} ` })).reason, ADMIN_REJECT.ORIGIN);
});

// #16 production 以外から書き込み拒否 / #17 context 未設定で拒否
test('#16/#17 production 以外・context 未設定 → 拒否', async () => {
  for (const ctx of [undefined, '', 'dev', 'deploy-preview', 'branch-deploy', 'unknown']) {
    const r = await decideAdminWrite({ ...allow, context: ctx });
    assert.equal(r.decision, ADMIN_WRITE.REJECT, `context=${ctx}`);
    assert.equal(r.reason, ADMIN_REJECT.NON_PRODUCTION, `context=${ctx}`);
  }
});

test('POST 以外 → 405', async () => {
  for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await decideAdminWrite({ ...allow, method: m });
    assert.equal(r.reason, ADMIN_REJECT.METHOD);
    assert.equal(r.status, 405);
  }
});
