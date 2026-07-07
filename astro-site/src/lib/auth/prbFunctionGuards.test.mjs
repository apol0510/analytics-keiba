/**
 * prbFunctionGuards.test.mjs — PR-B の認証 Function / 画面の静的 guard
 *   node --test src/lib/auth/prbFunctionGuards.test.mjs
 *
 * 会員判定・セッション発行の実配線が退行しないよう、実ソースを走査して以下を強制する:
 *   - fallback 秘密鍵なし / secret を console 出力しない
 *   - クライアント plan を採用しない / email 文字列から plan を推測しない
 *   - auth-user で日次ポイント更新をしない・有料 plan 名を email だけで返さない
 *   - verify は resolveMembership → paid のみ Cookie 発行、Used 更新は判定後
 *   - send-magic-link は paid のみ送信
 *   - logout は削除 Cookie を返す
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DIR = import.meta.dirname;
const FN = (f) => `${DIR}/../../../netlify/functions/${f}`;
const PAGE = (p) => `${DIR}/../../pages/${p}`;

function raw(path) {
  return readFileSync(path, 'utf8');
}
// JS コメントを除去（説明文中の語での誤検知を避ける）
function stripJs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const authUser = raw(FN('auth-user.js'));
const sendMagic = raw(FN('send-magic-link.js'));
const verifyMagic = raw(FN('verify-magic-link.js'));
const logout = raw(FN('logout.js'));
const dashboard = raw(PAGE('dashboard.astro'));
const verifyPage = raw(PAGE('auth/verify.astro'));

const FUNCTIONS = [
  ['auth-user.js', authUser],
  ['send-magic-link.js', sendMagic],
  ['verify-magic-link.js', verifyMagic],
  ['logout.js', logout],
];

// --- fallback 秘密鍵なし / ハードコード鍵なし ---
for (const [name, src] of FUNCTIONS) {
  test(`${name}: SESSION_SIGNING_SECRET の文字列フォールバックが無い`, () => {
    assert.equal(/SESSION_SIGNING_SECRET\s*(\|\||\?\?)\s*['"`]/.test(src), false);
    assert.equal(/(SIGNING_SECRET|SESSION_SECRET)\s*=\s*['"`][^'"`]/.test(src), false);
  });
  test(`${name}: secret 値を console 出力しない`, () => {
    const s = stripJs(src);
    // console.*(...) の中に secret 変数の展開や env 値そのものを渡していない
    assert.equal(/console\.\w+\([^)]*\$\{?\s*secret\b/.test(s), false);
    assert.equal(/console\.\w+\([^)]*process\.env\.SESSION_SIGNING_SECRET/.test(s), false);
  });
}

// --- クライアント plan を採用しない（body から plan を読まない） ---
for (const [name, src] of [['auth-user.js', authUser], ['send-magic-link.js', sendMagic]]) {
  test(`${name}: リクエスト body から plan を読まない`, () => {
    const m = stripJs(src).match(/const\s*\{([^}]*)\}\s*=\s*JSON\.parse\(event\.body/);
    if (m) assert.equal(/\bplan\b/.test(m[1]), false, `body 分解に plan が含まれる: ${m[1]}`);
  });
}

// --- email 文字列から plan を推測しない（Function + 画面） ---
for (const [name, src] of [
  ['auth-user.js', authUser],
  ['verify-magic-link.js', verifyMagic],
  ['dashboard.astro', dashboard],
  ['auth/verify.astro', verifyPage],
]) {
  test(`${name}: email 文字列から plan を推測しない`, () => {
    assert.equal(
      /email[^\n;]*\.includes\(\s*['"](premium|standard|light|free)/i.test(stripJs(src)),
      false,
    );
  });
}

// --- auth-user: 日次ポイント更新なし / 有料 plan 名を email だけで返さない ---
test('auth-user.js: 日次ログインポイントのロジックを持たない', () => {
  assert.equal(/POINTS_BY_PLAN/.test(authUser), false);
  assert.equal(/pointsAdded/.test(authUser), false);
});
test('auth-user.js: 会員判定を resolveMembership に委譲（ローカル plan 正規化を再実装しない）', () => {
  assert.match(authUser, /resolveMembership/);
  assert.match(authUser, /decideFreeLogin/);
  assert.match(authUser, /requiresMagicLink/);
  // 旧ローカル normalizePlan（プラン名の直返し）を再実装していない
  assert.equal(/function\s+normalizePlan/.test(authUser), false);
});
test('auth-user.js: 無料経路のユーザー plan は固定 "free" のみ', () => {
  // free 応答は plan:'free' 固定。プラン名（Premium 等）を返す分岐が無い
  assert.match(authUser, /plan:\s*'free'/);
  assert.equal(/plan:\s*normalizedPlan/.test(authUser), false);
});

// --- send-magic-link: paid のみ送信 ---
test('send-magic-link.js: paid のみ送信（shouldSendMagicLink 経由）', () => {
  assert.match(sendMagic, /shouldSendMagicLink/);
  assert.match(sendMagic, /resolveMembership/);
});

// --- verify-magic-link: 会員再判定 → paid のみ Cookie、Used は判定後 ---
const verifyFlow = raw(`${DIR}/verifyMagicLinkFlow.js`);

test('verify-magic-link.js: 純粋オーケストレータを注入して使う（薄いハンドラ）', () => {
  assert.match(verifyMagic, /runVerifyMagicLink/);
  assert.match(verifyMagic, /findToken/);
  assert.match(verifyMagic, /findCustomer/);
  assert.match(verifyMagic, /markUsed/);
  assert.match(verifyMagic, /Set-Cookie/);
});
test('verify-magic-link.js: PlanType をティアとして扱わない', () => {
  assert.equal(/PlanType/.test(verifyMagic), false);
});
test('verifyMagicLinkFlow.js: 会員判定・Cookie 準備は Used 更新（markUsed）より前', () => {
  assert.match(verifyFlow, /resolveMembership\(/);
  assert.match(verifyFlow, /issuePaidSessionCookie\(/);
  assert.match(verifyFlow, /checkSigningSecret\(/);
  const iResolve = verifyFlow.indexOf('resolveMembership({');
  const iIssue = verifyFlow.indexOf('issuePaidSessionCookie({');
  const iMark = verifyFlow.indexOf('markUsed(tok.id)');
  assert.ok(iResolve > -1 && iIssue > -1 && iMark > -1);
  assert.ok(iResolve < iMark, 'resolveMembership は markUsed より前');
  assert.ok(iIssue < iMark, 'Cookie 準備は markUsed より前');
});

// --- logout ---
test('logout.js: 削除 Cookie を Set-Cookie で返す', () => {
  assert.match(logout, /buildLogoutCookie/);
  assert.match(logout, /Set-Cookie/);
});
