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
    // 2026-07-30: 明細行のラベルは「払戻/返還金額」→「払戻金額」へ変更（AK は返還を扱わない）
    '購入金額合計', '払戻金額合計', '3連単フォーメーション', '払戻金額',
  ]) {
    assert.ok(html.includes(s), `JRA プレビューに "${s}" が無い`);
  }
  // フッター（© Japan Racing Association.）は削除済み。払戻金額 行でカード終端。
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

// 実画面（JRA 投票内容照会）はレース明細ヘッダー右端にもアコーディオン三角がある。装飾のみ（開閉なし）。
test('JRA レース明細ヘッダー: 装飾アコーディオン三角が 1 個ある（SPAT4 には出さない）', () => {
  const jra = renderReceiptCardHtml(deriveCard({
    date: '2026-07-25', circuit: 'chuo', venue: '新潟', raceNumber: 8,
    first: '6', second: '1,2,10', third: '1,2,7,8,10,11', unitStake: '1000',
    isHit: true, payout: '697200', unitPayout: '69720', hitCombo: '6-10-2',
  }));
  const accCount = (jra.match(/class="acc"/g) || []).length;
  assert.equal(accCount, 2, 'JRA カードの acc は「すべて閉じる」+ レース明細ヘッダーの 2 個であること');
  assert.ok(/<div class="vh">[\s\S]*?<span class="acc" aria-hidden="true">▲<\/span>/.test(jra),
    'レース明細ヘッダー内に装飾三角（aria-hidden）が無い');

  const spat = renderReceiptCardHtml(deriveCard({
    date: '2026-07-23', circuit: 'nankan', venue: '大井', raceNumber: 2,
    first: '7', second: '1,3', third: '1,2,3',
  }));
  assert.ok(!spat.includes('class="acc"'), 'SPAT4 カードに acc が混入している');
});

test('ドリフト検知: 本番コンポーネントのレース明細ヘッダーにも装飾三角がある', () => {
  const component = read('../components/premium-plus/PremiumPlusReceiptCardV2.astro');
  assert.ok(/<div class="vh">[\s\S]*?<span class="acc" aria-hidden="true">▲<\/span>/.test(component),
    'コンポーネントの vh に装飾三角が無い');
});

