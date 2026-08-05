/**
 * importJobRunner.js — 子バッチ 1 つを進める（**I/O は注入・純粋にテスト可能**）
 *
 * ── 不変条件（この順序を崩さない）────────────────────────────
 *   1. **グローバルロック**を取る（取れなければ Airtable を一切読まない・書かない）
 *   2. ジョブ正本（Redis）を読む。読めなければ **fail-closed**
 *   3. **snapshot 指紋**を検証する（開始後に CSV / 順序が変わっていないこと）
 *   4. 子バッチ claim（operationId）を確定する
 *   5. 行 claim を **Lua で atomic** に取る（正規化メール単位・**batchId 横断でグローバル**）
 *   6. **書き込み直前に**ロック所有権と fencing token を**再検証**する
 *   7. 所有権を失っていたら **Airtable create を行わない**
 *   8. create 成功を確認した行だけ claim を CREATED へ進める
 *   9. **claim は失敗しても解放しない**。回収は reconciler だけが行う
 *
 * ── Redis 異常は必ず伝播させる ────────────────────────────────
 * `RedisUnavailableError` を握りつぶさない。到達不能 / Lua 結果不明 / lock 状態不明 /
 * 正本が読めない / claim 不整合 / データ欠損の疑い — すべて**新規書き込みを全面停止**する。
 */

import { selectCreateRows } from './importEligibility.js';
import { writeCreateBatch } from './importWriteExecutor.js';
import { computeCreateRowKey } from './importWritePlan.js';
import { clampChildSize } from './importJobModel.js';
import { RedisUnavailableError } from './importClaimStore.js';
import { normalizeEmail } from './customerImport.js';

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** 子バッチが進めなかった理由 */
export const STEP_STOP = Object.freeze({
  LOCK_NOT_ACQUIRED: 'lock_not_acquired',
  LOCK_LOST: 'lock_lost',
  SNAPSHOT_CHANGED: 'snapshot_changed',
  CANCELLED: 'cancelled',
  NOTHING_TO_WRITE: 'nothing_to_write',
  LEASE_RENEW_FAILED: 'lease_renew_failed',
  REDIS_UNAVAILABLE: 'redis_unavailable',
});

/**
 * 子バッチを 1 つ実行する。
 *
 * @param {{
 *   job: object,                  Redis から読んだ正本
 *   entries: Array<object>,       決定的に並べ替え済みの一覧
 *   currentOrderedHashes: string[],
 *   facts: object,                **子バッチ直前に取り直した** Customers 由来の事実
 *   providerEmails: Set<string>,
 *   availableFields: Set<string>|null,
 *   lockToken: string,            グローバルロックの fencing token
 *   operationId: string,          この子バッチの操作 ID
 *   nowMs: number, nowIso: string,
 *   claims: object,               createClaimStore()
 *   authority: object,            createJobAuthority()
 *   deps: { createRecords, createRecord, sleep },
 * }} input
 */
