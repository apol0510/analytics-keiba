/**
 * premiumPlusFunnelAnalytics.js — 実閲覧の**段階・並び順・転換率**（純粋・I/O なし）
 *
 * ## 何のためか
 *
 * 実閲覧の記録（表示 / クリック / 商品ページ到達）は 2026-08-13 に本番稼働し、
 * E2E で 3 種別とも記録されることを確認した。ここから先は**運用**の話になる:
 *
 *   - 誰が「見たのに押していない」のか
 *   - 誰が「押したのに商品ページへ着いていない」のか
 *   - 表示 → クリック → 到達がどれだけ落ちているのか
 *
 * これを管理画面が答えられるようにする。判定はここに集約し、画面へ散らさない。
 *
 * ## ⚠️ 「記録が無い」を「0 回」と読み替えない
 *
 * 記録が無い理由は「本当に見ていない」だけではない:
 *   - 計測開始（2026-08-13）より前だった
 *   - Redis を読めなかった
 *
 * どちらも**確認不能**。したがって:
 *   - 段階は `unknown`（未確認）であって「未表示」ではない
 *   - 転換率は**分母が確定しないとき null**（0% と書かない）
 *
 * ## 個人情報を増やさない
 *
 * ここが扱うのは recordId とタイムスタンプ・回数だけ。
 * アドレス・氏名は受け取らないし返さない（Redis へも増やさない）。
 */

/** 実閲覧の段階。**到達した最も先の段階**で分類する。 */
export const FUNNEL_STAGE = Object.freeze({
  /** 記録が無い（= 見ていない、ではない） */
  UNKNOWN: 'unknown',
  /** 表示された。まだクリックしていない */
  VIEWED_NOT_CLICKED: 'viewed_not_clicked',
  /** クリックした。まだ商品ページに着いていない */
  CLICKED_NOT_REACHED: 'clicked_not_reached',
  /** 商品ページまで到達した */
  REACHED: 'reached',
});

export const FUNNEL_STAGE_LABEL = Object.freeze({
  unknown: '未確認',
  viewed_not_clicked: '表示済み・未クリック',
  clicked_not_reached: 'クリック済み・未到達',
  reached: '商品ページ到達済み',
});

/** 画面の絞り込みに出す順（未確認は最後） */
export const FUNNEL_STAGE_ORDER = Object.freeze([
  FUNNEL_STAGE.VIEWED_NOT_CLICKED,
  FUNNEL_STAGE.CLICKED_NOT_REACHED,
  FUNNEL_STAGE.REACHED,
  FUNNEL_STAGE.UNKNOWN,
]);

const measured = (cell) => !!(cell && cell.measured === true);
const ms = (v) => (Number.isFinite(v) ? v : null);

/**
 * 段階を決める。**先の段階を優先**する（到達していればクリック有無に関わらず reached）。
 *
 * クリック記録はあるが表示記録が無い、という並びも起こり得る
 * （表示は IntersectionObserver 由来なので、計測開始直後や
 *  画面外からの遷移では落ちる）。**そのときも「押した」事実を優先**する。
 *
 * @param {{available?:boolean, cta?:object, click?:object, page?:object}|null} realView
 * @returns {{stage:string, label:string}}
 */
export function resolveFunnelStage(realView) {
  const v = realView || {};
  if (v.available === false) return out(FUNNEL_STAGE.UNKNOWN);
  if (measured(v.page)) return out(FUNNEL_STAGE.REACHED);
  if (measured(v.click)) return out(FUNNEL_STAGE.CLICKED_NOT_REACHED);
  if (measured(v.cta)) return out(FUNNEL_STAGE.VIEWED_NOT_CLICKED);
  return out(FUNNEL_STAGE.UNKNOWN);
}

function out(stage) {
  return { stage, label: FUNNEL_STAGE_LABEL[stage] || stage };
}

/**
 * 「いちばん新しい反応」の時刻。並べ替えと「新規反応」の判定に使う。
 * 記録が無ければ null（0 ではない）。
 *
 * @returns {number|null}
 */
export function lastReactionAtMs(realView) {
  const v = realView || {};
  if (v.available === false) return null;
  const times = [v.cta, v.click, v.page]
    .filter((c) => measured(c))
    .map((c) => ms(c.lastAtMs))
    .filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * 前回見た時刻より後に反応があったか（= 管理者にとっての「新規反応」）。
 *
 * 基準時刻は**管理者のブラウザが持つ**（サーバーにも Redis にも保存しない）。
 * 基準が無いとき（初回）は **false**。全員を新規扱いにして意味を薄めない。
 */
export function isNewReaction(realView, seenAtMs) {
  if (!Number.isFinite(seenAtMs)) return false;
  const last = lastReactionAtMs(realView);
  return last !== null && last > seenAtMs;
}

/** 分母が確定しないときは null（0% と書かない） */
function rate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10; // 小数第 1 位
}

/**
 * 一覧全体の転換を数える。**人数**で数える（回数ではない）。
 *
 * @param {Array<{realView?: object}>} rows
 * @returns {{
 *   available: boolean, total: number,
 *   viewed: number, clicked: number, reached: number, unknown: number,
 *   rates: {viewToClick: number|null, clickToReach: number|null, viewToReach: number|null},
 *   note: string,
 * }}
 */
export function summarizeFunnel(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let available = list.length > 0;
  const c = { total: 0, viewed: 0, clicked: 0, reached: 0, unknown: 0 };

  for (const r of list) {
    const v = r && r.realView;
    c.total += 1;
    if (!v || v.available === false) { c.unknown += 1; available = false; continue; }
    // **累積**で数える（到達した人は表示・クリックにも数える）。
    // 段階別の人数ではなく「どこまで進んだか」の落ち方を見るため。
    const reached = measured(v.page);
    const clicked = measured(v.click);
    const viewed = measured(v.cta);
    if (reached) c.reached += 1;
    if (clicked || reached) c.clicked += 1;
    if (viewed || clicked || reached) c.viewed += 1;
    if (!viewed && !clicked && !reached) c.unknown += 1;
  }

  return {
    available,
    ...c,
    rates: {
      viewToClick: rate(c.clicked, c.viewed),
      clickToReach: rate(c.reached, c.clicked),
      viewToReach: rate(c.reached, c.viewed),
    },
    note: available
      ? '計測開始以降の実測です。記録が無い人は「未確認」（0 回ではありません）。'
      : '実閲覧を読み取れなかった人がいます。「未確認」は 0 回という意味ではありません。',
  };
}

/**
 * 並べ替え。**反応が新しい順**（記録が無い人は必ず後ろ）。
 *
 * 同着はブラウザの sort が不安定にならないよう recordId で決める。
 *
 * @param {Array<object>} rows 破壊しない
 */
export function sortByLastReaction(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const ta = lastReactionAtMs(a && a.realView);
    const tb = lastReactionAtMs(b && b.realView);
    if (ta === null && tb === null) return String(a?.recordId || '').localeCompare(String(b?.recordId || ''));
    if (ta === null) return 1;   // 記録なしは後ろ
    if (tb === null) return -1;
    if (tb !== ta) return tb - ta;
    return String(a?.recordId || '').localeCompare(String(b?.recordId || ''));
  });
}

/** 段階での絞り込み（未知の値が来たら**絞らない**＝人を隠さない） */
export function filterByStage(rows, stage) {
  const list = Array.isArray(rows) ? rows : [];
  if (!stage || !FUNNEL_STAGE_ORDER.includes(stage)) return list;
  return list.filter((r) => resolveFunnelStage(r && r.realView).stage === stage);
}

export default resolveFunnelStage;
