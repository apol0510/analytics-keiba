/**
 * grantOutcome.js — 「付与を予定したのに 0 件だった」をどう扱うか（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 2026-08-17 の本番: allowance 400 を 1 回で依頼したが、`buildComebackPlan` の
 * `MAX_GRANT_RECORDS=200` に掛かって `too_many_records:400>200` となり、
 * **granted 0 のまま `settleTick` が走った**。その結果
 *   - `batchSeq` だけが毎 tick 進む（operationId を無駄に消費する）
 *   - `lastRunCount: 0` が「正常に実行した」記録として残る
 *   - 5 分ごとに同じ失敗を繰り返し、**誰も止めない**（14 回空回りした）
 *
 * ── 決め方 ────────────────────────────────────────────────────
 * 「配る予定が 1 人以上あったか」と「実際に何人配れたか」で 3 つに分ける。
 *
 *   granted … 1 人以上配れた（部分成功を含む）→ 実数で settle する
 *   idle    … **正常に配る相手が居なかった**（候補 0）→ 何も記録しない（進めない）
 *   failed  … 配るはずが配れなかった → **fail closed**。settle せず自動停止する
 *
 * ⚠️ `idle` と `failed` を混ぜない。候補 0 は正常な終わり方で、
 *    `too_many_records` / 書き込み失敗は**運用が直すべき異常**。
 * ⚠️ ここは判定するだけ。状態の保存も停止も呼び出し側が行う。
 */

/** 付与結果の分類 */
export const GRANT_OUTCOME = Object.freeze({
  GRANTED: 'granted',
  IDLE: 'idle',
  FAILED: 'failed',
});

/**
 * 「配る相手が居ない」＝ 正常。これ以外の abort は異常として扱う。
 * （`lightTrialAutoGrant.js` の `AUTOGRANT_ABORT.NO_CANDIDATES` と同じ値）
 */
export const NORMAL_EMPTY_ABORTS = Object.freeze(['no_candidates']);

/** 異常の理由コード（固定。件数・理由だけを画面とログへ出す） */
export const GRANT_FAILURE = Object.freeze({
  /** 付与側が返した abort をそのまま使う（`too_many_records:400>200` など） */
  ABORTED: 'grant_aborted',
  /** 計画は通ったが 1 件も書けなかった（Airtable 書き込み失敗） */
  WRITE_FAILED: 'grant_write_failed',
  /** 理由が分からないまま 0 件（**0 件を成功にしない**） */
  ZERO_WITHOUT_REASON: 'grant_returned_zero',
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 付与の実行結果を分類する。
 *
 * @param {{requested: number, granted: number, failed?: number,
 *          abort?: string|null, ok?: boolean}} input
 *   `requested` … その tick が配る予定だった人数（`plan.allowance`）
 *   `granted`   … 実際に書けた人数
 *   `failed`    … 書き込みに失敗した人数（分かる場合）
 *   `abort`     … 付与側が返した中止理由（あれば）
 * @returns {{outcome: string, reason: string|null, detail: string|null,
 *            settle: boolean, pause: boolean, granted: number}}
 *   `settle` … 展開状態へ実行を記録してよいか（false なら batchSeq も日次集計も進めない）
 *   `pause`  … 新規付与を止めるべきか（積み残しの queue / 送信は別途進む）
 */
export function classifyGrantOutcome({ requested, granted, failed = 0, abort = null } = {}) {
  const want = Math.max(0, num(requested));
  const got = Math.max(0, num(granted));
  const bad = Math.max(0, num(failed));
  const abortCode = String(abort ?? '').trim();

  // ① 1 人でも配れたら成功として記録する（部分成功も実数で刻む）
  if (got > 0) {
    return {
      outcome: GRANT_OUTCOME.GRANTED,
      reason: null,
      detail: null,
      settle: true,
      pause: false,
      granted: got,
    };
  }

  // ② そもそも配る予定が無かった（呼ばれ方がおかしい）→ 何も記録しない
  if (want <= 0) {
    return {
      outcome: GRANT_OUTCOME.IDLE,
      reason: null, detail: null, settle: false, pause: false, granted: 0,
    };
  }

  // ③ 「配る相手が居ない」は正常な終わり方。記録も停止もしない
  //    （次の tick も同じ判断になるだけで、状態は汚れない）
  if (abortCode && NORMAL_EMPTY_ABORTS.includes(abortCode)) {
    return {
      outcome: GRANT_OUTCOME.IDLE,
      reason: abortCode, detail: null, settle: false, pause: false, granted: 0,
    };
  }

  // ④ 予定があったのに 1 人も配れなかった＝異常。**settle せず止める**
  //    （`too_many_records:400>200` のような構造的な誤りは、放置すると
  //      5 分ごとに永久に繰り返す。人が直すまで止めるのが正しい）
  const reason = abortCode
    ? GRANT_FAILURE.ABORTED
    : (bad > 0 ? GRANT_FAILURE.WRITE_FAILED : GRANT_FAILURE.ZERO_WITHOUT_REASON);
  return {
    outcome: GRANT_OUTCOME.FAILED,
    reason,
    /** 付与側の生の理由（`too_many_records:400>200` など。PII は含まない） */
    detail: abortCode || null,
    settle: false,
    pause: true,
    granted: 0,
  };
}

/** 画面・ログ用の短い説明（**件数と理由だけ**） */
export function describeGrantOutcome(v) {
  const o = v || {};
  return {
    outcome: o.outcome || null,
    reason: o.reason || null,
    detail: o.detail || null,
    granted: Math.max(0, num(o.granted)),
    settled: o.settle === true,
    paused: o.pause === true,
  };
}

export default classifyGrantOutcome;
