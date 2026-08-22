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

import { REGULAR_PRICE, DISCOUNT_TYPE } from '../promotions/promotionOfferCatalog.js';
import { encodeCouponAudit, parseCouponAudit } from '../coupons/couponPlatform.js';

/** 円表記（3 桁区切り）。表示の体裁もここ 1 か所で決める。 */
export function formatYen(n) {
  return Number.isFinite(Number(n)) ? `${Number(n).toLocaleString('ja-JP')}円` : '';
}

/**
 * ISO → JST の「YYYY年M月D日 HH:MM」。**日時表記もここ 1 か所**。
 *
 * ⚠️ サーバーの TZ に依存させない（Netlify は UTC）。UTC へ 9 時間足して
 *    `getUTC*` で読むことで、実行環境に関係なく JST になる。
 * ⚠️ 各画面で `toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })` を書き直さないこと
 *    （環境差・ロケール差で表記がズレる）。
 */
export function formatJstDateTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 割引額（円）。**この 1 か所だけが割引の実体**。
 * ⚠️ 画面・API・管理画面で数値を書き写さないこと（ズレたら guard テストが落ちる）。
 */
export const PP_REOPEN_COUPON_DISCOUNT_YEN = 10000;

/** クーポン定義（1 種類のみ。増やすときはここに足す） */
export const PP_REOPEN_COUPON = Object.freeze({
  couponId: 'premium-plus-reopen-priority',
  version: 1,
  /** 顧客に見せる名前 */
  name: 'Premium Plus 再募集 優待クーポン',
  /** 顧客に見せる説明（事実だけ。「好評につき」等の裏付けの無い表現は入れない） */
  description: '募集を再開した際に、ご利用いただける優待クーポンです。',
  /**
   * 割引条件（**2026-08-19 に MK が確定**）。
   *
   *   固定額割引 10,000円OFF ／ 通常 68,000円 → 58,000円
   *
   * 通常価格は価格の正本 `promotionOfferCatalog.js` の `REGULAR_PRICE.premium_plus` を参照し、
   * 適用価格は**引き算で導出**する（68,000 と 58,000 を別々に書かない＝ズレようがない）。
   *
   * ⚠️ `expiresAt` は**まだ未確定**。`expiresDetermined:false` のまま置く。
   *    勝手に日数を決めないこと（顧客へ出す期限は MK が決める）。
   */
  terms: Object.freeze({
    determined: true,
    discountType: DISCOUNT_TYPE.AMOUNT,
    discountValue: PP_REOPEN_COUPON_DISCOUNT_YEN,
    regularPrice: REGULAR_PRICE.premium_plus,
    offerPrice: REGULAR_PRICE.premium_plus - PP_REOPEN_COUPON_DISCOUNT_YEN,
    /**
     * 有効期限の**ルールは確定**（2026-08-19 MK）:
     *   **再募集開始日時から 14 日間**
     *
     * ⚠️ ただし **`reopenStartsAt`（再募集の開始日時）がまだ決まっていない**ので、
     *    絶対日時である `expiresAt` は**まだ計算できない**。
     *    `expiresDetermined` は「顧客へ出せる確定日時があるか」を表すフラグなので false のまま。
     *    再募集の開始日時が決まったら `reopenStartsAt` を入れるだけで、
     *    `expiresAt` は `resolveCouponExpiry()` が 14 日を足して導出する。
     * ⚠️ **仮の日付をここに書かないこと。**
     */
    expiryDays: 14,
    /** 再募集の開始日時（ISO）。**未定** */
    reopenStartsAt: null,
    expiresAt: null,
    expiresDetermined: false,
  }),
});

/**
 * 有効期限の説明。**期限だけはまだ未確定**なので、日数を書かずにそう伝える。
 * ⚠️ 「30日間有効」などと勝手に補完しないこと。
 */
