/**
 * emailEventLedgerSource.js — 台帳 `EmailEvents` を **Airtable 経由で読めるか**を決める単一源。
 *
 * ── なぜ要るか（2026-08-28 の誤読を恒久的に防ぐ）────────────────────
 * 台帳の行は容量対策で Netlify Blobs へ移し、Airtable の行は削除した
 * （`MARKETING_EVENT_SINK=blob` / `emailEventSink.js`）。それ以降、Airtable の
 * `EmailEvents` は **常に 0 行**である。これは正常な状態であって「反応が無い」でも
 * 「記録が止まっている」でもない。
 *
 * ところが顧客カルテは Airtable を読み続けており、**取得に成功して 0 行**なので
 * `available:true / rows:0` を返していた。画面には
 * 「台帳の運用開始前のメールは記録がありません」と出る。つまり
 * **記録は生きているのに「記録が無い」と読める**状態で、
 * 「0 件」と「取得不能」を区別するというカルテの目的が第 3 の形で破れていた。
 *
 * よってここで **sink mode を見て「そもそも読めるのか」を先に決める**。
 * blob モードでは Airtable を引かず、`available:false` + 理由コードで返す。
 *
 * ── 禁止事項 ────────────────────────────────────────────────
 * - 呼び出し側で `MARKETING_EVENT_SINK` を直接読んで分岐を再実装しない
 * - blob モードのときに `rows: 0` を「反応なし」として表示しない
 * - 読めない理由を握り潰して `available:true` にしない（fail closed）
 */

import { resolveEventSinkMode, writesAirtableEvents } from './emailEventSink.js';

export const LEDGER_SOURCE_REASON = Object.freeze({
  /** Airtable が正本。読んだ結果をそのまま出してよい */
  OK: 'ok',
  /** 行は Blob にある。Airtable を読んでも 0 行にしかならない */
  SINK_BLOB: 'sink_blob',
  /** Airtable を読もうとして失敗した（0 件ではない） */
  FETCH_FAILED: 'fetch_failed',
});

const NOTE = Object.freeze({
  [LEDGER_SOURCE_REASON.OK]:
    '恒久台帳（EmailEvents）から集計。台帳の運用開始前のメールは記録がありません',
  // ⚠️ 1 行のまま置く（guard がこの文言を丸ごと探す。分割すると検知が外れる）
  [LEDGER_SOURCE_REASON.SINK_BLOB]:
    '恒久台帳の行は Netlify Blobs へ退避済みで、Airtable 経由では読めません（反応が無かったという意味ではありません）',
  [LEDGER_SOURCE_REASON.FETCH_FAILED]:
    '恒久台帳を取得できませんでした（反応が無かったという意味ではありません）',
});

/**
 * Airtable の `EmailEvents` を読んでよいか。
 * @returns {{readable: boolean, sinkMode: string, reason: string}}
 */
export function resolveLedgerReadability(env = process.env) {
  const sinkMode = resolveEventSinkMode(env);
  const readable = writesAirtableEvents(sinkMode);
  return {
    readable,
    sinkMode,
    reason: readable ? LEDGER_SOURCE_REASON.OK : LEDGER_SOURCE_REASON.SINK_BLOB,
  };
}

/**
 * カルテへ返す `ledgerSource` を組み立てる（純粋）。
 *
 * @param {{
 *   readable: boolean, sinkMode: string,
 *   fetchAvailable?: boolean, rows?: number,
 *   unresolvedTotal?: number|null, conflictTotal?: number|null,
 *   unattributedAvailable?: boolean,
 * }} input
 */
export function describeLedgerSource(input = {}) {
  const {
    readable, sinkMode,
    fetchAvailable = false, rows = 0,
    unresolvedTotal = null, conflictTotal = null, unattributedAvailable = false,
  } = input;

  // 読めない経路なら、取得結果があっても採用しない（0 行を「反応なし」に化けさせない）
  if (!readable) {
    return {
      available: false,
      sinkMode,
      reason: LEDGER_SOURCE_REASON.SINK_BLOB,
      rows: null,
      unresolvedTotal: null,
      conflictTotal: null,
      unattributedAvailable: false,
      note: NOTE[LEDGER_SOURCE_REASON.SINK_BLOB],
    };
  }

  const reason = fetchAvailable ? LEDGER_SOURCE_REASON.OK : LEDGER_SOURCE_REASON.FETCH_FAILED;
  return {
    available: fetchAvailable === true,
    sinkMode,
    reason,
    rows: fetchAvailable ? Number(rows) || 0 : null,
    unresolvedTotal: unattributedAvailable ? unresolvedTotal : null,
    conflictTotal: unattributedAvailable ? conflictTotal : null,
    unattributedAvailable: unattributedAvailable === true,
    note: NOTE[reason],
  };
}
