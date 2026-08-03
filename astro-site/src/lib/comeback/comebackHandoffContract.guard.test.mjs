/**
 * comebackHandoffContract.guard.test.mjs — 無料付与 → 案内メール引き継ぎの契約
 *   node --test src/lib/comeback/comebackHandoffContract.guard.test.mjs
 *
 * 引き継ぎは「便利さ」のための導線だが、便利にした結果
 *   - 付与とメールが 1 操作に融合する
 *   - 画面が渡した recordId をサーバーが信じる
 *   - 除外判定（suppression / 配信停止）が緩む
 * のどれかが起きたら事故になる。ソース側でそれを起こせないように固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const CB_BLOCK = SCRIPT.slice(SCRIPT.indexOf('カムバック特典（無料 entitlement の付与）'));
const MK_BLOCK = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'), SCRIPT.indexOf('カムバック特典（無料 entitlement の付与）'));
const MARKETING_FN = read('../../../netlify/functions/admin-marketing.js');
const GRANTS_FN = read('../../../netlify/functions/admin-comeback-grants.js');
const MODULE = read('./comebackEmailHandoff.js');

/** コメントを落とした「実際に動くコード」。説明文の語をコードの証拠と取り違えないため */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MARKETING_CODE = codeOnly(MARKETING_FN);
const GRANTS_CODE = codeOnly(GRANTS_FN);

// ── 付与とメールは別operation のまま ──────────────────────────────

test('付与 Function は引き継ぎ票を返すだけで、メール経路を持たない', () => {
  assert.equal(/api\.sendgrid\.com/.test(GRANTS_CODE), false, '付与 Function が送信 API を持っている');
  for (const banned of ['ScheduledEmails', 'CampaignDeliveries']) {
    assert.equal(GRANTS_CODE.includes(banned), false, `付与 Function が ${banned} を触っている`);
  }
  assert.ok(GRANTS_FN.includes('buildHandoffTicket'), '引き継ぎ票を返していない');
});

test('付与の実行ハンドラがメール送信 action を呼ばない（1 操作に融合しない）', () => {
  assert.equal(/action:\s*'apply'[\s\S]{0,600}action:\s*'send'/.test(CB_BLOCK), false,
    '付与の直後にメール送信を呼んでいる');
  assert.equal(CB_BLOCK.includes("action: 'send'"), false, '特典タブから送信 action を呼んでいる');
});

test('特典タブはマーケティング API を直接叩かない（タブ越しの入口だけを使う）', () => {
  assert.equal(CB_BLOCK.includes('mkCall({'), false, 'マーケティング API を直接呼んでいる');
  assert.equal(CB_BLOCK.includes('MKT_API'), false);
  assert.ok(CB_BLOCK.includes('window.__mkHandoff'), '引き継ぎの入口を使っていない');
});

// ── 引き継ぐのは識別子と件数だけ ────────────────────────────────

