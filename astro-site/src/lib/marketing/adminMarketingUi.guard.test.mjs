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
  assert.ok(SCRIPT.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), '専用配信ゲートの状態を伝えていない');
  assert.ok(SCRIPT.includes('実送信されません'), '配信が無効なことを伝えていない');
  // 既存メールのマスタースイッチ名を操作条件として画面に出さない（誤って ON にさせない）
  assert.equal(SCRIPT.includes('NEWSLETTER_AUTOMATION_ENABLED'), false,
    'マーケ画面が newsletter の global gate を条件として案内している');
});

test('provider 側の配信停止と照合できたかを確認画面に出す', () => {
  assert.ok(SCRIPT.includes('plan.providerSuppression'), 'provider 照合状況を出していない');
  assert.ok(SCRIPT.includes('配信基盤の配信停止リスト'));
  assert.ok(SCRIPT.includes('この状態では送信できません'), '確認できない場合の警告が無い');
  // ⚠️ この画面には Premium Plus のプレビュー guard（stagedReleaseGuard）が効いており、
  //    ページ全体でメール送信基盤の固有名詞を禁止している。文言に製品名を書かないこと。
  assert.equal(/sendgrid/i.test(SCRIPT), false, 'ページに送信基盤の固有名詞が入っている');
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

test('dry-run 確認画面が除外を分類して出す', () => {
  for (const label of [
    'キャンペーン条件外', '配信停止・除外リスト', '最近マーケティング送信済み', '配信基盤の配信停止', 'その他',
  ]) {
    assert.ok(SCRIPT.includes(label), `除外分類「${label}」が無い`);
  }
  for (const reason of [
    'campaign_mismatch', 'recent_marketing_contact', 'provider_suppressed', 'already_delivered',
  ]) {
    assert.ok(SCRIPT.includes(reason), `理由 ${reason} が分類に含まれていない`);
  }
  // 分類漏れが出ても件数を落とさない
  assert.ok(SCRIPT.includes('未分類'), '未分類の受け皿が無い');
});

test('使用停止中のキャンペーンは選べず、理由が画面に出る', () => {
  assert.match(SCRIPT, /o\.disabled = !c\.usable/, '停止中を選択不可にしていない');
  assert.ok(SCRIPT.includes('使用停止中'), '停止中の表示が無い');
  assert.ok(SCRIPT.includes('c.disabledReason'), '停止理由を出していない');
  // dry-run 実行時にも停止中を弾く
  assert.match(SCRIPT, /if \(!c\.usable\) \{ mkMsg\('使用停止中のキャンペーンです/);
});

test('既定選択が使用可能なキャンペーンになる', () => {
  assert.match(SCRIPT, /const firstUsable = mkCampaigns\.find\(\(c\) => c\.usable\)/);
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
