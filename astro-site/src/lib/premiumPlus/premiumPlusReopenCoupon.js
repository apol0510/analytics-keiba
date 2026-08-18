/**
 * premiumPlusReopenCoupon.js — 「再募集時に使える優待クーポン」の保有状態の単一源（純粋・I/O なし）
 *
 * ## これは何で、何ではないか
 *
 * 販売を一時停止している会員が、以前保存した直 URL で `/premium-plus/` へ来たときに
 * 案内する「受付休止ページ」から取得できる **クーポンの保有状態**（＝取得権）を表す。
 *
 *   - **クーポンを取得しても権利は 1 ミリも増えない**。申込・課金・Premium 昇格・
 *     メール送信・queue 登録は一切発生しない。取得日時が記録されるだけ。
 *   - **販売停止そのものは解除しない**。購入 CTA も申込経路も閉じたまま。
 *   - `PremiumPlusEligibility` / `PremiumPlusReleaseOverride` / `PremiumPlusEligibleAt` /
 *     `PremiumPlusSalePaused` を**書かない**（資格・停止・anchor は別の軸のまま）。
 *
 * ## 割引条件は「未確定」である（創作しない）
 *
 * 既存の割引カタログ `src/lib/promotions/promotionOfferCatalog.js` には
 * **Premium Plus 向けの offer が 1 件も無い**（Light / Premium の grant と purchase offer だけ）。
 * したがって割引額・割引率・特別価格・有効期限は**この時点では決まっていない**。
 *
 * ここで勝手に金額を決めると、
 *   - 顧客に提示した条件と、再募集時に実際に出す条件がズレる
 *   - `promotionOfferCatalog.js`（価格の正本）を経由しない価格が生まれる
 * ため、**条件は `terms.determined = false` として明示的に未確定のまま持つ**。
 *
 * 再募集時の想定手順（正本）:
 *   1. `promotionOfferCatalog.js` に Premium Plus 用の `purchase_offer` を追加する
 *      （金額・割引率・TTL はそこが正本。`/pricing/` との突き合わせ guard も効く）
 *   2. 取得済み会員（下記 `readReopenCoupon().claimed === true`）を抽出する
 *   3. 既存の offer 発行経路（`promotionalOffer.js` / `PromotionalOffers`）で
 *      その会員へ offer を発行する
 *   このモジュールは 2 の**抽出条件**までを担当し、3 の発行は行わない。
 *
 * ## なぜ `PromotionalOffers` に 1 行積まないのか
 *
 * あの台帳は「**価格が入った購入条件**」の台帳で、`offerFilterModel.js` /
 * `customerTimeline.js` / `recommendedActions.js` が `Status` / `ExpiresAt` /
 * `OfferPrice` を読んで顧客の状態を分類している。価格も期限も無い行を混ぜると、
 * 割引オファーを 1 度も受け取っていない顧客が管理画面で
 * 「期限切れのオファーのみ」と表示される（＝**嘘の分類**が生まれる）。
 * 条件が確定して実際の offer を発行する段になったら、そのときは台帳へ積む（上記手順 3）。
 */

/** クーポン定義（1 種類のみ。増やすときはここに足す） */
export const PP_REOPEN_COUPON = Object.freeze({
  couponId: 'premium-plus-reopen-priority',
  version: 1,
  /** 顧客に見せる名前 */
  name: 'Premium Plus 再募集 優待クーポン',
  /** 顧客に見せる説明（事実だけ。「好評につき」等の裏付けの無い表現は入れない） */
  description: '募集を再開した際に、ご利用いただける優待クーポンです。',
  /**
   * 割引条件。**未確定**（`promotionOfferCatalog.js` に Premium Plus の offer が無いため）。
   * ⚠️ ここに金額・割引率・期限を書かないこと。決めるのは再募集時にカタログ側。
   */
  terms: Object.freeze({
    determined: false,
    discountType: null,
    discountValue: null,
    offerPrice: null,
    expiresAt: null,
  }),
});

/** 顧客画面に出す「条件は未確定」の説明（断定しない・数値を出さない） */
export const PP_REOPEN_COUPON_TERMS_NOTE =
  '優待の具体的な内容は、募集再開のご案内時に改めてお知らせいたします。';

/** 「いつ使えるか」の説明（顧客画面・管理画面で同じ文言を使う） */
export const PP_REOPEN_COUPON_USABLE_NOTE = '募集再開時にご利用いただけます。';

/**
 * Airtable Customers のフィールド名（正本）。
 *
 * ⚠️ **取得済みかどうかは `CLAIMED_AT` の有無だけで決める。**
 *    チェックボックスと日時の 2 本立てにすると、片方だけ書けたときに
 *    「取得済みだが日時不明」「日時はあるが未取得」というズレが生まれる。
 */
