/**
 * batchHealth.js — **次のバッチへ進んでよいか**を前のバッチの結果から決める（純粋）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 「1 日 1 回」をやめて同日に 500 名 × 複数バッチを回すなら、
 * **バッチとバッチの間に人の目が入らない**。そこで、次を始める前に
 * 前のバッチの結果を機械的に確かめ、**おかしければ自分で止まる**。
 *
 * ── 見るもの ──────────────────────────────────────────────────
 *   failed / duplicate            … 送信基盤と冪等性の壊れ
 *   bounce / complaint / unsubscribe … 名簿の質と受け手の反応
 *   previousOutstanding           … 前のバッチが本当に片付いたか
 *   providerSuppression           … 停止リストを**読めているか**
 *
 * ⚠️ **読めない値は「異常」として扱う**（0 件として通さない）。
 *    確認できないまま次の 500 名へ進むのが一番危ない。
 * ⚠️ ここは判断だけ。止め方（`stage: paused` へ落とす）は呼び出し側。
 */

/** 既定のしきい値（1 バッチぶんの比率） */
export const DEFAULT_BATCH_THRESHOLDS = Object.freeze({
  /** 送信失敗（provider が受理しなかった） */
  maxFailedRate: 0.05,
  /** ハードバウンス */
  maxBounceRate: 0.02,
  /** 苦情（1 件でも出たら止めて内容を見る） */
  maxComplaints: 0,
  /** 配信停止 */
  maxUnsubscribeRate: 0.02,
  /** 二重送信・二重付与は 1 件も許さない */
  maxDuplicates: 0,
});

export const BATCH_STOP = Object.freeze({
  UNREADABLE: 'batch_stats_unreadable',
  OUTSTANDING: 'previous_batch_outstanding',
  DUPLICATES: 'duplicates_detected',
  FAILED_RATE: 'failed_rate_exceeded',
  BOUNCE_RATE: 'bounce_rate_exceeded',
  COMPLAINTS: 'complaints_detected',
  UNSUBSCRIBE_RATE: 'unsubscribe_rate_exceeded',
  SUPPRESSION_UNREADABLE: 'provider_suppression_unreadable',
});

export const BATCH_STOP_LABEL = Object.freeze({
  batch_stats_unreadable: '前のバッチの結果を確認できません（確認できないまま次へ進みません）',
  previous_batch_outstanding: '前のバッチがまだ片付いていません（送信待ちが残っています）',
  duplicates_detected: '二重送信・二重付与を検知しました',
  failed_rate_exceeded: '送信失敗が多すぎます',
  bounce_rate_exceeded: 'ハードバウンスが多すぎます',
  complaints_detected: '苦情が発生しました',
  unsubscribe_rate_exceeded: '配信停止が多すぎます',
  provider_suppression_unreadable: '配信基盤の停止リストを読めません',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const stop = (reason, detail) => ({
  ok: false, reason, label: BATCH_STOP_LABEL[reason] || reason, ...(detail || {}),
});

/**
 * 次のバッチへ進んでよいか。
 *
 * @param {object} input
 * @param {number|null} input.sent            前のバッチで送った数
 * @param {number|null} input.failed          送信失敗
 * @param {number|null} input.duplicates      二重（DeliveryKey / 宛先の重複）
 * @param {number|null} input.bounces         そのバッチ以降に増えたハードバウンス
 * @param {number|null} input.complaints      苦情
 * @param {number|null} input.unsubscribes    配信停止
 * @param {number|null} input.previousOutstanding 関所（前バッチの未処理）
 * @param {boolean} input.suppressionReadable 停止リストを読めたか
 * @param {object} [input.thresholds]
 * @returns {{ok: boolean, reason?: string, label?: string, rates?: object}}
 */
export function canStartNextBatch({
  sent, failed, duplicates, bounces, complaints, unsubscribes,
  previousOutstanding, suppressionReadable, thresholds,
}) {
  const t = { ...DEFAULT_BATCH_THRESHOLDS, ...(thresholds || {}) };

  // ── 数えられないものがあれば進まない ───────────────────────────
  const s = num(sent);
  const f = num(failed);
  const d = num(duplicates);
  const b = num(bounces);
  const c = num(complaints);
  const u = num(unsubscribes);
  const out = num(previousOutstanding);
  if ([s, f, d, b, c, u, out].some((v) => v === null)) {
    return stop(BATCH_STOP.UNREADABLE, {
      missing: {
        sent: s === null, failed: f === null, duplicates: d === null,
        bounces: b === null, complaints: c === null, unsubscribes: u === null,
        previousOutstanding: out === null,
      },
    });
  }
  if (suppressionReadable !== true) return stop(BATCH_STOP.SUPPRESSION_UNREADABLE);

  // ── 前のバッチが片付いているか ────────────────────────────────
  if (out > 0) return stop(BATCH_STOP.OUTSTANDING, { previousOutstanding: out });

  // ── 冪等性の壊れは 1 件でも止める ─────────────────────────────
  if (d > t.maxDuplicates) return stop(BATCH_STOP.DUPLICATES, { duplicates: d });

  // ── 比率（分母が 0 なら比率を作らない）─────────────────────────
  const rate = (n) => (s > 0 ? n / s : null);
  const rates = {
    failed: rate(f), bounce: rate(b), unsubscribe: rate(u), complaints: c, sent: s,
  };
  if (rates.failed !== null && rates.failed > t.maxFailedRate) {
    return stop(BATCH_STOP.FAILED_RATE, { rates });
  }
  if (rates.bounce !== null && rates.bounce > t.maxBounceRate) {
    return stop(BATCH_STOP.BOUNCE_RATE, { rates });
  }
  if (c > t.maxComplaints) return stop(BATCH_STOP.COMPLAINTS, { rates });
  if (rates.unsubscribe !== null && rates.unsubscribe > t.maxUnsubscribeRate) {
    return stop(BATCH_STOP.UNSUBSCRIBE_RATE, { rates });
  }

  return { ok: true, reason: null, rates };
}

/** 画面・ログ用の要約（**件数と比率だけ**。PII を入れない） */
export function describeBatchHealth(result) {
  const r = result || {};
  return {
    ok: r.ok === true,
    reason: r.reason || null,
    label: r.label || null,
    rates: r.rates
      ? {
        sent: r.rates.sent,
        failedRate: r.rates.failed,
        bounceRate: r.rates.bounce,
        unsubscribeRate: r.rates.unsubscribe,
        complaints: r.rates.complaints,
      }
      : null,
  };
}

export default canStartNextBatch;
