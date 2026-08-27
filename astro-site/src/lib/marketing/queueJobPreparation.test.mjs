/**
 * queueJobPreparation.test.mjs — 「配信行を確認できていないジョブを送らない」を固定する
 *
 * ── 事故の経緯 ────────────────────────────────────────────────
 * 2026-08-18: キュー登録が配信行を書けず、**配信行 0 行の PENDING ジョブ**（orphan）が残った。
 * #385 で「読み戻して確認できたときだけ成功／駄目なら巻き戻す」を入れた。
 * 2026-08-20: それでも同じ形の orphan が再発。ジョブは PENDING のまま残り、
 * rollout 状態も集計も更新されておらず、**補償コードへ到達していない**（実行が途中で終わった疑い）。
 *
 * → 補償に頼らず、**途中で終わっても送られない**構造にする。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  markUnverified, clearUnverified, hasUnverifiedMark, isQueueVerified,
  decideJobRowAction, JOB_ROW_ACTION, JOB_ROW_REJECT, QUEUE_UNVERIFIED_NOTE,
} from './queueJobPreparation.js';

const NOTE = 'marketing campaign light-trial-to-premium-sequence v1 shell:v1 content:b7d45ce01bc4';

// ── 未検証の印 ──────────────────────────────────────────────
test('【重要】作った直後のジョブには未検証の印が付く', () => {
  const marked = markUnverified(NOTE);
  assert.ok(hasUnverifiedMark(marked));
  assert.equal(isQueueVerified(marked), false, '未検証のまま送ってよいと判定している');
  assert.ok(marked.startsWith(NOTE), '既存の Notes を壊している');
});

test('【重要】確認できたら印だけを外す（他の情報は残す）', () => {
  const cleared = clearUnverified(markUnverified(NOTE));
  assert.equal(cleared, NOTE);
  assert.equal(isQueueVerified(cleared), true);
});

test('印は二重に付かない（再実行しても 1 つ）', () => {
  const twice = markUnverified(markUnverified(NOTE));
  assert.equal(twice.split(QUEUE_UNVERIFIED_NOTE).length - 1, 1);
});

test('【重要】印が無い既存ジョブは従来どおり送れる（積み残しを止めない）', () => {
  assert.equal(isQueueVerified(NOTE), true);
  assert.equal(isQueueVerified(''), true);
  assert.equal(isQueueVerified(null), true);
});

test('部分一致で誤判定しない', () => {
  assert.equal(hasUnverifiedMark('queue:unverified-ish'), false);
  assert.equal(hasUnverifiedMark('xqueue:unverified'), false);
  assert.equal(hasUnverifiedMark(`${NOTE} ${QUEUE_UNVERIFIED_NOTE}`), true);
});

// ── 同じ JobId の行を二重に作らない ──────────────────────────
const row = (fields, id = 'rec1') => ({ id, fields });

test('【重要】同じ JobId の行が無ければ作る', () => {
  const d = decideJobRowAction({ rows: [] });
  assert.equal(d.action, JOB_ROW_ACTION.CREATE);
});

test('【重要】未送信の同じ JobId があれば作り直して使う（行を増やさない）', () => {
  const d = decideJobRowAction({ rows: [row({ JobId: 'j1', Status: 'PENDING' })] });
  assert.equal(d.action, JOB_ROW_ACTION.REUSE);
  assert.equal(d.recordId, 'rec1');
});

test('【重要】巻き戻し済み（CANCELLED）の行も作り直して使える', () => {
  const d = decideJobRowAction({ rows: [row({ JobId: 'j1', Status: 'CANCELLED' })] });
  assert.equal(d.action, JOB_ROW_ACTION.REUSE);
});

test('【重要】送信済みのジョブは絶対に作り直さない（二重送信になる）', () => {
  for (const f of [{ Status: 'SENT' }, { Status: 'PENDING', SentCount: 3 }, { Status: 'EXECUTING' }]) {
    const d = decideJobRowAction({ rows: [row({ JobId: 'j1', ...f })] });
    assert.equal(d.action, JOB_ROW_ACTION.REJECT, JSON.stringify(f));
    assert.equal(d.reason, JOB_ROW_REJECT.ALREADY_SENT);
  }
});

test('【重要】読めなければ書かない（fail closed）', () => {
  const d = decideJobRowAction({ rows: null });
  assert.equal(d.action, JOB_ROW_ACTION.REJECT);
  assert.equal(d.reason, JOB_ROW_REJECT.UNKNOWN_STATE);
  assert.equal(decideJobRowAction().action, JOB_ROW_ACTION.REJECT);
});

test('【重要】同じ JobId の行が複数あるなら書かない（過去の二重作成を上書きしない）', () => {
  const d = decideJobRowAction({ rows: [row({ JobId: 'j1', Status: 'PENDING' }, 'a'), row({ JobId: 'j1', Status: 'PENDING' }, 'b')] });
  assert.equal(d.action, JOB_ROW_ACTION.REJECT);
  assert.equal(d.reason, JOB_ROW_REJECT.DUPLICATE_ROWS);
});

// ══════════════════════════════════════════════════════════════════
//   配線（実ファイルを読んで固定する）
// ══════════════════════════════════════════════════════════════════

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
const ADMIN = 'netlify/functions/admin-marketing.js';
const DISPATCH = 'netlify/functions/marketing-campaign-dispatch.js';
const CRON = 'netlify/functions/cron-marketing-rollout.js';

test('【重要】キュー登録はジョブに未検証の印を付けてから作る', () => {
  const src = readRel(ADMIN);
  assert.ok(/jobFields\.Notes = markUnverified\(jobFields\.Notes\);/.test(src), '印を付けていない');
  const idxMark = src.indexOf('markUnverified(jobFields.Notes)');
  const idxCreate = src.indexOf('createRecord({ KEY, BASE, table: SCHEDULED_TABLE');
  assert.ok(idxMark > 0 && idxCreate > idxMark, 'ジョブを作ってから印を付けている');
});

test('【重要】印を外すのは配信行を確認できたあとだけ', () => {
  const src = readRel(ADMIN);
  const idxSettle = src.indexOf('const settled = await settleQueueWrite(');
  const idxPromote = src.indexOf('const promoted = await promoteVerifiedJobs(');
  const idxQueued = src.indexOf("mode: 'queued'");
  assert.ok(idxSettle > 0 && idxPromote > idxSettle, '確認より先に印を外している');
  assert.ok(idxQueued > idxPromote, '印を外す前に成功を返している');
});

test('【重要】印を外せたことを読み戻して確かめ、駄目なら巻き戻す', () => {
  const src = readRel(ADMIN);
  const fn = src.slice(src.indexOf('async function promoteVerifiedJobs('), src.indexOf('async function rollbackQueue('));
  assert.ok(/hasUnverifiedMark\(/.test(fn), '読み戻しで印の有無を見ていない');
  assert.ok(/stillUnverified === 0/.test(fn), '印が残っていても成功にしている');
  assert.equal(/ok: true,\s*\}\s*;\s*\/\/ 無条件/.test(fn), false);
  const caller = src.slice(src.indexOf('const promoted = await promoteVerifiedJobs('), src.indexOf("mode: 'queued'"));
  assert.ok(/rollbackQueue\(/.test(caller), '外せなかったときに巻き戻していない');
  assert.ok(/partial_unconfirmed/.test(caller), '巻き戻し未確認を成功扱いしている');
});

test('【重要】同じ JobId の行を二重に作らない（既存があれば作り直す）', () => {
  const src = readRel(ADMIN);
  assert.ok(/decideJobRowAction\(\{ rows: existingRows \}\)/.test(src), '既存行を見ていない');
  assert.ok(/JOB_ROW_ACTION\.REJECT/.test(src) && /JOB_ROW_ACTION\.REUSE/.test(src), '判定を使い分けていない');
  const block = src.slice(src.indexOf('const decided = decideJobRowAction('), src.indexOf('for (const r of batch) jobIdByEmail.set'));
  assert.ok(/return json\(409/.test(block), '送信済みでも積み直そうとしている');
  assert.ok(/patchRecord\(\{\s*\n?\s*KEY, BASE, table: SCHEDULED_TABLE, recordId: decided\.recordId/.test(block), '既存行を作り直していない');
});

test('【重要】dispatcher は未検証のジョブを送らない', () => {
  const src = readRel(DISPATCH);
  assert.ok(/import \{ isQueueVerified \}/.test(src), '判定を import していない');
  assert.ok(/const queueUnverified = !isQueueVerified\(f\.Notes\);/.test(src), '未検証を判定していない');
  // 送信の前に判定していること
  assert.ok(src.indexOf('const queueUnverified =') < src.indexOf('summary.jobs += 1'));

  /*
   * ⚠️ 未検証ジョブの出口は **2 つ**（live / dryRun の preview）。
   *    **どちらも `willSend: 0` ＋ `blocked` ＋ `continue`** で、実送信区間へ進まないこと。
   *    preview（2026-08-27 追加）は「印を外したら何人か」を見せるだけで、
   *    `willSend` を動かさない（cron の判断を変えない）。
   */
  const exits = [...src.matchAll(/blocked: 'queue_unverified'/g)].map((m) => m.index);
  assert.equal(exits.length, 2, `未検証ジョブの出口が ${exits.length} 個（live と preview の 2 つのはず）`);
  for (const at of exits) {
    const around = src.slice(Math.max(0, at - 700), at + 1400);
    assert.ok(/willSend: 0/.test(around), '未検証なのに willSend が 0 でない');
    assert.ok(/continue;/.test(around), '未検証なのに送信区間へ進んでいる');
  }
  // live 側は preview を作らずに即抜ける
  assert.ok(/if \(queueUnverified && !dryRun\) \{/.test(src), 'live の即抜けが無い');
  // preview は dryRun 限定（live 応答に preview を足していない）
  const liveBlock = src.slice(src.indexOf('if (queueUnverified && !dryRun) {'), src.indexOf('const jobShellVersion ='));
  assert.equal(/preview:/.test(liveBlock), false, '⚠️ live 応答に preview を足している');
});

