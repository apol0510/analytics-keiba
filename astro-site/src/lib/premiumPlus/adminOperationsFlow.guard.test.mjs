/**
 * adminOperationsFlow.guard.test.mjs — 管理者の**日常業務が最後まで通る**こと
 *   node --test src/lib/premiumPlus/adminOperationsFlow.guard.test.mjs
 *
 * 対象の導線（入口から最後まで）:
 *   検索 → 個別状態確認 → 資格変更 → 正本への保存 → 再読込確認 → 変更履歴 → 失敗時の再処理
 *
 * ここで固定するのは「壊れると管理者が業務を完了できない」ものだけ。
 * どれも**エラーにならずに静かに壊れる**種類なので、静的に押さえる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
const FN = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const FNC = code(FN);
const PAGEC = code(PAGE);

// ── 1. 検索した相手が操作後も残る ─────────────────────────────
test('【重要】検索でしか出ない人を、再読込で消さない', () => {
  // load() が rows を素朴に差し替えると、候補集合の外の人（例: 無料会員の Daniel）を
  // 操作したあと詳細が「対象が見つかりません」に化ける
  assert.match(PAGEC, /const searchedRows = new Map\(\)/);
  assert.match(PAGEC, /function mergeSearched\(/);
  assert.match(PAGEC, /rows: mergeSearched\(data\.rows \|\| \[\]\)/);
  assert.equal(/lastData = data;\s*render\(\);/.test(PAGEC), false,
    'load() が rows を全置換に戻っている（検索した相手が消える）');
});

test('検索で見つけた候補集合外の人を覚える', () => {
  assert.match(PAGEC, /if \(r\.inCandidateSet !== true\) searchedRows\.set\(/);
});

// ── 2. 保存の確認が正本の読み直しであること ───────────────────
test('【重要】保存の確認は Airtable を読み直して行う（送った値を前提にしない）', () => {
  assert.match(PAGEC, /async function refreshOne\(/);
  assert.match(PAGEC, /call\(\{ action: 'lookup', recordId \}\)/,
    'recordId で読み直していない（Email 未設定の会員を確認できない）');
  assert.match(FNC, /req\.recordId.*\|\|.*''/s);
  assert.match(FNC, /RECORD_ID\(\) = /);
});

test('【重要】保存成功の表示が直後の再読込に消されない', () => {
  // 旧実装は msg('更新しました') の直後に load() が msg('') で上書きしていた
  assert.match(PAGEC, /await refreshOne\(r\.recordId\)/);
  const upd = PAGEC.slice(PAGEC.indexOf("action: 'update'"), PAGEC.indexOf("action: 'update'") + 1600);
  assert.equal(/msg\('更新しました[\s\S]{0,200}await load\(\)/.test(upd), false,
    '成功メッセージを load() が消す並びに戻っている');
  assert.match(upd, /保存を確認済み/);
});

// ── 3. 失敗時の再処理 ────────────────────────────────────────
test('【重要】通信断で操作が固まらない（call が例外を投げない）', () => {
  // ⚠️ 引数が増えても検出できるようにする（自動更新の quiet 追加で `call(payload, opt)` になった）。
  //    literal 一致にすると、署名が変わった瞬間に**検査が素通り**して守れなくなる。
  const at = PAGEC.search(/async function call\(payload/);
  assert.ok(at >= 0, 'call() を見つけられない（署名が変わった？）');
  const c = PAGEC.slice(at, at + 1600);
  assert.match(c, /try \{[\s\S]*await fetch\(API/, 'fetch を try で囲っていない');
  assert.match(c, /__unknown: true/);
});

test('【重要】通信断を「失敗」と言い切らない（二重操作を誘発しない）', () => {
  assert.match(PAGEC, /const isUnknownResult = /);
  assert.match(PAGEC, /result: 'unknown'/);
  assert.match(PAGEC, /保存されたかどうかは分かりません/);
});

test('結果が分からない操作は画面上部で警告し続ける', () => {
  assert.match(PAGEC, /function renderOpWarning\(/);
  assert.match(PAGEC, /opLog\.unresolved\(\)/);
  assert.match(PAGEC, /同じ操作を繰り返さないでください/);
});

test('再処理の導線（再読込して確認）がある', () => {
  assert.match(PAGEC, /再読込して確認/);
});

// ── 4. 変更履歴 ──────────────────────────────────────────────
test('【重要】操作者名を送る（履歴が全部 admin にならない）', () => {
  assert.match(PAGEC, /const currentActor = \(\) =>/);
  assert.match(PAGEC, /action: 'update'[\s\S]{0,200}actor,/);
  assert.match(PAGEC, /action: 'setUpsell'[\s\S]{0,120}actor/);
});

test('【重要】操作者名が空なら書き込ませない', () => {
  assert.match(PAGEC, /操作者名を入力してください/);
});

test('正本の最終更新（誰が・いつ・メモ）を画面に出す', () => {
  for (const label of ['最終更新（正本）', '最終更新者（正本）', '内部メモ（正本）']) {
    assert.ok(PAGE.includes(label), `変更履歴に「${label}」が無い`);
  }
  assert.match(PAGEC, /r\.updatedBy/, 'updatedBy を一度も表示していない');
});

test('このタブの操作履歴を出し、正本と混同させない', () => {
  assert.match(PAGEC, /opLog\.forRecord\(r\.recordId\)/);
  assert.match(PAGE, /タブを閉じると消えます/);
  assert.match(PAGE, /恒久的な記録は上の「正本」だけです/);
});

test('操作履歴の橋渡しは遅延取得（module script の defer で壊さない）', () => {
  // inline script は解析時に即実行される。window.__ppOpLog を即座に触ると undefined
  assert.match(PAGEC, /window\.__ppOpLog = \{ createOperationLog, describeEntry \}/);
  assert.match(PAGEC, /const NOOP = \{ add: \(\) => null/);
});

// ── 5. 同時編集 ──────────────────────────────────────────────
test('【重要】別の管理者の変更を黙って上書きしない', () => {
  assert.match(PAGEC, /expectedUpdatedAt: r\.updatedAt \|\| ''/);
  assert.match(FNC, /if \(req\.expectedUpdatedAt !== undefined\)/);
  assert.match(FNC, /code: 'stale_record'/);
  assert.match(FNC, /409/);
});

test('版を送らない呼び出しは従来どおり通す（後方互換）', () => {
  const i = FNC.indexOf('req.expectedUpdatedAt !== undefined');
  assert.ok(i > -1);
  // undefined のときは比較ブロックに入らない = 従来動作
  assert.match(FNC.slice(i, i + 700), /seen !== nowValue/);
});

test('更新の応答が前後と次の版を返す（履歴と再武装のため）', () => {
  for (const key of ['previous', 'previousLabel', 'updatedAt', 'updatedBy']) {
    assert.ok(FNC.includes(`${key}:`), `更新応答に ${key} が無い`);
  }
});

// ── 6. 表示欠落 ──────────────────────────────────────────────
test('【重要】強い操作の「会員に見えるもの」説明が表示される', () => {
  // noteWhere を作りながら noteD を二度 append していたため、一度も表示されていなかった
  assert.match(PAGEC, /secD\.appendChild\(noteWhere\)/);
  const d = PAGEC.slice(PAGEC.indexOf('const noteWhere'), PAGEC.indexOf('const opsD'));
  assert.equal((d.match(/secD\.appendChild\(noteD\)/g) || []).length, 0,
    'noteD を二重に足している（noteWhere が消える）');
  assert.ok(PAGE.includes('会員に見えるもの'));
});