export const PP_REOPEN_COUPON_FIELDS = Object.freeze({
  /** 取得日時（dateTime）。値があれば取得済み */
  CLAIMED_AT: 'PremiumPlusReopenCouponClaimedAt',
  /** どのクーポン定義か（single line text。`couponId@version`） */
  COUPON_ID: 'PremiumPlusReopenCouponId',
  /** 取得元 / 対象キャンペーン（single line text） */
  SOURCE: 'PremiumPlusReopenCouponSource',
});

/** このモジュールが書いてよいフィールド（これ以外は構造的に禁止） */
export const PP_REOPEN_COUPON_WRITABLE_FIELDS = Object.freeze([
  PP_REOPEN_COUPON_FIELDS.CLAIMED_AT,
  PP_REOPEN_COUPON_FIELDS.COUPON_ID,
  PP_REOPEN_COUPON_FIELDS.SOURCE,
]);

/**
 * 絶対に書いてはいけないフィールド。
 * 資格 / 停止 / 段階公開 / 会員権 / 決済 のどれも、クーポン取得では動かさない。
 */
export const PP_REOPEN_COUPON_FORBIDDEN_FIELDS = Object.freeze([
  // 資格・段階公開・停止（Plus の既存の軸）
  'PremiumPlusEligibility', 'PremiumPlusEligibilityReason', 'PremiumPlusEligibleAt',
  'PremiumPlusEligibilityUpdatedAt', 'PremiumPlusEligibilityUpdatedBy',
  'PremiumPlusReleaseOverride',
  'PremiumPlusSalePaused', 'PremiumPlusSalePausedAt', 'PremiumPlusSalePausedBy',
  'PremiumPlusSalePauseReason',
  'SanrenpukuPaidAt', '三連複購入日時', 'UpsellTarget',
  // 会員権・決済
  'プラン', 'Plan', 'PlanType', 'Status', 'AccountStatus', '有効期限', 'ValidUntil',
  'ExpirationDate', 'PaidAt', 'LifetimeSanrenpuku', '三連複Lifetime',
  'PaymentEmailSent', 'PaymentEmailStatus', 'PaymentConfirmed',
  'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason',
  'RequestedPlan', 'RequestedPlanType', 'RequestedAmount',
  'SessionVersion',
]);

/** 取得元として認める値（クライアントが送った任意文字列は保存しない） */
export const PP_REOPEN_COUPON_SOURCE = Object.freeze({
  /** 受付休止ページ（`/premium-plus/` / `/premium-plus-v2/` の直 URL） */
  PAUSE_NOTICE: 'pause-notice',
  /** クーポンページ */
  COUPON_PAGE: 'coupon-page',
});

const SOURCES = new Set(Object.values(PP_REOPEN_COUPON_SOURCE));
const WRITABLE = new Set(PP_REOPEN_COUPON_WRITABLE_FIELDS);

/** 取得元の正規化。allow-list 外は `pause-notice`（既定）へ倒す。 */
export function normalizeCouponSource(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return SOURCES.has(v) ? v : PP_REOPEN_COUPON_SOURCE.PAUSE_NOTICE;
}

/** `couponId@version` 形式の保存値 */
export function couponIdWithVersion(def = PP_REOPEN_COUPON) {
  return `${def.couponId}@v${def.version}`;
}

/**
 * クーポンフィールドへの**書き込み**が有効か。
 *
 * 停止フラグ（`isSalePauseEnabled`）と同じ理由で gate を分ける。これらは後から追加する
 * フィールドで、未作成の本番へ PATCH すると Airtable が 422 を返し、同じ PATCH の
 * 他の更新まで巻き添えで落ちる。
 *
 * ⚠️ gate が off の間は取得を**受け付けない**（fail closed）。
 *    保存できないのに画面だけ「取得済み」にすると、再募集時に抽出できない相手が生まれ、
 *    「取得したのに案内が来ない」という最悪の裏切りになる。
 *    読み取り（未設定 = 未取得）に gate は不要。
 */
export function isReopenCouponEnabled(env) {
  return !!env
    && env.PREMIUM_PLUS_FIELDS_READY === '1'
    && env.PREMIUM_PLUS_REOPEN_COUPON_READY === '1';
}

function parseMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Customers の fields からクーポン保有状態を読む（未設定・フィールド未作成でも安全に未取得）。
 *
 * @param {object|null} fields
 * @returns {{ claimed: boolean, claimedAtMs: number|null, claimedAtIso: string,
 *             couponId: string, source: string }}
 */
export function readReopenCoupon(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const claimedAtMs = parseMs(f[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]);
  return {
    claimed: claimedAtMs !== null,
    claimedAtMs,
    claimedAtIso: claimedAtMs === null ? '' : new Date(claimedAtMs).toISOString(),
    couponId: String(f[PP_REOPEN_COUPON_FIELDS.COUPON_ID] ?? '').trim(),
    source: String(f[PP_REOPEN_COUPON_FIELDS.SOURCE] ?? '').trim(),
  };
}

