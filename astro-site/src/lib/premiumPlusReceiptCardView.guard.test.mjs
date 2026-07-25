/**
 * premiumPlusReceiptCardView.guard.test.mjs
 *
 * 管理画面プレビュー（renderReceiptCardHtml + premiumPlusReceiptCard.css）が本番カード
 * PremiumPlusReceiptCardV2.astro からドリフトしないことを固定する source ガード。
 *   node --test src/lib/premiumPlusReceiptCardView.guard.test.mjs
 *
 * 検知内容:
 *   1. CSS 単一源: 共有 .css とコンポーネントの <style> が空白正規化で一致（片方だけ編集で fail）
 *   2. レンダラ整合: renderReceiptCardHtml が本番と同じ主要クラス/文言を出す（南関=spat / 中央=jra 両方）
 *   3. HTML エスケープ: 文字列フィールドの < > がエスケープされる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderReceiptCardHtml } from './premiumPlusReceiptCardView.js';
import { deriveCard } from './premiumPlusResults.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// CSS ルールだけを比較するための正規化（コメント除去・空白畳み込み）
function normalizeCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // コメント除去
    .replace(/\s+/g, ' ')              // 空白畳み込み
    .replace(/\s*([{}:;,])\s*/g, '$1') // 記号周りの空白除去
    .trim();
}

test('CSS 単一源: 共有 .css == コンポーネント <style>（空白正規化）', () => {
  const sharedCss = read('../styles/premiumPlusReceiptCard.css');
  const component = read('../components/premium-plus/PremiumPlusReceiptCardV2.astro');
  const m = component.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, 'コンポーネントに <style> が無い');
  assert.equal(
    normalizeCss(sharedCss),
    normalizeCss(m[1]),
    '共有 premiumPlusReceiptCard.css とコンポーネント <style> がドリフトしている（片方を編集したらもう片方も揃える）',
  );
});

test('レンダラ整合: 南関(SPAT4) カードに本番の主要クラス/文言が出る', () => {
  const card = deriveCard({
    date: '2026-07-23', circuit: 'nankan', venue: '大井', raceNumber: 2,
    first: '7', second: '1,3,9', third: '1,2,3,6,9', unitStake: '1000',
    isHit: true, payout: '599000', hitCombo: '7-1-9', receiptNo: '0001',
    receiptAt: '2026年07月23日 15:11',
  });
  const html = renderReceiptCardHtml(card);
  for (const s of [
    'class="pp-evi"', 'pp-circuit nk', '南関', 'class="vref spat"',
    '受付番号', '0001', '受付日時', '購入件数', '1件',
    'レース/式別', '投票金額', '(各1,000円)', '599,000円', '大井2R', '三連単F・12点',
  ]) {
    assert.ok(html.includes(s), `SPAT4 プレビューに "${s}" が無い`);
  }
});

test('レンダラ整合: 中央(JRA) カードに本番の主要クラス/文言が出る', () => {
  const card = deriveCard({
    date: '2026-07-25', circuit: 'chuo', venue: '福島', raceNumber: 11,
    first: '3', second: '4,5', third: '4,5,9', unitStake: '1000', isHit: false,
  });
  const html = renderReceiptCardHtml(card);
  for (const s of [
    'pp-circuit ch', '中央', 'class="vref jra"',
    '合計購入金額', '合計払戻金額', '3連単フォーメーション', 'Japan Racing Association',
  ]) {
    assert.ok(html.includes(s), `JRA プレビューに "${s}" が無い`);
  }
});

test('HTML エスケープ: 文字列フィールドの < > をエスケープする', () => {
  const card = deriveCard({
    date: '2026-07-23', circuit: 'nankan', venue: '大井', raceNumber: 2,
    first: '7', second: '1,3', third: '1,2,3', raceName: '<script>x</script>',
  });
  const html = renderReceiptCardHtml(card);
  assert.ok(!html.includes('<script>x</script>'), 'raceName が生の <script> で出力されている（XSS）');
  assert.ok(html.includes('&lt;script&gt;'), 'raceName がエスケープされていない');
});
