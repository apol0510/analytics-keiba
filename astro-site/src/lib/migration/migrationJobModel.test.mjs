import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  JOB_TYPE, JOB_STATUS, MODEL_VERSION, DEFAULT_CHUNK, MAX_CHUNK, MIN_CHUNK,
  isValidJobType, clampChunk, jobKey, lockKey, JOB_NAMESPACE,
  createJob, applyStep, completeJob, failJob, verifyBalance, canStep,
  isExpiredCursorError, toPublicJob,
} from './migrationJobModel.js';

const T = '2026-08-10T00:00:00.000Z';
const mk = (o = {}) => ({ jobType: JOB_TYPE.DELIVERY_KEYS, chunkSize: 500, nowIso: T, ...o });

test('jobType は限定。未知は受け付けない', () => {
  assert.equal(isValidJobType('delivery-keys'), true);
  assert.equal(isValidJobType('email-events'), true);
  assert.equal(isValidJobType('whatever'), false);
  assert.throws(() => jobKey('whatever'), /bad_type/);
});

test('キーは AK 名前空間', () => {
  assert.equal(jobKey(JOB_TYPE.DELIVERY_KEYS), `${JOB_NAMESPACE}:delivery-keys`);
  assert.equal(lockKey(JOB_TYPE.EMAIL_EVENTS), `${JOB_NAMESPACE}:email-events:lock`);
  assert.ok(JOB_NAMESPACE.startsWith('ak:'));
});

test('chunkSize は範囲に丸める（Function の 26 秒に収める）', () => {
  assert.equal(clampChunk(500, JOB_TYPE.DELIVERY_KEYS), 500);
  assert.equal(clampChunk(99999, JOB_TYPE.DELIVERY_KEYS), MAX_CHUNK);
  assert.equal(clampChunk(1, JOB_TYPE.DELIVERY_KEYS), MIN_CHUNK);
  assert.equal(clampChunk('abc', JOB_TYPE.EMAIL_EVENTS), DEFAULT_CHUNK[JOB_TYPE.EMAIL_EVENTS]);
});

test('カウンタは増える方向のみ', () => {
  const j = createJob(mk());
  const a = applyStep(j, { recordsRead: 500, recordsWritten: 500, pagesRead: 5 }, T);
  assert.equal(a.recordsRead, 500);
  assert.equal(a.steps, 1);
  assert.throws(() => applyStep(a, { recordsRead: -1 }, T), /negative_delta/);
});

test('cursor は delta で更新でき、reset で null へ戻る', () => {
  let j = createJob(mk());
  j = applyStep(j, { cursor: 'itr1' }, T);
  assert.equal(j.cursor, 'itr1');
  j = applyStep(j, { cursorReset: true }, T);
  assert.equal(j.cursor, null);
  assert.equal(j.cursorResets, 1);
});

test('【重要】応答に cursor の実値を出さない', () => {
  let j = createJob(mk());
  j = applyStep(j, { cursor: 'itrSECRET123' }, T);
  const pub = toPublicJob(j);
  assert.equal(pub.hasCursor, true);
  assert.equal('cursor' in pub, false);
  assert.doesNotMatch(JSON.stringify(pub), /itrSECRET123/);
});

test('件数が合わなければ balanced=false', () => {
  let j = createJob(mk());
  j = applyStep(j, { recordsRead: 100, recordsWritten: 90, recordsSkipped: 10 }, T);
  assert.equal(verifyBalance(j).balanced, true);
  j = applyStep(j, { recordsRead: 5 }, T);
  assert.equal(verifyBalance(j).balanced, false);
  assert.equal(verifyBalance(j).missing, 5);
});

test('終わったジョブ・失敗したジョブは step できない', () => {
  const j = createJob(mk());
  assert.equal(canStep(j).ok, true);
  assert.equal(canStep(completeJob(j, T)).reason, 'already_completed');
  assert.equal(canStep(failJob(j, 'boom', T)).reason, 'failed_needs_restart');
  assert.equal(canStep(null).reason, 'not_started');
  assert.equal(canStep({ ...j, version: 99 }).reason, 'version_mismatch');
});

test('失敗の記録は理由コードだけ（長さも切る）', () => {
  const j = failJob(createJob(mk()), 'x'.repeat(500), T);
  assert.ok(j.lastError.length <= 120);
  assert.equal(j.status, JOB_STATUS.FAILED);
});

test('batchId は直近だけ保持する（無限に伸びない）', () => {
  let j = createJob(mk({ jobType: JOB_TYPE.EMAIL_EVENTS }));
  for (let i = 0; i < 80; i += 1) j = applyStep(j, { batchIds: [`k${i}`] }, T);
  assert.ok(j.recentBatchIds.length <= 50);
  assert.equal(j.recentBatchIds.at(-1), 'k79');
});

test('offset 失効だけを失効として拾う（本物のエラーを隠さない）', () => {
  assert.equal(isExpiredCursorError({ type: 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE' }), true);
  assert.equal(isExpiredCursorError(new Error('iterator is not available')), true);
  assert.equal(isExpiredCursorError({ type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' }), false);
  assert.equal(isExpiredCursorError(new Error('network')), false);
});

// ── Function 側のガード ─────────────────────────────────────────
const FN = readFileSync(new URL('../../../netlify/functions/admin-migration-job.js', import.meta.url), 'utf8');

test('guard: 専用 gate 未設定なら 403（main へ入れても何も起きない）', () => {
  assert.match(FN, /MIGRATION_WRITE_ENABLED === 'true'/);
  assert.match(FN, /reason: 'blocked_by_design'/);
  assert.match(FN, /const writeActions = new Set\(\['start', 'step'\]\)/);
});

test('guard: Airtable への書き込み・削除をしない', () => {
  assert.doesNotMatch(FN, /method:\s*'(POST|PATCH|PUT|DELETE)'[\s\S]{0,200}api\.airtable\.com/);
  assert.doesNotMatch(FN, /api\.airtable\.com[\s\S]{0,200}method:\s*'(PATCH|PUT|DELETE)'/);
});

test('guard: メール送信 API を呼ばない', () => {
  assert.doesNotMatch(FN, /mail\/send|sendgrid/i);
});

test('guard: Customers を触らない', () => {
  // コメントは対象外。**実コード**だけを見る（説明文の「Customers 変更 0」に反応させない）
  const code = FN.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(/Customers/.test(code), false, 'Customers を参照している');
});

test('guard: 壊れた Airtable 応答を 0 件と扱わない', () => {
  assert.match(FN, /throw new Error\('airtable_page_failed'\)/);
  assert.match(FN, /if \(j && Array\.isArray\(j\.records\)\) return/);
});

test('guard: offset 失効時は先頭から読み直す', () => {
  const hits = FN.match(/isExpiredCursorError\(e\) && offset/g) || [];
  assert.equal(hits.length, 2, '両方のジョブで失効を扱っていない');
  assert.match(FN, /offset = null; cursorReset = true;/);
});

test('guard: 同時実行をロックで 1 本に絞る', () => {
  assert.match(FN, /acquireLock\(cmd, jobType, token\)/);
  assert.match(FN, /'NX', 'EX'/);
  assert.match(FN, /releaseLock\(cmd, jobType, token\)/);
});

test('guard: ジョブ状態に TTL を付けない（途中状態が消えない）', () => {
  assert.doesNotMatch(FN, /\['SET', jobKey\(job\.jobType\)[^\]]*'EX'/);
});

test('guard: 件数が合わなければ COMPLETED にしない', () => {
  assert.match(FN, /if \(!bal\.balanced\)/);
  assert.match(FN, /件数が合わないため完了にしません/);
});
