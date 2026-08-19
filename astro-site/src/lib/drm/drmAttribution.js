/**
 * drmAttribution.js — 購入を**どの 1 通まで**辿れるか（純粋・I/O なし）
 *
 * ── 何をするか ────────────────────────────────────────────────
 * 購入した顧客について、campaignId / version / touch(step) / DeliveryKey /
 * offer（既存識別子がある場合）まで結ぶ。
 *
 * ── 推測でattributionしない ──────────────────────────────────
 * ⚠️ 「送った後に買った」は**メールのおかげとは限らない**（既存 `crm/campaignOutcome.js`
 *    の 3 段階と同じ立場）。ここも確からしさを落として持つ:
 *
 *      direct     … その 1 通の**クリック**が確認できる（＝ click 計測が有効なときだけ）
 *      correlated … その 1 通の**開封後・窓の中**に購入した（時間相関のみ）
 *      unattributed … 上のどちらにも当たらない（**unknown を 0 に丸めない**）
 *
 * ⚠️ AK は provider 側の click tracking が OFF（`deliveryEventIndex.js` の注記）。
 *    したがって **`direct` は原則成立しない**。その事実を `measured` として一緒に返し、
 *    画面が「direct 0 件＝効果が無い」と誤解しないようにする。
 * ⚠️ 購入時刻が分からない・送信時刻が分からないものは `unattributed`。
 *    **窓の外**も `unattributed`（勝手に伸ばさない）。
 */

/** 確からしさ（既存 `campaignOutcome.ATTRIBUTION` と同じ語彙を使う） */
export const ATTRIBUTION = Object.freeze({
  DIRECT: 'direct',
  CORRELATED: 'correlated',
  UNATTRIBUTED: 'unattributed',
});

export const ATTRIBUTION_LABEL = Object.freeze({
  direct: 'メール経由と確認できる（クリック）',
  correlated: '送信後の窓の中に購入（相関のみ・因果は不明）',
  unattributed: '紐づけられない',
});

/** 既定の帰属窓（日）。既存 `campaignOutcome.OUTCOME_WINDOWS` の d7 / d30 に合わせる */
export const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86400_000;

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 購入 1 件を、その人の touch 履歴へ結ぶ。
 *
 * @param {{
 *   purchasedAtMs: number|null,
 *   touches: Array<{step:number, deliveryKey:string, campaignId:string, version:number,
 *                   sentAtMs:number|null, openedAtMs:number|null, clicked:boolean|null,
 *                   offerKey?:string|null}>,
 *   windowDays?: number,
 *   clickMeasured?: boolean,
 * }} input
 * @returns {{attribution: string, campaignId: string|null, version: number|null,
 *            step: number|null, deliveryKey: string|null, offerKey: string|null,
 *            reason: string|null}}
 */
export function attributePurchase({
  purchasedAtMs, touches, windowDays = DEFAULT_WINDOW_DAYS, clickMeasured = false,
} = {}) {
  const none = (reason) => ({
    attribution: ATTRIBUTION.UNATTRIBUTED,
    campaignId: null, version: null, step: null, deliveryKey: null, offerKey: null, reason,
  });
  const at = num(purchasedAtMs);
  const list = (Array.isArray(touches) ? touches : []).filter((t) => t && str(t.deliveryKey));
  if (list.length === 0) return none('no_touch');
  if (at === null) return none('no_purchase_time');

  const win = Math.max(1, num(windowDays) ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
  const hit = (t, attribution) => ({
    attribution,
    campaignId: str(t.campaignId) || null,
    version: num(t.version),
    step: num(t.step),
    deliveryKey: str(t.deliveryKey),
    offerKey: str(t.offerKey) || null,
    reason: null,
  });

  // ── ① クリックが確認できる 1 通（**click 計測が有効なときだけ**）──────
  if (clickMeasured) {
    const clicked = list
      .filter((t) => t.clicked === true && num(t.sentAtMs) !== null && num(t.sentAtMs) <= at)
      .sort((a, b) => (num(b.sentAtMs) ?? 0) - (num(a.sentAtMs) ?? 0));
    if (clicked.length > 0) return hit(clicked[0], ATTRIBUTION.DIRECT);
  }

  // ── ② 窓の中に届いた・開いた直近の 1 通（相関のみ）────────────────
  const inWindow = list.filter((t) => {
    const base = num(t.openedAtMs) ?? num(t.sentAtMs);
    return base !== null && base <= at && at - base <= win;
  }).sort((a, b) => {
    const A = num(a.openedAtMs) ?? num(a.sentAtMs) ?? 0;
    const B = num(b.openedAtMs) ?? num(b.sentAtMs) ?? 0;
    return B - A;
  });
  if (inWindow.length > 0) return hit(inWindow[0], ATTRIBUTION.CORRELATED);

  return none('outside_window');
}

/**
 * 複数人ぶんをまとめる。**未帰属を落とさずに数える。**
 *
 * @returns {{total:number, byAttribution:object, byTouch:object, unattributed:number,
 *            clickMeasured:boolean}}
 */
export function summarizeAttribution(results, { clickMeasured = false } = {}) {
  const byAttribution = { direct: 0, correlated: 0, unattributed: 0 };
  const byTouch = {};
  let total = 0;
  for (const r of Array.isArray(results) ? results : []) {
    const a = str(r && r.attribution);
    if (!(a in byAttribution)) continue;
    byAttribution[a] += 1;
    total += 1;
    const step = num(r && r.step);
    if (a !== ATTRIBUTION.UNATTRIBUTED && step !== null) {
      byTouch[step] = (byTouch[step] || 0) + 1;
    }
  }
  return {
    total,
    byAttribution,
    byTouch,
    unattributed: byAttribution.unattributed,
    /** ⚠️ click 計測が無いと `direct` は原則 0。**「効果なし」ではない** */
    clickMeasured: clickMeasured === true,
  };
}

export default attributePurchase;
