/**
 * importJobFunction.guard.test.mjs — 取り込みジョブ Function / 画面の境界を固定する
 *   node --test src/lib/crm/importJobFunction.guard.test.mjs
 *
 * 「動いたときに何を書くか」だけでなく、**書けないこと**を構造で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const JOB_FN = read('../../../netlify/functions/admin-customer-import-job.js');
const RUN_FN = read('../../../netlify/functions/admin-customer-import-run.js');
const MODEL = read('./importJobModel.js');
const RUNNER = read('./importJobRunner.js');
const ELIG = read('./importEligibility.js');
const STORE = read('./importJobStore.js');
const EXEC = read('./importWriteExecutor.js');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');

const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ── 書ける範囲 ────────────────────────────────────────────────

test('guard: ジョブ Function は既存レコードを更新・削除しない', () => {
  const code = codeOnly(JOB_FN);
  assert.equal(/method:\s*['"]PATCH['"]/.test(code), false, 'PATCH を組み立てている');
  assert.equal(/method:\s*['"]PUT['"]/.test(code), false);
  assert.equal(/method:\s*['"]DELETE['"]/.test(code), false, '削除を組み立てている');
  // 作成は「まとめ書き」と「1 件ずつ（切り分け用）」の 2 経路だけ
  const posts = code.match(/method:\s*['"]POST['"]/g) || [];
  assert.equal(posts.length, 2, `作成経路が ${posts.length} 箇所ある（2 箇所であるべき）`);
  assert.match(JOB_FN, /createRecords: async \(fieldsArray\)/, 'まとめ書きの経路が無い');
  assert.match(JOB_FN, /createRecord: async \(fields\)/, '切り分け用の 1 件書き込みが無い');
});

test('guard: ジョブ Function はメールを送らない', () => {
  const code = codeOnly(JOB_FN);
  for (const bad of ['mail/send', '@sendgrid/mail', 'sendgrid.com/v3/mail']) {
    assert.equal(code.includes(bad), false, `送信経路がある: ${bad}`);
  }
  // 送信系モジュールを import していない
  assert.equal(/from '.*(sendMail|mailer|newsletter-send)/.test(code), false);
});

test('guard: 二重ゲート（env + 確認文字列）を通る経路しか無い', () => {
  assert.match(JOB_FN, /canStartImportJob\(/, '開始ゲートを通っていない');
  assert.match(JOB_FN, /canStepImportJob\(/, '続行ゲートを通っていない');
  assert.match(MODEL, /env\.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'/, 'env ゲートが無い');
  assert.match(MODEL, /JOB_REJECT\.NO_CONFIRMATION/, '確認文字列ゲートが無い');
  // 書き込み（runChildBatch）はゲート判定より後ろにある
  const gateAt = JOB_FN.indexOf('canStepImportJob(');
  const writeAt = JOB_FN.indexOf('await runChildBatch(');
  assert.ok(gateAt > -1 && writeAt > gateAt, 'ゲートより前に書き込んでいる');
});

test('guard: env ゲートは start と step の両方に掛かる', () => {
  // canStartImportJob / canStepImportJob のどちらも最初に env を見る
  for (const fn of ['canStartImportJob', 'canStepImportJob']) {
    const i = MODEL.indexOf(`export function ${fn}`);
    assert.ok(i > -1, `${fn} が無い`);
    // 次の export までを本文とみなす（引数の分割代入で切れないように）
    const nextExport = MODEL.indexOf('\nexport ', i + 1);
    const body = MODEL.slice(i, nextExport > -1 ? nextExport : MODEL.length);
    assert.match(body, /CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'/, `${fn} に env ゲートが無い`);
    // env の検査が**最初の関門**であること（他の判定より前）
    const envAt = body.indexOf("CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'");
    const confAt = body.indexOf('NO_CONFIRMATION');
    if (confAt > -1) assert.ok(envAt < confAt, `${fn} で env ゲートが後回しになっている`);
  }
});

test('guard: 子バッチは 100 件を超えられない（コードから緩められない）', () => {
  assert.match(MODEL, /export const JOB_CHILD_MAX_ROWS = FIRST_RUN_MAX_ROWS;/);
  assert.match(MODEL, /Math\.min\(JOB_CHILD_MAX_ROWS, Math\.max\(1, n\)\)/, '上限を上書きできてしまう');
  assert.match(JOB_FN, /childSize: JOB_CHILD_MAX_ROWS/, '子バッチの大きさを固定していない');
});

test('guard: まとめ書きは Airtable の上限 10 件を超えない（executor を再利用）', () => {
  assert.match(EXEC, /export const CREATE_CHUNK_SIZE = 10;/);
  assert.match(RUNNER, /writeCreateBatch\(/, '実績のある executor を使っていない');
  // ジョブ経路が独自の書き込みループを持っていないこと
  assert.equal(/for \(const chunk of/.test(codeOnly(RUNNER)), false, '独自のチャンク処理を再実装している');
});

test('guard: 計画総数を超えて書かない', () => {
  assert.match(RUNNER, /int\(job\?\.plannedTotal\) - int\(job\?\.totals\?\.created\)/, '残り予算の計算が無い');
  assert.match(RUNNER, /maxWrites: limit/, '上限を executor へ渡していない');
});

test('guard: 子バッチ直前に既存アドレスを取り直して渡す', () => {
  assert.match(RUNNER, /existingEmails: new Set\(facts && facts\.existing/, '直前再判定を渡していない');
  // buildJobContext（Customers 取得）は step のたびに呼ばれる
  const stepAt = JOB_FN.indexOf('async function handleStep');
  const body = JOB_FN.slice(stepAt, JOB_FN.indexOf('// ── action: status'));
  assert.match(body, /await buildJobContext\(/, 'step で Customers を取り直していない');
});

test('guard: CREATE だけ（既存・有料・重複・要確認は対象から外す）', () => {
  for (const s of ['SKIP_REASON.EXISTING', 'SKIP_REASON.PAID', 'SKIP_REASON.DUPLICATE_IN_AK',
    'SKIP_REASON.FLAGGED', 'SKIP_REASON.UNSUBSCRIBED', 'SKIP_REASON.HARD_BOUNCE',
    'SKIP_REASON.SOFT_BOUNCE', 'SKIP_REASON.SUSPENDED', 'SKIP_REASON.TEST_ACCOUNT',
    'SKIP_REASON.PROVIDER_SUPPRESSED']) {
    assert.ok(ELIG.includes(s), `${s} の除外が無い`);
  }
});

test('guard: ジョブ経路の除外集合は単発 run と一致する（取りこぼしを作らない）', () => {
  // 実績のある単発 run が見ている facts と同じものをジョブ側も見ていること
  for (const fact of ['unsubscribed', 'hardBounce', 'softBounce', 'suspended',
    'testAccounts', 'paid', 'duplicateInAk', 'existing']) {
    assert.ok(RUN_FN.includes(`facts.${fact}`), `単発 run に facts.${fact} が無い（前提が変わった）`);
    assert.ok(ELIG.includes(`f.${fact}`), `ジョブ側に f.${fact} が無い`);
  }
  // 停止リストが取れないときは両方とも書かない
  assert.match(RUN_FN, /if \(!\(provider && provider\.ok\)\) continue;/);
  assert.match(MODEL, /JOB_REJECT\.PREVIEW_INVALID/);
});

// ── 冪等性・再開・同時実行 ────────────────────────────────────

test('guard: 二重作成を防ぐ本体は Customers 側の実在判定（store ではない）', () => {
  assert.match(EXEC, /existing\.has\(email\)/, '書き込み直前の再判定が無い');
  assert.match(STORE, /正本ではない/, 'store が正本でないことを明記していない');
  assert.match(MODEL, /二重作成を防ぐのは \*\*Customers 側のアドレス実在判定\*\*/);
});

