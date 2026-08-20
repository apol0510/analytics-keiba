/**
 * pauseCouponWiring.guard.test.mjs — 受付休止ページ / クーポン取得の**配線**を固定する
 *
 * ロジック本体は premiumPlusReopenCoupon / premiumPlusPauseNotice のテストが見る。
 * ここは「実際にその単一源を通っているか」「余計なことをしていないか」を
 * ソースの構造として検査する（判定を書き写した第 2 の経路が生まれるのを防ぐ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 説明コメントを落として**実コード**だけを見る（注意書きが検査に引っかからないように） */
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const API = read('../../pages/api/premium-plus-coupon.json.js');
const COUPON_PAGE = read('../../pages/premium-plus-coupon.astro');
const PRODUCT_PAGES = {
  'premium-plus.astro': read('../../pages/premium-plus.astro'),
  'premium-plus-v2.astro': read('../../pages/premium-plus-v2.astro'),
};
const ADMIN_FN = read('../../../netlify/functions/premium-plus-eligibility.js');
const ADMIN_PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const BANK_FN = read('../../../netlify/functions/bank-transfer-application.js');
const COUPON_LIB = read('./premiumPlusReopenCoupon.js');
const NOTICE_PAGE_LIB = read('./premiumPlusPauseNoticePage.js');

// ── 1. 申込 Function は一切変えていない ──────────────────────────
test('申込 Function は販売停止で 403 sale_paused / sideEffects:none のまま', () => {
  assert.match(BANK_FN, /code:\s*'sale_paused'/);
  assert.match(BANK_FN, /sideEffects:\s*'none'/);
  assert.match(BANK_FN, /statusCode:\s*403/);
  assert.match(BANK_FN, /normalizeSalePaused\(plusCustomerFields\[PP_SALE_PAUSE_FIELDS\.PAUSED\]\)/);
  // クーポンで申込制限を迂回できる経路を作っていない
  assert.doesNotMatch(BANK_FN, /ReopenCoupon/);
});

