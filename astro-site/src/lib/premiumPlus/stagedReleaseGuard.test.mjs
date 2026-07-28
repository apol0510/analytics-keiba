/**
 * stagedReleaseGuard.test.mjs — Premium Plus 段階公開の配線を source レベルで固定する guard
 *   node --test src/lib/premiumPlus/stagedReleaseGuard.test.mjs
 *
 * 検知したい事故:
 *   - phase 判定が実績（的中 / 不的中）に連動してしまう
 *   - PHASE 1/2 で商品ページが 404 されなくなる（段階公開の迂回）
 *   - 購入 CTA が phase 判定を外れて常時表示に戻る
 *   - 受付 CLOSED でも購入操作ができてしまう
 *   - 商品ページの本文コピーが段階公開の実装ついでに書き換わる
 *   - 三連複会員ページ（静的 HTML）に Premium Plus の文言・価格・リンクが載る（存在秘匿の破れ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 「コメントで言及しているだけ」を誤検知しないようコメントを落とす。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RELEASE_LIB = read('./premiumPlusRelease.js');
const LOOKUP_LIB = read('./purchaseAnchorLookup.js');
const ENDPOINT = read('../../pages/api/premium-plus-stage.json.js');
const TEASER = read('../../components/PremiumPlusStageTeaser.astro');
const PRODUCT_PAGES = {
  'premium-plus.astro': read('../../pages/premium-plus.astro'),
  'premium-plus-v2.astro': read('../../pages/premium-plus-v2.astro'),
};
const SANRENPUKU_PAGES = {
  'premium-sanrenpuku.astro': read('../../pages/premium-sanrenpuku.astro'),
  'premium-sanrenpuku-jra.astro': read('../../pages/premium-sanrenpuku-jra.astro'),
};

// ── 実績と販売タイミングを連動させない ────────────────────────────────
test('phase 判定モジュールは実績台帳を読まない（的中/不的中で phase が動かない）', () => {
  const code = stripComments(RELEASE_LIB);
  assert.doesNotMatch(code, /premiumPlusResults/);
  assert.doesNotMatch(code, /archiveResults/);
  assert.doesNotMatch(code, /isHit|payout/);
  // import は 1 つも持たない純粋モジュール
  assert.doesNotMatch(code, /^\s*import\s/m);
});

test('取得層は Airtable を読むだけ（書き込み系メソッドを持たない）', () => {
  assert.doesNotMatch(LOOKUP_LIB, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i);
  assert.match(LOOKUP_LIB, /Customers/);
});

// ── ページ配線 ────────────────────────────────────────────────────────
for (const [name, src] of Object.entries(PRODUCT_PAGES)) {
  const fm = src.slice(0, src.indexOf('\n---', 3) + 4);

  test(`${name}: 段階公開の単一源を通す`, () => {
    assert.match(fm, /resolvePremiumPlusRelease\s*\(/);
    assert.match(fm, /lookupSanrenpukuPaidAt\s*\(/);
  });

  test(`${name}: PHASE 3 未満は 404（段階公開を迂回できない）`, () => {
    assert.match(fm, /if\s*\(\s*!ppRelease\.showProductPage\s*\)/);
    const gate = fm.slice(fm.indexOf('!ppRelease.showProductPage'));
    assert.match(gate.slice(0, 400), /status:\s*404/);
    // 認可ゲートと同じく 401/403 は使わない（存在を漏らさない）
    assert.doesNotMatch(fm, /status:\s*40[13]/);
  });

  test(`${name}: 購入 CTA は showPurchaseCta でのみ描画される`, () => {
    // 価格表示・購入ボタン・固定 CTA がすべて phase 判定の下にある
    assert.match(src, /ppRelease\.showPurchaseCta\s*\?/);
    assert.match(src, /\{ppRelease\.showPurchaseCta\s*&&/);
    assert.equal(
      (src.match(/onclick="openBankModal\(\)"/g) || []).length,
      (src.match(/onclick="openBankModal\(\)"\s+disabled=\{!ppRelease\.purchaseEnabled\}/g) || []).length,
      '購入ボタンに purchaseEnabled の disabled が付いていないものがある'
    );
  });

  test(`${name}: CLOSED で申込モーダルを開けない（JS 側の二重防御）`, () => {
    assert.match(src, /data-pp-purchase=\{ppRelease\.purchaseEnabled \? '1' : '0'\}/);
    assert.match(src, /PP_PURCHASE_ENABLED\s*=\s*document\.documentElement\.dataset\.ppPurchase === '1'/);
    assert.match(src, /function openBankModal\(\)\s*\{\s*\n?\s*if \(!PP_PURCHASE_ENABLED\) return;/);
  });

  test(`${name}: 受付準備中の文言は単一源から取る（ページに直書きしない）`, () => {
    assert.match(src, /PP_RELEASE_COPY\.preparing\.title/);
    assert.match(src, /PP_RELEASE_COPY\.preparing\.body/);
    assert.doesNotMatch(src, /受付準備中です<|>受付準備中/);
  });

  test(`${name}: 本文コピーと価格定数が変更されていない`, () => {
    for (const phrase of [
      'const PRICE = 68000;',
      'const LIST_PRICE = 98000;',
      '◆ Premium Sanrenpuku 会員 特別価格',
      '単品購入（サブスクリプションではありません）',
      '入金確認後、AI が厳選した 1 鞍の買い目をお届けします。',
      '🏦 銀行振込で購入する',
      '🔓 本日の1鞍を抽出する',
      '買い切り・追加課金なし',
      '平日は南関、土日は中央（JRA）。',
      '掲載している画像は、実際に投票した投票内容照会のスクリーンショットです。',
    ]) {
      assert.ok(src.includes(phrase), `本文が失われている: ${phrase}`);
    }
  });
}

// ── エンドポイント（存在秘匿）──────────────────────────────────────
test('stage エンドポイント: 認可 NG と PHASE 1 はどちらも 404', () => {
  assert.match(ENDPOINT, /export const prerender = false/);
  assert.match(ENDPOINT, /verifyPlanAccess\s*\(/);
  assert.match(ENDPOINT, /if \(!access\.ok\) return notFound\(\);/);
  assert.match(ENDPOINT, /if \(!release\.showTeaser\) return notFound\(\);/);
  assert.match(ENDPOINT, /status:\s*404/);
  assert.doesNotMatch(ENDPOINT, /status:\s*40[13]/);
  assert.match(ENDPOINT, /private, no-store/);
});

test('stage エンドポイント: 価格・口座情報を返さない', () => {
  assert.doesNotMatch(stripComments(ENDPOINT), /68,?000|98,?000|PRICE|振込|口座/);
});

test('stage エンドポイント: 商品ページ URL は PHASE 3 以降だけ返す', () => {
  assert.match(ENDPOINT, /release\.phase >= PP_PHASE\.PREVIEW \? PRODUCT_HREF : null/);
});

// ── 静的な三連複会員ページに Premium Plus を載せない ────────────────
test('予告コンポーネント: 静的マークアップに商品名・価格・リンクを持たない', () => {
  const body = TEASER.slice(TEASER.indexOf('\n---', 3) + 4); // frontmatter の説明コメントを除く
  assert.doesNotMatch(body, /68,?000|98,?000|¥/);
  assert.doesNotMatch(body, /Premium Plus/);
  assert.doesNotMatch(body, /href="\/premium-plus/);
  // 文言は SSR から取得する
  assert.match(body, /fetch\('\/api\/premium-plus-stage\.json'/);
});

for (const [name, src] of Object.entries(SANRENPUKU_PAGES)) {
  test(`${name}: 静的 HTML に Premium Plus の価格・商品リンクを出さない`, () => {
    // frontmatter（過去の経緯コメントに 68000 の記述がある）を除いたテンプレート本体を検査する
    const body = src.slice(src.indexOf('\n---', 3) + 4);
    assert.doesNotMatch(body, /68,?000|98,?000/);
    assert.doesNotMatch(body, /href="\/premium-plus/);
    assert.match(body, /<PremiumPlusStageTeaser \/>/);
  });
}
