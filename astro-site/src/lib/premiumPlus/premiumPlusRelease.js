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

/**
 * Premium Plus 販売資格（Premium Sanrenpuku 権限とは**独立**した Plus 専用の資格）。
 * 正本は管理者の手動判断。システムが自動で eligible / blocked にしてはいけない。
 */
export const PP_ELIGIBILITY = Object.freeze({
  /** 販売可 = 後続の段階公開・受付判定へ進める */
  ELIGIBLE: 'eligible',
  /** 保留 = 管理者確認待ち。購入 CTA を出さない（新規候補の初期値） */
  REVIEW: 'review',
  /** 販売対象外 = 何日経過しても購入 CTA を出さない */
  BLOCKED: 'blocked',
});

/** 管理画面の表示名（「ブラックリスト」という語は使わない）。顧客画面には出さない。 */
export const PP_ELIGIBILITY_LABEL = Object.freeze({
  eligible: '販売可',
  review: '保留',
  blocked: '販売対象外',
});

/** Plus 販売候補のルート */
export const PP_ROUTE = Object.freeze({
  /** ROUTE A: Premium Sanrenpuku 購入者 */
  SANRENPUKU: 'sanrenpuku',
  /** ROUTE B: 通常 Premium 会員で、加入から一定期間 Sanrenpuku 未購入 */
  PREMIUM_30D: 'premium_30d',
  /**
   * ROUTE C: 管理者が販売導線として **Plus を明示指定**した有効 Premium 会員。
   * ROUTE B の「加入 30 日以上」を満たさない（PaidAt が空な旧会員を含む）相手でも、
   * 管理者が個別に選んだときだけ販売対象にする。
   * ⚠️ 資格（PremiumPlusEligibility）と phase の判定は ROUTE B と同一。ここが飛ばすのは
   *    「加入からの経過日数」条件だけで、blocked / review は従来どおり打ち切られる。
   */
  PREMIUM_ADMIN: 'premium_admin',
  /** 対象外 */
  NONE: 'none',
});

/** ROUTE B の経過日数しきい値（JST 暦日）。定数だけで調整できるようにする。 */
export const PREMIUM_30D_DAYS = 30;

/**
 * 段階公開 phase の anchor をどう決めるか。
 *   （販売許可日 = PremiumPlusEligibleAt。監査用 UpdatedAt ではない。UpdatedAt を anchor に
 *     使うと、内部メモの編集や同じ資格の再保存で phase が Day 0 へ戻る）
 *
 *   'later'    … 購入日と販売許可日の**遅い方**（既定・推奨）
 *                 通常フロー（購入とほぼ同時に eligible）では購入日基準と同じ挙動になり、
 *                 blocked → eligible の遅い解除では「解除日から PHASE 1」で段階的に見せられる。
 *                 SanrenpukuPaidAt が無い既存会員も、管理者が eligible にした日を anchor にできる。
 *   'purchase' … 購入確定日時のみ（案A）
 *   'eligible' … 販売許可日のみ（案B）
 */
export const PP_PHASE_ANCHOR_MODE = 'later';

/**
 * Airtable Customers の Premium Plus 販売資格フィールド名（読む・管理画面だけが書く）
 *
 * ⚠️ ELIGIBLE_AT と UPDATED_AT は**責務が違う**。兼用してはいけない。
 *   - ELIGIBLE_AT … 段階公開 anchor。「eligible へ**実際に遷移した**日時」だけを持つ。
 *                   内部メモだけの編集 / eligible → eligible の再保存 / blocked・review への
 *                   変更では**更新しない**（更新すると phase が Day 0 へ戻ってしまう）。
 *   - UPDATED_AT  … 純粋な監査日時。どの操作でも更新してよい（phase には一切使わない）。
 */
