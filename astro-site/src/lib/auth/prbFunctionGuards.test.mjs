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
const refreshSession = raw(FN('refresh-session.js'));
const dashboard = raw(PAGE('dashboard.astro'));
const verifyPage = raw(PAGE('auth/verify.astro'));
const loginPage = raw(PAGE('login.astro'));

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

// =========================================================================
// マージブロッカー1: Customers 重複を先頭採用しない（0/1/複数を明確に区別）
// =========================================================================
for (const [name, src] of [
  ['auth-user.js', authUser],
  ['send-magic-link.js', sendMagic],
  ['verify-magic-link.js', verifyMagic],
]) {
  test(`${name}: classifyCustomerMatches で Customers 検索結果を分類する`, () => {
    assert.match(src, /classifyCustomerMatches/);
    assert.match(src, /CUSTOMER_LOOKUP/);
  });
}
test('auth-user.js: 先頭レコード records[0] を会員判定に使わない', () => {
  assert.equal(/records\[0\]/.test(stripJs(authUser)), false);
});
test('send-magic-link.js: 先頭レコード customers[0] を会員判定に使わない', () => {
  assert.equal(/customers\[0\]/.test(stripJs(sendMagic)), false);
});
test('verify-magic-link.js: 重複時 conflict を返し CUSTOMER_CONFLICT を処理する', () => {
  assert.match(verifyMagic, /conflict:\s*true/);
  assert.match(verifyMagic, /CUSTOMER_CONFLICT/);
});
test('verifyMagicLinkFlow.js: conflict は resolveMembership/issue/markUsed より前で返す', () => {
  const iConflict = verifyFlow.indexOf('CUSTOMER_CONFLICT');
  const iResolve = verifyFlow.indexOf('resolveMembership({');
  const iMark = verifyFlow.indexOf('markUsed(tok.id)');
  assert.ok(iConflict > -1 && iResolve > -1 && iMark > -1);
  assert.ok(iConflict < iResolve, 'conflict 判定は resolveMembership より前');
  assert.ok(iConflict < iMark, 'conflict 判定は markUsed より前');
});

