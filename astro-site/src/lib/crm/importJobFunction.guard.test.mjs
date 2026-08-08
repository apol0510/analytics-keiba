/**
 * importJobFunction.guard.test.mjs — 取り込みジョブ Function / 画面の境界を固定する
 *   node --test src/lib/crm/importJobFunction.guard.test.mjs
 *
 * 「動いたときに何を書くか」だけでなく、**書けないこと**を構造で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => readFileSync(path(rel), 'utf8');
const JOB_FN = read('../../../netlify/functions/admin-customer-import-job.js');
const RUN_FN = read('../../../netlify/functions/admin-customer-import-run.js');
const MODEL = read('./importJobModel.js');
const RUNNER = read('./importJobRunner.js');
const ELIG = read('./importEligibility.js');
const CLAIM = read('./importClaimStore.js');
const AUTH = read('./importJobAuthority.js');
const RECON = read('./importJobReconcile.js');
const EXEC = read('./importWriteExecutor.js');
const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');

const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ── BLOCKED（設計未完了のため write 経路を封じている）────────────

test('guard: start / step は kill-switch で構造的に封じられている', () => {
  assert.match(JOB_FN, /if \(action === 'start' \|\| action === 'step'\) \{/, 'kill-switch が無い');
  assert.match(JOB_FN, /code: 'blocked_by_design'/);
  const blockAt = JOB_FN.indexOf("action === 'start' || action === 'step'");
  const storeAt = JOB_FN.indexOf('createClaimStore({ cmd: redisCmd })');
  const startAt = JOB_FN.indexOf('return await handleStart(');
  const stepAt = JOB_FN.indexOf('return await handleStep(');
  assert.ok(blockAt > -1 && blockAt < storeAt, 'kill-switch が Redis 初期化より後ろにある');
  assert.ok(blockAt < startAt && blockAt < stepAt, 'kill-switch が実行分岐より後ろにある');
});

test('guard: plan（read-only）は封じない', () => {
  const blockAt = JOB_FN.indexOf("action === 'start' || action === 'step'");
  const planAt = JOB_FN.indexOf("if (action === 'plan')");
  assert.ok(planAt > -1 && planAt < blockAt, 'plan が kill-switch より後ろにある');
});

// ── Blobs を使わない ──────────────────────────────────────────

test('guard: Blobs 版の store は削除され、どこからも参照されない', () => {
  assert.equal(existsSync(path('./importJobStore.js')), false, 'importJobStore.js が残っている');
  for (const [name, src] of [['JOB_FN', JOB_FN], ['RUNNER', RUNNER], ['MODEL', MODEL]]) {
    assert.equal(src.includes('importJobStore'), false, `${name} が Blobs store を参照している`);
    assert.equal(src.includes('@netlify/blobs'), false, `${name} が Blobs を import している`);
    assert.equal(src.includes('connectLambda'), false, `${name} が Blobs を初期化している`);
  }
});

// ── 書ける範囲 ────────────────────────────────────────────────

test('guard: ジョブ Function は既存レコードを更新・削除しない', () => {
  const code = codeOnly(JOB_FN);
  assert.equal(/method:\s*['"]PATCH['"]/.test(code), false, 'PATCH を組み立てている');
  assert.equal(/method:\s*['"]PUT['"]/.test(code), false);
  assert.equal(/method:\s*['"]DELETE['"]/.test(code), false, '削除を組み立てている');
  // Airtable への POST は「まとめ書き」「1 件ずつ」の 2 経路のみ。
  // Upstash REST も POST を使うので、Airtable URL を伴う POST だけを数える。
  const airtablePosts = (code.match(/api\.airtable\.com[\s\S]{0,200}?method: 'POST'/g) || []).length;
  assert.equal(airtablePosts, 2, `Airtable への作成経路が ${airtablePosts} 箇所ある（2 箇所であるべき）`);
});

test('guard: ジョブ Function はメールを送らない', () => {
  const code = codeOnly(JOB_FN);
  for (const bad of ['mail/send', '@sendgrid/mail', 'sendgrid.com/v3/mail']) {
    assert.equal(code.includes(bad), false, `送信経路がある: ${bad}`);
  }
});

test('guard: 二重ゲート（env + 確認文字列）を通る経路しか無い', () => {
  assert.match(JOB_FN, /canStartImportJob\(/);
  assert.match(JOB_FN, /canStepImportJob\(/);
  assert.match(MODEL, /env\.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'/);
  assert.match(MODEL, /JOB_REJECT\.NO_CONFIRMATION/);
  const gateAt = JOB_FN.indexOf('canStepImportJob(');
  const writeAt = JOB_FN.indexOf('await runChildBatch(');
  assert.ok(gateAt > -1 && writeAt > gateAt, 'ゲートより前に書き込んでいる');
});

test('guard: env ゲートは start と step の両方に掛かり、最初の関門である', () => {
  for (const fn of ['canStartImportJob', 'canStepImportJob']) {
    const i = MODEL.indexOf(`export function ${fn}`);
    assert.ok(i > -1, `${fn} が無い`);
    const nextExport = MODEL.indexOf('\nexport ', i + 1);
    const body = MODEL.slice(i, nextExport > -1 ? nextExport : MODEL.length);
    assert.match(body, /CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'/, `${fn} に env ゲートが無い`);
    const envAt = body.indexOf("CUSTOMER_IMPORT_WRITE_ENABLED !== 'true'");
    const lockAt = body.indexOf('JOB_REJECT.LOCKED');
    if (lockAt > -1) assert.ok(envAt < lockAt, `${fn} で env ゲートが後回し`);
  }
});

// ── グローバルロック / 排他 ────────────────────────────────────

test('guard: ロックはグローバル 1 本（batchId で区切らない）', () => {
  assert.match(CLAIM, /export const GLOBAL_LOCK_KEY = 'customer-import:lock:global';/);
  assert.equal(/GLOBAL_LOCK_KEY.*\$\{.*batch/i.test(CLAIM), false, 'ロックキーに batchId が混ざっている');
  assert.match(CLAIM, /'SET', GLOBAL_LOCK_KEY, token, 'NX', 'EX'/, 'SET NX EX で取っていない');
  assert.match(CLAIM, /'INCR', FENCE_KEY/, 'fencing token を採番していない');
});

test('guard: ロックが取れなければ Airtable を読まない・書かない', () => {
  for (const fn of ['handleStart', 'handleStep', 'handleCancel']) {
    const i = JOB_FN.indexOf(`async function ${fn}`);
    assert.ok(i > -1, `${fn} が無い`);
    const body = JOB_FN.slice(i, i + 900);
    const lockAt = body.indexOf('acquireGlobalLock');
    const ctxAt = body.indexOf('buildJobContext');
    assert.ok(lockAt > -1, `${fn} がロックを取っていない`);
    if (ctxAt > -1) assert.ok(lockAt < ctxAt, `${fn} がロック取得より前に Airtable を読んでいる`);
    assert.match(body, /if \(!lock\.ok\)/, `${fn} に fail-closed が無い`);
  }
});

test('guard: 行 claim のキーに batchId を含めない（グローバル一意）', () => {
  assert.match(CLAIM, /export const EMAIL_CLAIM_PREFIX = 'customer-import:email:';/);
  const i = CLAIM.indexOf('export function emailClaimKey');
  const body = CLAIM.slice(i, i + 400);
  assert.equal(/batchId/.test(body), false, 'claim キーに batchId が混ざっている');
  assert.match(body, /normalizeEmail\(/, '正規化していない');
  assert.match(body, /sha256/, 'ハッシュ化していない（PII 保存）');
});

test('guard: 期限切れ claim を自動で奪わない（reconciler だけが解放する）', () => {
  // Lua に「期限切れなら奪う」分岐が無いこと
  const i = CLAIM.indexOf('export const CLAIM_ROWS_LUA');
  const lua = CLAIM.slice(i, CLAIM.indexOf('`;', i));
  assert.equal(/expired|expiresAt.*<|TTL.*steal/i.test(lua), false, 'Lua が期限切れ claim を奪っている');
  assert.match(lua, /out\[i\] = 'TAKEN'/, '他者保持を TAKEN にしていない');
  assert.match(CLAIM, /releaseClaimByReconciler/, 'reconciler 専用の解放経路が無い');
});

// ── 書き込み直前の再検証（stale writer 防止）──────────────────

test('guard: claim → 所有権再検証 → create の順序が固定されている', () => {
  const claimAt = RUNNER.indexOf('await claims.claimRows(');
  const verifyAt = RUNNER.indexOf('await claims.verifyLockOwnership(');
  const writeAt = RUNNER.indexOf('await writeCreateBatch(');
  assert.ok(claimAt > -1 && verifyAt > claimAt, 'claim の後に所有権を再検証していない');
  assert.ok(writeAt > verifyAt, 'create が所有権再検証より前にある');
  assert.match(RUNNER, /if \(!own\.ok\)/, '所有権を失ったときに止めていない');
});

test('guard: snapshot 検証は claim より前', () => {
  const snapAt = RUNNER.indexOf('await authority.verifySnapshot(');
  const claimAt = RUNNER.indexOf('await claims.claimRows(');
  assert.ok(snapAt > -1 && snapAt < claimAt, 'snapshot 検証が claim より後ろ');
});

test('guard: runner は claim を解放しない（reconciler の責務）', () => {
  assert.equal(/releaseClaim|DEL/.test(codeOnly(RUNNER)), false, 'runner が claim を解放している');
});

// ── fail-closed ───────────────────────────────────────────────

test('guard: Redis 異常は必ず RedisUnavailableError で伝播する', () => {
  assert.match(CLAIM, /export class RedisUnavailableError/);
  for (const code of ['UNREACHABLE', 'UNKNOWN_RESULT', 'LOCK_STATE_UNKNOWN',
    'JOB_UNREADABLE', 'CLAIM_INCONSISTENT', 'DATA_LOSS_SUSPECTED']) {
    assert.ok(CLAIM.includes(code), `REDIS_FAIL.${code} が無い`);
  }
  // 例外を握りつぶしていない
  assert.match(CLAIM, /throw new RedisUnavailableError/);
  assert.match(RUNNER, /if \(e instanceof RedisUnavailableError\) throw e;/, 'runner が Redis 異常を握りつぶす');
});

test('guard: Function は Redis 異常を 503 fail-closed で返す（黙って続行しない）', () => {
  assert.match(JOB_FN, /e instanceof RedisUnavailableError/);
  assert.match(JOB_FN, /JOB_REJECT\.REDIS_UNAVAILABLE/);
  assert.match(JOB_FN, /json\(503,/);
});

test('guard: 「Redis 消失時も重複しない」という主張がコードに残っていない', () => {
  for (const [name, src] of [['MODEL', MODEL], ['CLAIM', CLAIM], ['RUNNER', RUNNER], ['AUTH', AUTH]]) {
    assert.equal(/消失しても.*重複は発生しない|消失時も重複/.test(src), false,
      `${name} に撤回済みの主張が残っている`);
  }
  assert.match(MODEL, /第二防御/, 'Customers 判定が第二防御であることを明記していない');
});

// ── 正本 ──────────────────────────────────────────────────────

test('guard: 正本の必須項目が定義され、欠けたら保存しない', () => {
  for (const f of ['jobId', 'batchId', 'source', 'fileFingerprint', 'snapshotFingerprint',
    'plannedTotal', 'orderingVersion', 'cursor', 'attempted', 'created', 'skippedExisting',
    'failed', 'cancelledAt', 'status', 'currentChild', 'fencingToken', 'operationId',
    'childHistory', 'reconciliation', 'createdAt', 'updatedAt']) {
    assert.ok(AUTH.includes(`'${f}'`), `正本の必須項目に ${f} が無い`);
  }
  assert.match(AUTH, /validateJobRecord\(job\)/);
  assert.match(AUTH, /assertNoPii/);
});

test('guard: 正本に PII を保存しない', () => {
  for (const fn of ['async create(job)', 'async save(job)']) {
    const i = AUTH.indexOf(fn);
    assert.ok(i > -1, `${fn} が無い`);
    assert.match(AUTH.slice(i, i + 400), /validateJobRecord/, `${fn} に検証が無い`);
  }
  assert.match(AUTH, /PII_KEYS = \[/);
});

test('guard: snapshot は chunk 分割し、指紋で差し替えを検知する', () => {
  assert.match(AUTH, /export const SNAPSHOT_CHUNK_SIZE = 500;/);
  assert.match(AUTH, /computeSnapshotFingerprint/);
  assert.match(AUTH, /snapshot_fingerprint_mismatch/);
  assert.match(AUTH, /export const ORDERING_VERSION/);
});

// ── 突合 ──────────────────────────────────────────────────────

test('guard: 突合は 4 点以上（重複数を含む）', () => {
  for (const k of ['counters_balanced', 'within_plan', 'created_matches_airtable',
    'claims_created_matches_airtable', 'no_new_duplicates']) {
    assert.ok(RECON.includes(k), `突合 ${k} が無い`);
  }
  assert.match(RECON, /duplicateEmailPairs/);
  assert.match(JOB_FN, /countDuplicateEmailPairs\(/, 'Function が重複数を測っていない');
});

test('guard: 不一致なら自動続行しない', () => {
  assert.match(RECON, /canContinue: verdict === RECONCILE_VERDICT\.OK/);
  assert.match(JOB_FN, /markJobBlocked\(/, 'BLOCKED へ遷移していない');
});

test('guard: reconciler の解放は 4 条件すべてを確認する', () => {
  const i = RECON.indexOf('export function canReleaseClaim');
  const body = RECON.slice(i);
  for (const r of ['present_in_customers', 'present_for_source', 'not_expired', 'fencing_token_still_current']) {
    assert.ok(body.includes(r), `解放条件 ${r} が無い`);
  }
});

// ── CREATE だけ ───────────────────────────────────────────────

test('guard: CREATE だけ（既存・有料・重複・要確認は対象から外す）', () => {
  for (const s of ['SKIP_REASON.EXISTING', 'SKIP_REASON.PAID', 'SKIP_REASON.DUPLICATE_IN_AK',
    'SKIP_REASON.FLAGGED', 'SKIP_REASON.UNSUBSCRIBED', 'SKIP_REASON.HARD_BOUNCE',
    'SKIP_REASON.SOFT_BOUNCE', 'SKIP_REASON.SUSPENDED', 'SKIP_REASON.TEST_ACCOUNT',
    'SKIP_REASON.PROVIDER_SUPPRESSED']) {
    assert.ok(ELIG.includes(s), `${s} の除外が無い`);
  }
});

test('guard: ジョブ経路の除外集合は単発 run と一致する', () => {
  for (const fact of ['unsubscribed', 'hardBounce', 'softBounce', 'suspended',
    'testAccounts', 'paid', 'duplicateInAk', 'existing']) {
    assert.ok(RUN_FN.includes(`facts.${fact}`), `単発 run に facts.${fact} が無い（前提が変わった）`);
    assert.ok(ELIG.includes(`f.${fact}`), `ジョブ側に f.${fact} が無い`);
  }
});

test('guard: 子バッチは 100 件を超えられない / まとめ書きは 10 件', () => {
  assert.match(MODEL, /export const JOB_CHILD_MAX_ROWS = FIRST_RUN_MAX_ROWS;/);
  assert.match(MODEL, /Math\.min\(JOB_CHILD_MAX_ROWS, Math\.max\(1, n\)\)/);
  assert.match(EXEC, /export const CREATE_CHUNK_SIZE = 10;/);
  assert.match(RUNNER, /writeCreateBatch\(/, '実績のある executor を使っていない');
});

test('guard: 例外の中身を応答へ返さない', () => {
  const c = JOB_FN.slice(JOB_FN.indexOf('} catch (e) {', JOB_FN.indexOf('export const handler')));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});

// ── 画面 ──────────────────────────────────────────────────────

test('guard(ui): 旧・単発の本番取込ボタンは無効のまま', () => {
  const i = PAGE.indexOf('id="impRun"');
  assert.ok(i > -1);
  assert.match(PAGE.slice(i - 200, i + 300), /disabled/);
  assert.equal(/impRun'\)\?\.addEventListener/.test(PAGE), false);
});

test('guard(ui): BLOCKED を画面に明示する', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  assert.ok(s.includes('【BLOCKED】'), '画面に BLOCKED 表示が無い');
  assert.ok(s.includes('403'), '403 で断られることを書いていない');
});

test('guard(ui): 必須の進捗項目を出す', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const label of ['対象総数', '処理済み', '作成済み', '既存スキップ', '失敗',
    '残件数', '進捗率', '現在の子バッチ', '最終更新時刻', 'jobId', 'ImportBatchId', 'Source']) {
    assert.ok(s.includes(label), `画面に「${label}」が無い`);
  }
});

test('guard(ui): 開始・再開・取消は既定で無効', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const id of ['impJobStart', 'impJobResume', 'impJobCancel']) {
    const j = s.indexOf(`id="${id}"`);
    const btn = s.slice(j, j + 160);
    assert.match(btn, /disabled/, `${id} が既定で有効`);
    assert.match(btn, /aria-disabled="true"/);
  }
});

test('guard(ui): 書き込みゲートが閉じていれば開始できない / 完了後は再実行不可', () => {
  assert.match(PAGE, /canStart: out\.writeEnabled === true/);
  assert.match(PAGE, /const finished = !job\['再実行可能'\];/);
});

test('guard(ui): 子バッチは逐次実行（並行に走らせない）', () => {
  assert.match(PAGE, /let impJobRunning = false;/);
  const i = PAGE.indexOf('async function impJobDrive');
  const body = PAGE.slice(i, PAGE.indexOf("$('impJobStart')", i));
  assert.match(body, /await impJobCall\(\{ action: 'step'/);
  assert.equal(/Promise\.all|Promise\.allSettled/.test(body), false, '並行実行している');
});

test('guard(ui): 明細・アドレスを DOM へ出さない', () => {
  const i = PAGE.indexOf('外部顧客リストの取り込みジョブ（大量）');
  const s = PAGE.slice(i, PAGE.indexOf('</section>', i));
  for (const bad of ['RecipientEmail', 'recordId', 'Email"']) assert.equal(s.includes(bad), false);
});