export const PP_ELIGIBILITY_FIELDS = Object.freeze({
  STATUS: 'PremiumPlusEligibility',
  REASON: 'PremiumPlusEligibilityReason',
  /** 段階公開 anchor 用。eligible への実遷移時のみ更新する */
  ELIGIBLE_AT: 'PremiumPlusEligibleAt',
  /** 段階公開を飛ばして即 PHASE 4 にする明示 override（空 or 'phase4'） */
  OVERRIDE: 'PremiumPlusReleaseOverride',
  /** 監査専用。phase 判定に使わない */
  UPDATED_AT: 'PremiumPlusEligibilityUpdatedAt',
  UPDATED_BY: 'PremiumPlusEligibilityUpdatedBy',
});

/**
 * 段階公開 override（「今すぐ販売可」）。
 *
 * ⚠️ override は **eligibility の代替ではない**。販売可否の正本はあくまで
 *    PremiumPlusEligibility で、override は「eligible の人の phase 進行を飛ばす」だけ。
 *    review / blocked の会員が override だけで販売可能になってはいけない。
 *
 * ⚠️ 日時の偽装で実現しない。`PremiumPlusEligibleAt` / `SanrenpukuPaidAt` を過去日に
 *    書き換える方式は監査不能になるため禁止。専用の明示フラグで表現する。
 */
export const PP_RELEASE_OVERRIDE = Object.freeze({
  NONE: '',
  /** 即 PHASE 4（価格・購入 CTA 解禁。受付時間帯の OPEN/CLOSING/CLOSED は通常どおり適用） */
  PHASE4: 'phase4',
});

/**
 * 本日の受付ステータス（PHASE 4 到達後のみ意味を持つ）。
 *
 * ⚠️ `limited`（残りわずか）は **時刻だけ**で決まる。販売件数・在庫・上限とは
 *    一切連動させないこと（件数カウンタ・販売上限機能を追加してはいけない）。
 */
export const PP_INTAKE = Object.freeze({
  /** 00:00〜12:29 JST */
  OPEN: 'open',
  /** 12:30〜14:59 JST */
  LIMITED: 'limited',
  /** 15:00〜16:29 JST */
  CLOSING: 'closing',
  /**
   * 16:30〜23:59 JST。**翌日分の受付中**（購入可）。
   *
   * ⚠️ 2026-08-13 以前は「本日分の受付は終了しました」で**購入不可**だった。
   *    商品は毎日あるのに締切後の購入意欲を捨てていたため、対象日を翌日へ
   *    切り替えて売る形にした。買えない時間帯は無い。
   *    **値 `closed` は互換のため変えない**（保存済みデータ・既存判定を壊さない）。
   *    対象日そのものは `premiumPlusSaleDate.js` が決める。
   */
  CLOSED: 'closed',
});

/** 開催サーキット（曜日から導出。平日 = 南関 / 土日 = 中央） */
export const PP_CIRCUIT = Object.freeze({
  CHUO: 'chuo',
  NANKAN: 'nankan',
});

/**
 * 受付時刻の境界（JST・0:00 からの分）。**毎日共通**（2026-07-30 確定仕様）。
 *
 *   00:00〜12:29 → open    「本日分 受付中」            購入可
 *   12:30〜14:59 → limited 「本日分 残りわずか」        購入可
 *   15:00〜16:29 → closing 「本日分 まもなく受付終了」  購入可
 *   16:30〜23:59 → closed  「翌日分 受付中」            購入可（**対象日が翌日**）
 *
 * ⚠️ 開催区分（中央 / 南関 / 昼開催 / ナイター）による分岐は**廃止**した。
 *    Premium Plus は曜日・会場に関わらずこの JST 共通時間だけを使う。
 * ⚠️ `limited` は時刻のみで決まる。件数・在庫・販売上限と連動させない。
 */
export const PP_INTAKE_SCHEDULE = Object.freeze({
  limitedFromMin: 12 * 60 + 30, // 12:30
  closingFromMin: 15 * 60,      // 15:00
  closedFromMin: 16 * 60 + 30,  // 16:30
});