// ── 2. 取得 API の認可 ─────────────────────────────────────────
test('取得 API は ak_session を検証し、対象は必ずセッション由来の recordId', () => {
  assert.match(API, /verifyPlanAccess\(/);
  assert.match(API, /const recordId = access\.payload\?\.sub \|\| '';/);
  // body の id / email を対象にしない（他会員への発行を構造的に禁止）
  assert.doesNotMatch(API, /body\.(recordId|record_id|id|email)/);
  assert.doesNotMatch(API, /body && body\.(recordId|email)/);
});

test('取得 API は単一源の判定だけを使い、条件を書き直さない', () => {
  const code = stripComments(API);
  assert.match(code, /resolveUpsellForCustomer\(/);
  assert.match(code, /resolveCouponClaimDecision\(/);
  // 停止フラグ・資格を API 側で直接解釈しない
  assert.doesNotMatch(code, /SalePaused/);
  assert.doesNotMatch(code, /PremiumPlusEligibility/);
  assert.doesNotMatch(code, /showPurchaseCta|purchaseEnabled/);
});

test('取得 API は POST だけ（GET でプリフェッチ取得させない）', () => {
  assert.match(API, /export async function POST\(/);
  assert.match(API, /export function GET\(\)\s*\{\s*\n?\s*return notFound\(\);/);
});

test('取得 API は対象外に 404（存在を漏らさない・401/403 を使わない）', () => {
  assert.match(API, /COUPON_CLAIM_REJECT\.NOT_ELIGIBLE\) return notFound\(\)/);
  assert.doesNotMatch(API, /status:\s*40[13]/);
});

// ── 3. 取得 API の副作用 ───────────────────────────────────────
test('取得 API はクーポン 3 フィールド以外を PATCH できない', () => {
  assert.match(API, /assertOnlyCouponFields\(fields\)/);
  assert.match(API, /buildReopenCouponClaimFields\(/);
  // PATCH は Customers の 1 レコードだけ。他テーブルへ書かない
  assert.equal((API.match(/method:\s*'PATCH'/g) || []).length, 1);
  assert.doesNotMatch(API, /method:\s*'POST'[\s\S]{0,200}airtable/i);
  assert.doesNotMatch(API, /PromotionalOffers|ScheduledEmails|CampaignDeliveries/);
});

test('取得 API はメール送信・queue 登録・課金・昇格を一切しない', () => {
  const code = stripComments(API);
  assert.doesNotMatch(code, /sendgrid|SENDGRID|mail\.send|sendMail|sendEmail/i);
  assert.doesNotMatch(code, /queue|Queue|schedule|Schedule|dispatch/);
  assert.doesNotMatch(code, /プラン|有効期限|PaidAt|PaymentConfirmed|PaymentEmailSent/);
  assert.doesNotMatch(code, /stripe|Stripe|paypal|PayPal|price|amount/i);
});

test('取得 API は保存できなければ「取得した」と言わない（fail closed）', () => {
  assert.match(API, /if \(!wrote\)/);
  assert.match(API, /claimed: false,\s*\n?\s*code: COUPON_CLAIM_REJECT\.STORAGE_UNAVAILABLE/);
});

// ── 4. 商品ページの直 URL ─────────────────────────────────────
for (const [name, src] of Object.entries(PRODUCT_PAGES)) {
  test(`${name}: 休止案内は単一源で判定し、購入導線を持たない`, () => {
    assert.match(src, /ppUpsell\.pauseNotice\?\.showPauseNotice === true/);
    assert.match(src, /renderPauseNoticeHtml\(/);
    // ページ側で停止・資格の条件を書き直さない
    const gate = src.slice(src.indexOf('!ppRelease.showProductPage'), src.indexOf('const ppIntake'));
    assert.doesNotMatch(gate, /SalePaused|PremiumPlusEligibility|phase4/);
    // 休止分岐で計測・課金・メールを走らせない
    assert.doesNotMatch(gate, /recordPlusPageView|sendgrid/i);
  });

  test(`${name}: 休止ページも会員別レスポンスとして CDN に共有させない`, () => {
    const gate = src.slice(src.indexOf('!ppRelease.showProductPage'), src.indexOf('const ppIntake'));
    assert.match(gate, /'Cache-Control': 'private, no-store'/);
    assert.match(gate, /Vary: 'Cookie'/);
    assert.match(gate, /'X-Robots-Tag': 'noindex, nofollow'/);
  });
}

// ── 5. クーポンページ ─────────────────────────────────────────
test('クーポンページは認可 → 本人 1 件のみ参照（他会員は構造的に見えない）', () => {
  assert.match(COUPON_PAGE, /verifyPlanAccess\(/);
  assert.match(COUPON_PAGE, /recordId: access\.payload\?\.sub \|\| null/);
  // 一覧・検索・他人指定の経路を持たない
  assert.doesNotMatch(COUPON_PAGE, /filterByFormula|listRecords|fetchAll|Astro\.url\.searchParams/);
});

test('クーポンページは対象外に 404（存在秘匿）で、購入導線を持たない', () => {
  assert.match(COUPON_PAGE, /if \(!coupon\.claimed && !noticeTarget\) return notFound\(\);/);
  assert.match(COUPON_PAGE, /status:\s*404/);
  assert.doesNotMatch(COUPON_PAGE, /openBankModal|showPurchaseCta|68000|98000/);
});

test('停止解除後は新規取得させない（取得 CTA は案内対象のときだけ）', () => {
  assert.match(COUPON_PAGE, /claimable: noticeTarget/);
});

// ── 6. 管理画面 ───────────────────────────────────────────────
test('管理 Function: クーポンは資格・停止と別の軸として行に載る', () => {
  assert.match(ADMIN_FN, /readReopenCoupon\(fields\)/);
  assert.match(ADMIN_FN, /reopenCouponClaimed: reopenCoupon\.claimed === true/);
  assert.match(ADMIN_FN, /reopenCouponClaimedAt: reopenCoupon\.claimedAtIso/);
  assert.match(ADMIN_FN, /reopenCouponClaimed: rows\.filter\(\(r\) => r\.reopenCouponClaimed === true\)\.length/);
  // 既存の軸を書き換えていない
  assert.match(ADMIN_FN, /salePaused: member\.salePaused === true/);
  assert.match(ADMIN_FN, /overrideApplied: axis\.overrideApplied/);
});

test('管理 Function: クーポン取得を書き込む経路を持たない（顧客の操作でしか増えない）', () => {
  assert.doesNotMatch(ADMIN_FN, /buildReopenCouponClaimFields/);
  assert.doesNotMatch(ADMIN_FN, /PremiumPlusReopenCouponClaimedAt['"]\s*:/);
});

test('管理画面: クーポンは独立したフィルタ・件数・バッジで、既存の軸を置き換えない', () => {
  assert.match(ADMIN_PAGE, /id="fCoupon"/);
  assert.match(ADMIN_PAGE, /function couponBadge\(r\)/);
  assert.match(ADMIN_PAGE, /r\.reopenCouponClaimed !== true\) return null/);
  assert.match(ADMIN_PAGE, /c\.reopenCouponClaimed/);
  // 資格バッジ・停止バッジを消していない
  assert.match(ADMIN_PAGE, /function pauseBadge\(r\)/);
  assert.match(ADMIN_PAGE, /const pb = pauseBadge\(r\);/);
  // 詳細にも出る
  assert.match(ADMIN_PAGE, /再募集クーポン/);
  assert.match(ADMIN_PAGE, /r\.reopenCouponClaimedAt/);
});

// ── 7. 個人名・アドレスの直書きが無い ────────────────────────────
test('特定の会員名・メールアドレスを直書きしていない', () => {
  // 今回追加したファイルと、商品ページに**追加した分岐**だけを見る
  // （商品ページ本体には既存の問い合わせ先アドレス等があり、今回の対象外）
  const sources = { API, COUPON_PAGE, COUPON_LIB, NOTICE_PAGE_LIB };
  for (const [name, src] of Object.entries(PRODUCT_PAGES)) {
    sources[`${name}(休止分岐)`] = src.slice(
      src.indexOf('!ppRelease.showProductPage'), src.indexOf('const ppIntake'));
  }
  for (const [name, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    assert.doesNotMatch(src, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${name}: メールアドレスの直書き`);
    assert.doesNotMatch(src, /Daniel|ダニエル/i, `${name}: 個人名の直書き`);
    assert.doesNotMatch(src, /\brec[A-Za-z0-9]{14}\b/, `${name}: Airtable recordId の直書き`);
  }
});

// ── 8. 割引条件を勝手に作っていない ─────────────────────────────
test('価格・割引額の数値は単一源だけが持つ（他のファイルは文字列を受け取るだけ）', () => {
  // 単一源: 割引額は 1 か所、通常価格は価格の正本を参照して引き算で導く
  assert.match(COUPON_LIB, /PP_REOPEN_COUPON_DISCOUNT_YEN = 10000/);
  assert.match(COUPON_LIB, /REGULAR_PRICE\.premium_plus - PP_REOPEN_COUPON_DISCOUNT_YEN/);
  assert.doesNotMatch(COUPON_LIB, /offerPrice:\s*58000/, '適用価格を直書きしている');
  assert.doesNotMatch(COUPON_LIB, /regularPrice:\s*68000/, '通常価格を直書きしている');

  // 表示側・API・ページは数値を持たない
  for (const [name, src] of Object.entries({ NOTICE_PAGE_LIB, API, COUPON_PAGE })) {
    assert.doesNotMatch(src, /68000|58000|10000|98000/, `${name}: 金額を直書きしている`);
    assert.doesNotMatch(src, /offerPrice:\s*[0-9]/, `${name}: 価格を作っている`);
    assert.doesNotMatch(src, /discountValue:\s*[0-9]/, `${name}: 割引額を作っている`);
  }
  // 条件は確定済み・期限だけ未確定
  assert.match(COUPON_LIB, /determined:\s*true/);
  assert.match(COUPON_LIB, /expiresDetermined:\s*false/);
});
