/**
 * handoffResolution.js — 「引き継ぎを積もうとしたら対象 0 件」をどう扱うか（純粋）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 付与した人を Step1 のキューへ積むとき、dry-run が「対象 0 件」を返すことがある。
 * 意味は 2 つあり、**取り違えると人が取り残される**:
 *
 *   A. もう積み終わっている（queue は冪等なので当然 0 件）→ 引き継ぎを畳んでよい
 *   B. まだ Airtable に反映されていない（付与直後の読み取り遅延）→ **畳んではいけない**
 *
 * 2026-08-18 の #363 は 0 件を一律 A とみなして引き継ぎを消していた（**fail open**）。
 * B のときは「付与済みなのに案内が来ない人」が黙って残る。
 *
 * ── 見分け方（既存の事実だけで判定する）────────────────────────
 * 関所の `outstandingStep1` は「付与したのに Step1 が案内に乗っていない人」の数。
 *   - `0` なら誰も待っていない → **A**（畳んでよい）
 *   - `> 0` なら待っている人が居る → **B の疑い**。畳まず、次の tick でやり直す。
 *     それが続くなら **fail closed**（自動停止して人に見せる）
 * ⚠️ `outstandingStep1` が読めない（null）ときも畳まない（**推測で消さない**）。
 */

/** 0 件が続いても畳まずに再試行する回数。超えたら止める */
export const MAX_EMPTY_HANDOFF_ATTEMPTS = 3;

export const HANDOFF_ACTION = Object.freeze({
  /** もう積み終わっている。引き継ぎを消してよい */
  CLEAR: 'clear',
  /** まだ見えていないかもしれない。**消さずに**次の tick でやり直す */
  RETRY: 'retry',
  /** やり直しても解決しない。**止めて人に見せる** */
  STOP: 'stop',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {{outstandingStep1: number|null, attempts: number,
 *          maxAttempts?: number}} input
 * @returns {{action: string, attempts: number, reason: string|null}}
 */
export function resolveEmptyHandoff({
  outstandingStep1, attempts = 0, maxAttempts = MAX_EMPTY_HANDOFF_ATTEMPTS,
} = {}) {
  const outstanding = num(outstandingStep1);
  const tried = Math.max(0, num(attempts) ?? 0) + 1;

  // 誰も案内待ちでない = 本当に積み終わっている
  if (outstanding === 0) return { action: HANDOFF_ACTION.CLEAR, attempts: 0, reason: null };

  // 待っている人が居る / 数えられない → 畳まない
  if (tried >= Math.max(1, maxAttempts)) {
    return {
      action: HANDOFF_ACTION.STOP,
      attempts: tried,
      reason: outstanding === null ? 'handoff_unverifiable' : 'handoff_unresolved',
    };
  }
  return { action: HANDOFF_ACTION.RETRY, attempts: tried, reason: null };
}

export default resolveEmptyHandoff;