/**
 * 画面に出す文言（**指定文章をそのまま保持する**）。
 * 文言はここが正本。ページ側にベタ書きしないこと。
 */
export const PP_RELEASE_COPY = Object.freeze({
  // ── 予告枠（PremiumPlusStageTeaser）─────────────────────────────
  // 待機中（PHASE 2 / PHASE 3）と開通後（PHASE 4）で文言を分ける。
  // PHASE 4 に「準備しています」が出ると、閲覧・購入できる会員に「まだ買えない」と
  // 伝わってしまう（2026-08-07 事故）。逆に PHASE 4 でも予告枠は予告枠のままとし、
  // 「お申し込み受付中」「今すぐ購入」等の営業的な強調は置かない（静かな導線を維持）。
  // `linkLabel` は導線リンクの文字列。コンポーネント側にベタ書きしない。

  // ROUTE A（Premium Sanrenpuku 利用者向け）。既存コンセプトとの整合を維持する。
  teaser: Object.freeze({
    title: '新しい予想を準備しています',
    body: '全レースを広く狙うのではなく、その日の全開催から『1鞍だけ』を選ぶ、新しい予想を準備しています。',
    linkLabel: '内容を見る →',
  }),
  // ROUTE B（通常 Premium 会員・Sanrenpuku 未購入向け）。三連複購入者向けの文脈を前提にしない。
  teaserPremium30d: Object.freeze({
    title: '全レース型とは異なる、もうひとつの選択肢。',
    body: '対象レースを増やすのではなく、その日の全開催から1鞍だけを選ぶ、新しい予想を準備しています。',
    linkLabel: '内容を見る →',
  }),
  // PHASE 4（閲覧・購入が開通済み）の ROUTE A。待機中の文から「準備しています」だけを外す。
  teaserOpen: Object.freeze({
    title: '新しい予想をご用意しました',
    body: '全レースを広く狙うのではなく、その日の全開催から『1鞍だけ』を選ぶ予想です。',
    linkLabel: '詳細を見る →',
  }),
  // PHASE 4 の ROUTE B。ROUTE A と同じく「準備しています」だけを外す。
  teaserPremium30dOpen: Object.freeze({
    title: '全レース型とは異なる、もうひとつの選択肢。',
    body: '対象レースを増やすのではなく、その日の全開催から1鞍だけを選ぶ予想です。',
    linkLabel: '詳細を見る →',
  }),
  preparing: Object.freeze({
    title: 'Premium Plus の受付準備中です',
    body: '受付開始時に、このページからお申し込みいただけます。',
  }),
  intake: Object.freeze({
    open: Object.freeze({
      title: '本日のPremium Plus受付',
      status: '本日分 受付中',
      note: '',
    }),
    // 「残りわずか」は時間帯のみを表す。件数・在庫を示唆する注記は置かない。
    limited: Object.freeze({
      title: '本日のPremium Plus受付',
      status: '本日分 残りわずか',
      note: '',
    }),
    closing: Object.freeze({
      title: '本日のPremium Plus受付',
      status: '本日分 まもなく受付終了',
      note: '',
    }),
    // ⚠️ 名前は closed のままだが、**意味は「翌日分の受付中」**
    closed: Object.freeze({
      title: '翌日分のPremium Plus受付',
      status: '翌日分 受付中',
      note: '本日分の受付は終了しました。いまお申し込みいただくと翌日分をお届けします。',
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

/**
 * JST の曜日からサーキットを導出（土日 = 中央 / 平日 = 南関）。
 * ⚠️ 2026-07-30 以降、**受付時間帯の判定には使わない**（PHASE 4 の受付は JST 共通時間）。
 *    戻り値の circuit は参考情報としてのみ保持する。
 */
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
 * 本日の受付ステータスを JST 時刻だけから決める（毎日共通・開催区分に依存しない）。
 * 時刻が不正なら CLOSED（fail closed = 売らない側）。
 *
 * @param {{ nowMs: number }} input
 * @returns {string} PP_INTAKE の値
 */
export function computeIntakeStatus({ nowMs }) {
  const p = jstParts(nowMs);
  if (!p) return PP_INTAKE.CLOSED;
  const m = p.minutesOfDay;
  if (m >= PP_INTAKE_SCHEDULE.closedFromMin) return PP_INTAKE.CLOSED;
  if (m >= PP_INTAKE_SCHEDULE.closingFromMin) return PP_INTAKE.CLOSING;
  if (m >= PP_INTAKE_SCHEDULE.limitedFromMin) return PP_INTAKE.LIMITED;
  return PP_INTAKE.OPEN;
}


/**
 * Premium Plus 販売資格を正規化する。
 * 未設定 / 不正値 / 読取失敗は **review**（＝販売不可）へ倒す（fail closed）。
 * blocked へ自動で倒さないのは、blocked が「管理者が明示的に付けた印」だから。
 *
 * @param {unknown} raw
 * @returns {'eligible'|'review'|'blocked'}
 */
/**
 * 段階公開 override を正規化する。
 * 既知の値（'phase4'）以外・未設定・不正値はすべて **null（override なし）**（fail closed）。
 *
 * @param {unknown} raw
 * @returns {'phase4'|null}
 */
export function normalizeReleaseOverride(raw) {
  const v = (raw == null ? '' : String(raw)).trim().toLowerCase();
  return v === PP_RELEASE_OVERRIDE.PHASE4 ? PP_RELEASE_OVERRIDE.PHASE4 : null;
}

export function normalizeEligibility(raw) {
  const v = (raw == null ? '' : String(raw)).trim().toLowerCase();
  if (v === PP_ELIGIBILITY.ELIGIBLE) return PP_ELIGIBILITY.ELIGIBLE;
  if (v === PP_ELIGIBILITY.BLOCKED) return PP_ELIGIBILITY.BLOCKED;
  return PP_ELIGIBILITY.REVIEW;
}

/**
 * Plus 販売候補の route を決める（STEP 2）。
 *
 * 二重ルートは作らない: Sanrenpuku 購入済みなら常に ROUTE A。
 * ROUTE B は「有効な通常 Premium 会員 かつ Sanrenpuku 未購入 かつ 加入から 30 日以上」。
 *
 * @param {{ hasSanrenpuku:boolean, premiumActive:boolean, premiumPaidAtMs:number|null, nowMs:number }} input
 * @returns {{ route:string, daysSincePremium:number|null }}
 */
export function resolvePlusRoute({ hasSanrenpuku, premiumActive, premiumPaidAtMs, nowMs, adminPlusTarget }) {
  if (hasSanrenpuku === true) return { route: PP_ROUTE.SANRENPUKU, daysSincePremium: null };

  const days = isFiniteNumber(premiumPaidAtMs) ? jstDayDiff(premiumPaidAtMs, nowMs) : null;
  // ROUTE C: 管理者が Plus を明示指定した有効 Premium 会員。
  // 「PaidAt が無い / 30 日未満」だけを理由に塞がない（PaidAt は 2026-07-10 の
  // 入金確認フロー刷新以降しか書かれておらず、旧会員は構造的に空のため）。
  if (premiumActive === true && adminPlusTarget === true) {
    return { route: PP_ROUTE.PREMIUM_ADMIN, daysSincePremium: days };
  }
  if (premiumActive === true && days !== null && days >= PREMIUM_30D_DAYS) {
    return { route: PP_ROUTE.PREMIUM_30D, daysSincePremium: days };
  }
  return { route: PP_ROUTE.NONE, daysSincePremium: days };
}

/**
 * route と販売許可日から段階公開 anchor を決める（STEP 4）。
 * 既定 'later' は「購入日と販売許可日の遅い方」。詳細は PP_PHASE_ANCHOR_MODE を参照。
 *
 * @param {{ route:string, sanrenpukuPaidAtMs?:number|null, premiumPaidAtMs?:number|null,
 *           eligibleAtMs?:number|null, mode?:string }} input
 * @returns {number|null} anchor（不明なら null = PHASE 1）
 */
export function resolvePhaseAnchorMs({ route, sanrenpukuPaidAtMs, premiumPaidAtMs, eligibleAtMs, mode }) {
  const m = mode || PP_PHASE_ANCHOR_MODE;
  let purchase = null;
  if (route === PP_ROUTE.SANRENPUKU) purchase = isFiniteNumber(sanrenpukuPaidAtMs) ? sanrenpukuPaidAtMs : null;
  else if (route === PP_ROUTE.PREMIUM_30D || route === PP_ROUTE.PREMIUM_ADMIN) {
    purchase = isFiniteNumber(premiumPaidAtMs) ? premiumPaidAtMs : null;
  }
  const eligible = isFiniteNumber(eligibleAtMs) ? eligibleAtMs : null;

  if (m === 'purchase') return purchase;
  if (m === 'eligible') return eligible;
  // 'later': 両方あれば遅い方 / 片方だけならそれ / どちらも無ければ null
  if (purchase === null) return eligible;
  if (eligible === null) return purchase;
  return Math.max(purchase, eligible);
}

/**
 * route + phase に対応する予告文言を返す（対象外は null）。
 *
 * phase を渡さない場合は**待機中**の文言を返す（後方互換）。PHASE 4 の文言を出すには
 * 呼び出し側が release.phase を渡すこと。判定は「PHASE 4 かどうか」だけで、
 * 受付時間（intake）や購入可否では文言を変えない — 予告枠は受付状態を語らない。
 */
export function teaserCopyForRoute(route, phase) {
  const open = phase === PP_PHASE.SALE;
  if (route === PP_ROUTE.SANRENPUKU) {
    return open ? PP_RELEASE_COPY.teaserOpen : PP_RELEASE_COPY.teaser;
  }
  if (route === PP_ROUTE.PREMIUM_30D || route === PP_ROUTE.PREMIUM_ADMIN) {
    return open ? PP_RELEASE_COPY.teaserPremium30dOpen : PP_RELEASE_COPY.teaserPremium30d;
  }
  return null;
}

/**
 * 段階公開の最終判定（STEP 1〜7 の単一源）。ページ / エンドポイントはこの戻り値だけを見て描画する。
 *
 * 判定順（この優先順位を変えないこと）:
 *   1. audience 不成立（会員状態・route が none）→ 非公開
 *   2. PremiumPlusEligibility != eligible → 非公開
 *      （review / blocked は override があっても**絶対に**公開しない）
 *   3. 有効な phase4 override → PHASE 4（段階公開を飛ばす）
 *   4. それ以外 → 通常の段階公開判定（anchor からの JST 暦日）
 *   5. OPEN / CLOSING / CLOSED（PHASE 4 のときのみ。override 経由でも同じ）
 *   6. purchaseEnabled
 *
 * @param {{
 *   hasSanrenpuku: boolean,
 *   sanrenpukuPaidAtMs?: number|null,
 *   premiumActive?: boolean,
 *   premiumPaidAtMs?: number|null,
 *   eligibility?: unknown,     生値でよい（normalizeEligibility が正規化）
 *   eligibleAtMs?: number|null 販売許可日（PremiumPlusEligibilityUpdatedAt 等）
 *   nowMs: number,
 *   circuit?: string,
 *   anchorMode?: string,
 *   paidAtMs?: number|null,    後方互換: sanrenpukuPaidAtMs の旧名
 * }} input
 * @returns {{
 *   allowed: boolean,        Plus 販売候補として扱えるか（false なら以下すべて false / 商品ページは 404）
 *   route: string,
 *   eligibility: string,
 *   anchorMs: number|null,
 *   phase: number,
 *   daysSincePurchase: number|null,
 *   daysSincePremium: number|null,
 *   showTeaser: boolean,     予告を出すか（PHASE 2 以降）
 *   showProductPage: boolean 商品ページを描画してよいか（PHASE 3 以降。false = 404）
 *   showPurchaseCta: boolean 価格・購入 CTA を出すか（PHASE 4 のみ）
 *   purchaseEnabled: boolean 実際に申込操作を許可するか（PHASE 4 かつ CLOSED でない）
 *   intake: string|null      PHASE 4 のときのみ 'open'|'closing'|'closed'
 *   circuit: string   参考情報。受付時間帯の判定には使わない
 * }}
 */
export function resolvePremiumPlusRelease(input) {
  const {
    hasSanrenpuku,
    premiumActive = false,
    premiumPaidAtMs = null,
    eligibility,
    eligibleAtMs = null,
    releaseOverride,
    nowMs,
    circuit,
    anchorMode,
    /** 管理者が Plus を売ると決めているか（ROUTE C の条件。UpsellTarget=plus / 今すぐ販売可）*/
    adminPlusTarget = false,
    /**
     * 管理者が **販売導線として Plus を明示指定**しているか（`UpsellTarget=plus` のみ）。
     * これは「Plus を売る」という管理者判断そのものなので、
     *   - `PremiumPlusEligibility` が review / 未設定でも先へ進める（二重操作をなくす）
     *   - 段階公開（PHASE 1→4）を待たずに販売中として扱う
     * ⚠️ `blocked` は免除しない。Free / Light / 契約無効も免除しない（route で落ちる）。
     * ⚠️ Airtable の `PremiumPlusEligibility` を書き換えることは**しない**（判定上の扱いだけ）。
     */
    adminPlusAuthorized = false,
  } = input || {};
  // 後方互換: 旧 paidAtMs は Sanrenpuku 購入確定日時
  const sanrenpukuPaidAtMs = input && input.sanrenpukuPaidAtMs !== undefined
    ? input.sanrenpukuPaidAtMs
    : (input ? input.paidAtMs : null);

  const resolvedCircuit = circuit === PP_CIRCUIT.CHUO || circuit === PP_CIRCUIT.NANKAN
    ? circuit
    : circuitForJst(nowMs);

  const normalizedEligibility = normalizeEligibility(eligibility);
  const normalizedOverride = normalizeReleaseOverride(releaseOverride);

  const denied = (over = {}) => ({
    allowed: false,
    route: PP_ROUTE.NONE,
    eligibility: normalizedEligibility,
    releaseOverride: normalizedOverride,
    overrideApplied: false,
    anchorMs: null,
    phase: PP_PHASE.LOCKED,
    daysSincePurchase: null,
    daysSincePremium: null,
    showTeaser: false,
    showProductPage: false,
    showPurchaseCta: false,
    purchaseEnabled: false,
    intake: null,
    circuit: resolvedCircuit,
    adminSaleDirective: false,
    ...over,
  });

  if (!isFiniteNumber(nowMs)) return denied();

  // STEP 2: route
  const { route, daysSincePremium } = resolvePlusRoute({
    hasSanrenpuku: hasSanrenpuku === true,
    premiumActive: premiumActive === true,
    premiumPaidAtMs,
    nowMs,
    adminPlusTarget: adminPlusTarget === true,
  });
  if (route === PP_ROUTE.NONE) return denied({ daysSincePremium });

  // STEP 3: 販売資格。
  // ⚠️ blocked は**何があっても**ここで打ち切る（明示指定でも override でも免除しない）。
  if (normalizedEligibility === PP_ELIGIBILITY.BLOCKED) {
    return denied({ route, daysSincePremium });
  }
  // 管理者が販売導線として Plus を明示指定しているときは、review / 未設定でも先へ進める。
  // 「販売CTA=Plus を選ぶ」こと自体が管理者の販売許可であり、
  // 別途 PremiumPlusEligibility=eligible を設定させる二重操作をなくすため。
  // 明示指定が無い（auto / sanrenpuku / none）ときは従来どおり eligible 必須（fail closed）。
  const adminSaleDirective = adminPlusAuthorized === true;
  if (!adminSaleDirective && normalizedEligibility !== PP_ELIGIBILITY.ELIGIBLE) {
    return denied({ route, daysSincePremium });
  }

  // STEP 4: anchor（override 時も監査・表示のため計算しておく。日時は改変しない）
  const anchorMs = resolvePhaseAnchorMs({
    route, sanrenpukuPaidAtMs, premiumPaidAtMs, eligibleAtMs, mode: anchorMode,
  });

  // STEP 5: phase
  // eligible かつ有効な phase4 override があるときだけ段階公開を飛ばす。
  // `PremiumPlusReleaseOverride=phase4`（既存の「今すぐ販売可」）は従来どおり。
  // 管理者の明示指定（UpsellTarget=plus）も同じく段階公開を飛ばして販売中として扱う。
  // ⚠️ overrideApplied は **Airtable のフィールド由来のときだけ** true（管理一覧の「即時販売」表示を
  //    変えないため）。明示指定は adminSaleDirective として別に返す。
  const overrideApplied = normalizedOverride === PP_RELEASE_OVERRIDE.PHASE4;
  const phase = (overrideApplied || adminSaleDirective)
    ? PP_PHASE.SALE
    : computePhase({ paidAtMs: anchorMs, nowMs });

  // STEP 6: 受付ステータス
  const isSale = phase === PP_PHASE.SALE;
  const intake = isSale ? computeIntakeStatus({ nowMs }) : null;

  return {
    allowed: true,
    route,
    eligibility: normalizedEligibility,
    releaseOverride: normalizedOverride,
    overrideApplied,
    /** 管理者が販売導線として Plus を明示指定した結果、販売中として扱っているか */
    adminSaleDirective,
    anchorMs,
    phase,
    daysSincePurchase: isFiniteNumber(anchorMs) ? jstDayDiff(anchorMs, nowMs) : null,
    daysSincePremium,
    showTeaser: phase >= PP_PHASE.TEASER,
    showProductPage: phase >= PP_PHASE.PREVIEW,
    showPurchaseCta: isSale,
    // STEP 7
    // 16:30 以降も**翌日分として購入できる**（対象日が切り替わるだけ）。
    // 以前はここで CLOSED を弾いて買えなくしていた。
    purchaseEnabled: isSale,
    intake,
    circuit: resolvedCircuit,
  };
}

/**
 * 管理画面に出す「現在の状態」を日本語 1 行で返す（顧客向け画面には出さない）。
 *
 * @param {ReturnType<typeof resolvePremiumPlusRelease>} release
 * @returns {string}
 */
export function describeReleaseState(release) {
  const r = release || {};
  if (r.eligibility === PP_ELIGIBILITY.BLOCKED) return '販売対象外';
  if (r.eligibility !== PP_ELIGIBILITY.ELIGIBLE) return '保留';
  if (!r.allowed) return '対象外（Plus 候補の条件を満たしていません）';
  if (r.overrideApplied) return '即時販売';
  if (r.phase === PP_PHASE.SALE) return '販売中 PHASE 4';
  return `段階公開中 PHASE ${r.phase}`;
}

/**
 * 受付ステータスの表示文言を返す（PHASE 4 以外は null）。
 * @param {string|null} intake
 */
export function intakeCopy(intake) {
  if (intake === PP_INTAKE.OPEN) return PP_RELEASE_COPY.intake.open;
  if (intake === PP_INTAKE.LIMITED) return PP_RELEASE_COPY.intake.limited;
  if (intake === PP_INTAKE.CLOSING) return PP_RELEASE_COPY.intake.closing;
  if (intake === PP_INTAKE.CLOSED) return PP_RELEASE_COPY.intake.closed;
  return null;
}
