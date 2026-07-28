/**
 * premiumPlusRelease.js — Premium Plus「段階公開」の単一源（純粋関数・I/O なし）
 *
 * Premium Sanrenpuku を購入した会員に対し、いきなり ¥68,000 の Premium Plus 購入 CTA を
 * 見せるのではなく、時間差で「告知 → 商品閲覧 → 受付解禁」と開いていくための判定を
 * ここ 1 箇所へ集約する。ページ側に日数条件・時刻条件を散在させないこと。
 *
 * ── phase を決める入力（これ以外を見てはいけない）────────────────────────
 *   1. Premium Sanrenpuku 権限があるか（正本 = ak_session の plan / pageAccess.verifyPlanAccess）
 *   2. Premium Sanrenpuku の購入確定日時
 *   3. 現在日時（JST）
 *   4. 受付時刻（PHASE 4 到達後の OPEN / CLOSING / CLOSED）
 *
 *   ⚠️ 的中 / 不的中の実績データ（premiumPlusResults.json）は **入力にしない**。
 *      「当たった日は売る / 外した日は売らない」に見える連動を構造的に禁止する。
 *      このモジュールが実績台帳を import していないことを guard テストで固定している。
 *
 * ── fail closed ───────────────────────────────────────────────────────
 *   権限なし / 購入確定日時が不明・不正・未来 → すべて PHASE 1（何も出さない）。
 *   「判定できないときは公開しない」側に倒す。
 *
 * ⚠️ 購入確定日時の正本について（2026-07-28 時点・未解決）
 *   Airtable Customers には **三連複購入の日時フィールドが存在しない**。
 *   入金確認時の `buildConfirmationFields()`（payments/bankPaymentFlow.js）は三連複分岐で
 *   `LifetimeSanrenpuku: true` を書くだけで `PaidAt` を書かない（`PaidAt` は Light/Premium
 *   会員ランク購入時のみ）。そのため既存データから「三連複をいつ買ったか」は導出できない。
 *   - `PaidAt` で代用してはいけない。既存 Premium 会員が後から三連複を買った場合、
 *     馬単購入日が基準になり **購入直後に PHASE 4** へ飛ぶ（本機能の目的と正反対）。
 *   詳細と解禁手順は docs/PREMIUM_PLUS_STAGED_RELEASE.md を参照。
 */

/** 段階（数値が大きいほど公開が進む） */
export const PP_PHASE = Object.freeze({
  /** PHASE 1: 購入当日〜。Premium Plus は一切出さない（商品ページも 404） */
  LOCKED: 1,
  /** PHASE 2: 三連複会員向け画面に短い予告のみ（金額なし・購入ボタンなし・強制誘導なし） */
  TEASER: 2,
  /** PHASE 3: 商品ページ閲覧可（説明 / 実績 / 過去結果 / 本日の1鞍 UI）。購入 CTA は未解禁 */
  PREVIEW: 3,
  /** PHASE 4: 購入受付解禁（¥98,000 → ¥68,000 / 銀行振込 CTA） */
  SALE: 4,
});

/**
 * 各 phase へ入る「購入確定日からの JST 暦日数」。購入当日 = 0 日目。
 * PHASE 1 は 0〜2 日目（購入当日〜翌日を確実に含める）。
 * 日数はここだけで変更する（ページ・コンポーネントに数値を書かない）。
 */
export const PP_PHASE_START_DAY = Object.freeze({
  TEASER: 3,
  PREVIEW: 6,
  SALE: 10,
});

/** 本日の受付ステータス（PHASE 4 到達後のみ意味を持つ） */
export const PP_INTAKE = Object.freeze({
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
});

/** 開催サーキット（曜日から導出。平日 = 南関 / 土日 = 中央） */
export const PP_CIRCUIT = Object.freeze({
  CHUO: 'chuo',
  NANKAN: 'nankan',
});

/**
 * 受付時刻の境界（JST・0:00 からの分）。
 *
 * ⚠️ 未決定（暫定値）: AK 内に Premium Plus の正式な締切時刻仕様は存在しない
 *    （grep で確認済み。docs / コードのどこにも受付締切の定義が無い）。
 *    推測で本番確定させないため、ここに定数として置いたうえで
 *    docs/PREMIUM_PLUS_STAGED_RELEASE.md に「未決定」として記録している。
 *    運用で確定したら **この定数と docs を同時に更新**すること。
 *
 * 中央（土日）は昼開催、南関（平日）は夜開催で締切が大きく違うためサーキット別に持つ。
 */
