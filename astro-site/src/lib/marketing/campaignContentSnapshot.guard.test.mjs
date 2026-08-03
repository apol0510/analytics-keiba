/**
 * campaignContentSnapshot.guard.test.mjs
 *
 * 「確認した文面がそのまま送られる」ことを**構造として**固定する。
 *
 * この経路が壊れる形は決まっている:
 *   - キュー登録時にテンプレートから作り直す（編集内容が消える）
 *   - dispatcher が送信時にカタログから作り直す（登録後の編集が混ざる）
 *   - 文面を fingerprint に含めない（別文面へすり替えられる）
 * どれもテストで検知する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FN = readFileSync(path.join(HERE, '../../../netlify/functions/admin-marketing.js'), 'utf8');
const DISPATCH = readFileSync(path.join(HERE, '../../../netlify/functions/marketing-campaign-dispatch.js'), 'utf8');
const SEND = readFileSync(path.join(HERE, './campaignSend.js'), 'utf8');
const PAGE = readFileSync(path.join(HERE, '../../pages/admin/premium-plus-eligibility.astro'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));

test('guard: 送る文面は下書きを重ねた campaign から作る（テンプレート直描画に戻さない）', () => {
  assert.match(FN, /const sending = check\.campaign/, '確定した文面を 1 つに束ねていない');
  assert.match(FN, /renderCampaign\(\{ campaign: sending, name: null \}\)/, 'テンプレートから描画している');
  assert.match(FN, /buildCampaignPlan\(\{\s*\n?\s*campaign: sending/, '計画がテンプレート基準になっている');
});

test('guard: キュー登録は描画済みスナップショットを保存する', () => {
  const block = FN.slice(FN.indexOf('table: SCHEDULED_TABLE'), FN.indexOf('CampaignDeliveries を DeliveryKey'));
  assert.match(block, /Subject: rendered\.subject/, '件名のスナップショットを保存していない');
  assert.match(block, /Content: rendered\.html/, '本文のスナップショットを保存していない');
  assert.match(block, /content:\$\{contentHash/, '内容 hash を残していない');
});

test('guard: dispatcher は保存済みスナップショットで送る（再描画しない）', () => {
  assert.match(DISPATCH, /let html = String\(f\.Content \|\| ''\)/, '保存済み本文を使っていない');
  assert.match(DISPATCH, /subject: f\.Subject/, '保存済み件名を使っていない');
  // 送信ループでカタログから作り直していないこと
  assert.equal(/renderCampaign\(/.test(DISPATCH), false, 'dispatcher がテンプレートから作り直している');
});

test('guard: 文面が変われば planFingerprint も変わる（別文面へのすり替え防止）', () => {
  const fp = SEND.slice(SEND.indexOf('export function computePlanFingerprint'));
  assert.match(fp, /computeCampaignContentHash\(campaign\)/, '文面を指紋に含めていない');
});

test('guard: 送信登録は確認した文面と hash を送る', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("action: 'send'"));
  assert.match(block, /contentHash: mkContent\.confirmed/, '確認済み hash を送っていない');
  assert.match(block, /subject: mkContent\.confirmed/, '確認済み件名を送っていない');
  assert.match(block, /body: mkContent\.confirmed/, '確認済み本文を送っていない');
});

test('guard: Function は受け取った hash を再計算して照合する', () => {
  assert.match(FN, /if \(req\.contentHash && String\(req\.contentHash\) !== contentHash\)/, 'hash 照合が無い');
  assert.match(FN, /return json\(409, \{\s*\n?\s*error: '確認した文面と送ろうとしている文面が違います/, '不一致で止めていない');
});

test('guard: 文面の検証は Airtable を読む前に行う（不正な文面でデータを読まない）', () => {
  const fn = FN.slice(FN.indexOf('async function handlePlan'));
  const head = fn.slice(0, fn.indexOf('await loadCustomerMarketing'));
  assert.ok(head.includes('resolveDraft({ campaign, req })'), '読み込み前に検証していない');
});

test('guard: プレビューは送信と同じレンダラーを使う（専用実装を作らない）', () => {
  const preview = FN.slice(FN.indexOf('function buildPreview'), FN.indexOf('function handlePreview'));
  // 送信と同じ renderCampaign を使う（プレビュー用のサンプル値を渡すだけ）
  assert.match(preview, /renderCampaign\(\{/, '別実装で描いている');
  assert.match(preview, /name: PREVIEW_NAME/, 'サンプル宛名を使っていない');
  assert.match(preview, /PREVIEW_UNSUBSCRIBE_URL/, 'プレビュー用の配信停止 URL を使っていない');
  assert.equal(/<p style=/.test(preview), false, 'プレビュー側で HTML を組み立てている');
});

test('guard: 画面の文面編集は単一源の判定に従う', () => {
  assert.match(PAGE, /from '\.\.\/\.\.\/lib\/marketing\/campaignContentDraft\.js'/, '検証モジュールを使っていない');
  assert.match(PAGE, /from '\.\.\/\.\.\/lib\/marketing\/campaignEditorState\.js'/, '失効判定モジュールを使っていない');
  assert.match(SCRIPT, /draftApi\(\)\.canSendContent\(/, '送信可否を単一源で判定していない');
  assert.match(SCRIPT, /CONTENT_CHANGED_NOTICE/, '文面変更の案内文を使っていない');
});

test('guard: 文面編集の UI が揃っている（件名・本文・文字数・差し込み・既定へ戻す）', () => {
  for (const id of ['mkSubject', 'mkBody', 'mkSubjectCount', 'mkBodyCount',
    'mkPlaceholders', 'mkEditorReset', 'mkPreview', 'mkEditorErrors', 'mkContentState']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  // 件名は 1 行入力・本文は textarea
  assert.match(PAGE, /<input type="text" id="mkSubject"/, '件名が 1 行入力になっていない');
  assert.match(PAGE, /<textarea id="mkBody"/, '本文が textarea になっていない');
});

test('guard: 最終確認に件名・本文・hash・同意チェックがある', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkRenderConfirm'));
  assert.match(block, /内容 hash/, 'hash を出していない');
  assert.match(block, /送信する本文/, '本文を出していない');
  assert.match(block, /表示されている件名・本文を、この対象者へ送信します/, '同意チェックの文言が違う');
  assert.match(block, /送信後は取り消せません/, '取消不可の注意が無い');
  assert.match(block, /requireAck: true/, '同意を必須にしていない');
});

test('guard: 結果パネルは単一源（施策パネルからキャンペーンを外し、連打で積み上げない）', () => {
  assert.equal(/<option value="campaign">/.test(PAGE), false, '施策パネルにキャンペーンが残っている');
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkActionDry')"), SCRIPT.indexOf('function renderPlanView'));
  assert.match(block, /let mkActionSeq|mkActionSeq \+\+|\+\+mkActionSeq/, '実行世代で古い応答を捨てていない');
  assert.match(block, /btn\.dataset\.busy = '1'/, '連打を止めていない');
  assert.match(block, /box\.innerHTML = '';\s*\n?\s*\/\/ 常に最新/, '結果を積み上げている');
});
