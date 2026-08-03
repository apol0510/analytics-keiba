/**
 * comebackApplySinglePath.guard.test.mjs — 本番付与の入口は 1 つだけ
 *   node --test src/lib/comeback/comebackApplySinglePath.guard.test.mjs
 *
 * ── 何を防ぐか ────────────────────────────────────────────────
 * 2026-08-03 監査時点のカムバック特典タブには、本番付与に見えるボタンが 3 つあった。
 *
 *   Step 5 本体   「⚠️ 🎁 無料特典を付与する」（赤）… planFingerprint 無しで apply を直接呼ぶ → 400
 *   追従バー      「🚀 無料特典を付与」（赤）      … クリックハンドラが無く何も起きない
 *   確認モーダル  「実行する（付与 N 名 / オファー M 名）」… 別タブ用の変数を参照し ReferenceError
 *
 * どれが本番なのか画面から判別できないうえ、実際にはどれも付与に到達しなかった。
 * 「確認画面を開く操作」と「本番データを書き換える操作」を混ぜないことを構造で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const CB_BLOCK = SCRIPT.slice(SCRIPT.indexOf('カムバック特典（無料 entitlement の付与）'));

/** コメントを落とした「実際に動くコード」。説明文をコードの証拠と取り違えないため */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SCRIPT_CODE = codeOnly(SCRIPT);

/** ある関数・ハンドラの本文を、開始位置から一定長ぶん切り出す */
function sliceFrom(src, marker, len = 2600) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `見つからない: ${marker}`);
  return src.slice(i, i + len);
}

// ── 本番 write の入口は 1 つだけ ──────────────────────────────────

test('apply API を呼ぶ箇所はページ全体で 1 か所だけ', () => {
  const calls = (SCRIPT.match(/action:\s*'apply'/g) || []).length;
  assert.equal(calls, 1, `apply の呼び出しが ${calls} か所ある（1 か所に固定する）`);
});

