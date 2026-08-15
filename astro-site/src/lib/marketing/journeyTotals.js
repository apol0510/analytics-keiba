/**
 * journeyTotals.js — 2 フェーズの進行集計を**人を二重に数えずに**1 本へまとめる（純粋）
 *
 * ── 何が難しいか ──────────────────────────────────────────────
 * 体験中フェーズと終了後フェーズは**同じ人**を対象にしている
 * （どちらも「取り込みコホート × Light 無料付与の痕跡あり」）。
 * そのため 2 つの集計を単純に足すと、**1 人を 2 回数える**。
 *
 * ── どう解くか ────────────────────────────────────────────────
 * **終了後フェーズの集計を主にする。** こちらは同じ母集団を持ち、
 * 「まだ体験中の人」を `grant_still_active` として理由付きで数えているので、
 * 1 人が必ず 1 か所に入る:
 *
 *   体験中             … 終了後フェーズが `grant_still_active` で止めている人
 *   体験終了・フォロー中 … 終了後フェーズで待機中 / 送信可の人
 *   購入               … `purchased` で止まった人（キャンペーンに依らない事実）
 *   停止               … それ以外の理由で止まった人（配信停止・バウンス・対象外 等）
 *   完了               … 終了後フェーズを最後まで送り終えた人
 *
 * ⚠️ **数えられないものは `null`**。0 と書かない（「まだ計測していない」と
 *    「本当に 0 人」は運用上まったく違う）。
 */

/** 「まだ体験中」を表す停止理由（`sequenceProgress.js` と同じ綴り） */
export const STILL_ACTIVE_REASON = 'grant_still_active';

/** 購入で止まったことを表す停止理由 */
export const PURCHASED_REASON = 'purchased';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * フェーズ別の `action=sequence` 集計から、道のり全体の人数を出す。
 *
 * @param {{active: object|null, postExpiry: object|null}} input
 *   それぞれ `summary`（total / due / waiting / completed / stopped / byStopReason）
 * @returns {{ok: boolean, reason?: string, totals?: object}}
 */
export function buildJourneyTotals({ active, postExpiry }) {
  const post = postExpiry && typeof postExpiry === 'object' ? postExpiry : null;
  if (!post) return { ok: false, reason: 'post_expiry_summary_missing' };

  const total = num(post.total);
  const due = num(post.due);
  const waiting = num(post.waiting);
  const completed = num(post.completed);
  const stopped = num(post.stopped);
  if (total === null || due === null || waiting === null || completed === null || stopped === null) {
    return { ok: false, reason: 'summary_incomplete' };
  }

  const byReason = (post.byStopReason && typeof post.byStopReason === 'object') ? post.byStopReason : {};
  const reasonCount = (key) => num(byReason[key]) ?? 0;

  const inTrial = reasonCount(STILL_ACTIVE_REASON);
  const purchased = reasonCount(PURCHASED_REASON);
  // 「停止」は**理由が本当に停止であるもの**だけ。体験中と購入はここへ入れない。
  const stoppedOther = Math.max(0, stopped - inTrial - purchased);
  const inFollowUp = due + waiting;

  // 体験中フェーズの内訳（画面の補足。**人数の主計は終了後フェーズ側**）
  const activeSummary = active && typeof active === 'object' ? active : null;
  const trialDue = activeSummary ? num(activeSummary.due) : null;
  const trialWaiting = activeSummary ? num(activeSummary.waiting) : null;

  return {
    ok: true,
    totals: {
      /** 母集団（この道のりの対象として観測できた人数） */
      observed: total,
      inTrial,
      inFollowUp,
      purchased,
      stopped: stoppedOther,
      completed,
      byStopReason: byReason,
      /** 体験中フェーズの内訳（送信待ち / 期日待ち）。読めなければ null */
      trial: { due: trialDue, waiting: trialWaiting },
      /** 分類の合計が母集団と一致するか（ズレたら画面で警告する） */
      balanced: inTrial + inFollowUp + purchased + stoppedOther + completed === total,
    },
  };
}

/** 集計（Redis）へ書く形。`reconcile()` へそのまま渡せる */
export function toMetricsTotals({ totals, granted }) {
  const t = totals || {};
  return {
    granted: num(granted) ?? 0,
    notStarted: 0,
    inTrial: num(t.inTrial) ?? 0,
    inFollowUp: num(t.inFollowUp) ?? 0,
    // 旧来の「進行中」は 2 フェーズの合計（画面の互換のため残す）
    inProgress: (num(t.inTrial) ?? 0) + (num(t.inFollowUp) ?? 0),
    purchased: num(t.purchased) ?? 0,
    stopped: num(t.stopped) ?? 0,
    completed: num(t.completed) ?? 0,
    byStopReason: t.byStopReason && typeof t.byStopReason === 'object' ? t.byStopReason : {},
  };
}

/** 画面に出す並び（ラベルは運用者の言葉で） */
export const JOURNEY_STATE_LABEL = Object.freeze({
  inTrial: '体験中',
  inFollowUp: '体験終了・フォロー中',
  purchased: '購入',
  stopped: '停止',
  completed: '24 通完了',
});

export default buildJourneyTotals;