export const PP_REOPEN_COUPON_EXPIRY_NOTE =
  '募集再開日から14日間ご利用いただけます（開始日は募集再開のご案内時にお知らせいたします）。';

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
  /** 三連複会員ページの導線を押したその場（販売停止中に遷移させず案内した画面） */
  SANRENPUKU_CTA: 'sanrenpuku-cta',
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
  const source = String(f[PP_REOPEN_COUPON_FIELDS.SOURCE] ?? '').trim();
  // `Source` は監査行として構造化されうる（`pause-notice|by=customer|at=…|op=…`）。
  // ⚠️ **旧データ（素の `pause-notice`）もそのまま読める**（後方互換）。
  const audit = parseCouponAudit(source);
  return {
    claimed: claimedAtMs !== null,
    claimedAtMs,
    claimedAtIso: claimedAtMs === null ? '' : new Date(claimedAtMs).toISOString(),
    couponId: String(f[PP_REOPEN_COUPON_FIELDS.COUPON_ID] ?? '').trim(),
    /** 生値（監査行そのもの）*/
    source,
    /** **論理的な取得元**（`pause-notice` / `coupon-page` / `admin-*`）。構造化前後で同じ値 */
    sourceKind: audit.kind || '',
    /** 履歴の冪等キー（部分成功の回復に使う。旧データには無いので空）*/
    operationId: audit.operationId || '',
  };
}

/** fields がクーポン専用フィールドだけか（PATCH 直前の最終防衛） */
export function assertOnlyCouponFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  return keys.every((k) => WRITABLE.has(k));
}

/**
 * 取得を断る理由。
 *
 * ⚠️ **判定の本体は `premiumPlusCouponAccess.js` へ移した**（2026-08-22）。
 *    ここは既存の呼び出し名を保つための再エクスポートだけ。
 *    「取得できるか」は `salePaused` ではなく
 *    **Plus の対象会員 ＋ その会員の再募集が開始済みで期限内**で決まる。
 */