// =========================================================================
// マージブロッカー2: 新規登録 race再検索は resolveMembership へ渡す（固定 Free 化しない）
// =========================================================================
test('auth-user.js: 新規登録の再検索は resolveMembership 経由（固定 Free 化しない）', () => {
  const s = stripJs(authUser);
  const iReg = s.indexOf('handleNewFreeRegistration');
  assert.ok(iReg > -1);
  const body = s.slice(s.indexOf('async function handleNewFreeRegistration'));
  // 再検索結果を resolveMembership / decideFreeLogin に渡している
  assert.match(body, /classifyCustomerMatches/);
  assert.match(body, /resolveMembership\(/);
  assert.match(body, /decideFreeLogin\(/);
  // 旧: reCheck.length > 0 で無条件 Free 化する分岐を残さない
  assert.equal(/reCheck\.length\s*>\s*0/.test(body), false);
});

// =========================================================================
// マージブロッカー3: send-magic-link 失敗時に成功表示しない（response.ok 確認）
// =========================================================================
for (const [name, src] of [['login.astro', loginPage], ['dashboard.astro', dashboard]]) {
  test(`${name}: send-magic-link の応答 ok を確認してから成功表示する`, () => {
    const s = stripJs(src);
    // requiresMagicLink 分岐で send-magic-link を呼び、response.ok を確認している
    assert.match(s, /requiresMagicLink/);
    assert.match(s, /send-magic-link/);
    assert.match(s, /sendRes\.ok/);
    // 旧: 送信結果を捨てて（.catch(() => {})）無条件に成功表示するパターンを残さない
    assert.equal(/send-magic-link[\s\S]{0,200}\}\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(s), false);
  });
}

// =========================================================================
// #4: 有料ログアウト配線（dashboard.astro）
//   - 有料時に logout-section-paid を表示 / 無料時は非表示
//   - logout Function を呼び、response.ok の時だけ localStorage を削除
//   - 失敗時に localStorage を先に消さない / Cookie 値を JS から読まない
// =========================================================================
{
  const s = stripJs(dashboard);
  test('dashboard.astro: 有料時に logout-section-paid を表示（display 制御あり）', () => {
    // showPlanContent 内で logout-section-paid を isPaid 判定で表示切替している
    assert.match(s, /logout-section-paid/);
    assert.match(s, /paidLogoutSection[\s\S]{0,200}style\.display/);
    assert.match(s, /isPaidLogout\s*\?\s*'block'\s*:\s*'none'/);
  });

  test('dashboard.astro: logout は logout Function を呼び response.ok を確認する', () => {
    assert.match(s, /\/\.netlify\/functions\/logout/);
    assert.match(s, /res\.ok/);
    // 二重クリック防止フラグ + finally 復元
    assert.match(s, /_loggingOut/);
    assert.match(s, /finally\s*\{[\s\S]*?disabled\s*=\s*false/);
  });

  test('dashboard.astro: Cookie 削除失敗時に localStorage を先に消さない（ok 判定が先）', () => {
    // logout 関数本体にスコープを絞る（ファイル内の他 removeItem に引っ張られないため）
    const body = s.slice(s.indexOf('window.logout'));
    const iOkGuard = body.indexOf('if (!res.ok)');
    const iRemove = body.indexOf("localStorage.removeItem('user-plan')");
    assert.ok(iOkGuard > -1 && iRemove > -1, 'ok ガードと removeItem が存在する');
    assert.ok(iOkGuard < iRemove, '!res.ok の早期 return は localStorage 削除より前');
  });

  test('dashboard.astro: 有料 Cookie 値を JS から読まない（ak_session / document.cookie 参照なし）', () => {
    assert.equal(/ak_session/.test(s), false);
    assert.equal(/document\.cookie/.test(s), false);
  });
}

// #4b: 配置改善 — ステータスカード内・会員情報の下（ページ最下部に単独表示しない）
test('dashboard.astro: 有料ログアウトはステータスカード内・会員情報の下（最下部に単独表示しない）', () => {
  const html = dashboard; // markup の順序で位置を検証（strip しない）
  const iDetails = html.indexOf('id="membership-details"');
  const iLogout = html.indexOf('id="logout-section-paid"');
  const iPreds = html.indexOf('id="free-predictions"');
  assert.ok(iDetails > -1 && iLogout > -1 && iPreds > -1);
  assert.ok(iDetails < iLogout, 'ログアウトは会員情報(details)の直後');
  assert.ok(iLogout < iPreds, 'ログアウトは予想カード群より前＝ステータスカード内（最下部単独ではない）');
  assert.match(html, /id="logout-section-paid"[^>]*class="account-actions"/);
});
test('dashboard.astro: 旧・最下部の目立つログアウト（logout-primary / logout-section-paid class）を残さない', () => {
  assert.equal(/action-btn logout-primary/.test(dashboard), false);
  assert.equal(/class="logout-section-paid"/.test(dashboard), false);
});

// ─── refresh-session.js（PR-B2）───────────────────────────────
// Origin 拒否時に Airtable 照会も Set-Cookie も行わないことを、ソースの制御フロー順で保証する。
{
  const s = stripJs(refreshSession);

  test('refresh-session.js: Origin 検証が Airtable 照会より前（#7 拒否時に照会しない）', () => {
    // 呼び出し箇所（定義ではなく実行順）で比較する
    const iOrigin = s.indexOf('decideRefreshOrigin({');
    const iAirtable = s.indexOf('new Airtable');
    const iFindCall = s.indexOf('findCustomerById(base, verified');
    assert.ok(iOrigin > -1, 'decideRefreshOrigin を呼ぶ');
    assert.ok(iAirtable > -1 && iFindCall > -1, 'Airtable 照会の呼び出しが存在する');
    assert.ok(iOrigin < iAirtable, 'Origin 検証は new Airtable より前');
    assert.ok(iOrigin < iFindCall, 'Origin 検証は findCustomerById 呼び出しより前');
  });

  test('refresh-session.js: Origin 拒否の 403 は Set-Cookie を返さない（#8）', () => {
    // 403 Forbidden を返す行に Set-Cookie が無いこと
    const forbiddenLine = s.split('\n').find((l) => l.includes('403') && l.includes('Forbidden'));
    assert.ok(forbiddenLine, '403 Forbidden の return がある');
    assert.equal(/Set-Cookie/i.test(forbiddenLine), false, '403 行に Set-Cookie を含めない');
  });

  test('refresh-session.js: Origin 検証は process.env.CONTEXT を根拠にする（クライアント値を信用しない）', () => {
    assert.match(s, /decideRefreshOrigin\(\s*\{[^}]*context:\s*process\.env\.CONTEXT/);
  });

  test('refresh-session.js: 全レスポンスに Cache-Control: private, no-store', () => {
    assert.match(s, /'Cache-Control':\s*'private, no-store'/);
  });

  test('refresh-session.js: POST 以外は 405 / secret 未設定は 503（fail closed）', () => {
    assert.match(s, /httpMethod\s*!==\s*'POST'[\s\S]{0,120}405/);
    assert.match(s, /checkSigningSecret[\s\S]{0,160}503/);
  });

  test('refresh-session.js: secret / Cookie / token をログに出さない', () => {
    // console.* の引数に secret / token / cookie 変数を渡していない
    const logs = s.match(/console\.(log|warn|error)\([^)]*\)/g) || [];
    for (const line of logs) {
      assert.equal(/\bsecret\b|\btoken\b|\bcookie\b/i.test(line), false, `ログに機密を含めない: ${line}`);
    }
  });
}
