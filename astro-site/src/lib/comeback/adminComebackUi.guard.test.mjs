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
  // 付与ハンドラの中でメール送信 action を呼ばない
  assert.equal(/action:\s*'grant'[\s\S]{0,600}action:\s*'send'/.test(CB_BLOCK), false,
    '付与の直後にメール送信を呼んでいる');
  // 画面上でも「メールは送信されない」と明示する
  assert.ok(PAGE.includes('この操作でメールは送信されません'));
  assert.ok(CB_BLOCK.includes('メールは送信されません'));
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

test('付与ボタンは gate OFF / 0 件では押せない', () => {
  assert.match(CB_BLOCK, /btn\.disabled = !plan\.writeEnabled \|\| plan\.willGrant === 0/);
  assert.match(CB_BLOCK, /btn\.disabled = !cbWriteEnabled \|\| plan\.willRevoke === 0/);
});

test('dry-run を経ずに付与できない（fingerprint と operationId を必ず渡す）', () => {
  const grantCall = CB_BLOCK.slice(CB_BLOCK.indexOf("action: 'grant'"));
  assert.ok(grantCall.includes('planFingerprint: plan.planFingerprint'), 'fingerprint を渡していない');
  assert.ok(grantCall.includes('operationId: plan.operationId'), 'operationId を渡していない');
  // dry-run 応答を持たないまま grant を呼ぶ経路が無い
  assert.equal(/action:\s*'grant'[\s\S]{0,200}recordIds[\s\S]{0,200}\}\s*\)/.test(grantCall.replace(/planFingerprint[\s\S]*/, '')), false);
});

test('二重クリック防止がある', () => {
  const busyGuards = (CB_BLOCK.match(/dataset\.busy === '1'/g) || []).length;
  assert.ok(busyGuards >= 2, '付与・取り消しの両方に二重クリック防止が無い');
});

test('付与前に件数入りの最終確認を出す', () => {
  assert.ok(CB_BLOCK.includes('window.confirm'));
  assert.match(CB_BLOCK, /新規付与: ' \+ plan\.willGrant/);
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
