/**
 * sanrenpukuCtaStage.js — 三連複 CTA / 予告カード / 的中結果の「段階表示」単一源
 *
 * 三連複は「馬単で絞り込めない方向けの絞り込み補助機能」。Premium（馬単のみ）購入者に対し、
 * 初回表示日を 1 日目として次の段階で出し分ける（旧: 5日後に一括解禁 → 新: 4日目 CTA 解禁）。
 *
 *   1日目: 三連複関連は完全非表示
 *   2日目: 予告カードのみ
 *   3日目: 予告カード ＋ 三連複的中結果（結果セクションがあるページのみ＝南関。JRA は予告のみ）
 *   4日目以降: 既存の三連複 CTA カード（申込・アーカイブ）＋ 的中結果
 *
 * 【基準日について】
 *   - 経過日数の基準は現状ブラウザ localStorage の初回表示時刻（`ak-umatan-first-seen`）。
 *   - サーバー上の Premium 開始日基準化は PR-C / PR-D 以降の認証強化フェーズで別途対応する
 *     （本モジュールはサーバー Premium 開始日を参照しない・認証コードにも依存しない）。
 *
 * DOM も localStorage も触らない純粋関数。呼び出し側（premium-prediction/*.astro の <script>）が
 * localStorage 値と `Date.now()` を読んで渡し、返り値の表示プランを DOM へ適用する。
 */

/** 1 日（ミリ秒） */
export const SRP_DAY_MS = 24 * 60 * 60 * 1000;

/** 段階（何日目か） */
export const SRP_STAGE = Object.freeze({
  HIDDEN: 1, //  1日目: 完全非表示
  TEASER: 2, //  2日目: 予告のみ
  TEASER_RESULT: 3, // 3日目: 予告＋結果
  CTA: 4, // 4日目以降: CTA 解禁
});

// 馬単（三連複を持たない）Premium 系＝アップセル funnel 対象。casing 非依存で比較する。
const PAID_UMATAN = ['premium', 'premium predictions', 'premiumpredictions'];
// 既に三連複を保有（Sanrenpuku / Combo / Full）＝追加 CTA を出さない。
const HAS_SRP = ['premium sanrenpuku', 'premiumsanrenpuku', 'premium combo', 'premiumcombo', 'premium full'];

/** plan 文字列を比較キーへ正規化（trim + 小文字）。 */
export function normalizePlanKey(planRaw) {
  return (planRaw == null ? '' : String(planRaw)).trim().toLowerCase();
}

/**
 * 段階表示の funnel 対象か（馬単のみの Premium 系。三連複保有者・無料・未ログインは false）。
 */
export function isFunnelTarget(planRaw) {
  const p = normalizePlanKey(planRaw);
  if (!p) return false;
  if (HAS_SRP.indexOf(p) !== -1) return false; // 既に三連複保有 → 追加 CTA 不要
  return PAID_UMATAN.indexOf(p) !== -1;
}

/**
 * 経過ミリ秒 → 段階（何日目か）。
 * 負値・非数は 1日目（HIDDEN）として安全側に倒す。
 */
export function computeSanrenpukuStage(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !isFinite(elapsedMs) || elapsedMs < 0) return SRP_STAGE.HIDDEN;
  if (elapsedMs < SRP_DAY_MS) return SRP_STAGE.HIDDEN; // 1日目
  if (elapsedMs < 2 * SRP_DAY_MS) return SRP_STAGE.TEASER; // 2日目
  if (elapsedMs < 3 * SRP_DAY_MS) return SRP_STAGE.TEASER_RESULT; // 3日目
  return SRP_STAGE.CTA; // 4日目以降
}

/**
 * 表示プランを算出する（DOM 非依存）。
 *
 * @param {Object} p
 * @param {string} p.planRaw            localStorage user-plan の plan 文字列
 * @param {boolean} [p.dismissed]       CTA を ×閉じ 済みか（ak-srp-cta-dismissed === '1'）
 * @param {number} p.firstSeen          初回表示時刻(ms)。未設定なら now を渡す
 * @param {number} p.now                Date.now()
 * @param {boolean} [p.hasResultSection] そのページに三連複的中結果セクションがあるか（南関=true / JRA=false）
 * @returns {{ isFunnelTarget:boolean, stage:number, teaser:('none'|'day2'|'day3'), showResult:boolean, showCta:boolean }}
 *   funnel 対象外は全て false/none（＝このコントローラは何もせず、既存の結果ゲートに委ねる）。
 *   - teaser: 表示する予告カードの内側ボディ（day2 / day3）。'none' は非表示。
 *   - showResult: このコントローラが的中結果を表示すべきか（funnel 対象・3日目以降・結果セクション有り）。
 *   - showCta: 既存 CTA カードを表示すべきか（4日目以降・未dismiss）。
 *
 * 排他性（設計上の不変条件）:
 *   - teaser!=='none' と showCta は同時に true にならない（予告と通常CTAが同居しない）。
 *   - showCta（アーカイブ導線を含む）が true のとき teaser は 'none'（解禁前案内と同居しない）。
 */
export function planSanrenpukuDisplay({ planRaw, dismissed = false, firstSeen, now, hasResultSection = false }) {
  const off = { isFunnelTarget: false, stage: SRP_STAGE.HIDDEN, teaser: 'none', showResult: false, showCta: false };
  if (!isFunnelTarget(planRaw)) return off;
  if (typeof now !== 'number' || !isFinite(now)) return off;

  const first = typeof firstSeen === 'number' && isFinite(firstSeen) && firstSeen > 0 ? firstSeen : now;
  const stage = computeSanrenpukuStage(now - first);

  let teaser = 'none';
  let showResult = false;
  let showCta = false;

  if (stage === SRP_STAGE.TEASER) {
    teaser = 'day2';
  } else if (stage === SRP_STAGE.TEASER_RESULT) {
    // 結果セクションがあるページ（南関）は day3 予告＋結果。無いページ（JRA）は day2 予告のみ。
    teaser = hasResultSection ? 'day3' : 'day2';
    showResult = hasResultSection;
  } else if (stage === SRP_STAGE.CTA) {
    showResult = hasResultSection;
    showCta = !dismissed;
  }

  return { isFunnelTarget: true, stage, teaser, showResult, showCta };
}
