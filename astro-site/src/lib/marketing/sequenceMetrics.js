/**
 * sequenceMetrics.js — 連続配信の実績を**配信台帳の実データ**から数える（純粋・I/O なし）
 *
 * ## 何を出すか（2026-08-26 MK 要望）
 *
 * キャンペーン × ステップごとに、管理画面で目視できる数字を出す。
 *
 *   対象数 / queue済み / 実送信数 / 除外数 / 失敗数 / 未送信残 / 二重送信数 / 最終実行時刻
 *
 * ## ⚠️ queued を「送信済み」として数えない
 *
 * キュー登録（queued）は**まだ届いていない**。実送信は dispatcher が別に行い、
 * そのとき初めて `sent` になる。ここを混ぜると「送ったつもりで届いていない」を
 * 見逃す（実際に 2026-08-25 の 1 通目で、488 通が queued のまま止まっていた）。
 *
 *   - **実送信数** … `Status='sent'` の行だけ
 *   - **未送信残** … queued のまま sent になっていない行
 *   - 対象数 = queued + sent + 除外 + 失敗（その step で扱った全員）
 *
 * ## 二重送信数
 *
 * `DeliveryKey`（campaign × version × step × 受信者）は 1 通 1 行になるよう upsert される。
 * 同じ鍵が 2 行以上あれば**台帳の異常**なので数えて可視化する（正常なら 0）。
 */

/** 台帳の Status（`marketing-campaign-dispatch.js` が書く値） */
export const LEDGER_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
  /** `skipped-duplicate` / `skipped-blacklist` / `skipped-unsubscribed` など */
  SKIPPED_PREFIX: 'skipped',
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/** 1 ステップぶんの空の集計 */
export function emptyStepMetrics() {
  return {
    target: 0, queued: 0, sent: 0, skipped: 0, failed: 0,
    duplicates: 0, lastActivityAtMs: null,
  };
}

/** キャンペーン全体の空の集計 */
export function emptyMetrics() {
  return { steps: {}, rows: 0, keys: 0 };
}

/**
 * 台帳の行を集計へ足す（**同じ行を二度渡さないこと**。走査は 1 周につき 1 回）。
 *
 * @param {object} metrics `emptyMetrics()` の戻り値（破壊的に更新する）
 * @param {Array<{fields?: object}>} rows CampaignDeliveries の行
 * @param {{ seenKeys?: Set<string> }} [state] 二重送信の検出に使う（周をまたいで持ち回る）
 */
export function accumulateMetrics(metrics, rows, state = {}) {
  const seen = state.seenKeys instanceof Set ? state.seenKeys : new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const f = (r && r.fields) || {};
    const step = num(f.StepNumber) ?? 1;
    if (!metrics.steps[step]) metrics.steps[step] = emptyStepMetrics();
    const m = metrics.steps[step];
    const status = String(f.Status ?? '').trim();

    metrics.rows += 1;
    m.target += 1;
    if (status === LEDGER_STATUS.SENT) m.sent += 1;
    else if (status === LEDGER_STATUS.QUEUED) m.queued += 1;
    else if (status === LEDGER_STATUS.FAILED) m.failed += 1;
    else if (status.startsWith(LEDGER_STATUS.SKIPPED_PREFIX)) m.skipped += 1;

    // 二重送信（同じ DeliveryKey が 2 行以上）
    const key = String(f.DeliveryKey ?? '').trim();
    if (key) {
      if (seen.has(key)) m.duplicates += 1;
      else { seen.add(key); metrics.keys += 1; }
    }

    for (const t of [ms(f.SentAt), ms(f.QueuedAt), ms(f.FailedAt), ms(f.SkippedAt)]) {
      if (t !== null && (m.lastActivityAtMs === null || t > m.lastActivityAtMs)) m.lastActivityAtMs = t;
    }
  }
  state.seenKeys = seen;
  return metrics;
}

/**
 * 画面へ出す形にする。**アドレスも recordId も出さない**（件数と時刻だけ）。
 *
 * @param {object} metrics
 * @param {{ complete?: boolean, computedAtMs?: number|null }} [meta]
 */
export function describeMetrics(metrics, meta = {}) {
  const m = metrics && metrics.steps ? metrics : emptyMetrics();
  const steps = Object.keys(m.steps)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
    .map((step) => {
      const s = m.steps[step];
      return {
        step,
        /** その step で扱った全員（queued + sent + 除外 + 失敗）*/
        target: s.target,
        /** キュー登録済み。**まだ届いていない** */
        queued: s.queued,
        /** 実際に送った数（`Status='sent'` だけ）*/
        sent: s.sent,
        excluded: s.skipped,
        failed: s.failed,
        /** queued のまま送られていない数。0 が正常 */
        pending: s.queued,
        /** 台帳の異常。0 が正常 */
        duplicates: s.duplicates,
        lastActivityAt: s.lastActivityAtMs ? new Date(s.lastActivityAtMs).toISOString() : null,
      };
    });
  return {
    steps,
    rows: m.rows,
    keys: m.keys,
    /** 1 周ぶんを読み切った集計か（false なら途中経過）*/
    complete: meta.complete === true,
    computedAt: Number.isFinite(Number(meta.computedAtMs))
      ? new Date(Number(meta.computedAtMs)).toISOString() : null,
    note: meta.complete === true
      ? '配信台帳を 1 周読み切った集計です。'
      : '集計の途中経過です（台帳を読み進めている最中）。',
    /** 画面が「queued を送信済みとして表示しない」ための注意書き */
    queuedNote: 'queue済みは**まだ届いていません**。実送信数には含めていません。',
  };
}

/** 集計の保存層（Redis）。キャンペーンごとに 1 キー */
export const METRICS_KEY_PREFIX = 'ak:marketing:seq-metrics:v1:';
export const metricsKey = (campaignType) => `${METRICS_KEY_PREFIX}${String(campaignType || '').trim()}`;

export function createSequenceMetricsStore({ redisCmd } = {}) {
  const usable = typeof redisCmd === 'function';
  return {
    usable,
    async read(campaignType) {
      if (!usable) return null;
      try {
        const raw = await redisCmd(['GET', metricsKey(campaignType)]);
        return raw ? JSON.parse(String(raw)) : null;
      } catch { return null; }
    },
    async write(campaignType, payload) {
      if (!usable) return { ok: false };
      try {
        await redisCmd(['SET', metricsKey(campaignType), JSON.stringify(payload)]);
        return { ok: true };
      } catch { return { ok: false }; }
    },
  };
}