test('guard: 同時実行はリースで fail-closed に断る', () => {
  assert.match(MODEL, /JOB_REJECT\.LOCKED/);
  assert.match(MODEL, /isLeaseHeld\(\{ job, nowMs, leaseMs \}\)\) return no\(JOB_REJECT\.LOCKED\)/);
});

test('guard: 完了・取消・失敗のジョブは進めない（再実行拒否）', () => {
  assert.match(MODEL, /job\.status === JOB_STATUS\.COMPLETED\) return no\(JOB_REJECT\.ALREADY_COMPLETED\)/);
  assert.match(MODEL, /job\.status === JOB_STATUS\.CANCELLED\) return no\(JOB_REJECT\.CANCELLED\)/);
  assert.match(MODEL, /job\.status === JOB_STATUS\.FAILED\) return no\(JOB_REJECT\.FAILED\)/);
});

test('guard: cancel は作成済みを消さない', () => {
  const i = MODEL.indexOf('export function cancelImportJob');
  const body = MODEL.slice(i, MODEL.indexOf('\n}', i));
  assert.equal(/delete|splice|totals: \{/.test(body), false, 'cancel が作成済みを触っている');
  assert.match(body, /JOB_STATUS\.CANCELLED/);
});

test('guard: ファイルが差し替わったら進めない', () => {
  assert.match(MODEL, /JOB_REJECT\.FILE_CHANGED/);
  assert.match(JOB_FN, /fileFingerprint: ctx\.fileFingerprint/, '指紋を照合していない');
});

// ── PII ───────────────────────────────────────────────────────

test('guard: ジョブ記録に PII を保存しない', () => {
  assert.match(STORE, /assertNoPii\(job\)/, 'PII 検査をしていない');
  assert.match(STORE, /pii_detected/, 'PII 検知時に拒否していない');
  // 保存前に必ず検査を通る
  for (const fn of ['async create(job)', 'async save(job)']) {
    const i = STORE.indexOf(fn);
    assert.ok(i > -1, `${fn} が無い`);
    const body = STORE.slice(i, i + 600);
    assert.match(body, /assertNoPii/, `${fn} に PII 検査が無い`);
  }
});

test('guard: 監査ログに PII を入れない（executor 経由のみ）', () => {
  assert.match(EXEC, /buildImportAuditEntry\(/);
  assert.equal(/buildImportAuditEntry/.test(codeOnly(JOB_FN)), false, 'Function 側で監査ログを自作している');
});

test('guard: 例外の中身を応答へ返さない', () => {
  const c = JOB_FN.slice(JOB_FN.indexOf('} catch (e) {', JOB_FN.indexOf('export const handler')));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});

// ── 画面 ──────────────────────────────────────────────────────

test('guard(ui): 旧・単発の本番取込ボタンは無効のまま（ジョブへ移行した）', () => {
  const i = PAGE.indexOf('id="impRun"');
  assert.ok(i > -1);
  assert.match(PAGE.slice(i - 200, i + 300), /disabled/);
  assert.equal(/impRun'\)\?\.addEventListener/.test(PAGE), false, '旧ボタンに処理を配線している');
});

test('guard(ui): ジョブ画面が必須の進捗項目を出す', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  assert.ok(i > -1, 'ジョブ画面が無い');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const label of ['対象総数', '処理済み', '作成済み', '既存スキップ', '失敗',
    '残件数', '進捗率', '現在の子バッチ', '最終更新時刻', 'jobId', 'ImportBatchId', 'Source']) {
    assert.ok(s.includes(label), `画面に「${label}」が無い`);
  }
  for (const id of ['impJobStart', 'impJobResume', 'impJobCancel', 'impJobPlan']) {
    assert.ok(s.includes(id), `${id} が無い`);
  }
});

test('guard(ui): 開始・再開・取消は既定で無効（下見してから有効化する）', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const id of ['impJobStart', 'impJobResume', 'impJobCancel']) {
    const j = s.indexOf(`id="${id}"`);
    const btn = s.slice(j, j + 160);
    assert.match(btn, /disabled/, `${id} が既定で有効になっている`);
    assert.match(btn, /aria-disabled="true"/, `${id} に aria-disabled が無い`);
  }
});