export { COUPON_ACCESS_REJECT as COUPON_CLAIM_REJECT } from './premiumPlusCouponAccess.js';

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
export function buildReopenCouponClaimFields({
  current, now, source, enabled = false,
  /**
   * 履歴の冪等キー。**`Source` へ `op=` として残す**ので、
   * 「Customers は成功したが履歴だけ失敗した」を後から検出して積み直せる。
   * 省略しても取得自体は成立する（旧データと同じ形になる）。
   */
  operationId,
} = {}) {
  if (enabled !== true) return null;
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return null;

  const held = readReopenCoupon(current);
  if (held.claimed) {
    return { fields: {}, changed: false, claimedAtIso: held.claimedAtIso };
  }

  const iso = new Date(ms).toISOString();
  // ⚠️ 取得元は **allow-list を通した値だけ**（クライアントが `admin-grant` 等を騙れない）。
  //    監査行として構造化しても、先頭の kind は論理的な取得元のまま。
  const kind = normalizeCouponSource(source);
  const out = {
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: iso,
    [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: couponIdWithVersion(),
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: operationId
      ? encodeCouponAudit({ kind, actor: 'customer', atIso: iso, reason: '', operationId })
      : kind,
  };
  if (!assertOnlyCouponFields(out)) return null;
  // 資格・停止・会員権・決済を巻き添えで書いていないことを構造的に確認する
  for (const k of PP_REOPEN_COUPON_FORBIDDEN_FIELDS) {
    if (k in out) return null;
  }
  return { fields: out, changed: true, claimedAtIso: iso };
}

/**
 * 優待条件を 1 文で返す（**条件の表示はここだけ**）。
 *
 * 現在は `PP_REOPEN_COUPON.terms.determined === false` なので「募集再開時にご案内」を返す。
 * 条件確定後にここが具体条件を返すようにすれば、全画面へ同時に反映される。
 * ⚠️ 金額・割引率をこの関数の外で組み立てないこと。
 */
export function describeCouponTerms(def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  if (t.determined !== true) {
    // 条件が未確定に戻された場合でも金額を出さない（fail safe）
    return '優待の具体的な内容は、募集再開のご案内時に改めてお知らせいたします。';
  }
  return `${formatYen(t.discountValue)}OFF（通常 ${formatYen(t.regularPrice)} → ${formatYen(t.offerPrice)}）`;
}

/** 割引だけを短く（バッジ・見出し用）。例: 「10,000円OFF」 */
export function describeCouponDiscount(def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  return t.determined === true ? `${formatYen(t.discountValue)}OFF` : '';
}

/** 価格だけを短く。例: 「通常 68,000円 → 58,000円」 */
export function describeCouponPrice(def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  return t.determined === true
    ? `通常 ${formatYen(t.regularPrice)} → ${formatYen(t.offerPrice)}`
    : '';
}

/**
 * 有効期限を導出する（**期限の計算はここだけ**）。
 *
 * ルール: **再募集開始日時 + 14 日**。
 * `reopenStartsAt` が未定のあいだは `null` を返す（＝仮の日付を作らない）。
 */
export function resolveCouponExpiry(def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  if (t.expiresAt) return { expiresAtIso: String(t.expiresAt), determined: true };
  const startMs = Date.parse(String(t.reopenStartsAt || ''));
  const days = Number(t.expiryDays);
  if (!Number.isFinite(startMs) || !Number.isFinite(days)) {
    return { expiresAtIso: null, determined: false };
  }
  return {
    expiresAtIso: new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString(),
    determined: true,
  };
}

/**
 * 有効期限の表示。**未確定のあいだは日付を作らない**。
 *
 * 確定後（＝ admin で再募集を開始したあと）は **JST の日時**を返す。
 * ⚠️ ISO 文字列をそのまま顧客画面へ出さない（`2026-09-04T…Z` は読めない・UTC と誤読される）。
 */
export function describeCouponExpiry(def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  if (t.expiresDetermined === true && t.expiresAt) {
    const text = formatJstDateTime(t.expiresAt);
    return text ? `${text}（JST）まで` : PP_REOPEN_COUPON_EXPIRY_NOTE;
  }
  return PP_REOPEN_COUPON_EXPIRY_NOTE;
}

/**
 * 適用価格を返す（**購入価格を計算してよいのはここだけ**）。
 *
 * ⚠️ 二重割引を防ぐため、**入力価格から引き算しない**。常に正本の通常価格から
 *    1 回だけ引いた確定値を返す。既に割引済みの価格を渡しても結果は変わらない。
 */
export function resolveCouponPrice(def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  if (t.determined !== true) return null;
  return {
    regularPrice: t.regularPrice,
    offerPrice: t.offerPrice,
    discountType: t.discountType,
    discountValue: t.discountValue,
  };
}

/** 申込画面のパス（クーポンから申込へ進む先） */
export const PP_ORDER_PATH = '/premium-plus-v2/';

/**
 * 「取得後にどこへ進めるか」の CTA（**dashboard / クーポンページで共用**）。
 *
 * ⚠️ **販売停止中・再募集前は購入させない。**
 *    押せる購入 CTA を偽装せず、`href: null` の**非購入表示**を返す。
 * ⚠️ 文言・遷移先をここ以外で組み立てないこと（面ごとにズレる）。
 *
 * @param {{ claimed: boolean, purchasable: boolean, source?: string }} input
 * @returns {{ show: boolean, purchasable: boolean, label: string, href: string|null,
 *             note: string, detailLabel: string, detailHref: string }}
 */
export function describeCouponOrderCta({
  claimed, purchasable, source = 'dashboard', def = PP_REOPEN_COUPON,
} = {}) {
  const discount = describeCouponDiscount(def);
  const base = {
    show: claimed === true,
    detailLabel: 'クーポン詳細を確認',
    detailHref: '/premium-plus-coupon/',
  };
  if (claimed !== true) {
    return { ...base, show: false, purchasable: false, label: '', href: null, note: '' };
  }
  if (purchasable === true) {
    // 再募集後・購入可能: 申込であることが明確な文言にする
    return {
      ...base,
      purchasable: true,
      label: `${discount}で申し込む`,
      href: `${PP_ORDER_PATH}?from=${encodeURIComponent(source)}`,
      note: '',
    };
  }
  // 販売停止中・再募集前: **リンクにしない**（押せる購入 CTA を偽装しない）
  return {
    ...base,
    purchasable: false,
    label: `再募集時に${discount}で申し込めます`,
    href: null,
    note: '再募集時にこのクーポンをご利用いただけます。',
  };
}

/**
 * 顧客画面に出す表示モデル（クーポンページ・受付休止ページで共用）。
 * **他会員の情報は入らない**（渡された 1 人分の fields からしか作らない）。
 *
 * @param {{ coupon: object, paused: boolean, claimable: boolean, storageReady?: boolean }} input
 */
export function describeCouponForMember({
  coupon, paused,
  /**
   * 取得 CTA を出してよいか。**単一源 `resolveCouponAccess().canClaim` を渡すこと。**
   * ⚠️ `salePaused` から導かないこと（2026-08-22 の不整合修正）。
   */
  claimable, storageReady = true,
  /** いま購入できるか（`plusRelease.purchaseEnabled`）。停止中は false */
  purchasable = false,
  /** CTA の導線元（`?from=` に載る） */
  ctaSource = 'dashboard',
  /**
   * **実効クーポン定義**（`withReopenStart()` の戻り値）。
   * 再募集を開始していれば有効期限が確定した定義が渡る。省略時は基準定義＝期限未確定。
   * ⚠️ ここで `PP_REOPEN_COUPON` を直接読み直さないこと（面ごとに期限がズレる）。
   */
  def = PP_REOPEN_COUPON,
} = {}) {
  const held = coupon || { claimed: false, claimedAtIso: '' };
  const terms = (def && def.terms) || {};
  return {
    /**
     * 「いまの優待条件」として**全ての面に出す 1 本の文字列**。
     *
     * 条件が未確定の今は「募集再開時にご案内します」を返す。
     * 条件が決まったら **`PP_REOPEN_COUPON.terms` を埋める（正本は
     * `promotions/promotionOfferCatalog.js` の Premium Plus 用 offer）だけ**でよく、
     * ここを読んでいる面（受付休止ページ / クーポンページ / マイページ）は
     * **すべて自動で同じ表示に変わる**。
     * ⚠️ 各画面で条件文を組み立て直さないこと（表示がズレる）。
     */
    termsText: describeCouponTerms(def),
    /** 「10,000円OFF」だけ（見出し・バッジ用） */
    discountText: describeCouponDiscount(def),
    /** 「通常 68,000円 → 58,000円」だけ */
    priceText: describeCouponPrice(def),
    /** 有効期限（未確定のあいだは「未定」と伝える） */
    expiryText: describeCouponExpiry(def),
    /** 期限が確定しているか（未確定を隠さない） */
    expiryDetermined: terms.expiresDetermined === true,
    name: def.name,
    description: def.description,
    claimed: held.claimed === true,
    claimedAtIso: held.claimedAtIso || '',
    /** 募集再開時に利用できる旨（取得済みのときだけ意味を持つ） */
    usableNote: PP_REOPEN_COUPON_USABLE_NOTE,
    /** 条件が未確定であることを隠さない */
    termsDetermined: terms.determined === true,
    termsNote: PP_REOPEN_COUPON_EXPIRY_NOTE,
    /** 現在受付休止中か */
    paused: paused === true,
    /** 取得 CTA を出してよいか（取得済みなら常に false ＝ 二重取得させない） */
    showClaimCta: claimable === true && held.claimed !== true,
    /**
     * 取得後の申込導線（主 CTA）。販売停止中は `href: null` の非購入表示。
     * ⚠️ 呼び出し側は `purchasable` を見てリンクにするか決めること。
     */
    orderCta: describeCouponOrderCta({
      claimed: held.claimed === true, purchasable: purchasable === true, source: ctaSource, def,
    }),
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
