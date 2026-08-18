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
 * ── 見分け方（**正の証拠だけ**）──────────────────────────────
 * 畳んでよいのは「その付与 operation の対象者**全員**の Step1 が配信台帳に
 * `queued` / `sent` で載っている」と**確認できたとき**だけ（`handoffQueueProof.js`）。
 *
 * ⚠️ 使ってはいけない根拠（本番で誤りが実証された）:
 *   - dry-run の「対象 0 件」… まだ Airtable に見えていないだけのことがある
 *   - 関所の `outstandingStep1 === 0` … **同じ読み取り遅延で 0 に見える**（2026-08-18 / #362）
 *   - 「救済経路があるから大丈夫」… 引き継ぎの責任を推測で手放さない
 * ⚠️ 証明できなければ**消さない**。続くなら fail closed（自動停止）。
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
 * @param {{proof: {ok: boolean, reason?: string|null}|null, attempts: number,
 *          maxAttempts?: number}} input
 *   `proof` … `proveHandoffQueued()` の結果。**これだけが CLEAR の根拠**
 * @returns {{action: string, attempts: number, reason: string|null}}
 */
export function resolveEmptyHandoff({
  proof, attempts = 0, maxAttempts = MAX_EMPTY_HANDOFF_ATTEMPTS,
} = {}) {
  const proven = !!(proof && proof.ok === true);
  const tried = Math.max(0, num(attempts) ?? 0) + 1;

  // **全員ぶんの Step1 が台帳にある**と確認できたときだけ畳む
  if (proven) return { action: HANDOFF_ACTION.CLEAR, attempts: 0, reason: null };

  // 証明できない → 消さない。続くなら止めて人に見せる
  if (tried >= Math.max(1, maxAttempts)) {
    return {
      action: HANDOFF_ACTION.STOP,
      attempts: tried,
      reason: `handoff_unproven:${(proof && proof.reason) || 'unknown'}`.slice(0, 60),
    };
  }
  return { action: HANDOFF_ACTION.RETRY, attempts: tried, reason: null };
}

export default resolveEmptyHandoff;
