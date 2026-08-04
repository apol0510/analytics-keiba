/**
 * batchPlan.js — 大規模配信を親ジョブ + 子バッチへ分ける（純粋・I/O なし）
 *
 * ── なぜ分けるか ──────────────────────────────────────────────
 * 13,000 通を 1 ジョブで送ると、途中で落ちたときに
 * 「どこまで送ったか」が分からず、やり直せば二重送信になる。
 *
 *   親ジョブ  … 何を・誰に・どの snapshot で送るか
 *   子バッチ  … 500〜1,000 名ずつ。**成否をバッチ単位で確定**する
 *
 * 受信者 1 人ごとの二重送信防止は従来どおり DeliveryKey（campaignId × version × 相手）。
 * バッチはその上に載る「再開できる単位」であって、重複防止の主役ではない。
 *
 * ── 停止と再開の約束 ──────────────────────────────────────────
 *   - 一時停止は**いま動いているバッチを終えてから**止まる（途中で切らない）
 *   - 未送信バッチは取り消せる。**送信済みは取り消せない**
 *   - 再開は「未送信のバッチ」からだけ。送信済みバッチは二度と実行しない
 *   - 異常を検知したら自動で止める（閾値は設定値。コードに直書きしない）
 *
 * ⚠️ このモジュールは**状態と判断だけ**。送信も書き込みもしない。
 */