// 明細表の罫線は実機スクショ実測に合わせる（横罫線は左右 5px インセット / 縦罫線は .dt 内部のみ）。
// .vh（灰色のレース概要）に罫線が生えると、縦線が白い表の外へ伸びて見える。
test('明細表の罫線: 縦罫線は .dt 内だけ・.vh には罫線を置かない', () => {
  const css = read('../styles/premiumPlusReceiptCard.css');
  const rule = (sel) => (css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`)) || [, ''])[1];
  const vh = rule('.vref.jra .vh');
  assert.ok(!/border(-top|-bottom|-left|-right)?\s*:/.test(vh), '.vh に border が付いている（縦罫線が灰色ヘッダーへ伸びる）');
  assert.ok(/padding: 3px 5px 0/.test(rule('.vref.jra .dt')), '.dt の inset padding（3px 5px 0）が無い');
  assert.ok(/border-bottom: 1px solid #c0c0c0/.test(rule('.vref.jra .dt .row')), '行境界の横罫線が .row の border-bottom でない');
  assert.ok(!/border-top/.test(rule('.vref.jra .dt .row')), '.row に border-top が残っている（二重描画）');
  assert.ok(/border-right: 1px solid #c0c0c0/.test(rule('.vref.jra .dt .lc')), '縦罫線が .lc の border-right でない');
});

// v2 ページは同じ .vref.jra ルールをページスコープで重複保持している。片方だけ直すと将来ドリフトする。
test('CSS 同期: premium-plus-v2.astro の .vref.jra ルールが共有 CSS と一致', () => {
  const norm = (s) => s.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.startsWith('.vref.jra'));
  const shared = new Set(norm(read('../styles/premiumPlusReceiptCard.css')));
  const page = new Set(norm(read('../pages/premium-plus-v2.astro')));
  for (const r of shared) {
    assert.ok(page.has(r), `premium-plus-v2.astro に同じルールが無い（ドリフト）: ${r.slice(0, 80)}`);
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

// ── 投票内容照会の複製に「不的中」を書かない（2026-07-30 実物照合）──────────
// 実物の SPAT4 / JRA 投票内容照会には否定表現の欄が無く、的中しなかった行は**単に存在しない**。
// 「不的中」と書くと実物と食い違い、複製としての信頼性が落ちる。
const cardOf = (over = {}) => deriveCard({
  date: '2026-07-23', circuit: 'nankan', venue: '大井', raceNumber: 2,
  first: '7', second: '1,3', third: '1,2,3', ...over,
});

test('不的中: 投票内容照会の複製に「不的中」の文字を出さない', () => {
  const html = renderReceiptCardHtml(cardOf({ isHit: false }));
  const vref = html.slice(html.indexOf('<div class="vref'));
  assert.ok(!vref.includes('不的中'), '複製部分に「不的中」が出力されている（実物には無い表現）');
  assert.ok(!vref.includes('class="miss"'), 'レシート内に .miss 要素が残っている');
});

test('不的中: 投票金額セルは 2 行のまま（末尾の空行を作らない）', () => {
  const html = renderReceiptCardHtml(cardOf({ isHit: false }));
  const c3 = (html.match(/<td class="c3">([\s\S]*?)<\/td>/) || [, ''])[1];
  assert.ok(c3.includes('(各'), '「(各N円)」が無い');
  assert.ok(/\d,?\d*円$/.test(c3.trim()), `合計金額で終わっていない（末尾に空行が残る）: ${JSON.stringify(c3)}`);
  assert.equal((c3.match(/<br>/g) || []).length, 1, '<br> は 1 個（2 行）であるべき');
});

test('的中: 3 行目に「的中 N円」を出す（従来どおり）', () => {
  const html = renderReceiptCardHtml(cardOf({ isHit: true, payout: 222400, winnerCombo: '7-1-2' }));
  const c3 = (html.match(/<td class="c3">([\s\S]*?)<\/td>/) || [, ''])[1];
  assert.equal((c3.match(/<br>/g) || []).length, 2, '<br> は 2 個（3 行）であるべき');
  assert.ok(/<span class="hit">的中 [\d,]+円<\/span>/.test(c3), '的中行が無い');
});

test('不的中の 2 行が上下等間隔になる（.c3 は vertical-align: middle）', () => {
  const css = read('../styles/premiumPlusReceiptCard.css');
  const c3 = (css.match(/\.vref\.spat \.bet \.c3 \{([^}]*)\}/) || [, ''])[1];
  assert.ok(/vertical-align:\s*middle/.test(c3), '.c3 が vertical-align: middle でない（2 行時に上下余白が偏る）');
});

test('CSS 同期: .vref.spat .bet .c3 が全コピーで一致（片方だけ直さない）', () => {
  const files = [
    '../styles/premiumPlusReceiptCard.css',
    '../components/premium-plus/PremiumPlusReceiptCardV2.astro',
    '../pages/premium-plus.astro',
    '../pages/premium-plus-v2.astro',
  ];
  const rules = files.map((f) => {
    const m = read(f).match(/\.vref\.spat \.bet \.c3 \{([^}]*)\}/);
    assert.ok(m, `${f} に .c3 ルールが無い`);
    return m[1].split(';').map((s) => s.trim()).filter(Boolean).sort().join('; ');
  });
  for (let i = 1; i < rules.length; i += 1) {
    assert.equal(rules[i], rules[0], `${files[i]} の .c3 が共有 CSS とドリフトしている`);
  }
});

test('中央（JRA）側も不的中で否定表現を出さない', () => {
  const html = renderReceiptCardHtml(cardOf({ circuit: 'jra', venue: '中山', isHit: false }));
  const vref = html.slice(html.indexOf('<div class="vref'));
  assert.ok(!vref.includes('不的中'), 'JRA 複製に「不的中」が出力されている');
  assert.ok(!vref.includes('払戻単価'), '不的中なのに払戻単価行が出ている');
});

// ── JRA 払戻表示（2026-07-30 指定）────────────────────────────────
const jraOf = (over = {}) => renderReceiptCardHtml(deriveCard({
  date: '2026-07-18', circuit: 'jra', venue: '福島', raceNumber: 11,
  first: '6', second: '1,3,4', third: '1,3,4,9', ...over,
}));

test('JRA 明細行のラベルは「払戻金額」（払戻/返還金額 にしない）', () => {
  for (const html of [jraOf({ isHit: false }), jraOf({ isHit: true, payout: 1214000, winnerCombo: '6-1-4' })]) {
    assert.ok(html.includes('<div class="lc">払戻金額</div>'), '明細行のラベルが「払戻金額」でない');
    assert.ok(!html.includes('払戻/返還金額'), '「払戻/返還金額」が残っている');
  }
});

test('JRA 払戻金額は不的中（0円）でも赤色で出す（2 箇所）', () => {
  const html = jraOf({ isHit: false });
  // 1) アコーディオン見出しの `払戻金額:0円`
  assert.ok(html.includes('払戻金額:<span class="pay">0円</span>'),
    '見出しの 0円 が赤（.pay）になっていない');
  // 2) 明細行の払戻金額
  assert.ok(html.includes('<div class="lc">払戻金額</div><div class="rc red">0円</div>'),
    '明細行の 0円 が赤（.rc.red）になっていない');
});

test('JRA 払戻金額は的中時も同じ赤の付け方（条件分岐で色が消えない）', () => {
  const html = jraOf({ isHit: true, payout: 1214000, winnerCombo: '6-1-4' });
  assert.ok(/払戻金額:<span class="pay">1,214,000円<\/span>/.test(html), '見出しの金額が赤でない');
  assert.ok(/<div class="lc">払戻金額<\/div><div class="rc red">1,214,000円<\/div>/.test(html), '明細行の金額が赤でない');
});

test('JRA「払戻金額:」のラベル自体は赤にしない（実物もラベルは黒）', () => {
  const html = jraOf({ isHit: false });
  assert.ok(!/<span class="pay">払戻金額:/.test(html), 'ラベルごと赤にしている');
  assert.ok(!/class="[^"]*pay[^"]*">払戻金額/.test(html), 'ラベルを含む span に .pay が付いている');
});

test('JRA 払戻金額合計は .hlrow.back でラベルごと赤（構造は不変）', () => {
  const html = jraOf({ isHit: false });
  assert.ok(html.includes(`<div class="hlrow back"><span>払戻金額合計</span><span>0円</span></div>`),
    '払戻金額合計の構造が変わっている');
});

test('ドリフト検知: 本番コンポーネント / ページも払戻表示をそろえている', () => {
  for (const rel of [
    '../components/premium-plus/PremiumPlusReceiptCardV2.astro',
    '../pages/premium-plus.astro',
  ]) {
    const src = read(rel);
    assert.ok(!src.includes('払戻/返還金額'), `${rel}: 旧ラベル「払戻/返還金額」が残っている`);
    assert.ok(/<div class="lc">払戻金額<\/div><div class="rc red">/.test(src),
      `${rel}: 明細行の払戻金額が常時赤（rc red）になっていない`);
    assert.ok(/払戻金額:<span class="pay">/.test(src),
      `${rel}: 見出しの金額が常時赤（.pay）になっていない`);
    assert.ok(!/class=\{[^}]*'pay'[^}]*\}>払戻金額/.test(src),
      `${rel}: ラベルごと赤にする旧実装が残っている`);
  }
});

test('JRA ハイライトのラベルは「購入金額合計」「払戻金額合計」（2026-07-30 指定）', () => {
  const html = jraOf({ isHit: false });
  assert.ok(html.includes('<span>購入金額合計</span>'), '「購入金額合計」でない');
  assert.ok(html.includes('<span>払戻金額合計</span>'), '「払戻金額合計」でない');
  assert.ok(!html.includes('合計購入金額'), '旧ラベル「合計購入金額」が残っている');
  assert.ok(!html.includes('合計払戻金額'), '旧ラベル「合計払戻金額」が残っている');
});

test('ラベル変更は JRA のみ（南関 SPAT4 には出さない）', () => {
  const spat = renderReceiptCardHtml(deriveCard({
    date: '2026-07-23', circuit: 'nankan', venue: '大井', raceNumber: 2,
    first: '7', second: '1,3', third: '1,2,3',
  }));
  for (const s of ['購入金額合計', '払戻金額合計', '合計購入金額', '合計払戻金額']) {
    assert.ok(!spat.includes(s), `SPAT4 カードに "${s}" が混入している`);
  }
});

test('ドリフト検知: 本番コンポーネント / ページも新ラベルにそろえている', () => {
  for (const rel of [
    '../components/premium-plus/PremiumPlusReceiptCardV2.astro',
    '../pages/premium-plus.astro',
  ]) {
    const src = read(rel);
    assert.ok(src.includes('>購入金額合計<'), `${rel}: 「購入金額合計」でない`);
    assert.ok(src.includes('>払戻金額合計<'), `${rel}: 「払戻金額合計」でない`);
    assert.ok(!src.includes('合計購入金額'), `${rel}: 旧ラベルが残っている`);
    assert.ok(!src.includes('合計払戻金額'), `${rel}: 旧ラベルが残っている`);
  }
});
