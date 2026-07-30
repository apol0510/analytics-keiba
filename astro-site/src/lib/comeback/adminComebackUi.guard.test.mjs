/**
 * adminComebackUi.guard.test.mjs — カムバック特典タブの UI 契約
 *   node --test src/lib/comeback/adminComebackUi.guard.test.mjs
 *
 * 画面は prerender=true の静的ページなので、配信される HTML/JS = このソースそのもの。
 * 「操作は簡単・内部は fail closed・メールとは分離」を UI 側でも壊さないよう固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const CB_BLOCK = SCRIPT.slice(SCRIPT.indexOf('カムバック特典（無料 entitlement の付与）'));

test('3 つのタブが並存する（既存 2 タブを壊していない）', () => {
  for (const id of ['tabSales', 'tabMkt', 'tabCb', 'paneSales', 'paneMkt', 'paneCb']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(CB_BLOCK.length > 2000, 'カムバック特典ブロックが見つからない');
});

test('専用 API を叩く（販売資格 API / マーケティング API を流用しない）', () => {
  assert.ok(CB_BLOCK.includes("CB_API = '/.netlify/functions/admin-comeback-grants'"));
  // カムバック側の呼び出しは必ず cbCall
  assert.equal(/[^b]\bcall\(\{\s*action:/.test(CB_BLOCK), false, '販売資格 API を呼んでいる');
  assert.equal(CB_BLOCK.includes('mkCall({'), false, 'マーケティング API を呼んでいる');
  assert.equal(CB_BLOCK.includes('MKT_API'), false);
});

test('特典タブから販売資格・キャンペーン送信の payload を送らない', () => {
  for (const banned of ['plusAction', "action: 'update'", "action: 'send'", 'campaignId', 'PremiumPlusEligibility:']) {
    assert.equal(CB_BLOCK.includes(banned), false, `${banned} を送っている`);
  }
});

test('特典付与とメール送信を 1 操作に結合しない', () => {
  // 実行ハンドラの中でメール送信 action を呼ばない
  assert.equal(/action:\s*'apply'[\s\S]{0,600}action:\s*'send'/.test(CB_BLOCK), false,
    '実行の直後にメール送信を呼んでいる');
  // 文面プレビューは preview action だけ（送信 action を持たない）
  assert.ok(CB_BLOCK.includes("action: 'preview'"));
  // 画面上でも「メールは送信されない」と明示する
  assert.ok(PAGE.includes('この操作でメールは送信されません'));
  assert.ok(CB_BLOCK.includes('メールは送信されません'));
});

test('Light と Premium を独立に選べる（Light は Premium の fallback ではないと明示）', () => {
  for (const id of ['cbLightOffer', 'cbPremiumOffer']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  const lead = PAGE.slice(PAGE.indexOf('id="cbLightOffer"'), PAGE.indexOf('id="cbPremiumOffer"'));
  assert.match(lead, /メイン買い目のみ閲覧できる独立プラン/);
  assert.match(lead, /Premium 終了後の代替ではありません/);
});

test('任意期限・任意価格の入力欄があり、選んだときだけ出る', () => {
  for (const id of ['cbLightDays', 'cbPremiumDays', 'cbPremiumPrice']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.match(CB_BLOCK, /\$\('cbLightDaysWrap'\)\.hidden = !\(lightOpt && lightOpt\.dataset\.customDays\)/);
  assert.match(CB_BLOCK, /\$\('cbPremiumPriceWrap'\)\.hidden = !\(premiumOpt && premiumOpt\.dataset\.customPrice\)/);
});

test('価格（通常 / 割引率 / 特別価格 / 無料）を画面で確認できる', () => {
  assert.ok(PAGE.includes('id="cbPriceBox"'));
  assert.ok(CB_BLOCK.includes("kvRow(dl, '通常価格'"));
  assert.ok(CB_BLOCK.includes("kvRow(dl, '割引率'"));
  assert.ok(CB_BLOCK.includes("kvRow(dl, '特別価格'"));
  assert.ok(CB_BLOCK.includes('無料（課金は発生しません）'));
});

test('割引は「権限を付与しない」と画面で明示する', () => {
  assert.ok(CB_BLOCK.includes('購入条件のみ（支払い完了まで権限は付与されません）'));
  assert.ok(CB_BLOCK.includes('付与しません（支払い完了後に既存の入金確認フローが昇格します）'));
  assert.ok(CB_BLOCK.includes('権限は付与されません'));
});

test('専用 URL は実行応答からだけ表示する（推測 URL を作らない）', () => {
  assert.ok(CB_BLOCK.includes('out.offerTokens'));
  assert.equal(/https:\/\/analytics\.keiba\.link\/offer/.test(CB_BLOCK), false,
    'UI 側で offer URL を組み立てている');
});

test('一覧の checkbox 一括操作がそろっている', () => {
  for (const id of ['cbSelAll', 'cbSelNone', 'cbSelCount']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(CB_BLOCK.includes('cbSelected.clear()'));
  assert.ok(CB_BLOCK.includes('cbSelected.add(r.recordId)'));
});

test('付与できない顧客は選択できない（UI 側でも fail closed）', () => {
  assert.match(CB_BLOCK, /cb\.disabled = !r\.grantable/);
  assert.match(CB_BLOCK, /if \(r\.grantable\) cbSelected\.add\(r\.recordId\)/, '全選択が付与不可まで拾っている');
});

test('実行ボタンは gate OFF / 0 件では押せない', () => {
  assert.match(CB_BLOCK, /btn\.disabled = !plan\.writeEnabled \|\| total === 0/);
  assert.match(CB_BLOCK, /btn\.disabled = !cbWriteEnabled \|\| plan\.willRevoke === 0/);
});

test('dry-run を経ずに実行できない（fingerprint と operationId を必ず渡す）', () => {
  const applyCall = CB_BLOCK.slice(CB_BLOCK.indexOf("action: 'apply'"));
  assert.ok(applyCall.includes('planFingerprint: plan.planFingerprint'), 'fingerprint を渡していない');
  assert.ok(applyCall.includes('operationId: plan.operationId'), 'operationId を渡していない');
});

test('二重クリック防止がある', () => {
  const busyGuards = (CB_BLOCK.match(/dataset\.busy === '1'/g) || []).length;
  assert.ok(busyGuards >= 2, '付与・取り消しの両方に二重クリック防止が無い');
});

test('実行前に件数入りの最終確認を出す', () => {
  assert.ok(CB_BLOCK.includes('window.confirm'));
  assert.match(CB_BLOCK, /無料特典を付与: ' \+ plan\.willGrant/);
  assert.match(CB_BLOCK, /割引オファーを発行: ' \+ plan\.willOffer/);
});

test('現在 → 付与後 の before/after を表示する', () => {
  assert.ok(CB_BLOCK.includes("'現在: ' + p.before"));
  assert.ok(CB_BLOCK.includes("'付与後: ' + p.after"));
  assert.ok(CB_BLOCK.includes('顧客ごとの変更（現在 → 付与後）'));
});

test('要求されたフィルターがそろっている', () => {
  for (const id of ['cbContract', 'cbPlan', 'cbWithdrawn', 'cbPromo', 'cbGrantable', 'cbHistory']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} フィルターが無い`);
  }
});

test('画面文言が「権限は変えるがメール・課金は変えない」ことを明示する', () => {
  const lead = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="cbSummary"'));
  assert.ok(lead.includes('特典専用フィールドだけ'));
  assert.ok(lead.includes('Premium Plus 販売資格は一切変更しません'));
});