export async function runChildBatch({
  job, entries, currentOrderedHashes, facts, providerEmails, availableFields,
  lockToken, operationId, nowMs, nowIso, claims, authority, deps,
} = {}) {
  const stop = (reason, note) => ({ ok: false, stopped: reason, job, result: null, note });

  // ── 2. 正本が読めていること（呼び出し側が load 済みである前提を再確認）──
  if (!job || !job.jobId) return stop(STEP_STOP.NOTHING_TO_WRITE, 'ジョブ正本がありません。');
  if (job.status === 'CANCELLED') return stop(STEP_STOP.CANCELLED, '取り消し済みのジョブです。');

  // ── 3. snapshot 検証（開始後に CSV / 順序が変わっていないこと）──
  const snap = await authority.verifySnapshot({ jobId: job.jobId, currentOrderedHashes });
  if (!snap.ok) return stop(STEP_STOP.SNAPSHOT_CHANGED, `snapshot が一致しません（${snap.reason}）。`);

  // 残り予算。**開始時に固定した総数を超えて書かない**
  const size = clampChildSize(job.childSize);
  const budget = Math.max(0, int(job.plannedTotal) - int(job.created));
  const limit = Math.min(size, budget);
  if (limit <= 0) return stop(STEP_STOP.NOTHING_TO_WRITE, '計画に到達しています。');

  // ── 5a. 対象を選ぶ（既存・除外・要確認はここで落ちる）──
  const picked = selectCreateRows({
    entries, facts, providerEmails, cursor: int(job.cursor), limit,
  });
  if (picked.rows.length === 0) {
    return {
      ok: true, stopped: null, job, result: null, exhausted: picked.exhausted,
      scannedTo: picked.scannedTo, skipped: picked.skipped, claimed: null,
      note: '作成対象が残っていません。',
    };
  }

  // ── 5b. 行 claim を atomic に取る（**グローバル・正規化メール単位**）──
  //     ここで負けた行は他ジョブ / 他 batchId が持っているので**触らない**。
  const claimed = await claims.claimRows({
    emails: picked.rows.map((r) => r.email),
    ownerJobId: job.jobId,
    batchId: job.batchId,
    operationId,
    fencingToken: lockToken,
    nowIso,
    ttlMs: undefined,
  });

  // 自分が書いてよいのは won + mine（再送・再開で自分が既に確保していた分）だけ
  const writable = new Set([...claimed.won, ...claimed.mine]);
  const target = picked.rows.filter((r) => writable.has(normalizeEmail(r.email)));

  if (target.length === 0) {
    return {
      ok: true, stopped: null, job, result: null, exhausted: picked.exhausted,
      scannedTo: picked.scannedTo, skipped: picked.skipped, claimed,
      note: 'すべて他の実行が確保済み、または作成済みでした（書き込みなし）。',
    };
  }

  // ── 6. 書き込み直前の再検証。**ここを通らなければ create しない** ──
  const own = await claims.verifyLockOwnership(lockToken);
  if (!own.ok) {
    // ⚠️ claim は**解放しない**。回収は reconciler だけが行う。
    return stop(STEP_STOP.LOCK_LOST,
      `書き込み直前にロック所有権を失っていました（${own.reason}）。Airtable へは 1 件も書いていません。`);
  }

  // ── 7. 書く ──
  let result;
  try {
    result = await writeCreateBatch({
      rows: target,
      batchId: job.batchId,
      nowIso,
      availableFields,
      doneRowKeys: new Set(),
      // 第二防御（排他の代替ではない）
      existingEmails: new Set(facts && facts.existing ? facts.existing : []),
      maxWrites: limit,
      deps,
    });
  } catch (e) {
    if (e instanceof RedisUnavailableError) throw e;
    // create が途中で落ちた。**claim は解放しない**（作成済みかもしれないため）
    return {
      ok: false, stopped: null, job, result: null, claimed,
      scannedTo: picked.scannedTo, exhausted: false, writeError: true,
      note: '子バッチの書き込みが失敗しました。claim は保持したままです（reconciler が回収します）。',
    };
  }

  // ── 8. 作成できた行だけ CREATED へ進める ──
  //     rowKey → email の対応はローカルで作る（監査ログに PII を入れないため）
  const byRowKey = new Map(
    target.map((r) => [computeCreateRowKey({ batchId: job.batchId, email: r.email }), r.email]),
  );
  const createdEmails = [];
  for (const a of (result.audit || [])) {
    if (a && a.result === 'created') {
      const email = byRowKey.get(a.rowKey);
      if (email) createdEmails.push(email);
    }
  }
  const marked = createdEmails.length
    ? await claims.markRowsCreated({ emails: createdEmails, ownerJobId: job.jobId, nowIso })
    : { ok: [], notMine: [], missing: [] };

  return {
    ok: result.ok !== false,
    stopped: null,
    job,
    result,
    claimed,
    marked,
    attempted: target.length,
    scannedTo: picked.scannedTo,
    exhausted: picked.exhausted,
    skipped: picked.skipped,
    /** claim は取れたが作成に至らなかった行（reconciler の回収対象） */
    claimedNotCreated: target.length - createdEmails.length,
  };
}

export default runChildBatch;
