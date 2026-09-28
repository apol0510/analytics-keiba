/**
 * lightUpgradeCta.test.mjs — Light 会員の Premium アップグレード導線は /pricing/・年払いは ¥44,820 に統一（2026-09-28 MK 確定）
 *
 * 経緯: Light ページの CTA「⬆️ Premiumにアップグレード」が /premium-upgrade/ を指し、そこでは年払い ¥49,800
 *       （乗り換え特典なし）が出ていた。/pricing/ の Light 表示は乗り換え特典 ¥44,820。
 *       同じ Light 会員が入口によって 2 つの価格を見ていた。
 * 決定: 正規導線は /pricing/。年払いは乗り換え特典 ¥44,820 に統一。
 *       ⚠️ Premium 30 日 ¥18,000・買い切り ¥78,000 等の既存商品は廃止しない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');

test('Light ページ（南関・中央）の Premium アップグレード CTA は /pricing/ を指す', () => {
  for (const f of ['src/pages/light-predictions.astro', 'src/pages/light-predictions-jra.astro']) {
    const src = read(f);
    assert.equal(src.includes('href="/premium-upgrade/"'), false, `${f}: /premium-upgrade/ を指している`);
    assert.match(src, /<a href="\/pricing\/" class="btn-purchase-modal">/, f);
  }
});

test('/premium-upgrade/ の年払いは乗り換え特典 ¥44,820（¥49,800 で申し込ませない）', () => {
  const src = read('src/pages/premium-upgrade.astro');
  assert.equal(/openBankModal\([^)]*49800/.test(src), false, '¥49,800 の申込ボタンが残っている');
  assert.match(src, /<div class="plan-card-price">¥44,820<\/div>/);
  assert.match(src, /<span class="final-option-price">¥44,820<\/span>/);
  assert.match(src, /<a class="cta-button cta-secondary" href="\/pricing\/">/);
});

test('既存商品は廃止しない（買い切り ¥78,000・30 日 ¥18,000 は残る）', () => {
  const src = read('src/pages/premium-upgrade.astro');
  assert.match(src, /openBankModal\('Premium 買い切り \(Light会員アップグレード\)', 78000, 'lifetime'\)/);
  assert.match(src, /openBankModal\('Premium 30日 \(Light会員アップグレード\)', 18000, 'monthly'\)/);
});

test('/pricing/ の Light 向け乗り換え特典（¥44,820・Premium Annual - Campaign）は変えていない', () => {
  const src = read('src/pages/pricing.astro');
  assert.match(src, /openBankModal\('Premium Annual - Campaign', 44820, 'annual'\)/);
});
