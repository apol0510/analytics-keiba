/**
 * adminMarketingUi.guard.test.mjs — マーケティングタブの UI 契約
 *   node --test src/lib/marketing/adminMarketingUi.guard.test.mjs
 *
 * 画面は prerender=true の静的ページなので、配信される HTML/JS = このソースそのもの。
 * 「操作は簡単・内部は fail closed」を UI 側でも壊さないように固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));

test('販売タブとマーケティングタブが分かれている', () => {
  assert.ok(PAGE.includes('id="tabSales"'));
  assert.ok(PAGE.includes('id="tabMkt"'));
  assert.ok(PAGE.includes('id="paneSales"'));
  assert.ok(PAGE.includes('id="paneMkt"'));
});

test('マーケティングは別 API を叩く（販売資格 API を流用しない）', () => {
  assert.ok(SCRIPT.includes("MKT_API = '/.netlify/functions/admin-marketing'"));
  // マーケ側の呼び出しは必ず mkCall（販売側の call を混ぜない）
  const mktBlock = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  assert.ok(mktBlock.length > 1000, 'マーケ用ブロックが見つからない');
  assert.equal(/[^k]\bcall\(\{\s*action:\s*'(update|list|preview)'/.test(mktBlock), false,
    'マーケタブから販売資格 API を呼んでいる');
});

test('マーケタブから Premium Plus の資格変更 payload を送らない', () => {
  const mktBlock = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  for (const banned of ['plusAction', "action: 'update'", 'PremiumPlusEligibility:']) {
    assert.equal(mktBlock.includes(banned), false, `${banned} を送っている`);
  }
});

test('一覧の checkbox 一括操作がそろっている', () => {
  for (const id of ['mkSelAll', 'mkSelNone', 'mkSelCount']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(SCRIPT.includes('mkSelected.clear()'));
  assert.ok(SCRIPT.includes('mkSelected.add(r.recordId)'));
});

test('送信できない顧客は選択できない（UI 側でも fail closed）', () => {
  assert.match(SCRIPT, /cb\.disabled = !r\.sendable/);
  assert.match(SCRIPT, /if \(r\.sendable\) mkSelected\.add\(r\.recordId\)/, '全選択が除外者まで拾っている');
});

test('dry-run を経ずに送信できない（送信ボタンは確認画面の中だけ）', () => {
  // 一覧・ツールバーに送信ボタンが無い
  assert.equal(/id="mkSend"/.test(PAGE), false, '一覧に送信ボタンがある');
  // 送信は dry-run 応答（plan）から組み立てた確認画面でのみ生成される
  assert.match(SCRIPT, /function mkRenderConfirm\(campaign, plan\)/);
  assert.match(SCRIPT, /action:\s*'send',[\s\S]{0,240}?planFingerprint:\s*plan\.planFingerprint/);
});

test('確認ダイアログに 対象 / 除外 / 実送信 の件数が出る', () => {
  assert.match(SCRIPT, /送信対象: '\s*\+\s*plan\.selected/);
  assert.match(SCRIPT, /除外: '\s*\+\s*plan\.excluded/);
  assert.match(SCRIPT, /実送信: '\s*\+\s*plan\.willSend/);
  assert.ok(SCRIPT.includes('window.confirm'), '最終確認ダイアログが無い');
});

test('送信ボタンは無効時と 0 件で押せない / 二重クリックを防ぐ', () => {
  assert.match(SCRIPT, /btn\.disabled = !plan\.sendEnabled \|\| plan\.willSend === 0/);
  assert.match(SCRIPT, /if \(btn\.dataset\.busy === '1'\) return/);
});

test('送信有効/無効の状態を画面に明示する', () => {
  assert.ok(PAGE.includes('id="mkSendState"'));
  assert.ok(SCRIPT.includes('MARKETING_CAMPAIGN_ENABLED 未設定'));
  assert.ok(SCRIPT.includes('実送信されません'), '送信基盤が無効なことを伝えていない');
});

test('本文プレビューはサンドボックス iframe で表示する（スクリプト実行なし）', () => {
  assert.match(SCRIPT, /frame\.setAttribute\('sandbox', ''\)/);
  assert.match(SCRIPT, /frame\.srcdoc/);
  assert.equal(SCRIPT.includes('innerHTML = data.html'), false, 'メール HTML を管理画面へ直接流し込んでいる');
});

test('除外理由が画面に必ず出る（黙って落とさない）', () => {
  assert.ok(SCRIPT.includes('plan.excludedDetail'));
  assert.ok(SCRIPT.includes('r.suppressionReasons'), '一覧に除外理由を出していない');
});

test('顧客データを URL に載せない', () => {
  const mktBlock = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  assert.equal(/location\.(href|search)\s*=/.test(mktBlock), false);
  assert.equal(mktBlock.includes('URLSearchParams'), false);
});

test('マーケタブが Premium Plus 販売の説明文を書き換えていない', () => {
  assert.ok(PAGE.includes('候補は自動で「販売可」になりません'), '販売タブの注意書きが消えている');
  assert.ok(PAGE.includes('メールを送っても会員権限は復活しません'), 'マーケタブの注意書きが無い');
});
