/**
 * reopenStartWiring.guard.test.mjs — 「再募集開始日時の単一源」を**構造で**守る
 *
 * 挙動のテスト（`premiumPlusReopenStart.test.mjs` / `adminReopenStart.smoke.test.mjs`）とは別に、
 * **配線が外れていないこと**をソースの形で固定する。
 *
 * 守るもの:
 *   1. 顧客画面・申込・admin が**同じ 1 か所**（`loadReopenStart` → `withReopenStart`）から読む
 *   2. 開始日時を **client から受け取らない**（サーバー時刻だけ）
 *   3. 上書き・削除の経路をコードで持たない
 *   4. 有効期限の計算式・鍵名・確認文言を**書き写さない**
 *   5. 基準定義に**仮の開始日時を書かない**
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

/** クーポンの条件・期限を顧客／管理者へ出す面（**全部ここから読む**） */
const SURFACES = Object.freeze([
  ['/premium-plus/（受付休止ページ）', '../../pages/premium-plus.astro'],
  ['/premium-plus-v2/（受付休止ページ）', '../../pages/premium-plus-v2.astro'],
  ['/premium-plus-coupon/（クーポンページ）', '../../pages/premium-plus-coupon.astro'],
  ['/api/upsell.json（マイページ）', '../../pages/api/upsell.json.js'],
  ['/api/premium-plus-order.json（申込画面）', '../../pages/api/premium-plus-order.json.js'],
]);

test('顧客に条件・期限を出す面は必ず単一源から開始日時を読む', () => {
  for (const [label, rel] of SURFACES) {
    const src = read(rel);
    assert.match(src, /loadReopenStart/, `${label}: 開始日時を読んでいない`);
    assert.match(src, /withReopenStart/, `${label}: 実効クーポン定義を作っていない`);
    assert.match(src, /\bdef:/, `${label}: 単一源へ def を渡していない`);
  }
});

test('申込（銀行振込 Function）もサーバー側の単一源から読む', () => {
  assert.match(BANK_FN, /loadReopenStart/);
  assert.match(BANK_FN, /withReopenStart/);
  // 価格判定へ実効定義を渡している
  assert.match(BANK_FN, /def: plusCouponDef/);
});

test('admin も同じ単一源を読む（画面用に別経路を作らない）', () => {
  assert.match(ADMIN_FN, /loadReopenStart/);
  assert.match(ADMIN_FN, /withReopenStart/);
  assert.match(ADMIN_FN, /resolveReopenStatus/);
  // 一覧・個別検索・状態取得の 3 経路がすべて同じ readReopenState() を通る
  assert.equal((ADMIN_FN.match(/await readReopenState\(\)/g) || []).length, 3);
  assert.equal((ADMIN_FN.match(/async function readReopenState\(\)/g) || []).length, 1);
});

test('開始日時を client から受け取らない（サーバー時刻だけ）', () => {
  // handler は now（サーバー）を渡している
  assert.match(ADMIN_FN, /store\.start\(\{\s*nowMs:\s*now/);
  // client の申告時刻を読む口を作らない
  for (const bad of [
    /req\.startsAt/, /req\.reopenStartsAt/, /req\.expiresAt/, /req\.now\b/,
    /body\.startsAt/, /body\.reopenStartsAt/,
  ]) {
    assert.ok(!bad.test(ADMIN_FN), `client 由来の時刻を読んでいる: ${bad}`);
  }
});

test('上書き・削除の経路をコードで持たない', () => {
  for (const bad of [/export function setReopenStart/, /export function clearReopenStart/,
    /export function updateReopenStart/, /\bDEL\b/, /'GETSET'/, /getset/i]) {
    assert.ok(!bad.test(STORE_LIB), `上書き / 削除の経路がある: ${bad}`);
  }
  // 書き込みは NX 付きの SET 1 か所だけ
  const sets = STORE_LIB.match(/'SET'/g) || [];
  assert.equal(sets.length, 1, 'SET は 1 か所だけ');
  assert.match(STORE_LIB, /'SET', REOPEN_START_KEY, [^\n]*'NX'/);
  // admin から取消・リセットの action を生やさない
  for (const bad of [/'reopenClear'/, /'reopenReset'/, /'reopenCancel'/, /'reopenUpdate'/]) {
    assert.ok(!bad.test(ADMIN_FN), `admin に取消系 action がある: ${bad}`);
  }
});

test('有効期限の計算式を書き写さない（14 日はクーポン定義だけが持つ）', () => {
  assert.match(COUPON_LIB, /expiryDays:\s*14/);
  // 判定モジュール側は日数を持たない（既定値のフォールバック表示を除く）
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
  // 「2026-…」のような具体日を定義へ埋め込んでいない
  assert.ok(!/reopenStartsAt:\s*['"]\d{4}-/.test(COUPON_LIB));
});

test('保存先の鍵名は 1 か所（他のファイルで文字列を書き写さない）', () => {
  assert.match(STORE_LIB, /REOPEN_START_KEY = `\$\{REOPEN_NAMESPACE\}:start`/);
  for (const src of [COUPON_LIB, START_LIB, ADMIN_FN, BANK_FN]) {
    assert.ok(!/ak:pp:reopen/.test(src), '鍵名を書き写している');
  }
});

test('確認ダイアログの文言はサーバーが配る（画面で作り直さない）', () => {
  const page = read('../../pages/admin/premium-plus-eligibility.astro');
  // 文言の実体は判定モジュールにだけある
  assert.match(START_LIB, /REOPEN_START_CONFIRM_TEXT = \[/);
  assert.match(START_LIB, /confirmText: REOPEN_START_CONFIRM_TEXT/);
  // 画面はサーバーが返した文字列を使う（受け取れていなければ押させない）
  assert.match(page, /st\.confirmText/);
  assert.match(page, /if \(!st\.confirmText\)/);
  // 画面側に独自コピーを持たせない
  assert.ok(!/再募集を開始します。/.test(page), '確認文言を画面側で組み立てている');
  // ⚠️ 判定モジュールを client bundle へ入れない（共通クーポン基盤が node:crypto に依存する）
  const clientImports = page.slice(page.indexOf('<script>'), page.indexOf('<script is:inline>'));
  assert.ok(!/premiumPlusReopenStart/.test(clientImports), 'client へ import している');
  // ボタンは startable のときだけ出す
  assert.match(page, /st\.startable !== true/);
  // 押下時に時刻を送っていない
  assert.match(page, /call\(\{ action: 'reopenStart', actor \}\)/);
});

test('判定モジュールは I/O を持たない（純粋のまま）', () => {
  for (const bad of [/\bfetch\(/, /@netlify\/blobs/, /UPSTASH/, /process\.env/]) {
    assert.ok(!bad.test(START_LIB), `純粋モジュールに I/O が入った: ${bad}`);
  }
});
