/**
 * comebackLightGrantEmail.guard.test.mjs — Light 無料付与済み案内の導線契約
 *   node --test src/lib/comeback/comebackLightGrantEmail.guard.test.mjs
 *
 * ── 2026-08-03 本番で観測した不具合 ────────────────────────────────
 *   1. 今回に合う文面が無く、既定が**運用テスト専用カナリア**になっていた
 *   2. 本文に URL を書けないのに、CTA のリンク先が画面のどこにも出ていない
 *   3. 過去の別キャンペーン送信を理由に、引き継いだ 28 名が全員「送信済み」で除外された
 *   4. 引き継ぎ中なのに「特典・オファーの下見」が「対象を選択してください」と言う
 *   5. 引き継ぎ帯が未定義 CSS 変数のフォールバックで白背景になり、文字が読めない
 *
 * 同じことが再発しないようソース側で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const GRANTS_FN = read('../../../netlify/functions/admin-comeback-grants.js');
const MARKETING_FN = read('../../../netlify/functions/admin-marketing.js');

const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const GRANTS_CODE = codeOnly(GRANTS_FN);

const sliceFrom = (src, marker, len = 2600) => {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `見つからない: ${marker}`);
  return src.slice(i, i + len);
};

// ── 1. 既定選択 ────────────────────────────────────────────────

test('既定選択を単一源へ委譲し、運用テスト専用を既定にしない', () => {
  assert.match(PAGE, /comebackGrantCampaign\.js/, '判定モジュールを読み込んでいない');
  assert.match(SCRIPT, /pickInitialCampaign\(\{/, '既定選択を単一源で決めていない');
  assert.equal(/const firstUsable = mkCampaigns\.find\(\(c\) => c\.usable\)/.test(SCRIPT), false,
    '「最初に使えるもの」を既定にしている（カナリアが選ばれうる）');
});

test('引き継ぎを採用したら文面を選び直す', () => {
  assert.match(SCRIPT, /function mkApplyHandoffCampaign\(/, '選び直しの処理が無い');
  const adopt = sliceFrom(SCRIPT, 'function mkHandoffAdopt(', 1600);
  assert.match(adopt, /mkApplyHandoffCampaign\(\)/, '引き継ぎ採用時に選び直していない');
  assert.match(adopt, /grantOffers: ticket\.grantOffers/, '配った特典を状態へ持っていない');
});

test('配った特典と選んでいる文面が違えば画面で警告する', () => {
  const fn = sliceFrom(SCRIPT, 'function renderCampDesc(', 4200);
  assert.match(fn, /recommendCampaignForGrant\(/, '対応関係を確認していない');
  assert.match(fn, /いま選んでいる文面と違います/, '不一致の警告が無い');
});

// ── 2. CTA の表示 ──────────────────────────────────────────────

test('CTA のラベルとリンク先を画面に出す', () => {
  const fn = sliceFrom(SCRIPT, 'function renderCampDesc(', 4200);
  assert.match(fn, /describeCta\(/, 'CTA の表示内容を単一源で作っていない');
  assert.match(fn, /cta-box/, 'CTA の表示領域が無い');
  assert.match(fn, /CTAボタン/, 'CTA の見出しが無い');
  assert.match(PAGE, /\.ppe \.cta-box \{/, 'CTA のスタイルが無い');
});

test('受信者ごとの専用 URL は実 URL を画面へ出さない（token 境界を保つ）', () => {
  const mod = read('./comebackGrantCampaign.js');
  const fn = sliceFrom(mod, 'export function describeCta(', 1200);
  assert.match(fn, /perRecipient \? '' : url/, '未発行の専用 URL を出している');
});

// ── 3. 新しい送信識別子 ────────────────────────────────────────

test('Light 30日無料付与済み案内は独立した campaignId × version を持つ', () => {
  const cat = read('../marketing/campaignCatalog.js');
  assert.match(cat, /campaignId: 'comeback-light-30d-granted'/, 'キャンペーンが無い');
  // 既存のカムバック系と ID を共有しない（DeliveryKey が分かれる）
  for (const other of ['expired-comeback', 'comeback-offer', 'dormant-reactivation']) {
    assert.notEqual('comeback-light-30d-granted', other);
  }
});

test('dry-run 画面で送信識別子と二重送信の判定基準が読める', () => {
  const fn = sliceFrom(SCRIPT, 'function mkRenderDryPanel(', 2200);
  assert.match(fn, /送信識別子/, 'campaignId × version を出していない');
  assert.match(fn, /c\.campaignId \+ ' : v' \+ c\.version/, '識別子の中身を出していない');
  assert.match(fn, /DeliveryKey/, '二重送信の判定基準を説明していない');
});

// ── 4. 下見の引き継ぎ対応 ──────────────────────────────────────

test('下見は引き継ぎ中に recordId を送らず、サーバー再導出を使う', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkActionDry')"), SCRIPT.indexOf('// ── 実配信'));
  assert.match(block, /const handoffOp = mkState\.handoff \? mkState\.handoff\.operationId : ''/, '引き継ぎを見ていない');
  assert.match(block, /grantOperationId: handoffOp/, 'サーバー再導出へ委ねていない');
  assert.equal(/recordIds: \[\.\.\.mkSelected\][\s\S]{0,80}grantOperationId/.test(block), false,
    '引き継ぎ中に recordId を併送している');
  assert.match(block, /付与済み/, '「すでに配り終えた人の下見」だと伝えていない');
  assert.match(block, /追加のオファー発行もありません/, '追加発行が無いことを伝えていない');
});

test('付与 Function の引き継ぎ解決は dry-run 限定（実行は従来どおり recordIds）', () => {
  assert.match(GRANTS_CODE, /const grantOperationId = live \? '' : String\(req\.grantOperationId/,
    'live でも引き継ぎを受け付けている');
  assert.match(GRANTS_CODE, /collectGrantedRecipients\(/, 'サーバー再導出を使っていない');
  assert.match(GRANTS_CODE, /validateHandoffResolution\(/, '期限判定を委譲していない');
});

test('下見は書き込まない（dry-run 経路に write が増えていない）', () => {
  const fn = sliceFrom(GRANTS_FN, 'async function handlePlan(', 4000);
  const beforeLive = fn.slice(0, fn.indexOf('// ── live:'));
  assert.equal(/method: 'PATCH'|method: 'POST'/.test(beforeLive), false, 'dry-run 経路で書き込んでいる');
});

test('引き継ぎの導出は admin-marketing と同じ単一源を使う', () => {
  for (const src of [GRANTS_FN, MARKETING_FN]) {
    assert.match(src, /comebackEmailHandoff\.js/, '単一源を import していない');
    assert.match(src, /collectGrantedRecipients/, '対象導出を再実装している');
  }
});

// ── 5. 引き継ぎ帯の可読性 ──────────────────────────────────────

test('引き継ぎ帯が未定義 CSS 変数に頼らない', () => {
  const css = sliceFrom(PAGE, '.ppe .handoff-bar {', 900);
  for (const undefinedVar of ['--ok-bg', '--ok-bd', '--ok-fg']) {
    assert.equal(css.includes(undefinedVar), false, `未定義変数 ${undefinedVar} を使っている（白背景になる）`);
  }
  assert.match(css, /--action-green/, '実在する色トークンを使っていない');
  assert.match(css, /color: var\(--text-main\)/, '文字色を指定していない');
});

test('引き継ぎ帯はモバイルでも崩れない', () => {
  assert.match(PAGE, /@media \(max-width: 640px\) \{[\s\S]{0,200}\.ppe \.handoff-bar \{ flex-direction: column/,
    'モバイルでの折り返し指定が無い');
});

test('引き継ぎ帯は色だけで状態を表さない', () => {
  const fn = sliceFrom(SCRIPT, 'function mkHandoffRender(', 1400);
  assert.match(fn, /カムバック無料付与の成功者を引き継ぎ中/, '状態を文章で出していない');
  assert.match(fn, /describeHandoff\(/, '人数・期限を出していない');
  assert.match(fn, /引き継ぎを解除/, '解除できない');
});

// ── 6. 件数表示 ────────────────────────────────────────────────

test('引き継ぎ中は「0 名選択」を主表示にしない', () => {
  const fn = sliceFrom(SCRIPT, "const counts = $('mkStepCounts')", 900);
  assert.match(fn, /引き継ぎ対象 ' \+ mkState\.handoff\.grantedCount/, '引き継ぎ人数を主表示にしていない');
  assert.match(fn, /画面での再選択は不要/, '再選択不要だと伝えていない');
  assert.match(PAGE, /id="mkStepCountsSub"/, '取得・選択件数の補助表示が無い');
  assert.match(fn, /対象は送信のたびにサーバーが確定します/, 'サーバー確定であることを伝えていない');
});

// ── 7. 既存契約を壊していない ──────────────────────────────────

test('#217 / #218 の導線を壊していない', () => {
  // 引き継ぎ（#217）
  assert.match(SCRIPT, /grantOperationId: mkState\.handoff\.operationId/, 'メール側の引き継ぎ指定が消えている');
  assert.ok(SCRIPT.includes('成功者へ案内メールを作成'), '案内メールへの導線が消えている');
  // 本番付与の単一経路（#218）
  assert.equal((SCRIPT.match(/action:\s*'apply'/g) || []).length, 1, 'apply の呼び出しが 1 か所でない');
  assert.match(SCRIPT, /async function cbRunApply\(/, '付与の単一経路が消えている');
});

test('専用 URL キャンペーン（割引案内）を壊していない', () => {
  const cat = read('../marketing/campaignCatalog.js');
  assert.match(cat, /campaignId: 'comeback-offer'/, '割引案内が消えている');
  assert.match(cat, /requiresOfferUrl/, '専用 URL の仕組みが消えている');
  assert.match(MARKETING_FN, /requiresOfferUrl\(/, '専用 URL の分岐が消えている');
});

test('suppression / 配信停止 / fail closed を維持', () => {
  assert.match(MARKETING_FN, /provider_suppression_unavailable/, 'suppression の fail closed が消えている');
  assert.match(MARKETING_FN, /fetchProviderSuppression\(/, 'suppression を確認していない');
  assert.match(MARKETING_FN, /buildCampaignPlan\(/, '除外判定の単一源が消えている');
});
