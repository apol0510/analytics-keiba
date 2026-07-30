/**
 * offerIntakeFunction.guard.test.mjs — offer 申込経路の安全条件をソースで固定する
 *   node --test src/lib/promotions/offerIntakeFunction.guard.test.mjs
 *
 * 対象: netlify/functions/offer-lookup.js / offer-application.js / src/pages/offer/index.astro
 *
 * 「実装を後から書き換えても壊せない」性質:
 *   1. offer-lookup は 1 バイトも書かない（read-only）
 *   2. offer-application が Customers へ書くのは buildApplicationFields() の戻り値だけ。
 *      権限・課金フィールド（プラン / 有効期限 / Status='active' / PaymentConfirmed=true /
 *      PaidAt / PaymentEmailSent / LifetimeSanrenpuku / WithdrawalRequested）を書かない
 *   3. プランと請求額をフォーム入力から作らない（offer 台帳が唯一の出所）
 *   4. gate（COMEBACK_OFFER_TABLE_READY / PROMO_OFFER_SECRET）が無ければ閉じる
 *   5. 生のトークンをログへ出さない
 *   6. ページは noindex で、ログイン必須にしない（退会者が申し込めるため）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OFFER_FORBIDDEN_FIELDS } from './promotionalOffer.js';

function load(rel) {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  return {
    src,
    /** コメントを除いた実コード（説明文で guard が誤検知しないようにする） */
    code: src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  };
}

const lookup = load('../../../netlify/functions/offer-lookup.js');
const apply = load('../../../netlify/functions/offer-application.js');
const page = load('../../pages/offer/index.astro');
const robots = readFileSync(fileURLToPath(new URL('../../../public/robots.txt', import.meta.url)), 'utf8');

// ── 1. lookup は read-only ──────────────────────────────────────

test('1. offer-lookup は書き込みメソッドを一切使わない', () => {
  for (const m of ['PATCH', 'PUT', 'DELETE']) {
    assert.equal(lookup.code.includes(`'${m}'`), false, `${m} を使っている`);
  }
  // Airtable への POST（レコード作成）も無い。POST は自身の httpMethod 判定だけ
  assert.equal(/method:\s*'POST'/.test(lookup.code), false, 'Airtable へ POST している');
  assert.equal(lookup.code.includes('Customers'), false, 'Customers を読んでいる（不要な PII 取得）');
});

test('1-b. offer-lookup は完全なメールアドレスや内部 ID を返さない', () => {
  // レスポンスに載せるのは buildOfferPresentation の戻り値（伏せ字済み）だけ
  assert.ok(lookup.code.includes('buildOfferPresentation'));
  assert.ok(/json\(200,\s*\{\s*ok:\s*true,\s*state:\s*'valid',\s*offer:\s*presentation\s*\}\)/.test(lookup.code),
    '成功レスポンスが presentation 以外を返している');
  for (const m of lookup.code.matchAll(/json\([^)]*\)/g)) {
    assert.equal(/verified\.offer|\.fields|record\b/.test(m[0]), false,
      `検証済み offer / Airtable の生レコードを返している: ${m[0]}`);
  }
  for (const f of ['TokenHash', 'CustomerRecordId']) {
    assert.equal(lookup.code.includes(f), false, `${f} を扱っている`);
  }
});

// ── 2. application が Customers へ書く内容 ─────────────────────────

