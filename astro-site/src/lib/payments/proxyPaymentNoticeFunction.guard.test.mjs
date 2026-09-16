/**
 * proxyPaymentNoticeFunction.guard.test.mjs — 代理入金連絡 Function の構造ガード
 *   node --test src/lib/payments/proxyPaymentNoticeFunction.guard.test.mjs
 *
 * 純粋関数のテストでは守れないこと（認可・副作用・通常フォームの非変更）を
 * ソースの構造で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { decideAdminWrite, ADMIN_WRITE, ADMIN_REJECT } from '../premiumPlus/mediaAuth.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // astro-site/
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const FN = 'netlify/functions/admin-proxy-payment-notice.js';
const fn = read(FN);

// ── 認可（admin 以外・未認証・URL 直打ち・直接 POST を通さない）────────────

test('認可は mediaAuth の decideAdminWrite に委ねる（自前の認可を書かない）', () => {
  assert.match(fn, /decideAdminWrite/, 'decideAdminWrite を使っていない');
  assert.match(fn, /mediaAuth\.js/, 'mediaAuth を import していない');
  assert.ok(!/providedSecret\s*===\s*/.test(fn), 'secret を素の === で比較してはいけない');
});

test('認可より前に Airtable へ触れない（拒否時の副作用ゼロ）', () => {
  const authAt = fn.indexOf('decideAdminWrite');
  for (const marker of ['findCustomerByEmail', 'patchRecord(', 'api.airtable.com']) {
    const at = fn.indexOf(marker);
    if (at === -1) continue;
    assert.ok(at > authAt, `${marker} が認可より前にある`);
  }
});

test('secret は env からのみ読み、ヘッダ以外（body / query）からは受け取らない', () => {
  assert.match(fn, /process\.env\.PROXY_NOTICE_ADMIN_SECRET/);
  assert.match(fn, /x-admin-secret/);
  assert.ok(!/body\.secret|body\.adminSecret|queryStringParameters/.test(fn),
    'secret を body / query から受け取ってはいけない');
});

/**
 * 2026-09-16 の実測事故: 当初 `PAYMENT_ADMIN_SECRET` / `PREMIUM_PLUS_ADMIN_SECRET` への
 * fallback を持たせていたが、本番には既に両方が入っていたため、**deploy した瞬間から
 * この経路が有効**になっていた（正規形式 POST が 503 ではなく 403 を返した）。
 * 「専用 secret を入れるまで不活性」を守るため、fallback の再導入をここで禁止する。
 */
test('他の管理 secret へ fallback しない（専用 secret 以外では動かない）', () => {
  for (const other of ['PAYMENT_ADMIN_SECRET', 'PREMIUM_PLUS_ADMIN_SECRET', 'COMEBACK_ADMIN_SECRET']) {
    assert.ok(!new RegExp(`process\\.env\\.${other}`).test(fn),
      `${other} へ fallback してはいけない（その secret を持つだけで申込を書けてしまう）`);
  }
  // 代入は 1 本だけ（`a || b` の形が残っていないこと）
  const line = fn.split('\n').find((l) => l.includes('const adminSecret'));
  assert.ok(line && !line.includes('||'), 'adminSecret の解決に fallback が残っている');
});

