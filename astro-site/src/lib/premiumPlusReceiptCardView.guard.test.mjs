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
    '合計購入金額', '合計払戻金額', '3連単フォーメーション', '払戻/返還金額',
  ]) {
    assert.ok(html.includes(s), `JRA プレビューに "${s}" が無い`);
  }
  // フッター（© Japan Racing Association.）は削除済み。払戻/返還金額 行でカード終端。
  assert.ok(!html.includes('Japan Racing Association'), 'JRA フッターが残っている（削除済みのはず）');
  assert.ok(!html.includes('class="foot"'), 'foot 要素が残っている（削除済みのはず）');
});

// 三連単は順序付き（1着→2着→3着）。台帳は "6-1-4" で保存するが、表示は矢印区切りに統一する。
// JRA 投票内容照会の「払戻単価」は 2 桁ゼロ埋め（06→01→04）。
test('的中組合せ表示: 中央(JRA) は 払戻単価=ゼロ埋め矢印 / 結果=矢印（ハイフン禁止）', () => {
  const card = deriveCard({
    date: '2026-07-18', circuit: 'chuo', venue: '福島', raceNumber: 11,
    first: '6', second: '1,3,4', third: '1,3,4,9', unitStake: '1000',
    isHit: true, payout: '1214000', unitPayout: '121400', hitCombo: '6-1-4', receiptNo: '0001',
  });
  const html = renderReceiptCardHtml(card);
  assert.ok(html.includes('06→01→04'), '払戻単価が JRA 実画面表記（06→01→04）になっていない');
  assert.ok(html.includes('<b>6→1→4</b>'), '左メタ「結果」が矢印区切りになっていない');
  assert.ok(!html.includes('6-1-4'), '的中組合せが生のハイフン区切りのまま出力されている');
});

test('的中組合せ表示: 南関(SPAT4) の 結果 も矢印区切り', () => {
  const card = deriveCard({
    date: '2026-07-23', circuit: 'nankan', venue: '大井', raceNumber: 2,
    first: '7', second: '1,3,9', third: '1,2,3,6,9', unitStake: '1000',
    isHit: true, payout: '599000', hitCombo: '7-1-9',
  });
  const html = renderReceiptCardHtml(card);
  assert.ok(html.includes('<b>7→1→9</b>'), '左メタ「結果」が矢印区切りになっていない');
  assert.ok(!html.includes('7-1-9'), '的中組合せが生のハイフン区切りのまま出力されている');
});

// 本番コンポーネントは node から実行できないため、矢印表記の適用箇所を source で固定する。
test('ドリフト検知: 本番コンポーネントも矢印表記の変数を使う', () => {
  const component = read('../components/premium-plus/PremiumPlusReceiptCardV2.astro');
  assert.ok(component.includes("wArr.join('→')"), 'コンポーネントに wDisp（矢印表記）が無い');
  assert.ok(component.includes("wArr.map(pad2).join('→')"), 'コンポーネントに wDispPad（ゼロ埋め矢印）が無い');
  assert.ok(component.includes('{isHit ? wDisp'), '結果 行が矢印表記を使っていない');
  assert.ok(component.includes('<span>{wDispPad}</span>'), '払戻単価 行がゼロ埋め矢印を使っていない');
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
