/**
 * dashboardCouponCard.test.mjs — マイページの「取得済みクーポン」カード
 *
 * 固定する仕様:
 *   - 取得済み**本人だけ**に出る（未取得はカードごと出さない）
 *   - 他会員の情報が出る経路が無い（対象はセッション由来の 1 件のみ）
 *   - 取得日時は JST・時刻まで
 *   - `/premium-plus-coupon/` への導線がある
 *   - 価格・割引率・期限を dashboard 側でハードコードしない
 *   - 表示によって salePaused / eligibility / override / PHASE / plan / payment を変えない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const DASH = read('../../pages/dashboard.astro');
const API = read('../../pages/api/upsell.json.js');
const CLIENT = read('../upsell/upsellClient.js');

const {
  describeCouponForMember, readReopenCoupon, PP_REOPEN_COUPON_FIELDS, PP_REOPEN_COUPON,
} = await import('./premiumPlusReopenCoupon.js');
const { formatClaimedAtJst, COUPON_PAGE_PATH } = await import('./premiumPlusPauseNoticePage.js');

// ── 表示モデル（単一源）────────────────────────────────────────
test('取得済みなら名称・利用時期・条件文が単一源から出る', () => {
  const held = readReopenCoupon({
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
  });
  const v = describeCouponForMember({ coupon: held, paused: true, claimable: false });
  assert.equal(v.claimed, true);
  assert.equal(v.name, PP_REOPEN_COUPON.name);
  assert.ok(v.usableNote.length > 0);
  assert.ok(v.termsText.length > 0);
  // マイページからは新規取得させない
  assert.equal(v.showClaimCta, false);
});

test('確定条件が表示モデルから出る（10,000円OFF / 68,000円 → 58,000円）', () => {
  const v = describeCouponForMember({ coupon: { claimed: true }, paused: true, claimable: false });
  assert.equal(v.termsDetermined, true);
  assert.equal(v.discountText, '10,000円OFF');
  assert.equal(v.priceText, '通常 68,000円 → 58,000円');
  // 有効期限だけは未確定のまま
  assert.equal(v.expiryDetermined, false);
  // ルールは確定（募集再開日から14日）だが、開始日が未定なので**具体的な日付は出さない**
  assert.match(v.expiryText, /14日間/);
  assert.doesNotMatch(v.expiryText, /\d{4}-\d{2}-\d{2}|\d+月\d+日/);
});

test('取得日時は JST・時刻まで（UTC 基準で日付をズラさない）', () => {
  assert.equal(formatClaimedAtJst('2026-08-18T22:07:54.803Z'), '2026年8月19日 07:07');
  assert.match(formatClaimedAtJst('2026-08-18T22:07:54.803Z'), /\d{2}:\d{2}$/);
});

// ── API（本人 1 件だけ・未取得は何も返さない）──────────────────
test('API はセッション由来の recordId しか使わない（他会員のクーポンが出ない）', () => {
  const code = stripComments(API);
  assert.match(code, /recordId: access\.payload\?\.sub \|\| null/);
  assert.doesNotMatch(code, /body\.(recordId|email|id)/);
  assert.doesNotMatch(code, /searchParams/);
});

test('API は「取得できない相手」には条件も名称も返さない（2026-08-22 整合修正）', () => {
  // ⚠️ 旧仕様は「取得済みのときだけカードを返す」だった。
  //    再募集が会員ごとになり、**取得できる相手にはマイページからも取得させる**ため、
  //    `visible`（取得済み or いま取得できる）で返すように変えた。
  //    取得もできず保有もしていない相手には従来どおり最小限しか返さない。
  const code = stripComments(API);
  assert.match(code, /:\s*\{\s*claimed:\s*false,\s*canClaim:\s*false\s*\}/);
  assert.match(code, /readReopenCoupon\(fields\)/);
  assert.match(code, /describeCouponForMember\(/);
  // 取得できるかは**単一源**が決める（API 側で条件を書き直さない）
  assert.match(code, /resolveCouponAccess\(/);
  assert.match(code, /couponAccess\.visible/);
  assert.match(code, /claimable: couponAccess\.canClaim/);
  // ⚠️ 停止フラグで取得可否を決めていない
  assert.ok(!/claimable:\s*[^,\n]*salePaused/.test(code), '停止フラグで取得可否を決めている');
});

test('API は書き込みをしない（表示のためにレコードを変えない）', () => {
  const code = stripComments(API);
  assert.doesNotMatch(code, /method:\s*'(PATCH|POST|PUT|DELETE)'/);
  for (const f of ['PremiumPlusSalePaused', 'PremiumPlusEligibility', 'PremiumPlusReleaseOverride',
    'PremiumPlusEligibleAt', 'プラン', 'PlanType', 'PaidAt', 'PaymentConfirmed']) {
    assert.doesNotMatch(code, new RegExp(`${f}['"]?\\s*:`), `${f} を書いている`);
  }
});

// ── クライアント ────────────────────────────────────────────
test('クライアントは追加の通信をせず、取得できなければ未取得扱い（fail closed）', () => {
  const code = stripComments(CLIENT);
  assert.match(code, /export async function getReopenCoupon\(\)/);
  assert.match(code, /coupon:\s*\{\s*claimed:\s*false\s*\}/);
  // fetch は既存の 1 か所だけ（クーポン用に増やしていない）
  assert.equal((code.match(/fetch\(/g) || []).length, 1);
});

// ── dashboard ───────────────────────────────────────────────
test('dashboard は既定でカードを隠し、取得済み or 取得できるときだけ出す', () => {
  assert.match(DASH, /id="reopen-coupon-section"[^>]*style="display: none;"/);
  const fn = DASH.slice(DASH.indexOf('function renderReopenCoupon'));
  // ⚠️ 2026-08-22: 未取得でも**いま取得できる**ならカードを出す（取得導線をマイページにも置く）
  assert.match(fn.slice(0, 900), /c\.claimed !== true && c\.canClaim !== true\)+\s*\{\s*sec\.style\.display = 'none'; return; \}/);
  // 取得できるかはサーバーの値をそのまま使う（画面で条件を作らない）
  assert.match(fn.slice(0, 1200), /const canClaim = c\.claimed !== true && c\.canClaim === true;/);
});

test('dashboard は表示に必要な項目をすべて出す', () => {
  for (const id of ['reopen-coupon-name', 'reopen-coupon-claimed-at', 'reopen-coupon-usable',
    'reopen-coupon-discount', 'reopen-coupon-price', 'reopen-coupon-expiry']) {
    assert.ok(DASH.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.match(DASH, /取得済みクーポン/);
  assert.match(DASH, /取得日時/);
  assert.match(DASH, /ご利用時期/);
  assert.match(DASH, /有効期限/);
});

test('dashboard に /premium-plus-coupon/ への導線がある', () => {
  assert.match(DASH, /id="reopen-coupon-link"[^>]*href="\/premium-plus-coupon\/"/);
  assert.equal(COUPON_PAGE_PATH, '/premium-plus-coupon/');
  assert.match(DASH, /クーポン詳細を確認/);
});

test('dashboard は価格・割引額をハードコードしない（サーバーの文字列を出すだけ）', () => {
  const card = DASH.slice(DASH.indexOf('reopen-coupon-section'), DASH.indexOf('今日の予想'));
  assert.doesNotMatch(card, /68,?000|58,?000|10,?000|98,?000/, 'カードに金額を直書きしている');
  const fn = DASH.slice(DASH.indexOf('function renderReopenCoupon'), DASH.indexOf('function renderReopenCoupon') + 1400);
  assert.doesNotMatch(fn, /68,?000|58,?000|10,?000/, '描画側に金額を直書きしている');
  // 表示はサーバーが返した文字列をそのまま入れている
  assert.match(fn, /c\.discountText/);
  assert.match(fn, /c\.priceText/);
  assert.match(fn, /c\.expiryText/);
});

test('dashboard に割引・価格・有効期限の枠がある', () => {
  for (const id of ['reopen-coupon-discount', 'reopen-coupon-price', 'reopen-coupon-expiry']) {
    assert.ok(DASH.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.match(DASH, /有効期限/);
});

test('dashboard 側で独自の保有判定を作っていない（サーバーの claimed をそのまま使う）', () => {
  const fn = stripComments(DASH.slice(DASH.indexOf('function renderReopenCoupon'))).slice(0, 1200);
  assert.doesNotMatch(fn, /ReopenCouponClaimedAt|localStorage|user-plan/);
  assert.match(fn, /c\.claimed !== true/);
});

test('dashboard はクーポン表示のために会員レコードを変更しない', () => {
  const code = stripComments(DASH);
  const fn = code.slice(code.indexOf('function renderReopenCoupon'), code.indexOf('function renderReopenCoupon') + 1500);
  assert.doesNotMatch(fn, /fetch\(/);
  assert.doesNotMatch(fn, /PATCH|POST/);
});
