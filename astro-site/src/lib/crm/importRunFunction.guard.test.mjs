/**
 * importRunFunction.guard.test.mjs — 取り込み実行 Function の境界を固定する
 *   node --test src/lib/crm/importRunFunction.guard.test.mjs
 *
 * 「動いたときに何を書くか」だけでなく、**書けないこと**を構造で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const RUN = read('../../../netlify/functions/admin-customer-import-run.js');
const PREVIEW_FN = read('../../../netlify/functions/admin-customer-import.js');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const PLAN = read('./importWritePlan.js');
const EXEC = read('./importWriteExecutor.js');

const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ── 書ける範囲 ────────────────────────────────────────────────

test('guard: 実行 Function は既存レコードを更新しない（PATCH を持たない）', () => {
  const code = codeOnly(RUN);
  assert.equal(/method:\s*['"]PATCH['"]/.test(code), false, 'PATCH を組み立てている');
  assert.equal(/method:\s*['"]PUT['"]/.test(code), false);
  assert.equal(/method:\s*['"]DELETE['"]/.test(code), false, '削除を組み立てている');
  // 作成は「まとめ書き」と「1 件ずつ（切り分け用）」の 2 経路だけ。
  // どちらも Customers への POST で、更新系は持たない。
  const posts = code.match(/method:\s*['"]POST['"]/g) || [];
  assert.equal(posts.length, 2, `作成経路が ${posts.length} 箇所ある（まとめ書き + 切り分け用の 2 箇所）`);
  assert.match(RUN, /createRecords: async \(fieldsArray\)/, 'まとめ書きの経路が無い');
  assert.match(RUN, /createRecord: async \(fields\)/, '切り分け用の 1 件書き込みが無い');
});

test('guard: まとめ書きは Airtable の上限 10 件を超えない', () => {
  assert.match(EXEC, /export const CREATE_CHUNK_SIZE = 10;/);
  assert.match(EXEC, /Math\.min\(size, CREATE_CHUNK_SIZE\)/, 'チャンク上限を上書きできてしまう');
});

test('guard: 許可外の列があれば 1 件も書かない（部分書き込みを作らない）', () => {
  assert.match(EXEC, /if \(blocked > 0\) \{/, '許可列違反で全体を止めていない');
  const i = EXEC.indexOf('if (blocked > 0) {');
  const j = EXEC.indexOf('Phase 2');
  assert.ok(i > -1 && j > i, '許可列の検査が書き込みより後ろにある');
});

test('guard: 実行 Function はメールを送らない', () => {
  const code = codeOnly(RUN);
  assert.equal(code.includes('mail/send'), false);
  assert.equal(code.includes('@sendgrid/mail'), false);
});

test('guard: 初回は CREATE だけ（既存は対象から外す）', () => {
  assert.match(RUN, /facts\.existing\.has\(email\)\) continue;/, '既存を除外していない');
  assert.match(RUN, /facts\.paid\.has\(email\)\) continue;/, '現役有料会員を除外していない');
  assert.match(RUN, /facts\.duplicateInAk\.has\(email\)\) continue;/, 'AK 側重複を除外していない');
  assert.match(RUN, /e\.flags && e\.flags\.length > 0\) continue;/, '要確認を除外していない');
});

test('guard: 停止リストを確認できないときは 1 件も書かない', () => {
  assert.match(RUN, /if \(!\(provider && provider\.ok\)\) continue;/, 'fail closed になっていない');
});

// ── ゲート ────────────────────────────────────────────────────

test('guard: 二重ゲート（env + 確認文字列）を通る経路しか無い', () => {
  assert.match(RUN, /canRunFirstImport\(/, 'ゲートを通っていない');
  assert.match(PLAN, /env\.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'/, 'env ゲートが無い');
  assert.match(PLAN, /RUN_REJECT\.NO_CONFIRMATION/, '確認文字列ゲートが無い');
  // writeCreateBatch の呼び出しはゲート判定より後ろにある
  const gateAt = RUN.indexOf('canRunFirstImport(');
  const writeAt = RUN.indexOf('await writeCreateBatch(');
  assert.ok(gateAt > -1 && writeAt > gateAt, 'ゲートより前に書き込んでいる');
});

test('guard: 初回上限は 100 件で、コードから緩められない', () => {
  assert.match(PLAN, /export const FIRST_RUN_MAX_ROWS = 100;/);
  assert.match(PLAN, /Math\.min\(maxRows, FIRST_RUN_MAX_ROWS\)/, '上限を上書きできてしまう');
});

test('guard: 課金・特典・決済・電話番号・登録日を書けない', () => {
  for (const f of ['PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
    'LightGrantUntil', 'PremiumGrantUntil', 'LifetimeSanrenpuku', 'Phone', '登録日',
    'UnsubscribedAnalyticsKeiba']) {
    assert.ok(PLAN.includes(`'${f}'`), `${f} が禁止列に無い`);
  }
  assert.match(EXEC, /assertOnlyCreateFields\(fields\)/, '許可列の検査をしていない');
});

// ── 冪等性・再試行 ────────────────────────────────────────────

test('guard: 冪等キーと直前再判定を必ず通る', () => {
  assert.match(EXEC, /done\.has\(rowKey\)/, '冪等キーを見ていない');
  assert.match(EXEC, /existing\.has\(email\)/, '書き込み直前の再判定が無い');
  // 上限は**書き込む前**（適格判定の段階）で切る。まとめ書きへ計画より多く渡さないため
  assert.match(EXEC, /accepted\.length >= limit/, '上限の検査が無い');
});

test('guard: 429/5xx だけ再試行する', () => {
  assert.match(PLAN, /s === 429 \|\| \(s >= 500 && s <= 599\)/);
  assert.match(EXEC, /shouldRetryStatus\(lastStatus\)/);
});

test('guard: 監査ログに PII を入れない', () => {
  assert.match(EXEC, /buildImportAuditEntry\(/, '監査ログを共通ビルダー経由で作っていない');
  // 監査に渡してよいのは rowKey（ハッシュ）だけ。email 変数・氏名を渡していないこと
  // （`reason: 'no_email'` のような**理由コード**は値ではないので検知対象外）
  const pushes = EXEC.match(/buildImportAuditEntry\(\{[^}]*\}\)/g) || [];
  assert.ok(pushes.length > 0, '監査ログの生成箇所が無い');
  for (const p of pushes) {
    assert.equal(/\bemail\b\s*[,}]/.test(p), false, `監査ログにアドレスを渡している: ${p.slice(0, 60)}`);
    assert.equal(p.includes('name'), false, `監査ログに氏名を渡している: ${p.slice(0, 60)}`);
    assert.equal(/rowKey/.test(p), true, '監査ログに rowKey が無い');
  }
});

test('guard: 例外の中身を応答へ返さない', () => {
  const c = RUN.slice(RUN.indexOf('} catch (e) {'));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});

// ── 下見 Function は read-only のまま ─────────────────────────

test('guard: 下見 Function に書き込み経路が増えていない', () => {
  const code = codeOnly(PREVIEW_FN);
  assert.equal(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(code), false,
    '下見 Function に書き込みが混ざっている');
  assert.match(PREVIEW_FN, /action === 'run'/);
  assert.match(PREVIEW_FN, /501/);
});

// ── 画面 ──────────────────────────────────────────────────────

test('guard(ui): 本番取込ボタンはまだ有効化しない', () => {
  const i = PAGE.indexOf('id="impRun"');
  assert.ok(i > -1);
  const btn = PAGE.slice(i - 200, i + 300);
  assert.match(btn, /disabled/);
  assert.equal(/impRun'\)\?\.addEventListener/.test(PAGE), false, '実行ボタンに処理を配線している');
});

test('guard(ui): 初回方針を画面に明記する', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込み（下見）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const phrase of ['新規作成のみ', '更新しません', '再判定', '最大 100 件', '別承認', '現在は書き込み無効']) {
    assert.ok(s.includes(phrase), `画面に「${phrase}」が無い`);
  }
});

test('guard(ui): 明細・アドレスを DOM へ出さない', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込み（下見）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const bad of ['RecipientEmail', 'recordId']) assert.equal(s.includes(bad), false);
});
