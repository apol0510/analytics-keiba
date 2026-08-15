/**
 * sendBudget.js — 1 回の実行で「どこまで送るか」を決める（純粋・I/O なし）
 *
 * ── 解決する問題（2026-08-15 の設計監査）────────────────────────
 * `marketing-campaign-dispatch` は同期 Function（Netlify の上限 26 秒）で、
 * 1 通ごとに **SendGrid 送信 + Airtable PATCH** を逐次実行する。
 * 10 通は収まったが、100 通なら外部 API 呼び出しが約 200 回になり、
 * **上限を超えて途中で kill される**。kill されると応答が返らず、
 * 運用者は「何通送れたのか」を応答から知れない。
 *
 * ── 方針: 件数ではなく**時間**で切る ──────────────────────────
 * 「1 回 200 通まで」のような件数上限は、1 通あたりの所要が変われば意味を失う。
 * **経過時間**を見て、次の 1 通を送る余裕が無ければそこで止める。
 * 止めた時点までは 1 通ごとに `sent` を書いてあるので、
 * 残りは**次の実行が続きから**処理できる（既送信は `already_sent_in_job` で除外）。
 *
 * これは `execute-scheduled-emails-background.js` が 2026-05-22 に採った
 * 「8 分グレースフル break」と同じ考え方で、実績のある形をそのまま使う。
 *
 * ── 使い方 ────────────────────────────────────────────────
 *   const budget = createSendBudget({ limitMs, nowMs: Date.now() });
 *   for (const email of recipients) {
 *     if (!budget.canSendAnother(Date.now())) { stopped = true; break; }
 *     ... 送信 ...
 *     budget.record(Date.now());
 *   }
 */

/** 同期 Function（Netlify）の実行上限。**これ自体は変えられない** */
export const SYNC_FUNCTION_LIMIT_MS = 26_000;

/** Background Function の実行上限（Netlify） */
export const BACKGROUND_FUNCTION_LIMIT_MS = 15 * 60_000;

/**
 * 同期 Function で使う既定の予算。
 * 上限 26 秒に対し、**応答の組み立て・台帳の後片付け・ロック解放**の余白を残す。
 */
export const DEFAULT_SYNC_BUDGET_MS = 18_000;

/**
 * Background Function で使う既定の予算。
 * 15 分に対し、**残りの記録と応答**のための余白を大きめに取る
 *（途中 kill が最も危険なのは「送ったのに記録できていない」状態）。
 */
export const DEFAULT_BACKGROUND_BUDGET_MS = 8 * 60_000;

/** 1 通あたりの所要をまだ知らないときの見積り（保守的に大きめ） */
export const INITIAL_PER_SEND_MS = 800;

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * 予算オブジェクトを作る。
 *
 * @param {{limitMs?: number, nowMs: number, initialPerSendMs?: number, safetyFactor?: number}} input
 */
export function createSendBudget({
  limitMs = DEFAULT_SYNC_BUDGET_MS,
  nowMs,
  initialPerSendMs = INITIAL_PER_SEND_MS,
  safetyFactor = 1.5,
} = {}) {
  const startedAt = num(nowMs, 0);
  const limit = Math.max(0, num(limitMs, DEFAULT_SYNC_BUDGET_MS));
  const initial = Math.max(1, num(initialPerSendMs, INITIAL_PER_SEND_MS));
  const factor = Math.max(1, num(safetyFactor, 1.5));

  let sends = 0;
  let lastAt = startedAt;
  let totalMs = 0;

  /** 実測から 1 通あたりの所要を見積もる（まだ 0 通なら初期値） */
  const perSendMs = () => (sends > 0 ? totalMs / sends : initial);

  return {
    startedAt,
    limitMs: limit,

    /** これまでの送信数 */
    get sends() { return sends; },
    /** 1 通あたりの実測（ms） */
    get averageMs() { return Math.round(perSendMs()); },
    elapsedMs(atMs) { return Math.max(0, num(atMs, startedAt) - startedAt); },

    /**
     * **次の 1 通を送る余裕があるか。**
     * 「経過 + 見積り × 安全係数」が予算を超えるなら送らない。
     * 見積りは実測で更新されるので、遅い環境では自動的に早めに止まる。
     */
    canSendAnother(atMs) {
      const elapsed = this.elapsedMs(atMs);
      return elapsed + perSendMs() * factor <= limit;
    },

    /** 1 通ぶんの実績を記録する */
    record(atMs) {
      const at = num(atMs, lastAt);
      totalMs += Math.max(0, at - lastAt);
      lastAt = at;
      sends += 1;
    },

    /** 応答へ載せる要約（**PII を含めない**） */
    describe(atMs) {
      return {
        limitMs: limit,
        elapsedMs: this.elapsedMs(atMs),
        sends,
        averageMs: Math.round(perSendMs()),
      };
    },
  };
}

/**
 * 実行結果から「続きがあるか」をまとめる。
 *
 * ⚠️ **途中で止めたことを成功と区別できる形で返す。**
 *    黙って `sent` だけ返すと、運用者は「全部送り終えた」と読む。
 *
 * @returns {{complete: boolean, remaining: number, stoppedByBudget: boolean, resumeHint: string|null}}
 */
export function summarizeSendRun({ total, sent, skipped = 0, failed = 0, stoppedByBudget = false }) {
  const t = Math.max(0, num(total, 0));
  const done = Math.max(0, num(sent, 0)) + Math.max(0, num(skipped, 0)) + Math.max(0, num(failed, 0));
  const remaining = Math.max(0, t - done);
  const complete = remaining === 0;
  return {
    complete,
    remaining,
    stoppedByBudget: stoppedByBudget === true && !complete,
    resumeHint: complete
      ? null
      : '同じ jobId でもう一度実行すると、送信済みを飛ばして残りから再開します。',
  };
}

/**
 * 1 回の実行で安全に扱える最大件数の**目安**（画面表示・計画用）。
 * 実際の打ち切りは時間で行うので、これは「だいたい何通で分割されるか」を示すだけ。
 */
export function estimateChunkSize({ limitMs = DEFAULT_SYNC_BUDGET_MS, perSendMs = INITIAL_PER_SEND_MS } = {}) {
  const per = Math.max(1, num(perSendMs, INITIAL_PER_SEND_MS));
  return Math.max(1, Math.floor(Math.max(0, num(limitMs, DEFAULT_SYNC_BUDGET_MS)) / per));
}

export default createSendBudget;