export const PP_INTAKE_WINDOW = Object.freeze({
  chuo: Object.freeze({ closingFromMin: 13 * 60, closedFromMin: 15 * 60 }),
  nankan: Object.freeze({ closingFromMin: 18 * 60, closedFromMin: 20 * 60 }),
});

/**
 * 画面に出す文言（**指定文章をそのまま保持する**）。
 * 文言はここが正本。ページ側にベタ書きしないこと。
 */
export const PP_RELEASE_COPY = Object.freeze({
  teaser: Object.freeze({
    title: '新しい予想を準備しています',
    body: '全レースを広く狙うのではなく、その日の全開催から『1鞍だけ』を選ぶ、新しい予想を準備しています。',
  }),
  preparing: Object.freeze({
    title: 'Premium Plus の受付準備中です',
    body: '受付開始時に、このページからお申し込みいただけます。',
  }),
  intake: Object.freeze({
    open: Object.freeze({
      title: '本日のPremium Plus受付',
      status: '現在受付中',
      note: '受付状況は時間帯・申込状況により変動します。',
    }),
    closing: Object.freeze({
      title: '本日のPremium Plus受付',
      status: '受付終了が近づいています',
      note: '',
    }),
    closed: Object.freeze({
      title: '本日分の受付は終了しました',
      status: '本日分の受付は終了しました',
      note: '次回受付時に、このページからお申し込みいただけます。',
    }),
  }),
});

