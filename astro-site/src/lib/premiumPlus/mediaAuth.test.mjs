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

// #16 既知の非本番 context は拒否（deploy-preview / branch-deploy / dev）
test('#16 既知の非本番 context（dev/deploy-preview/branch-deploy）→ NON_PRODUCTION 拒否', async () => {
  for (const ctx of ['dev', 'deploy-preview', 'branch-deploy']) {
    const r = await decideAdminWrite({ ...allow, context: ctx });
    assert.equal(r.decision, ADMIN_WRITE.REJECT, `context=${ctx}`);
    assert.equal(r.reason, ADMIN_REJECT.NON_PRODUCTION, `context=${ctx}`);
  }
});

// #17 CONTEXT 欠落（Functions ランタイムで未定義になり得る）/ 未知 / 'production' は本番相当で ALLOW。
// 非本番からの誤書き込みは secret + Origin 完全一致 + kill-switch の多層で防ぐ（context 単独に依存しない）。
test('#17 CONTEXT 未定義/空/未知/"production" → 本番相当で ALLOW', async () => {
  for (const ctx of [undefined, '', 'unknown', 'production']) {
    const r = await decideAdminWrite({ ...allow, context: ctx });
    assert.equal(r.decision, ADMIN_WRITE.ALLOW, `context=${JSON.stringify(ctx)}`);
  }
});

test('POST 以外 → 405', async () => {
  for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await decideAdminWrite({ ...allow, method: m });
    assert.equal(r.reason, ADMIN_REJECT.METHOD);
    assert.equal(r.status, 405);
  }
});

// secret の前後空白/改行を正規化（env secret footgun 対策・本番 403 の code-level 機序の回帰）
test('env secret に前後の改行/空白が混入しても、送出ヘッダが本質同一なら ALLOW（正規化）', async () => {
  // adminSecret 側に末尾改行/空白/CR/タブ、providedSecret は clean
  for (const suffix of ['\n', '\r\n', ' ', '  \n', '\t', '\r']) {
    const r = await decideAdminWrite({ ...allow, adminSecret: `${SECRET}${suffix}` });
    assert.equal(r.decision, ADMIN_WRITE.ALLOW, `admin suffix=${JSON.stringify(suffix)}`);
  }
  // providedSecret 側に前後空白（HTTP OWS 相当）、adminSecret は clean
  for (const wrap of [`${SECRET}\n`, ` ${SECRET} `, `\t${SECRET}\r\n`]) {
    const r = await decideAdminWrite({ ...allow, providedSecret: wrap });
    assert.equal(r.decision, ADMIN_WRITE.ALLOW, `provided wrap=${JSON.stringify(wrap)}`);
  }
  // 両側に異なる前後空白でも本質が同じなら ALLOW
  assert.equal(
    (await decideAdminWrite({ ...allow, adminSecret: `${SECRET}\r\n`, providedSecret: ` ${SECRET}` })).decision,
    ADMIN_WRITE.ALLOW,
  );
});

test('正規化は前後のみ。本質が異なる/内部空白の差は依然 403（マスクしない）', async () => {
  // trim 後も異なる → FORBIDDEN
  assert.equal(
    (await decideAdminWrite({ ...allow, providedSecret: `${SECRET}x` })).reason,
    ADMIN_REJECT.FORBIDDEN,
  );
  // 内部空白は秘密の一部として保持（trim しない）→ 不一致
  const withInner = 'admin secret-32-characters-minimum-length!!';
  assert.equal(
    (await decideAdminWrite({ ...allow, adminSecret: withInner, providedSecret: SECRET })).reason,
    ADMIN_REJECT.FORBIDDEN,
  );
});

test('trim 後に空/短すぎ → 503 fail closed（空白のみ・短い値+改行）', async () => {
  assert.equal((await decideAdminWrite({ ...allow, adminSecret: '   \n\t ' })).reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
  assert.equal((await decideAdminWrite({ ...allow, adminSecret: '   ' })).reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
  assert.equal((await decideAdminWrite({ ...allow, adminSecret: `short\n` })).reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
});

test('core が 16 文字以上なら末尾改行付きでも 503 にならず一致で ALLOW', async () => {
  const core16 = 'abcdefghijklmnop'; // ちょうど 16
  const r = await decideAdminWrite({ ...allow, adminSecret: `${core16}\n`, providedSecret: core16 });
  assert.equal(r.decision, ADMIN_WRITE.ALLOW);
});
