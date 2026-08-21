/**
 * reopenStartWiring.guard.test.mjs — 「**会員ごとの**再募集開始日時の単一源」を構造で守る
 *
 * 挙動のテスト（`premiumPlusReopenStart.test.mjs` / `premiumPlusReopenStartStore.test.mjs` /
 * `adminReopenStart.smoke.test.mjs`）とは別に、**配線が外れていないこと**をソースの形で固定する。
 *
 * 守るもの:
 *   1. 顧客画面・申込・admin が**同じ 1 か所**（`loadReopenStart` → `withReopenStart`）から読む
 *   2. **必ず会員の recordId を渡す**（サイト全体で 1 個の開始日時を復活させない）
 *   3. 開始日時を **client から受け取らない**（サーバー時刻だけ）
 *   4. 上書き・削除・一括開始の経路をコードで持たない
 *   5. 有効期限の計算式・鍵名・確認文言を**書き写さない**
 *   6. 基準定義に**仮の開始日時を書かない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const COUPON_LIB = read('./premiumPlusReopenCoupon.js');
const START_LIB = read('./premiumPlusReopenStart.js');
const STORE_LIB = read('./premiumPlusReopenStartStore.js');
const ADMIN_FN = read('../../../netlify/functions/premium-plus-eligibility.js');
const BANK_FN = read('../../../netlify/functions/bank-transfer-application.js');
const ADMIN_PAGE = read('../../pages/admin/premium-plus-eligibility.astro');

/** クーポンの条件・期限を顧客へ出す面（**全部ここから、本人の recordId で読む**） */
const SURFACES = Object.freeze([
  ['/premium-plus/（受付休止ページ）', '../../pages/premium-plus.astro'],
  ['/premium-plus-v2/（受付休止ページ）', '../../pages/premium-plus-v2.astro'],
  ['/premium-plus-coupon/（クーポンページ）', '../../pages/premium-plus-coupon.astro'],
  ['/api/upsell.json（マイページ）', '../../pages/api/upsell.json.js'],
  ['/api/premium-plus-order.json（申込画面）', '../../pages/api/premium-plus-order.json.js'],
]);