/** 親ジョブの状態 */
export const JOB_STATE = Object.freeze({
  PLANNED: 'planned',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED_ABNORMAL: 'stopped_abnormal',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

/** 子バッチの状態 */
export const BATCH_STATE = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** 既定のバッチサイズ（設定値。運用で変えられる） */
export const DEFAULT_BATCH_SIZE = 500;
export const MIN_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 1000;

/**
 * 段階配信の既定。**いきなり全件送らない**。
 * 数値は「仕様上の設定値」であって、production での変更は別承認とする。
 */
export const DEFAULT_STAGES = Object.freeze([
  { id: 'admin-test', label: '管理者テスト', size: 1, observeHours: 0 },
  { id: 'wave-500', label: '初回 500 名', size: 500, observeHours: 24 },
  { id: 'wave-1000', label: '次の 1,000 名', size: 1000, observeHours: 24 },
  { id: 'wave-2000', label: '2,000 名ずつ', size: 2000, observeHours: 12 },
  { id: 'wave-rest', label: '残り', size: null, observeHours: 0 },
]);

/**
 * 異常停止の閾値（**既定値**）。コードに埋めず、ここを設定として読む。
 * production での変更は別承認。緩める方向の変更は特に慎重に。
 */
export const DEFAULT_ABNORMAL_THRESHOLDS = Object.freeze({
  minDeliveredRate: 0.90,      // delivered / sent がこれを下回ったら停止
  maxBounceRate: 0.05,
  maxBlockedRate: 0.02,
  maxSpamReportRate: 0.001,
  maxUnsubscribeRate: 0.02,
  maxProviderErrorRate: 0.02,  // 429 / 5xx
  ledgerMismatchStops: true,   // 台帳と provider の件数不一致で停止
  contentHashMismatchStops: true,
  audienceDriftStops: true,    // 対象件数が想定外に変わったら停止
  duplicateDeliveryKeyStops: true,
  /** 率を判定する最小母数。少数で率を見ると誤検知する */
  minSampleForRates: 100,
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => String(v ?? '').trim();

/**
 * snapshot の対象数からバッチを割る。
 * @param {{ targetCount: number, batchSize?: number }} input
 */
export function planBatches({ targetCount, batchSize } = {}) {
  const total = num(targetCount);
  let size = Number.isInteger(batchSize) ? batchSize : DEFAULT_BATCH_SIZE;
  if (size < MIN_BATCH_SIZE) size = MIN_BATCH_SIZE;
  if (size > MAX_BATCH_SIZE) size = MAX_BATCH_SIZE;
  if (total <= 0) return { ok: false, error: 'empty_audience', batches: [] };

  const batches = [];
  for (let offset = 0; offset < total; offset += size) {
    batches.push({
      index: batches.length + 1,
      offset,
      size: Math.min(size, total - offset),
      state: BATCH_STATE.PENDING,
      sent: 0,
      failed: 0,
    });
  }
  return { ok: true, error: null, batchSize: size, batchCount: batches.length, batches };
}

/** 進捗（画面にそのまま出せる形。個人情報は含まない） */
export function summarizeProgress(job = {}) {
  const batches = Array.isArray(job.batches) ? job.batches : [];
  const by = (st) => batches.filter((b) => b.state === st);
  const total = num(job.targetCount);
  const sent = batches.reduce((a, b) => a + num(b.sent), 0);
  const failed = batches.reduce((a, b) => a + num(b.failed), 0);
  const cancelled = by(BATCH_STATE.CANCELLED).reduce((a, b) => a + num(b.size), 0);
  const remaining = Math.max(0, total - sent - failed - cancelled);
  const current = batches.find((b) => b.state === BATCH_STATE.SENDING) || null;
  return {
    state: str(job.state) || JOB_STATE.PLANNED,
    総対象数: total,
    送信済み: sent,
    配信済み: num(job.delivered),
    未送信: remaining,
    除外: num(job.excludedCount),
    失敗: failed,
    取消: cancelled,
    現在のバッチ: current ? current.index : null,
    バッチ数: batches.length,
    進捗率: total > 0 ? Math.round(((sent + failed + cancelled) / total) * 100) : 0,
    最終更新時刻: Number.isFinite(job.updatedAtMs) ? new Date(job.updatedAtMs).toISOString() : null,
  };
}

/** 一時停止できるか（動いているときだけ） */
export function canPause(job = {}) {
  return job.state === JOB_STATE.RUNNING
    ? { allowed: true, reason: null, note: 'いま送っているバッチを送り終えてから止まります。' }
    : { allowed: false, reason: 'not_running' };
}

/** 再開できるか。異常停止からの再開は**原因確認を明示的に通す**必要がある */
export function canResume(job = {}, options = {}) {
  if (job.state === JOB_STATE.PAUSED) return { allowed: true, reason: null };
  if (job.state === JOB_STATE.STOPPED_ABNORMAL) {
    return options.abnormalAcknowledged === true
      ? { allowed: true, reason: null, note: '異常の原因を確認したうえで再開します。' }
      : { allowed: false, reason: 'abnormal_not_acknowledged' };
  }
  return { allowed: false, reason: 'not_paused' };
}

/**
 * 未送信バッチの取消。**送信済みは取り消さない**（メールは戻せない）。
 */
export function cancelPendingBatches(job = {}) {
  const batches = Array.isArray(job.batches) ? job.batches : [];
  let cancelled = 0;
  const next = batches.map((b) => {
    if (b.state !== BATCH_STATE.PENDING) return b;
    cancelled += 1;
    return { ...b, state: BATCH_STATE.CANCELLED };
  });
  return {
    batches: next,
    cancelledBatches: cancelled,
    keptSent: batches.filter((b) => b.state === BATCH_STATE.SENT).length,
    note: '送信済みのバッチは取り消せません（送ったメールは戻せません）。',
  };
}

/**
 * 次に実行してよいバッチ。**送信済み・失敗済みは二度と返さない**（再開時の二重送信防止）。
 */
export function nextBatch(job = {}) {
  if (job.state !== JOB_STATE.RUNNING) return { ok: false, reason: `not_running:${str(job.state)}` };
  const batches = Array.isArray(job.batches) ? job.batches : [];
  if (batches.some((b) => b.state === BATCH_STATE.SENDING)) {
    return { ok: false, reason: 'batch_in_flight' };   // 同時に 2 バッチ走らせない
  }
  const b = batches.find((x) => x.state === BATCH_STATE.PENDING);
  return b ? { ok: true, batch: b } : { ok: false, reason: 'no_pending_batch' };
}

/**
 * 異常検知。**閾値は引数で受ける**（コードに直書きしない）。
 *
 * @param {{ metrics: object, thresholds?: object }} input
 * @returns {{ stop: boolean, reasons: Array<{code: string, detail: string}> }}
 */
export function detectAbnormal({ metrics, thresholds } = {}) {
  const m = metrics || {};
  const t = { ...DEFAULT_ABNORMAL_THRESHOLDS, ...(thresholds || {}) };
  const reasons = [];
  const sent = num(m.sent);
  const enough = sent >= num(t.minSampleForRates);
  const rate = (x) => (sent > 0 ? num(x) / sent : 0);

  if (enough && rate(m.delivered) < t.minDeliveredRate) {
    reasons.push({ code: 'delivered_rate_low', detail: `配信率 ${(rate(m.delivered) * 100).toFixed(1)}%` });
  }
  if (enough && rate(m.bounce) > t.maxBounceRate) {
    reasons.push({ code: 'bounce_rate_high', detail: `バウンス率 ${(rate(m.bounce) * 100).toFixed(1)}%` });
  }
  if (enough && rate(m.blocked) > t.maxBlockedRate) {
    reasons.push({ code: 'blocked_rate_high', detail: `ブロック率 ${(rate(m.blocked) * 100).toFixed(1)}%` });
  }
  if (enough && rate(m.spamReport) > t.maxSpamReportRate) {
    reasons.push({ code: 'spam_report_high', detail: `迷惑メール報告 ${num(m.spamReport)} 件` });
  }
  if (enough && rate(m.unsubscribe) > t.maxUnsubscribeRate) {
    reasons.push({ code: 'unsubscribe_high', detail: `配信停止 ${num(m.unsubscribe)} 件` });
  }
  if (enough && rate(m.providerErrors) > t.maxProviderErrorRate) {
    reasons.push({ code: 'provider_errors', detail: `配信基盤エラー ${num(m.providerErrors)} 件（429 / 5xx）` });
  }
  // 率ではなく「起きたら即停止」する種類
  if (t.ledgerMismatchStops && m.ledgerMismatch === true) {
    reasons.push({ code: 'ledger_mismatch', detail: '台帳と配信基盤の件数が食い違っています' });
  }
  if (t.contentHashMismatchStops && m.contentHashMismatch === true) {
    reasons.push({ code: 'content_hash_mismatch', detail: 'メール内容が確認時と違います' });
  }
  if (t.audienceDriftStops && m.audienceDrift === true) {
    reasons.push({ code: 'audience_drift', detail: '対象件数が想定外に変わりました' });
  }
  if (t.duplicateDeliveryKeyStops && num(m.duplicateDeliveryKeys) > 0) {
    reasons.push({ code: 'duplicate_delivery_key', detail: `同一 DeliveryKey が ${num(m.duplicateDeliveryKeys)} 件` });
  }

  return { stop: reasons.length > 0, reasons };
}

/** 段階配信: 次に送ってよい人数と、その前に待つ時間 */
export function nextStage({ stages, sentSoFar, lastStageFinishedAtMs, nowMs } = {}) {
  const list = Array.isArray(stages) && stages.length ? stages : DEFAULT_STAGES;
  const done = num(sentSoFar);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let acc = 0;
  for (const s of list) {
    const size = s.size === null ? Infinity : num(s.size);
    if (done < acc + size) {
      const waitUntil = Number.isFinite(lastStageFinishedAtMs) && acc > 0
        ? lastStageFinishedAtMs + num(s.observeHours) * 3600000 : 0;
      if (waitUntil > now) {
        return { ok: false, reason: 'observing', stage: s, waitUntilMs: waitUntil };
      }
      return {
        ok: true, stage: s,
        allow: size === Infinity ? null : Math.max(0, acc + size - done),
      };
    }
    acc += size;
  }
  return { ok: false, reason: 'all_stages_done' };
}

export default planBatches;