/** Airtable Customers の「三連複購入確定日時」フィールド名候補（存在すれば読む・書かない） */
export const SANRENPUKU_PAID_AT_FIELDS = Object.freeze(['SanrenpukuPaidAt', '三連複購入日時']);

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** ms epoch → JST の暦日・時刻要素。 */
export function jstParts(ms) {
  if (!isFiniteNumber(ms)) return null;
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dayOfWeek: d.getUTCDay(), // 0=日 … 6=土
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** ms epoch → JST 暦日の通し番号（UTC 基準の切り捨てではなく JST 日付で数える）。 */
function jstDayNumber(ms) {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

/** JST 暦日の差（to の暦日 − from の暦日）。同じ日なら 0、翌日なら 1。 */
export function jstDayDiff(fromMs, toMs) {
  if (!isFiniteNumber(fromMs) || !isFiniteNumber(toMs)) return null;
  return jstDayNumber(toMs) - jstDayNumber(fromMs);
}

/** JST の曜日からサーキットを導出（土日 = 中央 / 平日 = 南関）。 */
export function circuitForJst(nowMs) {
  const p = jstParts(nowMs);
  if (!p) return PP_CIRCUIT.NANKAN; // 判定不能は平日扱い（締切が遅い側に倒さない＝下の closed 判定で安全側）
  return p.dayOfWeek === 0 || p.dayOfWeek === 6 ? PP_CIRCUIT.CHUO : PP_CIRCUIT.NANKAN;
}

/**
 * 日時文字列 / Date / ms を ms epoch へ。解釈できなければ null（fail closed）。
 * 'YYYY-MM-DD'（Airtable の日付のみフィールド）は **JST の 0:00** として解釈する
 * （UTC 解釈だと JST 深夜 0〜9 時に 1 日ズレる）。
 */
export function toPaidAtMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const t = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isFinite(t) ? t - JST_OFFSET_MS : null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * 三連複購入確定日時を解決する（純粋・読み取りのみ）。
 *
 * 優先順:
 *   1. Airtable Customers の会員別フィールド（SANRENPUKU_PAID_AT_FIELDS）
 *   2. 全体アンカー（env PREMIUM_PLUS_FUNNEL_ANCHOR 相当の値）— 会員別の正本が用意される
 *      までの暫定運用。設定されていなければ null（＝ PHASE 1 で fail closed）。
 *
 * @param {{ fields?: object|null, fallbackAnchor?: unknown }} input
 * @returns {{ paidAtMs: number|null, source: 'field'|'anchor'|'none' }}
 */
export function resolveSanrenpukuPaidAt(input) {
  const { fields, fallbackAnchor } = input || {};
  if (fields && typeof fields === 'object') {
    for (const key of SANRENPUKU_PAID_AT_FIELDS) {
      const ms = toPaidAtMs(fields[key]);
      if (ms !== null) return { paidAtMs: ms, source: 'field' };
    }
  }
  const anchorMs = toPaidAtMs(fallbackAnchor);
  if (anchorMs !== null) return { paidAtMs: anchorMs, source: 'anchor' };
  return { paidAtMs: null, source: 'none' };
}

/**
 * 購入確定日時と現在時刻から phase を決める。
 * 不明 / 不正 / 未来日 → PHASE 1（fail closed）。
 *
 * @param {{ paidAtMs: number|null, nowMs: number }} input
 * @returns {number} PP_PHASE の値
 */
export function computePhase({ paidAtMs, nowMs }) {
  if (!isFiniteNumber(paidAtMs) || !isFiniteNumber(nowMs)) return PP_PHASE.LOCKED;
  const days = jstDayDiff(paidAtMs, nowMs);
  if (days === null || days < 0) return PP_PHASE.LOCKED; // 未来日 = データ不正
  if (days >= PP_PHASE_START_DAY.SALE) return PP_PHASE.SALE;
  if (days >= PP_PHASE_START_DAY.PREVIEW) return PP_PHASE.PREVIEW;
  if (days >= PP_PHASE_START_DAY.TEASER) return PP_PHASE.TEASER;
  return PP_PHASE.LOCKED;
}

/**
 * 本日の受付ステータスを JST 時刻から決める。
 * 時刻が不正なら CLOSED（fail closed = 売らない側）。
 *
 * @param {{ nowMs: number, circuit?: string }} input
 * @returns {string} PP_INTAKE の値
 */
export function computeIntakeStatus({ nowMs, circuit }) {
  const p = jstParts(nowMs);
  if (!p) return PP_INTAKE.CLOSED;
  const key = circuit === PP_CIRCUIT.CHUO || circuit === PP_CIRCUIT.NANKAN ? circuit : circuitForJst(nowMs);
  const win = PP_INTAKE_WINDOW[key];
  if (!win) return PP_INTAKE.CLOSED;
  if (p.minutesOfDay >= win.closedFromMin) return PP_INTAKE.CLOSED;
  if (p.minutesOfDay >= win.closingFromMin) return PP_INTAKE.CLOSING;
  return PP_INTAKE.OPEN;
}

/**
 * 段階公開の最終判定。ページ / エンドポイントはこの戻り値だけを見て描画する。
 *
 * @param {{
 *   hasSanrenpuku: boolean,
 *   paidAtMs: number|null,
 *   nowMs: number,
 *   circuit?: string,
 * }} input
 * @returns {{
 *   allowed: boolean,        三連複会員か（false なら以下すべて false / 商品ページは 404）
 *   phase: number,
 *   daysSincePurchase: number|null,
 *   showTeaser: boolean,     三連複会員向け画面に予告を出すか（PHASE 2 以降）
 *   showProductPage: boolean 商品ページを描画してよいか（PHASE 3 以降。false = 404）
 *   showPurchaseCta: boolean 価格・購入 CTA を出すか（PHASE 4 のみ）
 *   purchaseEnabled: boolean 実際に申込操作を許可するか（PHASE 4 かつ CLOSED でない）
 *   intake: string|null      PHASE 4 のときのみ 'open'|'closing'|'closed'
 *   circuit: string
 * }}
 */
export function resolvePremiumPlusRelease({ hasSanrenpuku, paidAtMs, nowMs, circuit }) {
  const resolvedCircuit = circuit === PP_CIRCUIT.CHUO || circuit === PP_CIRCUIT.NANKAN
    ? circuit
    : circuitForJst(nowMs);

  const denied = {
    allowed: false,
    phase: PP_PHASE.LOCKED,
    daysSincePurchase: null,
    showTeaser: false,
    showProductPage: false,
    showPurchaseCta: false,
    purchaseEnabled: false,
    intake: null,
    circuit: resolvedCircuit,
  };

  if (hasSanrenpuku !== true) return denied;
  if (!isFiniteNumber(nowMs)) return denied;

  const phase = computePhase({ paidAtMs, nowMs });
  const isSale = phase === PP_PHASE.SALE;
  const intake = isSale ? computeIntakeStatus({ nowMs, circuit: resolvedCircuit }) : null;

  return {
    allowed: true,
    phase,
    daysSincePurchase: isFiniteNumber(paidAtMs) ? jstDayDiff(paidAtMs, nowMs) : null,
    showTeaser: phase >= PP_PHASE.TEASER,
    showProductPage: phase >= PP_PHASE.PREVIEW,
    showPurchaseCta: isSale,
    purchaseEnabled: isSale && intake !== PP_INTAKE.CLOSED,
    intake,
    circuit: resolvedCircuit,
  };
}

/**
 * 受付ステータスの表示文言を返す（PHASE 4 以外は null）。
 * @param {string|null} intake
 */
export function intakeCopy(intake) {
  if (intake === PP_INTAKE.OPEN) return PP_RELEASE_COPY.intake.open;
  if (intake === PP_INTAKE.CLOSING) return PP_RELEASE_COPY.intake.closing;
  if (intake === PP_INTAKE.CLOSED) return PP_RELEASE_COPY.intake.closed;
  return null;
}