test('2. Customers への PATCH は buildApplicationFields() の戻り値だけ', () => {
  assert.ok(apply.code.includes('buildApplicationFields'), '単一源を経由していない');
  // PATCH に渡す `fields` は buildApplicationFields() の戻り値そのもの（別代入で差し替えられない）
  const bindings = [...apply.code.matchAll(/\bconst\s+fields\s*=\s*([\s\S]{0,40})/g)];
  assert.equal(bindings.length, 1, `fields への代入が複数ある: ${bindings.length}`);
  assert.match(bindings[0][1], /^buildApplicationFields\(\{/, 'fields が単一源の戻り値ではない');
  // PATCH は Customers と PromotionalOffers の 2 か所だけ
  const patches = [...apply.code.matchAll(/method:\s*'PATCH'/g)];
  assert.equal(patches.length, 2, `想定外の PATCH 数: ${patches.length}`);
  // Customers への PATCH body は fields 変数（= buildApplicationFields の戻り値）
  assert.ok(/body:\s*JSON\.stringify\(\{\s*fields,\s*typecast:\s*true\s*\}\)/.test(apply.code));
  // インラインでフィールドを組み立てた PATCH が無い
  assert.equal(/fields:\s*\{\s*'/.test(apply.code), false, 'フィールドを直書きしている');
});

test('2-b. 権限・課金フィールド名がコードに現れない', () => {
  const banned = [
    ...OFFER_FORBIDDEN_FIELDS.filter((f) => !f.startsWith('Requested')),
    'PaidAt', 'PaymentEmailSent', 'LifetimeSanrenpuku', 'WithdrawalRequested',
    'PromoLight', 'PromoPremium',
  ];
  for (const f of banned) {
    assert.equal(apply.code.includes(`'${f}'`), false, `${f} を書いている`);
    assert.equal(apply.code.includes(`"${f}"`), false, `${f} を書いている`);
  }
  // Status='active' への昇格をこの Function から行わない
  assert.equal(/Status['"]?\s*[:=]\s*['"]active['"]/.test(apply.code), false, 'active へ昇格している');
  assert.equal(/PaymentConfirmed['"]?\s*[:=]\s*true/.test(apply.code), false, 'PaymentConfirmed を立てている');
});

// ── 3. 価格・プランの出所 ───────────────────────────────────────

test('3. プラン・請求額は resolveOfferApplication の戻り値だけを使う', () => {
  assert.ok(apply.code.includes('resolveOfferApplication'));
  assert.ok(/planName:\s*app\.requestedPlan/.test(apply.code));
  assert.ok(/planType:\s*app\.requestedPlanType/.test(apply.code));
  assert.ok(/amount:\s*app\.requestedAmount/.test(apply.code));
  // フォームの申告値・商品名からプランや金額を導かない
  assert.equal(apply.code.includes('form.productName'), false, 'productName からプランを導いている');
  assert.equal(apply.code.includes('form.transferAmount'), false, '申告金額を直接使っている');
  assert.equal(/amount:\s*(reportedAmount|form\.)/.test(apply.code), false, '申告金額を請求額にしている');
});

test('3-b. 顧客レコードは email 一致を確認してから書く', () => {
  assert.ok(apply.code.includes('recEmail === app.email') || apply.code.includes('app.email === recEmail'),
    'CustomerRecordId の email 突合が無い');
  // 見つからないときに推測で新規作成しない
  assert.equal(/method:\s*'POST'[\s\S]{0,200}Customers/.test(apply.code), false, 'Customers を新規作成している');
  assert.ok(apply.code.includes('見つからない') || apply.code.includes('409'));
});

// ── 4. gate ────────────────────────────────────────────────────

test('4. 両 Function が gate を通る（未整備なら 503）', () => {
  for (const [name, f] of [['offer-lookup', lookup], ['offer-application', apply]]) {
    assert.ok(f.code.includes('isOfferTableEnabled(process.env)'), `${name}: 台帳 gate が無い`);
    assert.ok(f.code.includes('getOfferSecret(process.env)'), `${name}: 署名鍵 gate が無い`);
    assert.ok(f.code.includes('503'), `${name}: gate が閉じたときの 503 が無い`);
  }
});

test('4-b. token 検証は共通の verifyOfferToken を使い、Function 内で再実装しない', () => {
  for (const [name, f] of [['offer-lookup', lookup], ['offer-application', apply]]) {
    assert.ok(f.code.includes('verifyOfferToken'), `${name}: 検証を委譲していない`);
    assert.equal(f.code.includes('createHmac'), false, `${name}: HMAC を再実装している`);
    assert.equal(f.code.includes('timingSafeEqual'), false, `${name}: 比較を再実装している`);
  }
  // 申込側は「フォームの email と offer の email が一致するか」を必ず渡す
  assert.ok(/verifyOfferToken\(\{[^}]*claimedEmail[^}]*\}\)/.test(apply.code), 'claimedEmail を渡していない');
});

test('4-c. redeem は buildRedeemFields + allowlist 検査を通す', () => {
  assert.ok(apply.code.includes('buildRedeemFields'));
  assert.ok(apply.code.includes('assertOnlyOfferFields'));
});

// ── 5. トークンをログに残さない ──────────────────────────────────

test('5. 生のトークンをログへ出さない', () => {
  for (const [name, f] of [['offer-lookup', lookup], ['offer-application', apply]]) {
    for (const m of f.code.matchAll(/console\.(log|warn|error)\(([\s\S]*?)\);/g)) {
      const args = m[2];
      // 値としての token（変数そのもの / テンプレート埋め込み）が引数に混ざっていないか。
      // メッセージ文字列に "token" という単語が入るのは可（値ではない）。
      assert.equal(/\$\{\s*token\s*\}/.test(args), false, `${name}: token を埋め込んでいる: ${args}`);
      assert.equal(/(^|[,{(:]\s*)token\s*($|[,})])/.test(args), false, `${name}: token を渡している: ${args}`);
    }
  }
});

// ── 6. ページ ──────────────────────────────────────────────────

test('6. /offer/ は noindex かつ robots.txt で Disallow', () => {
  assert.ok(/noindex=\{true\}/.test(page.src), 'noindex が無い');
  assert.ok(robots.includes('Disallow: /offer/'), 'robots.txt に Disallow が無い');
});

test('6-b. /offer/ はログイン必須にしない（退会者が申し込めるため）', () => {
  // 判定はコメントを除いた実コードで行う（設計意図の説明文で誤検知しないように）
  assert.equal(page.code.includes('AccessControl'), false, 'AccessControl を置いている');
  assert.equal(page.code.includes('requiredPlan'), false);
  assert.equal(/location\.href\s*=\s*['"]\/login/.test(page.code), false, 'ログインへリダイレクトしている');
});

test('6-c. ページは価格をハードコードせず、lookup の戻り値だけを表示する', () => {
  // 金額の数値リテラルを埋め込まない（口座番号は除く）
  const withoutBank = page.src.replace(/5338892/g, '');
  assert.equal(/¥\s*\d{1,3},\d{3}/.test(withoutBank), false, '価格をハードコードしている');
  assert.ok(page.src.includes('offer-lookup'));
  assert.ok(page.src.includes('offer-application'));
  // 既存の通常価格経路へは投げない
  assert.equal(page.src.includes('bank-transfer-application'), false, '通常価格の申込 Function を呼んでいる');
});

test('6-d. ページは入金済みチェックを必須で送る（3 点セット）', () => {
  assert.ok(page.src.includes('offerPaymentConfirm'));
  assert.ok(/paymentCompletedConfirm:\s*el\('offerPaymentConfirm'\)\.checked/.test(page.src),
    'paymentCompletedConfirm を送っていない');
  assert.ok(page.src.includes('未来の日付は指定できません'), '未来日ガードが無い');
});
