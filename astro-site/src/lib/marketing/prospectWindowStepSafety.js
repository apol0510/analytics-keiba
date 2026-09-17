/**
 * prospectWindowStepSafety.js — **窓で step の順序を壊さない**（純粋・I/O なし）
 *
 * ## 何が危なかったか（2026-09-17 のレビュー指摘）
 *
 * `selectNextDueStep` は「**全体で**いちばん小さい due step」を選ぶ。
 * ところが prospect の読み込みを窓で切ると、progress は**窓の中だけ**から作られる。
 *
 * | | step2 due | step3 due |
 * |---|---|---|
 * | 窓 A | **0** | あり |
 * | 窓 B | あり | — |
 *
 * カーソルが窓 A を指している tick では「窓の中の最小」が **step3** になり、
 * **全体にはまだ step2 待ちが残っているのに step3 を先に送ってしまう**。
 * これは現行の実効挙動（全体に step2 due がある限り step3 を送らない）を変える。
 * **性能改善のために step 順序を変えてはいけない。**
 *
 * ## ここで決めること（証明できる規則だけ）
 *
 * 窓の中で選ばれた step が **選べる中でいちばん小さい step** と同じなら、
 * **それより小さい due は全体のどこにも存在し得ない**ので、窓の判断は全体の判断と一致する。
 *
 *   - 窓の最小 due step ＝ 選べる最小 step  → **窓のままで安全**
 *   - それより大きい                        → **全体を読み直す**（従来どおりの全件）
 *
 * ⚠️ これは「速いかどうか」ではなく「**同じ結論になるか**」の判定。
 *    証明できないときは**必ず全件へ落とす**（fail closed）。
 * ⚠️ step1 は共有 cron では既定で選べない（入口は別経路）。
 *    したがって通常の「選べる最小」は **2**。入口が開いているときは **1**。
 */

/** 共有 cron が step1 を自動で撃たないときの、選べる最小 step */
export const LOWEST_SELECTABLE_STEP_DEFAULT = 2;

/**
 * 選べる最小の step。
 *
 * @param {{allowFirstStep?: boolean}} input
 */
export function lowestSelectableStep({ allowFirstStep = false } = {}) {
  return allowFirstStep === true ? 1 : LOWEST_SELECTABLE_STEP_DEFAULT;
}

/**
 * `dueByStep` から「選べる中での最小 due step」を出す。
 *
 * ⚠️ 件数 0 の step は due ではない（キーがあっても数えない）。
 * @returns {number|null} 誰も due でなければ null
 */
export function minSelectableDueStep({ dueByStep, allowFirstStep = false } = {}) {
  const lowest = lowestSelectableStep({ allowFirstStep });
  const entries = Object.entries(dueByStep || {});
  let min = null;
  for (const [k, v] of entries) {
    const step = Number(k);
    const count = Number(v);
    if (!Number.isInteger(step) || !Number.isFinite(count) || count <= 0) continue;
    if (step < lowest) continue;                       // 選べない step は無視
    if (min === null || step < min) min = step;
  }
  return min;
}

/**
 * **窓の判断を全体の判断として採用してよいか。**
 *
 * 採用してよいのは「窓の最小 due step が、選べる最小 step と同じ」ときだけ。
 * そのときに限り、**全体にそれより小さい due は存在し得ない**。
 *
 * @param {{dueByStep: object, allowFirstStep?: boolean, windowed?: boolean}} input
 * @returns {{safe: boolean, reason: string, windowMinStep: number|null, lowest: number}}
 */
export function isWindowStepDecisionSafe({ dueByStep, allowFirstStep = false, windowed = true } = {}) {
  const lowest = lowestSelectableStep({ allowFirstStep });
  // 窓で切っていないなら、そもそも全体を見ている
  if (windowed !== true) {
    return { safe: true, reason: 'not_windowed', windowMinStep: null, lowest };
  }
  const windowMinStep = minSelectableDueStep({ dueByStep, allowFirstStep });
  if (windowMinStep === null) {
    /**
     * 窓の中に due が 1 人も居ない。**全体にも居ないとは限らない**ので、
     * 窓のまま「送る相手なし」と結論してはいけない。
     */
    return { safe: false, reason: 'window_has_no_due', windowMinStep: null, lowest };
  }
  if (windowMinStep === lowest) {
    return { safe: true, reason: 'window_min_is_lowest_possible', windowMinStep, lowest };
  }
  /**
   * 窓の最小が「選べる最小」より大きい。
   * 窓の外にもっと小さい due が居るかもしれないので**全体を読み直す**。
   */
  return { safe: false, reason: 'lower_step_may_exist_outside_window', windowMinStep, lowest };
}

export default isWindowStepDecisionSafe;