test('顧客に条件・期限を出す面は単一源から「本人の」開始日時を読む', () => {
  for (const [label, rel] of SURFACES) {
    const src = read(rel);
    assert.match(src, /loadReopenStart/, `${label}: 開始日時を読んでいない`);
    assert.match(src, /withReopenStart/, `${label}: 実効クーポン定義を作っていない`);
    assert.match(src, /\bdef:/, `${label}: 単一源へ def を渡していない`);
    // ⚠️ **会員を指定せずに読まない**（全体で 1 個の値を復活させない）
    assert.match(src, /loadReopenStart\(\{[\s\S]{0,160}recordId/,
      `${label}: recordId を渡していない（会員ごとに読んでいない）`);
  }
});

test('申込（銀行振込 Function）も申込者本人の recordId で読む', () => {
  assert.match(BANK_FN, /loadReopenStart\(\{[\s\S]{0,160}recordId: plusCustomerRecordId/);
  assert.match(BANK_FN, /withReopenStart/);
  assert.match(BANK_FN, /def: plusCouponDef/);
});

test('admin も同じ単一源を読む（画面用に別経路を作らない）', () => {
  assert.match(ADMIN_FN, /createReopenStartStore/);
  assert.match(ADMIN_FN, /withReopenStart/);
  assert.match(ADMIN_FN, /resolveReopenStatus/);
  // 一覧・個別検索の両方が同じ attachReopenStart を通る（定義 1 + 呼び出し 2）
  assert.equal((ADMIN_FN.match(/await attachReopenStart\(rows\)/g) || []).length, 2);
  assert.equal((ADMIN_FN.match(/async function attachReopenStart\(rows\)/g) || []).length, 1);
  // 会員ぶんを 1 回でまとめて読む（会員ごとに引かない）
  assert.match(ADMIN_FN, /store\.readMany\(\{/);
});

test('開始日時を client から受け取らない（サーバー時刻だけ）', () => {
  // handler は now（サーバー）を渡している
  assert.match(ADMIN_FN, /store\.start\(\{\s*recordId,\s*nowMs:\s*now/);
  // client の申告時刻を読む口を作らない
  for (const bad of [
    /req\.startsAt/, /req\.reopenStartsAt/, /req\.expiresAt/, /req\.now\b/,
    /body\.startsAt/, /body\.reopenStartsAt/,
  ]) {
    assert.ok(!bad.test(ADMIN_FN), `client 由来の時刻を読んでいる: ${bad}`);
  }
  // 画面も時刻を送らない（対象会員と操作者だけ）
  assert.match(ADMIN_PAGE, /action: 'reopenStart', recordId: r\.recordId, email: r\.email, actor/);
  assert.ok(!/reopenStart[\s\S]{0,120}startsAt:/.test(ADMIN_PAGE), '画面が開始日時を送っている');
});

test('会員の指定はサーバーが必ず検証する（URL 直打ち・API 直呼び対策）', () => {
  assert.match(ADMIN_FN, /isSafeCustomerRecordId/);
  // status / start の**両方**が検証している
  assert.equal((ADMIN_FN.match(/if \(!isSafeCustomerRecordId\(recordId\)\)/g) || []).length, 2);
  // 保存側でも二重に検証する（Function を迂回されても鍵空間を汚さない）
  assert.match(STORE_LIB, /isSafeCustomerRecordId/);
});

test('上書き・削除・一括開始の経路をコードで持たない', () => {
  for (const bad of [/export function setReopenStart/, /export function clearReopenStart/,
    /export function updateReopenStart/, /\bHDEL\b\s*'/, /'HSET'/, /'HDEL'/, /startAll/i]) {
    assert.ok(!bad.test(STORE_LIB), `上書き / 削除 / 一括の経路がある: ${bad}`);
  }
  // 書き込みは HSETNX 1 か所だけ
  assert.equal((STORE_LIB.match(/'HSETNX'/g) || []).length, 1, 'HSETNX は 1 か所だけ');
  // admin から取消・リセット・一括開始の action を生やさない
  for (const bad of [/'reopenClear'/, /'reopenReset'/, /'reopenCancel'/, /'reopenUpdate'/, /'reopenStartAll'/]) {
    assert.ok(!bad.test(ADMIN_FN), `admin に取消・一括系 action がある: ${bad}`);
  }
});

test('サイト全体を一括で開始する UI を置かない', () => {
  // 一覧上部のパネルは**読むだけ**（操作ボタンを持たない）
  const panel = ADMIN_PAGE.slice(
    ADMIN_PAGE.indexOf('function renderReopenPanel()'),
    ADMIN_PAGE.indexOf('function renderReopenPanel()') + 2600,
  );
  assert.ok(!/addEventListener\('click'/.test(panel), '全体パネルにボタンが復活している');
  assert.ok(!/action: 'reopenStart'/.test(panel), '全体パネルから開始を呼んでいる');
  // 開始の操作は会員の詳細パネルにだけある
  assert.match(ADMIN_PAGE, /この会員の再募集を開始する/);
  assert.match(ADMIN_PAGE, /再募集（この会員）/);
});

test('有効期限の計算式を書き写さない（14 日はクーポン定義だけが持つ）', () => {
  assert.match(COUPON_LIB, /expiryDays:\s*14/);
  assert.ok(!/expiryDays:\s*\d+/.test(START_LIB), '開始判定モジュールが日数を再定義している');
  assert.ok(!/14 \* 24 \* 60 \* 60 \* 1000/.test(START_LIB), '期限計算を書き写している');
  for (const [label, rel] of SURFACES) {
    const src = read(rel);
    assert.ok(!/expiryDays/.test(src), `${label}: 期限日数を画面側で持っている`);
    assert.ok(!/expiresAt:\s*['"]/.test(src), `${label}: 期限を画面側で作っている`);
  }
});

test('基準定義に仮の開始日時を書かない（未開始が既定）', () => {
  assert.match(COUPON_LIB, /reopenStartsAt:\s*null/);
  assert.match(COUPON_LIB, /expiresAt:\s*null/);
  assert.match(COUPON_LIB, /expiresDetermined:\s*false/);
  assert.ok(!/reopenStartsAt:\s*['"]\d{4}-/.test(COUPON_LIB));
});

/** コメント（/* … *\/ と //）を落として**実コードだけ**にする */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('保存先の鍵名は 1 か所（他のファイルで書き写さない・旧鍵を使わない）', () => {
  assert.match(STORE_LIB, /REOPEN_MEMBERS_KEY = `\$\{REOPEN_NAMESPACE\}:members`/);
  for (const src of [COUPON_LIB, START_LIB, ADMIN_FN, BANK_FN, ADMIN_PAGE]) {
    // いま使う鍵名は保存モジュール以外に現れない
    assert.ok(!/ak:pp:reopen:v1:members/.test(codeOnly(src)), '鍵名を書き写している');
  }
  // 旧グローバル鍵（全体で 1 個）を**実コードとして**使っていない。
  // ⚠️ 注意書き（コメント）での言及は残す — 復活させないための警告なので消さない。
  for (const src of [COUPON_LIB, START_LIB, STORE_LIB, ADMIN_FN, BANK_FN, ADMIN_PAGE]) {
    assert.ok(!/ak:pp:reopen:v1:start/.test(codeOnly(src)), '旧グローバル鍵を使っている');
  }
});

test('確認ダイアログの文言はサーバーが配る（対象会員入り・画面で作り直さない）', () => {
  // 文言の実体は判定モジュールにだけある
  assert.match(START_LIB, /export function buildReopenStartConfirmText/);
  assert.match(START_LIB, /confirmText: buildReopenStartConfirmText\(\{ memberLabel \}\)/);
  // 画面はサーバーが返した文字列を使う（受け取れていなければ押させない）
  assert.match(ADMIN_PAGE, /rs\.confirmText/);
  assert.match(ADMIN_PAGE, /if \(!rs\.confirmText\)/);
  assert.ok(!/再募集を開始します。/.test(ADMIN_PAGE), '確認文言を画面側で組み立てている');
  // ⚠️ 判定モジュールを client bundle へ入れない（共通クーポン基盤が node:crypto に依存する）
  const clientImports = ADMIN_PAGE.slice(
    ADMIN_PAGE.indexOf('<script>'), ADMIN_PAGE.indexOf('<script is:inline>'),
  );
  assert.ok(!/premiumPlusReopenStart/.test(clientImports), 'client へ import している');
  // ボタンは startable のときだけ出す
  assert.match(ADMIN_PAGE, /rs\.startable === true/);
});

test('判定モジュールは I/O を持たない（純粋のまま）', () => {
  for (const bad of [/\bfetch\(/, /@netlify\/blobs/, /UPSTASH/, /process\.env/]) {
    assert.ok(!bad.test(START_LIB), `純粋モジュールに I/O が入った: ${bad}`);
  }
});

test('「確認できない」を件数 0 に潰さない（admin の集計）', () => {
  // 読めていないときは開始済み件数を null にする
  assert.match(ADMIN_FN, /reopenStarted: reopen\.available[\s\S]{0,120}: null/);
  // 画面も「0 名」と言わない
  assert.match(ADMIN_PAGE, /0 名という意味ではありません/);
});