/** fields がクーポン専用フィールドだけか（PATCH 直前の最終防衛） */
export function assertOnlyCouponFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  return keys.every((k) => WRITABLE.has(k));
}

/** 取得を断る理由（呼び出し側が握りつぶさずそのまま返す） */
export const COUPON_CLAIM_REJECT = Object.freeze({
  /** 取得条件を満たさない（停止中の対象会員ではない）→ 存在秘匿のため 404 */
  NOT_ELIGIBLE: 'not_eligible',
  /** 保存先が本番でまだ有効化されていない → 503（取得したことにしない） */
  STORAGE_UNAVAILABLE: 'coupon_storage_unavailable',
});

/**
 * 取得してよいかを決める（**サーバー側の唯一の判定**）。
 *
 * URL 直打ち・API 直接呼び出しでも必ずここを通す。画面が CTA を出していたかどうかは
 * 判定材料にしない（クライアントの状態は根拠にならない）。
 *
 * @param {{ pauseNotice?: object|null, coupon?: object|null, enabled?: boolean }} input
 * @returns {{ ok: true, alreadyClaimed: boolean } | { ok: false, reason: string }}
 */
export function resolveCouponClaimDecision({ pauseNotice, coupon, enabled } = {}) {
  const notice = pauseNotice || {};
  const held = coupon || { claimed: false };

  // 停止中の対象会員以外には、存在も知らせない
  if (notice.showPauseNotice !== true) {
    return { ok: false, reason: COUPON_CLAIM_REJECT.NOT_ELIGIBLE };
  }
  // 既に持っているなら**何も書かない**で成功を返す（冪等・二重取得なし）
  if (held.claimed === true) return { ok: true, alreadyClaimed: true };

  if (enabled !== true) {
    return { ok: false, reason: COUPON_CLAIM_REJECT.STORAGE_UNAVAILABLE };
  }
  return { ok: true, alreadyClaimed: false };
}

/**
 * 取得を記録する fields を組み立てる。
 *
 * 冪等: 既に取得済みなら `changed:false` / `fields:{}` を返し、**PATCH させない**
 * （取得日時が上書きされて「いつ取得したか」が失われるのを防ぐ）。
 *
 * @param {{ current?: object|null, now: Date|number, source?: unknown, enabled?: boolean }} input
 * @returns {{ fields: object, changed: boolean, claimedAtIso: string }|null}
 *   書けない（enabled=false / now 不正）なら null（呼び出し側は 503。fail closed）
 */
export function buildReopenCouponClaimFields({ current, now, source, enabled = false } = {}) {
  if (enabled !== true) return null;
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return null;

  const held = readReopenCoupon(current);
  if (held.claimed) {
    return { fields: {}, changed: false, claimedAtIso: held.claimedAtIso };
  }

  const iso = new Date(ms).toISOString();
  const out = {
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: iso,
    [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: couponIdWithVersion(),
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: normalizeCouponSource(source),
  };
  if (!assertOnlyCouponFields(out)) return null;
  // 資格・停止・会員権・決済を巻き添えで書いていないことを構造的に確認する
  for (const k of PP_REOPEN_COUPON_FORBIDDEN_FIELDS) {
    if (k in out) return null;
  }
  return { fields: out, changed: true, claimedAtIso: iso };
}

/**
 * 顧客画面に出す表示モデル（クーポンページ・受付休止ページで共用）。
 * **他会員の情報は入らない**（渡された 1 人分の fields からしか作らない）。
 *
 * @param {{ coupon: object, paused: boolean, claimable: boolean, storageReady?: boolean }} input
 */
export function describeCouponForMember({ coupon, paused, claimable, storageReady = true } = {}) {
  const held = coupon || { claimed: false, claimedAtIso: '' };
  return {
    name: PP_REOPEN_COUPON.name,
    description: PP_REOPEN_COUPON.description,
    claimed: held.claimed === true,
    claimedAtIso: held.claimedAtIso || '',
    /** 募集再開時に利用できる旨（取得済みのときだけ意味を持つ） */
    usableNote: PP_REOPEN_COUPON_USABLE_NOTE,
    /** 条件が未確定であることを隠さない */
    termsDetermined: PP_REOPEN_COUPON.terms.determined === true,
    termsNote: PP_REOPEN_COUPON_TERMS_NOTE,
    /** 現在受付休止中か */
    paused: paused === true,
    /** 取得 CTA を出してよいか（取得済みなら常に false ＝ 二重取得させない） */
    showClaimCta: claimable === true && held.claimed !== true,
    /** 保存先が有効化されていない（押しても取得できない）ことを隠さない */
    storageReady: storageReady !== false,
  };
}

/**
 * 再募集時に「クーポン取得済み会員だけ」を抽出する述語（純粋）。
 * 抽出そのもの（Airtable の走査）は呼び出し側の責務。ここは 1 レコードの判定だけ。
 */
export function hasClaimedReopenCoupon(fields) {
  return readReopenCoupon(fields).claimed === true;
}