test('guard(ui): 書き込みゲートが閉じていれば開始できない', () => {
  assert.match(PAGE, /canStart: out\.writeEnabled === true/, 'ゲートで開始可否を決めていない');
  assert.ok(PAGE.includes('impJobGateWarn'), 'ゲート警告が無い');
});

test('guard(ui): 完了後は再実行できない', () => {
  assert.match(PAGE, /const finished = !job\['再実行可能'\];/, '完了判定が無い');
  assert.match(PAGE, /impJobSetButtons\(\{ canStart: false, canResume: !finished, canCancel: !finished \}\)/);
});

test('guard(ui): 子バッチは逐次実行（並行に走らせない）', () => {
  assert.match(PAGE, /let impJobRunning = false;/, '二重起動フラグが無い');
  assert.match(PAGE, /if \(impJobRunning\) \{/, '二重起動を止めていない');
  // ループ内は await で直列
  const i = PAGE.indexOf('async function impJobDrive');
  const body = PAGE.slice(i, PAGE.indexOf('$(\'impJobStart\')', i));
  assert.match(body, /await impJobCall\(\{ action: 'step'/, 'step を await していない');
  assert.equal(/Promise\.all|Promise\.allSettled/.test(body), false, '並行実行している');
});

test('guard(ui): 明細・アドレスを DOM へ出さない', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const bad of ['RecipientEmail', 'recordId', 'Email"']) assert.equal(s.includes(bad), false, `${bad} を出している`);
});

test('guard(ui): ジョブの方針を画面に明記する', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const phrase of ['新規のみ', '1 件も更新しません', '最大 100 件', '10 件ずつ',
    '再実行できません', '消しません', 'Source 単位の隔離', 'メールを 1 通も送りません']) {
    assert.ok(s.includes(phrase), `画面に「${phrase}」が無い`);
  }
});
