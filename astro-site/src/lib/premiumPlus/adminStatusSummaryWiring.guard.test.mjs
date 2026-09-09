/**
 * adminStatusSummaryWiring.guard.test.mjs
 *   管理画面が「現在の状態」要約を**先頭に**出し、判定を画面で作り直していないことを固定する
 *
 * 2026-09-09 MK 指示:
 *   「先頭に『現在の状態』を要約して表示」「詳細情報は省略せず、その下に残して」
 *   「まず今どういう状態かが一目で分かり、その後に詳細と操作」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url).pathname, 'utf8');
const fn = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url).pathname, 'utf8');

test('判定は単一源を import して橋渡しする（画面でロジックを書かない）', () => {
  assert.match(page, /premiumPlusAdminStatusSummary\.js/);
  assert.match(page, /window\.__ppStatus\s*=\s*\{[^}]*describeAdminStatusSummary/);
  assert.match(page, /window\.__ppStatus\s*=\s*\{[^}]*describeActionConflicts/);
});

test('【重要】要約は詳細（基本情報）より前に出る', () => {
  const iSummary = page.indexOf("smH.textContent = '現在の状態'");
  const iInfo = page.indexOf("h1.textContent = '基本情報'");
  assert.ok(iSummary > 0, '要約の描画が無い');
  assert.ok(iInfo > 0, '基本情報の描画が無い');
  assert.ok(iSummary < iInfo, '要約が詳細より後ろにある（先頭に出す指示に反する）');
});

test('【重要】詳細セクションを削っていない（省略せず下に残す）', () => {
  for (const h of ['基本情報', '通常操作', '強い操作（本番の販売状態が変わります）',
    '再募集（この会員）']) {
    assert.ok(page.includes(h), `詳細セクション「${h}」が消えている`);
  }
});

test('【重要】状態と食い違う操作は押させない（判定は単一源）', () => {
  assert.match(page, /describeActionConflicts\(r\)/);
  // 「今すぐ販売可」の disabled に conflicts を必ず混ぜている
  const m = page.match(/mkBtn\('immediate'[\s\S]{0,220}?\);/);
  assert.ok(m, '「今すぐ販売可」の描画が見つからない');
  assert.match(m[0], /conflicts\.immediate/, '食い違い判定が disabled に効いていない');
});

test('購入可否はサーバーが解決した値を使う（画面・要約で再計算しない）', () => {
  assert.match(fn, /purchaseEnabled:\s*release\.purchaseEnabled === true/,
    'サーバーが purchaseEnabled を行に載せていない');
  const mod = readFileSync(new URL('./premiumPlusAdminStatusSummary.js', import.meta.url).pathname, 'utf8');
  assert.doesNotMatch(mod, /16[:：]?30|SALE_CUTOFF|resolveSaleTarget/,
    '受付時間帯の判定を要約側で作り直している（二重実装）');
});

test('要約の文言は単一源から受け取って描画する（画面で組み立てない）', () => {
  // 要約ブロックだけを見る（他セクションに元からある同名ラベルで誤検知しない）
  const i = page.indexOf("smH.textContent = '現在の状態'");
  assert.ok(i > 0, '要約の描画が無い');
  const block = page.slice(i, i + 2600);   // 要約ブロック全体（バッジ・段階行を含む）
  assert.match(block, /dt\.textContent\s*=\s*it\.label/, '項目名を単一源から取っていない');
  assert.match(block, /v\.textContent\s*=\s*it\.value/, '値を単一源から取っていない');
  assert.match(block, /n\.textContent\s*=\s*it\.note/, '補足を単一源から取っていない');
  assert.match(block, /smHead\.textContent\s*=\s*summary\.headline/, '見出しを単一源から取っていない');
  // 要約ブロック内に項目名を直書きしていない
  for (const label of ['購入可否', '段階公開の現在地', 'クーポンの14日間']) {
    assert.ok(!block.includes(label), `要約ブロックに文言 "${label}" が直書きされている`);
  }
});