test('専用 secret 未設定なら 503（機能は不活性のまま）', async () => {
  const r = await decideAdminWrite({
    method: 'POST', adminSecret: undefined, providedSecret: 'x'.repeat(32),
    origin: 'https://analytics.keiba.link', context: 'production',
  });
  assert.equal(r.reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
  assert.equal(r.status, 503);
});

test('GET / URL 直打ちは認可段で落ちる', async () => {
  const r = await decideAdminWrite({
    method: 'GET', adminSecret: 'x'.repeat(32), providedSecret: 'x'.repeat(32),
    origin: 'https://analytics.keiba.link', context: 'production',
  });
  assert.equal(r.decision, ADMIN_WRITE.REJECT);
  assert.equal(r.reason, ADMIN_REJECT.METHOD);
});

test('secret 未設定なら誰も通さない（fail closed）', async () => {
  const r = await decideAdminWrite({
    method: 'POST', adminSecret: undefined, providedSecret: 'whatever',
    origin: 'https://analytics.keiba.link', context: 'production',
  });
  assert.equal(r.decision, ADMIN_WRITE.REJECT);
  assert.equal(r.reason, ADMIN_REJECT.SECRET_UNAVAILABLE);
});

test('secret 不一致 / Origin 欠落は通さない（直接 POST 対策）', async () => {
  const secret = 'y'.repeat(32);
  const mismatched = await decideAdminWrite({
    method: 'POST', adminSecret: secret, providedSecret: 'z'.repeat(32),
    origin: 'https://analytics.keiba.link', context: 'production',
  });
  assert.equal(mismatched.reason, ADMIN_REJECT.FORBIDDEN);

  const noOrigin = await decideAdminWrite({
    method: 'POST', adminSecret: secret, providedSecret: secret,
    origin: undefined, context: 'production',
  });
  assert.equal(noOrigin.reason, ADMIN_REJECT.ORIGIN);
});

// ── 副作用の範囲 ────────────────────────────────────────────────

test('メールを一切送らない（PaymentConfirmed 前に利用開始メールを出さない）', () => {
  assert.ok(!/sendgrid|SENDGRID|sendMail|api\.sendgrid\.com|mail\/send/i.test(fn),
    '代理登録でメールを送ってはいけない');
});

test('有料権限のフィールドを Function 内で直書きしない', () => {
  for (const forbidden of ['プラン', '有効期限', 'PaidAt', 'PaymentEmailSent', 'LifetimeSanrenpuku']) {
    const assignment = new RegExp(`['"\`]${forbidden}['"\`]\\s*:`);
    assert.ok(!assignment.test(fn), `${forbidden} を Function で直書きしてはいけない`);
  }
  assert.ok(!/Status['"]?\s*:\s*['"]active['"]/.test(fn), "Status:'active' を直書きしてはいけない");
});

test('書き込むフィールドは単一源が組み立てる', () => {
  assert.match(fn, /buildProxyNoticeFields/);
  assert.match(fn, /decideProxyPaymentNotice/);
});

test('preview は Airtable を書かない', () => {
  const previewAt = fn.indexOf("action === 'preview'");
  const patchAt = fn.indexOf('await patchRecord(');
  assert.ok(previewAt !== -1 && patchAt !== -1);
  assert.ok(previewAt < patchAt, 'preview の分岐が PATCH より後にある');
  assert.match(fn, /sideEffects: 'none'/);
});

test('会員レコードを新規作成しない（POST で Customers を作らない）', () => {
  assert.ok(!/method:\s*['"]POST['"][\s\S]{0,200}Customers/.test(fn),
    'Customers への POST（新規作成）があってはいけない');
  assert.match(fn, /maxRecords=2/, '同一アドレスの重複検出のため 2 件見ていない');
});

// ── 通常の顧客フローを壊していない（回帰）────────────────────────

test('通常の入金連絡フォームのアドレス固定は外れていない', () => {
  const form = read('netlify/functions/bank-transfer-application.js');
  assert.match(form, /decideApplicationEmail/, 'セッションのアドレス固定が外れている');
  assert.match(form, /APPLICATION_EMAIL\.MISMATCH/, '不一致の拒否が外れている');
  assert.match(form, /paymentCompletedConfirm !== true/, '入金済みチェックの検証が外れている');
});

test('代理登録は通常フォームの identity 判定へ手を入れない', () => {
  assert.ok(!/decideApplicationEmail|APPLICATION_EMAIL/.test(fn),
    '代理登録が顧客フォームの identity 判定を流用・改変してはいけない');
  const identity = read('src/lib/payments/applicationIdentity.js');
  assert.ok(!/admin|proxy|代理/i.test(identity),
    '顧客向けの identity 単一源へ代理登録の例外を持ち込んではいけない');
});

test('申込フィールドの単一源（buildApplicationFields）を迂回しない', () => {
  const lib = read('src/lib/payments/proxyPaymentNotice.js');
  assert.match(lib, /buildApplicationFields/, '通常フォームと同じ単一源を使っていない');
  assert.ok(!/['"`]RequestedPlan['"`]\s*:/.test(fn),
    'Function が Requested* を自前で組み立ててはいけない');
});
