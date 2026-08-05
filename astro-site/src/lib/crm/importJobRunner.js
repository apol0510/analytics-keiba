/**
 * importJobRunner.js — 子バッチ 1 つを進める（**I/O は注入・純粋にテスト可能**）
 *
 * 1 回の呼び出しで**子バッチをちょうど 1 つ**処理する。理由:
 *   - Netlify の同期 Function は上限 26 秒。100 件（実測 9〜13 秒）なら 1 回で確実に収まる
 *   - 途中で切れても「作成済みだけ残って結果が返らない」状態にならない
 *   - 1 呼び出し = 1 子バッチ なので、進捗が常に確定した状態で保存される
 *
 * 呼び出し側（画面）は完了まで**逐次**呼び直す。並行に走らせない。
 */

import { selectCreateRows } from './importEligibility.js';
import { writeCreateBatch } from './importWriteExecutor.js';
import {
  applyChildResult, beginChildBatch, markChildError, clampChildSize,
} from './importJobModel.js';

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * 子バッチを 1 つ実行する。
 *
 * @param {{
 *   job: object,
 *   entries: Array<object>,        決定的に並べ替え済みの対象一覧
 *   facts: object,                 **子バッチ直前に取り直した** Customers 由来の事実
 *   providerEmails: Set<string>,
 *   availableFields: Set<string>|null,
 *   nowMs: number, nowIso: string,
 *   holder?: string,
 *   deps: { createRecords, createRecord, sleep },
 * }} input
 */
export async function runChildBatch({
  job, entries, facts, providerEmails, availableFields, nowMs, nowIso, holder, deps,
} = {}) {
  const size = clampChildSize(job?.childSize);

  // 残り書いてよい件数。**開始時に固定した総数を超えて書かない**
  const budget = Math.max(0, int(job?.plannedTotal) - int(job?.totals?.created));
  const limit = Math.min(size, budget);
  if (limit <= 0) {
    return {
      ok: true, job: applyChildResult({
        job, result: { ok: true, attempted: 0, created: 0, skippedExisting: 0, failed: 0 },
        scannedTo: int(job?.cursor), exhausted: true, nowIso,
      }), result: null, note: 'これ以上書く予定がありません（計画到達）。',
    };
  }

  // 1) 対象を選ぶ（**既存は facts.existing で落ちる**＝作成済みは自然に飛ばされる）
  const picked = selectCreateRows({
    entries, facts, providerEmails, cursor: int(job?.cursor), limit,
  });

  if (picked.rows.length === 0) {
    // 拾えるものが無い＝この一覧はもう終わり
    return {
      ok: true,
      job: applyChildResult({
        job, result: { ok: true, attempted: 0, created: 0, skippedExisting: 0, failed: 0 },
        scannedTo: picked.scannedTo, exhausted: true, nowIso,
      }),
      result: null, skipped: picked.skipped,
      note: '作成対象が残っていません。',
    };
  }

  // 2) リースを張って子バッチ開始を記録
  const running = beginChildBatch({ job, nowMs, nowIso, holder });

  // 3) 書く（10 件単位のまとめ書きは executor 側の責務）
  let result;
  try {
    result = await writeCreateBatch({
      rows: picked.rows,
      batchId: job.batchId,
      nowIso,
      availableFields,
      doneRowKeys: new Set(),
      // **書き込み直前に取り直した既存アドレス**（二重作成を防ぐ本体）
      existingEmails: new Set(facts && facts.existing ? facts.existing : []),
      maxWrites: limit,
      deps,
    });
  } catch (e) {
    // 例外でも**リースを外して PARTIAL で残す**（続きから再開できる）
    return {
      ok: false,
      job: markChildError({ job: running, error: 'write_error', nowIso }),
      result: null,
      note: '子バッチが失敗しました。作成済みの行は残ります。続きから再開できます。',
    };
  }

  const attempted = picked.rows.length;
  const next = applyChildResult({
    job: running,
    result: { ...result, attempted },
    scannedTo: picked.scannedTo,
    // 一覧を見終わった、または計画に到達したら完了
    exhausted: picked.exhausted,
    nowIso,
  });

  return { ok: result.ok !== false, job: next, result, skipped: picked.skipped };
}

export default runChildBatch;
