/**
 * paymentEmailDispatcher.js — pending 送信ディスパッチャのコア（依存注入・純粋ロジック）。
 *
 * D1 cutover の B1。`PaymentEmailStatus='pending'` のレコードを列挙し、1 件ずつ worker コア
 * （runWorkerOnce）へ渡して送信させる。実 IO（Airtable / SendGrid / Redis）は deps 経由で、
 * ユニットテストは fake を注入するため実接続しない。
 *
 * 実行環境の制約（Netlify Scheduled Functions 公式仕様）:
 * - **公開 URL から直接呼び出せない**（プラットフォームが遮断。手動は Netlify UI「Run now」）。
 *   → よって Function 側は Scheduled 専用。URL POST 認証分岐は持たない。
 * - **実行 30 秒上限**。超えると強制終了され得る。逐次処理では **deadline guard** で
 *   時間切れ前に新規レコードの処理開始を止め、残りは次回スケジュールへ回す。
 *
 * 設計の要点:
 * - **HTTP で自分の worker Function を呼ばず**、worker コアを同一プロセスで実行する（deps.runOne）。
 * - **dispatch 単位のグローバルロック**（deps.acquireLock）で重複起動・並行実行を防ぐ。
 *   これに加え各レコードは runWorkerOnce 内で record 単位ロック + fencing token を取る（二重防御）。
 * - **1 実行の最大件数を小さく固定**（maxRecords。30 秒に安全に収まる値）。超過分は次回へ。
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
 * @param {number} p.now ms epoch（実行開始時刻）
 * @param {number} p.maxRecords 1 実行の最大処理件数（小さく固定）
 * @param {number} [p.deadlineAt] ms epoch。この時刻に達したら**新規レコードの処理を開始しない**
 *   （30 秒上限に対する安全マージン）。未指定なら時間制限なし（テスト用）。
 * @param {() => number} [p.clock] 現在時刻取得（テスト用に差し替え可。既定は Date.now）
 * @param {object} p.deps
 *   - acquireLock(key) -> {ok: boolean, token: string|number}
 *   - releaseLock(key, token) -> any
 *   - listPending(limit) -> [{id, fields}]   Airtable 側で status=pending に限定・件数制限して取得
 *   - runOne(recordId, now) -> {ok, status?, stage?, reason?, providerAccepted?}  （= runWorkerOnce）
 *   - log?(obj)
 * @returns {Promise<{ok: boolean, skipped?: string, listed: number, processed: number, deadlineStopped: boolean, byOutcome: Record<string, number>, errors: number}>}
 */
export async function dispatchPendingBatch({ now, maxRecords, deadlineAt = null, clock = Date.now, deps }) {
  const limit = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : 0;
  if (limit <= 0) return { ok: false, skipped: 'invalid_max', listed: 0, processed: 0, deadlineStopped: false, byOutcome: {}, errors: 0 };

  // dispatch 単位ロック（重複起動・並行 Scheduled を防ぐ）。取れなければ何もしない。
  const lock = await deps.acquireLock(DISPATCH_LOCK_KEY);
  if (!lock || !lock.ok) {
    if (deps.log) deps.log({ at: 'dispatch', skipped: 'dispatch_locked' });
    return { ok: true, skipped: 'dispatch_locked', listed: 0, processed: 0, deadlineStopped: false, byOutcome: {}, errors: 0 };
  }
  const token = lock.token;

  const byOutcome = {};
  let processed = 0;
  let errors = 0;
  let listed = 0;
  let deadlineStopped = false;
  const bump = (k) => { byOutcome[k] = (byOutcome[k] || 0) + 1; };
  const pastDeadline = () => Number.isFinite(deadlineAt) && clock() >= deadlineAt;

  try {
    const records = (await deps.listPending(limit)) || [];
    listed = records.length;

    for (const rec of records) {
      // deadline guard: 時間切れ前に**新規レコードの処理を開始しない**（残りは次回へ）。
      if (pastDeadline()) { deadlineStopped = true; bump('deadline_skipped'); continue; }
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

    if (deps.log) deps.log({ at: 'dispatch', listed, processed, errors, deadlineStopped, byOutcome });
    return { ok: true, listed, processed, deadlineStopped, byOutcome, errors };
  } finally {
    await deps.releaseLock(DISPATCH_LOCK_KEY, token);
  }
}

export { DISPATCH_LOCK_KEY };
