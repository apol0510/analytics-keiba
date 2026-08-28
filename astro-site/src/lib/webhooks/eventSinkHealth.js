/**
 * eventSinkHealth.js — 「配信イベントが本当に記録されているか」の判定（純粋）。
 *
 * ── なぜ要るか（2026-08-28）────────────────────────────────────
 * Airtable の `EmailEvents` が 0 行なのを見て「イベントが記録されていない」と
 * 誤読した。実際は `MARKETING_EVENT_SINK=blob` で **Airtable へ書かない設計**であり、
 * 行は Netlify Blobs にある。0 行が正常な構成では、0 行を見ても何も分からない。
 *
 * そこで「記録が生きているか」を **Airtable の行数以外の材料**で判定する:
 *   - sink mode（どこへ書く構成か）
 *   - 台帳 gate（そもそも書く設定か）
 *   - 観測カウンタ `ak:mkt:events:sink`（blob_ok / blob_failed …）
 *   - 受信の最終時刻（webhook が生きている証拠）
 *
 * ⚠️ 「確認できない」を「正常」にも「異常」にも倒さない（材料が無ければ unknown）。
 */

import { EVENT_SINK, writesAirtableEvents } from './emailEventSink.js';

export const RECORDING = Object.freeze({
  OK: 'ok',            // 直近に受信していて、書き込み先も失敗していない
  FAILING: 'failing',  // 書き込み先が失敗している（記録が欠ける）
  STALE: 'stale',      // 受信が古い（配信が無いだけの可能性もある）
  UNKNOWN: 'unknown',  // 材料が足りない。異常と決めつけない
  DISABLED: 'disabled',// gate が閉じている（設計どおり書かない）
});

/** 「最近受信した」とみなす既定の窓（7 日）。配信が疎な運用でも誤検知しない幅にする */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {{
 *   sinkMode: string, ledgerEnabled: boolean,
 *   counters?: Record<string, string|number>|null, countersAvailable?: boolean,
 *   lastEventAtMs?: number|null, nowMs: number,
 *   freshWindowMs?: number,
 * }} input
 */
export function judgeEventSinkHealth(input) {
  const {
    sinkMode, ledgerEnabled,
    counters = null, countersAvailable = false,
    lastEventAtMs = null, nowMs,
    freshWindowMs = FRESH_WINDOW_MS,
  } = input || {};

  const reasons = [];
  // blob モードでは Airtable 行は増えない。**期待値を明示して 0 を異常と読ませない**
  const expectedAirtableRows = writesAirtableEvents(sinkMode) ? null : 0;

  if (ledgerEnabled !== true) {
    reasons.push('ledger_gate_closed');
    return { recording: RECORDING.DISABLED, reasons, expectedAirtableRows, sinkMode };
  }

  const blobFailed = countersAvailable ? num(counters && counters.blob_failed) : 0;
  const blobOk = countersAvailable ? num(counters && counters.blob_ok) : 0;
  if (sinkMode !== EVENT_SINK.AIRTABLE && countersAvailable && blobFailed > 0 && blobOk === 0) {
    reasons.push('blob_write_failing');
    return { recording: RECORDING.FAILING, reasons, expectedAirtableRows, sinkMode };
  }
  if (countersAvailable && blobFailed > 0) reasons.push('blob_write_degraded');

  if (!Number.isFinite(lastEventAtMs) || lastEventAtMs === null) {
    reasons.push('no_event_observed');
    return { recording: RECORDING.UNKNOWN, reasons, expectedAirtableRows, sinkMode };
  }
  const ageMs = nowMs - lastEventAtMs;
  if (ageMs > freshWindowMs) {
    reasons.push('last_event_stale');
    return { recording: RECORDING.STALE, reasons, expectedAirtableRows, sinkMode, lastEventAgeMs: ageMs };
  }

  return { recording: RECORDING.OK, reasons, expectedAirtableRows, sinkMode, lastEventAgeMs: ageMs };
}