test('【重要】preview は willSend を動かさない（cron の判断を変えない）', () => {
  const src = readRel(DISPATCH);
  const at = src.indexOf('if (queueUnverified) {');
  assert.ok(at > 0, 'preview 経路が無い');
  const block = src.slice(at, src.indexOf('jobResults.push({\n      jobId,\n      campaignId', at) + 200);
  assert.ok(/willSend: 0/.test(block), '⚠️ preview 経路で willSend を 0 以外にしている');
  assert.ok(/wouldSend/.test(block) && /previewFingerprint/.test(block), 'preview の中身が無い');
  assert.ok(/continue;/.test(block), '⚠️ preview 経路が実送信区間へ落ちている');
});

test('【重要】キュー登録は排他を取ってから書く（二重 queue 防止）', () => {
  const src = readRel(ADMIN);
  assert.ok(/QUEUE_LOCK_ROOT/.test(src), 'キュー用の鍵空間を使っていない');
  const fn = src.slice(src.indexOf('async function handleQueuedPlan({'), src.indexOf('async function handlePlan({'));
  assert.ok(/if \(!live\) return handlePlan\(/.test(fn), 'dry-run で鍵を取っている');
  assert.ok(/LOCK_FAIL\.BUSY/.test(fn), '衝突時に止めていない');
  assert.ok(/sideEffects: 'none'/.test(fn), '鍵を取れないのに書いている');
  assert.ok(/finally \{/.test(fn), '鍵を返していない');
});

test('【重要】cron tick は重複実行しない', () => {
  const src = readRel(CRON);
  assert.ok(/TICK_LOCK_ROOT/.test(src), 'tick 用の鍵空間を使っていない');
  assert.ok(/'tick_busy'/.test(src), '重なった tick を止めていない');
  const block = src.slice(src.indexOf('const lockId = `tick:'), src.indexOf('return json(200, await runRolloutTick('));
  assert.ok(/if \(!dryRun/.test(block), '下見でも鍵を取っている');
  assert.ok(/sideEffects: 'none'/.test(block), '鍵を取れないのに処理している');
  assert.ok(/finally \{/.test(src), '鍵を返していない');
});

test('【重要】鍵空間は用途ごとに分かれている（送信の鍵を奪わない）', () => {
  const src = readRel('src/lib/marketing/dispatchLock.js');
  assert.ok(/export const QUEUE_LOCK_ROOT = 'ak:marketing-queue:'/.test(src));
  assert.ok(/export const TICK_LOCK_ROOT = 'ak:marketing-tick:'/.test(src));
  assert.ok(/const root = String\(deps\.root \|\| DISPATCH_LOCK_ROOT\)/.test(src), '鍵空間を差し替えられない');
  assert.ok(/if \(!k\.startsWith\(root\)\)/.test(src), '鍵空間の外を触れてしまう');
});