test('apply を呼ぶのは cbRunApply だけ', () => {
  const body = sliceFrom(SCRIPT, 'async function cbRunApply(');
  assert.match(body, /action:\s*'apply'/, 'cbRunApply が付与を実行していない');
  // 呼び出し元は確認モーダルの最終ボタンだけ
  const callers = (SCRIPT_CODE.match(/cbRunApply\(/g) || []).length;
  assert.equal(callers, 2, `cbRunApply の定義 + 呼び出しが ${callers} 箇所（定義 1 + 呼び出し 1 のはず）`);
  assert.match(sliceFrom(SCRIPT, "function cbRenderConfirm(", 14000), /await cbRunApply\(btn, plan, sel\)/,
    '確認モーダルの最終ボタンから呼んでいない');
});

test('Step 5 本体のボタンは apply を呼ばず、確認画面を開くだけ', () => {
  const handler = sliceFrom(SCRIPT, "$('cbApplyBtn')?.addEventListener", 300);
  assert.equal(/action:\s*'apply'/.test(handler), false, 'Step 5 本体が本番付与を呼んでいる');
  assert.equal(/cbRunApply\(/.test(handler), false, 'Step 5 本体が本番付与を呼んでいる');
  assert.match(handler, /cbOpenApplyConfirm\(/, '確認画面を開いていない');
});

test('追従バーのボタンは apply を呼ばず、Step 5 と同じ確認画面を開く', () => {
  const handler = sliceFrom(SCRIPT, "$('cbSbNext')?.addEventListener", 700);
  assert.equal(/action:\s*'apply'/.test(handler), false, '追従バーが本番付与を呼んでいる');
  assert.equal(/cbRunApply\(/.test(handler), false, '追従バーが本番付与を呼んでいる');
  assert.match(handler, /cbOpenApplyConfirm\(/, 'Step 5 と同じ確認画面を開いていない');
});

test('確認画面を開く関数は書き込み系 action を一切持たない', () => {
  const fn = sliceFrom(SCRIPT, 'function cbOpenApplyConfirm(', 700);
  for (const b of ["action: 'apply'", "action: 'revoke'", "action: 'offerRevoke'"]) {
    assert.equal(fn.includes(b), false, `確認を開くだけの関数が ${b} を呼んでいる`);
  }
});

test('dry-run は書き込みボタン入りの画面を勝手に開かない', () => {
  const handler = sliceFrom(SCRIPT, "$('cbDryRun').addEventListener", 2200);
  assert.match(handler, /action: 'dryRun'/, 'dry-run を呼んでいない');
  assert.equal(/cbRenderConfirm\(/.test(handler), false, 'dry-run が最終確認モーダルを開いている');
});

// ── 文言と役割の一致 ────────────────────────────────────────────

test('Step 5 本体と追従バーは同じ文言・同じアイコンになる', () => {
  assert.match(PAGE, /id="cbApplyBtn"[^>]*>📋 付与内容の最終確認へ/, 'Step 5 本体の文言が違う');
  // 追従バーの文言は単一源が返す（画面に直書きしない）
  assert.match(SCRIPT, /5: '📋 '/, '追従バーのアイコンが Step 5 と揃っていない');
  assert.equal(/id="cbSbNext"[^>]*>[^<]*無料特典を付与/.test(PAGE), false, '追従バーが本番付与を名乗っている');
});

test('追従バーが別操作でないことを支援技術にも伝える', () => {
  const el = PAGE.match(/<button[^>]*id="cbSbNext"[^>]*>/);
  assert.ok(el, 'cbSbNext が無い');
  assert.match(el[0], /aria-label="[^"]*別の操作ではありません/, 'aria-label に説明が無い');
  assert.match(el[0], /title="[^"]*別の操作ではありません/, 'title に説明が無い');
});

test('Step 5 本体の aria-label は「付与しない」ことを名乗る', () => {
  const el = PAGE.match(/<button[^>]*id="cbApplyBtn"[^>]*>/);
  assert.ok(el, 'cbApplyBtn が無い');
  assert.match(el[0], /aria-label="[^"]*この操作では付与しません/, 'aria-label が役割を表していない');
});

test('抽象的な「実行する（…）」ボタンを残さない', () => {
  assert.equal(/実行する（付与/.test(CB_BLOCK), false, '抽象的な実行ボタンが残っている');
  assert.match(SCRIPT, /buildApplyActionLabel\(/, '最終ボタンの文言を単一源で作っていない');
  assert.match(SCRIPT, /buildApplyActionAriaLabel\(/, '最終ボタンの aria-label を単一源で作っていない');
});

// ── 二重実行の防止 ────────────────────────────────────────────

test('最終ボタンは二重クリックで 2 回走らない', () => {
  const body = sliceFrom(SCRIPT, "function cbRenderConfirm(", 14000);
  assert.match(body, /if \(btn\.dataset\.busy === '1'\) return;/, '二重クリック防止が無い');
  assert.match(body, /canRunApply\(/, '実行可否を単一源で判定していない');
});

test('実行中は無効化し「付与中…」を出す', () => {
  const body = sliceFrom(SCRIPT, 'async function cbRunApply(', 900);
  assert.match(body, /btn\.dataset\.busy = '1'/, '実行中フラグが無い');
  assert.match(body, /btn\.disabled = true/, '実行中に無効化していない');
  assert.match(body, /APPLY_BUSY_LABEL/, '実行中の表示が無い');
});

test('完了後は同じ確認から再実行できない', () => {
  const body = sliceFrom(SCRIPT, 'async function cbRunApply(', 3000);
  assert.match(body, /cbState\.applied = true/, '完了状態にしていない');
  assert.match(body, /cbState\.dryPlan = null/, '確認内容を捨てていない');
  assert.match(body, /APPLY_DONE_LABEL/, '完了後の表示が無い');
});

test('operationId は dry-run のものを使い、planFingerprint を必ず送る', () => {
  const body = sliceFrom(SCRIPT, 'async function cbRunApply(', 1200);
  assert.match(body, /operationId: cbState\.dryRun\.operationId/, '冪等性の鍵が dry-run 由来でない');
  assert.match(body, /planFingerprint: plan\.planFingerprint/, 'TOCTOU 検証トークンを送っていない');
});

// ── 確認モーダルの必須表示 ──────────────────────────────────────

test('確認モーダルは要求項目を単一源の並びで出す', () => {
  const body = sliceFrom(SCRIPT, "function cbRenderConfirm(", 14000);
  assert.match(body, /buildApplySummaryRows\(/, '必須項目を単一源で作っていない');
  assert.match(body, /APPLY_MAIL_NOTICE|buildApplySummaryRows/, 'メール送信の有無を出していない');
  assert.match(body, /APPLY_HANDOFF_NOTICE/, '付与後の引き継ぎ導線を説明していない');
  assert.match(body, /UNCHANGED_NOTICE/, '変更しないものを出していない');
});

test('本番 write の直前に「本番データを変更する」と書く', () => {
  const body = sliceFrom(SCRIPT, "function cbRenderConfirm(", 14000);
  assert.match(body, /APPLY_WRITE_NOTICE/, '本番変更の明示が無い');
  assert.match(body, /sec3\.className = 'dt-sec danger'/, '実行区画が danger になっていない');
});

test('gate OFF / 0 名では最終ボタンを押せない', () => {
  const body = sliceFrom(SCRIPT, "function cbRenderConfirm(", 14000);
  assert.match(body, /btn\.disabled = !plan\.writeEnabled \|\| total === 0/, '無効化条件が無い');
});

// ── 既存の導線を壊していない ────────────────────────────────────

test('付与成功者の引き継ぎ導線が残っている', () => {
  const body = sliceFrom(SCRIPT, 'async function cbRunApply(', 3000);
  assert.match(body, /cbState\.lastHandoff = out\.handoff \|\| null/, '引き継ぎ票を保持していない');
  assert.match(body, /cbRenderApplyResult\(out\)/, '付与結果を出していない');
  // 途中で止まっても付与済みは巻き戻さない
  assert.match(body, /canHandoff \? res\.data\.handoff : null/, '部分成功の引き継ぎが消えている');
  assert.ok(CB_BLOCK.includes('成功者へ案内メールを作成'), '案内メールへの導線が消えている');
});

test('現有効会員の混入時は最終確認へ進めない（既存の fail closed を維持）', () => {
  const fn = sliceFrom(SCRIPT, 'function cbOpenApplyConfirm(', 700);
  assert.match(fn, /canApply\(cbState\)/, '対象の妥当性を単一源で判定していない');
  assert.match(SCRIPT, /現在有効な会員が含まれています/, '混入時の警告が消えている');
});

test('モーダルの開閉でフォーカスが迷子にならない', () => {
  assert.match(PAGE, /id="cbModalTitle" tabindex="-1"/, '見出しへフォーカスを移せない');
  assert.match(SCRIPT, /\$\('cbModalTitle'\)\.focus\(\)/, '開いたときに見出しへフォーカスしていない');
  assert.match(SCRIPT, /cbModalOpener/, '閉じたあとの戻り先を覚えていない');
});