test('引き継ぎ票に載せるのは operationId と件数だけ（PII を組み立てない）', () => {
  const fn = MODULE.slice(MODULE.indexOf('export function buildHandoffTicket'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const banned of ['Email', 'email', '氏名', 'recordId']) {
    assert.equal(body.includes(banned), false, `引き継ぎ票に ${banned} を入れている`);
  }
});

test('画面は recordId を保存しない（保存するのは operationId と人数だけ）', () => {
  const save = MODULE.slice(MODULE.indexOf('export function saveHandoff'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.equal(/recordId/.test(body), false, '保存値に recordId を入れている');
  assert.ok(body.includes('operationId'));
});

test('顧客情報を URL へ載せない', () => {
  assert.equal(/location\.(href|search)\s*=/.test(MK_BLOCK), false);
  assert.equal(MK_BLOCK.includes('URLSearchParams'), false);
  assert.equal(/location\.(href|search)\s*=/.test(CB_BLOCK), false);
  assert.equal(CB_BLOCK.includes('URLSearchParams'), false);
});

// ── サーバーが対象を確定する ────────────────────────────────────

test('引き継ぎモードでは画面が渡した recordIds を読まない', () => {
  // grantOperationId があるときは recordIds を空配列に固定している
  assert.match(
    MARKETING_FN,
    /const recordIds = grantOperationId\s*\n?\s*\?\s*\[\]/,
    '引き継ぎ時に recordIds を読み飛ばしていない',
  );
  assert.ok(MARKETING_FN.includes('collectGrantedRecipients'), '対象をサーバー側で導出していない');
});

test('対象導出・期限判定を Function 内へ再実装しない（単一源へ委譲）', () => {
  assert.ok(MARKETING_FN.includes('validateHandoffResolution'), '期限判定を委譲していない');
  // 期限の数値を Function 内に直書きしない
  assert.equal(/2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(MARKETING_CODE), false, 'TTL を Function 内に直書きしている');
  // grant フィールド名を Function 内で直接読まない（判定はモジュールの責務）
  for (const f of ['LightGrantOp', 'PremiumGrantOp', 'LightGrantedAt', 'PremiumGrantedAt']) {
    assert.equal(MARKETING_CODE.includes(f), false, `${f} を Function 内で直接読んでいる`);
  }
});

test('引き継ぎの応答は件数と期限だけ（アドレス・recordId を返さない）', () => {
  const view = MARKETING_FN.slice(MARKETING_FN.indexOf('handoffView = {'));
  const body = view.slice(0, view.indexOf('};'));
  for (const banned of ['recordIds', 'email', 'Email']) {
    assert.equal(body.includes(banned), false, `引き継ぎ応答に ${banned} を載せている`);
  }
  assert.ok(body.includes('resolved'));
  assert.ok(body.includes('expiresAt'));
});

test('引き継ぎでも既存の除外判定を通す（別経路を作らない）', () => {
  // 対象の差し替えは buildCampaignPlan より前。プラン生成そのものは 1 本のまま
  const plan = MARKETING_FN.slice(MARKETING_FN.indexOf('async function handlePlan'));
  assert.equal((plan.match(/buildCampaignPlan\(/g) || []).length, 1, '送信計画の生成が 2 経路ある');
  assert.ok(plan.includes('provider_suppression_unavailable'), 'suppression の fail closed が消えている');
});

test('live gate は引き継ぎでも先に通る（gate → 書き込みの順序を保つ）', () => {
  const gateIdx = MARKETING_FN.indexOf('if (live && !isMarketingSendEnabled');
  const resolveIdx = MARKETING_FN.indexOf('collectGrantedRecipients(');
  const writeIdx = MARKETING_FN.indexOf('createRecord(', MARKETING_FN.indexOf('async function handlePlan'));
  assert.ok(gateIdx > 0 && gateIdx < resolveIdx, 'gate より前に引き継ぎ解決が走っている');
  assert.ok(resolveIdx < writeIdx, '書き込みより後で対象を確定している');
});

test('キュー登録には由来の付与操作を残す（後から辿れる）', () => {
  assert.ok(MARKETING_FN.includes('handoffNote(grantOperationId)'), '監査用の印を残していない');
});

// ── 画面の導線 ────────────────────────────────────────────────

test('付与結果に 成功人数 / 失敗人数 / PII なしの理由集計 が出る', () => {
  const block = CB_BLOCK.slice(CB_BLOCK.indexOf('function cbRenderApplyResult'));
  const body = block.slice(0, block.indexOf('\n    }\n'));
  assert.ok(body.includes('付与できた人数'));
  assert.ok(body.includes('付与できなかった人数'));
  assert.ok(body.includes('付与できなかった理由'));
  assert.ok(body.includes('notGrantedReasons'), '理由集計を使っていない');
  assert.equal(/\.email|Email|recordId/.test(body), false, '結果表示に PII を出している');
});

test('「成功者へ案内メールを作成」ボタンがあり、0 名では押せない', () => {
  assert.ok(CB_BLOCK.includes('成功者へ案内メールを作成'), '次工程への導線が無い');
  assert.match(CB_BLOCK, /canGo = !!\(ho && ho\.canHandoff\)/, '0 名でも押せる状態になっている');
  assert.match(CB_BLOCK, /go\.disabled = !canGo/);
  assert.match(CB_BLOCK, /aria-disabled['"]?,\s*String\(!canGo\)/, '無効状態が支援技術へ伝わらない');
});

test('引き継ぎボタンは二重クリックで 2 回走らない', () => {
  // ボタンを組み立てている箇所（通知文ではなく実装）を見る
  const block = CB_BLOCK.slice(CB_BLOCK.indexOf("go.textContent = '✉️ 成功者へ案内メールを作成'"));
  assert.ok(block.length > 0, '引き継ぎボタンの実装が見つからない');
  assert.match(block.slice(0, 800), /dataset\.busy === '1'/, '二重クリック防止が無い');
});

test('文面プレビューは閲覧専用で終わらせず、例であることを明示して次工程へ接続する', () => {
  assert.ok(PAGE.includes('送信予定文面の例'), '「例」であることを明示していない');
  const block = CB_BLOCK.slice(CB_BLOCK.indexOf("action: 'preview'"));
  assert.ok(block.slice(0, 2500).includes('メール作成工程へ進む'), 'メール作成工程へ接続していない');
});

test('メール工程では引き継ぎ中に recordIds を送らない', () => {
  assert.match(MK_BLOCK, /function mkTargetPayload[\s\S]{0,400}grantOperationId/, '対象指定を切り替えていない');
  // dry-run / 送信の両方が同じ切替関数を通る（片方だけ引き継ぎ、が起きない）
  assert.ok(MK_BLOCK.includes("action: 'dryRun', campaignId: c.campaignId, ...mkTargetPayload()"));
  assert.match(MK_BLOCK, /action: 'send',[\s\S]{0,200}\.\.\.mkTargetPayload\(\)/);
});

test('引き継ぎは使い切り（キュー登録後に同じ引き継ぎを再利用しない）', () => {
  assert.ok(MK_BLOCK.includes('markHandoffQueued'), 'キュー登録済みの印を付けていない');
  assert.ok(MK_BLOCK.includes('mkHandoffRelease'), '使い切り後に解除していない');
});

test('引き継ぎ中であることと解除方法を画面に出す', () => {
  assert.ok(PAGE.includes('id="mkHandoffBar"'), '引き継ぎ中の表示が無い');
  assert.ok(MK_BLOCK.includes('引き継ぎを解除'), '解除できない');
  assert.ok(MK_BLOCK.includes('カムバック無料付与の成功者を引き継ぎ中'));
});

test('再読み込みで引き継ぎを復元し、期限切れ・使用済みは復元しない', () => {
  assert.ok(SCRIPT.includes('mkHandoffRestore()'), '復元処理を呼んでいない');
  const fn = MK_BLOCK.slice(MK_BLOCK.indexOf('function mkHandoffRestore'));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  assert.ok(body.includes('EXPIRED') && body.includes('ALREADY_QUEUED'), '失効理由を扱っていない');
  assert.ok(body.includes('clearHandoff'), '使えない引き継ぎを捨てていない');
});

test('引き継ぎの判定を画面へ再実装しない（単一源へ委譲）', () => {
  assert.ok(PAGE.includes('comebackEmailHandoff.js'), '判定モジュールを読み込んでいない');
  assert.ok(PAGE.includes('window.__cbHandoff'), '橋渡ししていない');
  // 画面側で期限を計算し直さない
  assert.equal(/HANDOFF_TTL_MS\s*=\s*\d/.test(SCRIPT), false, '画面で TTL を定義し直している');
});
