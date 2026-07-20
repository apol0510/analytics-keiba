/**
 * paymentEmailDispatcher.js — pending 送信ディスパッチャのコア（依存注入・純粋ロジック）。
 *
 * D1 cutover の B1。`PaymentEmailStatus='pending'` のレコードを列挙し、1 件ずつ worker コア
 * （runWorkerOnce）へ渡して送信させる。実 IO（Airtable / SendGrid / Redis）は deps 経由で、
 * ユニットテストは fake を注入するため実接続しない。
 *
 * 設計の要点:
 * - **HTTP で自分の worker Function を呼ばず**、worker コアを同一プロセスで実行する（deps.runOne）。
 * - **dispatch 単位のグローバルロック**（deps.acquireLock）で重複起動・並行実行を防ぐ。
 *   これに加え各レコードは runWorkerOnce 内で record 単位ロック + fencing token を取る（二重防御）。
 * - **1 件あたり最大件数を小さく固定**（maxRecords）。超過分は次回実行へ回す（silent 打ち切りにしない）。
 * - **1 件失敗で他件を止めない**（catch して集計へ回し継続）。
 * - **unknown_after_attempt / accepted 等は runWorkerOnce 側が lease 対象外**として弾くため、
 *   ここでは再送を判断しない（pending / stale attempting / failed_retryable の扱いは state machine に一任）。
 * - **戻り値・ログに Email / secret / recordId を出さない**。集計は status/reason コードの件数のみ。
 *
 * gate / pause / A2 の fail-closed 判定は **Function ラッパー側**（env を持つ層）で行う。
 * このコアは「送ってよいと判断された後」の列挙・実行・集計だけを担う。
 */

const DISPATCH_LOCK_KEY = 'payemail:dispatch';

/**
 * pending を一括ディスパッチする。
 * @param {object} p
 * @param {number} p.now ms epoch
 * @param {number} p.maxRecords 1 実行の最大処理件数（小さく固定）
 * @param {object} p.deps
 *   - acquireLock(key) -> {ok: boolean, token: string|number}
 *   - releaseLock(key, token) -> any
 *   - listPending(limit) -> [{id, fields}]   Airtable 側で status=pending に限定・件数制限して取得
 *   - runOne(recordId, now) -> {ok, status?, stage?, reason?, providerAccepted?}  （= runWorkerOnce）
 *   - log?(obj)
 * @returns {Promise<{ok: boolean, skipped?: string, listed: number, processed: number, byOutcome: Record<string, number>, errors: number}>}
 */
export async function dispatchPendingBatch({ now, maxRecords, deps }) {
  const limit = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : 0;
  if (limit <= 0) return { ok: false, skipped: 'invalid_max', listed: 0, processed: 0, byOutcome: {}, errors: 0 };

  // dispatch 単位ロック（重複起動・並行 Scheduled を防ぐ）。取れなければ何もしない。
  const lock = await deps.acquireLock(DISPATCH_LOCK_KEY);
  if (!lock || !lock.ok) {
    if (deps.log) deps.log({ at: 'dispatch', skipped: 'dispatch_locked' });
    return { ok: true, skipped: 'dispatch_locked', listed: 0, processed: 0, byOutcome: {}, errors: 0 };
  }
  const token = lock.token;

  const byOutcome = {};
  let processed = 0;
  let errors = 0;
  let listed = 0;
  const bump = (k) => { byOutcome[k] = (byOutcome[k] || 0) + 1; };

  try {
    const records = (await deps.listPending(limit)) || [];
    listed = records.length;

    for (const rec of records) {
      const id = rec && rec.id;
      if (!id) { errors += 1; bump('no_id'); continue; }
      try {
        const r = await deps.runOne(id, now);
        processed += 1;
        // 非機密の集計キーのみ（recordId / missingFields / Email は含めない）。
        const key = (r && (r.status || r.reason || r.stage)) || 'unknown';
        bump(String(key));
      } catch {
        // 1 件失敗で他件を止めない。例外本文は握りつぶす（応答本文流出防止）。
        errors += 1;
        bump('exception');
      }
    }

    if (deps.log) deps.log({ at: 'dispatch', listed, processed, errors, byOutcome });
    return { ok: true, listed, processed, byOutcome, errors };
  } finally {
    await deps.releaseLock(DISPATCH_LOCK_KEY, token);
  }
}

export { DISPATCH_LOCK_KEY };
