/**
 * memberResolution.js — Airtable Customers レコードから会員権限を解決する純粋関数
 *
 * PR-B スコープ: サーバー専用の会員判定を **1 箇所に集約**する。
 *   - ランタイム非依存・依存注入可能（Airtable / env / 時計に触れない）。
 *   - 呼び出し側（Netlify Functions）が Airtable から取得した `record.fields` と
 *     `record.id`、`now`（ms epoch）を渡す。この関数は I/O を一切行わない。
 *   - クライアントから送られた plan は **使わない**（引数に取らない）。
 *
 * 判定原則（fail closed）:
 *   - 有効な有料会員だけ `paid`
 *   - Free / **契約が終わった元有料会員**（期限切れ・退会申請）は `free`
 *   - 強制ログアウト / 利用停止 / plan 欠落 / 未知 plan / 複数解釈 /
 *     SessionVersion 異常 は `denied`
 *   - SessionVersion 欠落・空は `0`。負数 / 非整数 / 異常型は `denied`
 *
 * ── ⏰ 期限切れ・退会申請は `free`（2026-08-01 / 旧挙動の復元）────────────
 * PR-B（`7c479db` / 2026-07-08）で期限切れ有料・退会申請を `denied` にしたが、これは
 * **PR-B 以前の挙動からの意図しない後退**だった。旧 `auth-user.js` は期限切れでも 200 を返し
 * 「有効期限が切れています。無料会員としてご利用いただけます。」と案内していた。
 * `denied` にしたことで、元有料会員は**マイページ・保有ポイント・ポイント交換・
 * 再契約導線のすべてに到達できなくなり**、退会確認メールの「契約期間終了後は自動的に
 * Free プランに切り替わります」という案内とも矛盾していた（2026-08-01 に本番で 75 名該当）。
 *
 * そこで `free` へ戻す。**ただし旧挙動そのままではない**:
 *   - 旧: `プラン` の値（Premium / Light 等）をそのまま返し、クライアントが期限を見て落としていた
 *   - 新: **`normalizedPlan` は `'free'` 固定**。元のプラン名は返さない（権限判定に使わせない）
 * `memberType='free'` なので `issuePaidSessionCookie` / `sessionRefresh` /
 * `verifyMagicLinkFlow` / `shouldSendMagicLink` はいずれも通らず、**有料権限は 1 つも付かない**。
 * Airtable の `プラン` / `有効期限` / `PaymentConfirmed` / `PaidAt` は**読むだけで書き換えない**。
 *
 * `reason` で `expired` / `withdrawal_requested` を区別できるので、呼び出し側は
 * 「無料会員としてログインした」ことを案内できる（プラン名は伏せる）。
 *
 * ── 無料特典（promotional grant）の扱い（2026-07-30 追加）──────────────
 * `promotionalGrants.js` の無料権利は **課金契約とは独立**にログイン権限を与える。
 *   - Premium 無料権利が有効 → `paid('premium')`
 *   - Light 無料権利が有効   → `paid('light')`
 * 有料契約が有効なときは **有料側を優先**する（特典で契約プランを上書きしない）。
 * 拒否ゲート（ForceLogout / 停止 / SessionVersion 不正）は特典より**先**に評価する。
 * 退会申請は拒否ではなく `free` だが、**特典より先**に評価する（退会者に無料特典で
 * 有料権限を与えない）。
 * 特典は権利を増やすだけで、減らさない。フィールドが無いレコードは従来と同じ判定。
 *
 * ── ⚠️ `memberType='paid'` は「支払済み」ではない（認可ラベル）─────────────
 * この値は **「有料階層のセッションを発行してよいか」** だけを表す legacy な認可ラベルで、
 * 課金実績を意味しない。消費者は以下の 6 か所しかなく、すべて認証経路の分岐である
 * （2026-07-30 に repository 全体を grep して確認。課金・請求・契約更新の判定に使っている
 *  consumer は 1 つも無い）:
 *
 *   1. `authPolicies.decideFreeLogin`      paid → マジックリンク必須（即時 Free ログインしない）
 *   2. `authPolicies.shouldSendMagicLink`  paid のみリンク送信
 *   3. `sessionIssuance.issuePaidSessionCookie`  paid のみ Cookie 発行
 *   4. `sessionRefresh`                    paid のみ更新
 *   5. `verifyMagicLinkFlow`               paid のみ検証成功
 *   6. `auth-user` / `login.astro`         'free' 分岐の表示のみ
 *
 * **Cookie payload に memberType は入らない**（sub / plan / venueAccess / sessionVersion のみ）。
 * 課金実績が前提の判定（Premium Plus 販売資格 / 三連複購入資格 / 契約状態のマーケ区分）は
 * `resolveEntitlements` の `paidPremiumActive` / `paidLightActive`、または
 * Airtable の課金フィールドを直接見ており、この値を参照していない。
 *
 * 将来 consumer を増やすときのために、根拠を `entitlementSource`
 * （`paid_contract` / `promotional_grant` / `none`）で返す。**課金実績が要るなら
 * memberType ではなくこちらを見ること。**
 */

import {
  normalizePlan,
  isPaidPlan,
  normalizeVenueAccess,
  CANONICAL_VENUES,
} from './planNormalization.js';
import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';

export const MEMBER_TYPE = Object.freeze({
  FREE: 'free',
  PAID: 'paid',
  DENIED: 'denied',
});

/** 判定理由コード（構造化。人間可読メッセージ・機密は含めない）。 */
/**
 * `memberType='paid'` の**根拠**。memberType 自体は変えずに、課金契約と無料特典を
 * 構造的に見分けられるようにするための追加情報（セッション Cookie には入らない）。
 */
export const MEMBER_SOURCE = Object.freeze({
  /** 通常購入の契約（プラン / 有効期限 / PlanType / LifetimeSanrenpuku） */
  PAID_CONTRACT: 'paid_contract',
  /** カムバック等の無料特典（promotional grant）。**支払い実績ではない** */
  PROMOTIONAL_GRANT: 'promotional_grant',
  /** 有料階層ではない（free / denied） */
  NONE: 'none',
});

export const MEMBER_REASON = Object.freeze({
  CLEAR_FREE: 'clear_free',
  PENDING_PAYMENT_FREE: 'pending_payment_free',
  ACTIVE_PAID: 'active_paid',
  LIFETIME_SANRENPUKU: 'lifetime_sanrenpuku',
  FORCE_LOGOUT: 'force_logout',
  /** 退会申請済み → `free`（課金停止であって利用禁止ではない） */
  WITHDRAWAL_REQUESTED: 'withdrawal_requested',
  STATUS_SUSPENDED: 'status_suspended',
  INVALID_SESSION_VERSION: 'invalid_session_version',
  MISSING_PLAN: 'missing_plan',
  UNKNOWN_PLAN: 'unknown_plan',
  PLAN_CONFLICT: 'plan_conflict',
  /** 有料契約の期限切れ → `free`（元のプラン名は返さない） */
  EXPIRED: 'expired',
  UNKNOWN_VENUE: 'unknown_venue',
  INVALID_NOW: 'invalid_now',
  /** 無料特典（Premium 無料権利）で有料相当になった */
  PROMO_PREMIUM_GRANT: 'promo_premium_grant',
  /** 無料特典（Light 無料権利）で有料相当になった */
  PROMO_LIGHT_GRANT: 'promo_light_grant',
});

// Airtable 上の停止系ステータス（大小・和英を吸収）。
const SUSPENDED_STATUS = new Set([
  'suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled',
  '停止', '無効', '解約', '退会',
]);
// 入金待ち（有料プラン名が入っていても有料扱いしない）。
const PENDING_STATUS = new Set(['pending', '入金待ち', '未入金']);

function readRaw(fields, names) {
  for (const n of names) {
    const v = fields[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Airtable のチェックボックス/数値フラグ（true / 1 のみ真）。
function isTruthyFlag(v) {
  return v === true || v === 1;
}

/**
 * SessionVersion を整数へ解決する。
 * 欠落・null・空文字は 0。負数 / 非整数 / 異常型は不正。
 * @returns {{ ok: true, value: number } | { ok: false }}
 */
export function resolveSessionVersion(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0 };
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 0) return { ok: true, value: raw };
    return { ok: false };
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return { ok: true, value: parseInt(raw.trim(), 10) };
  }
  return { ok: false };
}

// 期限切れ判定。パース不能な値は「期限なし」とみなす（誤って有効会員を弾かない）。
function isExpiredDate(raw, now) {
  if (raw === undefined || raw === null || raw === '') return false;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  return t < now;
}

// VenueAccess を正規配列へ。未指定は両会場（jra+nankan）。未知値は ok:false。
function resolveVenues(fields) {
  const raw = readRaw(fields, ['VenueAccess']);
  if (raw === undefined) return { ok: true, venues: [...CANONICAL_VENUES] };
  const norm = normalizeVenueAccess(raw);
  if (norm === null) return { ok: false };
  return { ok: true, venues: norm };
}

function deny(reason, recordId, sessionVersion = 0, lifetimeSanrenpuku = false) {
  return {
    memberType: MEMBER_TYPE.DENIED,
    normalizedPlan: null,
    venueAccess: [],
    sessionVersion,
    recordId: recordId ?? null,
    reason,
    lifetimeSanrenpuku,
    entitlementSource: MEMBER_SOURCE.NONE,
  };
}

/**
 * 無料会員の判定結果。
 *
 * ⚠️ **`normalizedPlan` は常に `'free'`**。期限切れ・退会申請の元有料会員でも、
 * Airtable の `プラン`（Premium / Light / Premium Sanrenpuku 等）は**一切返さない**。
 * 返してしまうと呼び出し側・クライアントがそれを権限判定に使えてしまう。
 * `lifetimeSanrenpuku` も false 固定（三連複の永久権は有料判定側で `paid` として返る）。
 */
function freeResult(recordId, sessionVersion, reason = MEMBER_REASON.CLEAR_FREE) {
  return {
    memberType: MEMBER_TYPE.FREE,
    normalizedPlan: 'free',
    venueAccess: [],
    sessionVersion,
    recordId: recordId ?? null,
    reason,
    lifetimeSanrenpuku: false,
    entitlementSource: MEMBER_SOURCE.NONE,
  };
}

function paidResult(plan, venues, recordId, sessionVersion, lifetimeSanrenpuku, reason,
  entitlementSource = MEMBER_SOURCE.PAID_CONTRACT) {
  return {
    memberType: MEMBER_TYPE.PAID,
    normalizedPlan: plan,
    venueAccess: venues,
    sessionVersion,
    recordId: recordId ?? null,
    reason,
    lifetimeSanrenpuku,
    /**
     * この判定の根拠が **課金契約か無料特典か**。
     * memberType='paid' は「有料階層のセッションを発行してよい」という認可ラベルであって
     * 支払い実績ではないため、課金実績が前提の判定はこちらを見ること。
     */
    entitlementSource,
  };
}

/**
 * 会員権限を解決する。I/O なし・純粋。
 *
 * @param {{ fields?: Record<string, unknown>, recordId?: string|null, now: number }} input
 * @returns {{
 *   memberType: 'free'|'paid'|'denied',
 *   normalizedPlan: string|null,
 *   venueAccess: string[],
 *   sessionVersion: number,
 *   recordId: string|null,
 *   reason: string,
 *   lifetimeSanrenpuku: boolean,
 *   entitlementSource: 'paid_contract'|'promotional_grant'|'none',
 * }}
 */
export function resolveMembership(input = {}) {
  const { fields = {}, recordId = null, now } = input;
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return deny(MEMBER_REASON.INVALID_NOW, recordId);
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return deny(MEMBER_REASON.MISSING_PLAN, recordId);
  }

  const sv = resolveSessionVersion(readRaw(fields, ['SessionVersion']));

  // --- 拒否ゲート（lifetime よりも優先。ここを通らないと有料化しない） ---
  if (isTruthyFlag(readRaw(fields, ['ForceLogout']))) {
    return deny(MEMBER_REASON.FORCE_LOGOUT, recordId, sv.ok ? sv.value : 0);
  }
  const statusRaw = readRaw(fields, ['Status']);
  const status = statusRaw == null ? '' : String(statusRaw).trim().toLowerCase();
  if (SUSPENDED_STATUS.has(status)) {
    return deny(MEMBER_REASON.STATUS_SUSPENDED, recordId, sv.ok ? sv.value : 0);
  }
  if (!sv.ok) {
    return deny(MEMBER_REASON.INVALID_SESSION_VERSION, recordId);
  }
  const sessionVersion = sv.value;

  const withdrawn = isTruthyFlag(readRaw(fields, ['WithdrawalRequested']));

  const lifetime = isTruthyFlag(readRaw(fields, ['LifetimeSanrenpuku', '三連複Lifetime']));

  /**
   * カムバック特典で有料相当になるか。
   * 有効な有料契約があるときは呼ばれない（有料側を優先するため、free / 期限切れの分岐でのみ使う）。
   * @returns {object|null} paidResult or deny(UNKNOWN_VENUE)、特典が無ければ null
   */
  const promoResult = () => {
    const g = resolvePromotionalGrants(fields, now);
    // 強い方を優先: Premium 無料権利 > Light 無料権利（Light は fallback ではなく独立プラン）
    const plan = g.premium.active ? 'premium' : (g.light.active ? 'light' : null);
    if (!plan) return null;
    const v = resolveVenues(fields);
    if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
    return paidResult(
      plan, v.venues, recordId, sessionVersion, lifetime,
      plan === 'premium' ? MEMBER_REASON.PROMO_PREMIUM_GRANT : MEMBER_REASON.PROMO_LIGHT_GRANT,
      // ⚠️ 支払い実績ではない。課金前提の判定はこの値で除外できる
      MEMBER_SOURCE.PROMOTIONAL_GRANT,
    );
  };

  // --- plan（ティア）の解決（クライアント値は使わない） ---
  // ティアの正本は `プラン`（日本語）。`Plan`（英語）は読み取り互換の別名。
  // ※ `PlanType` は課金サイクル（Monthly/annual/lifetime）でありティアではないため
  //    ここでは **絶対に参照しない**（verify-magic-link 旧実装の混同を持ち込まない）。
  const jaRaw = fields['プラン'];
  const enRaw = fields['Plan'];
  const jaPlan = jaRaw !== undefined && jaRaw !== null && jaRaw !== '' ? normalizePlan(jaRaw) : undefined;
  const enPlan = enRaw !== undefined && enRaw !== null && enRaw !== '' ? normalizePlan(enRaw) : undefined;

  // `プラン` と `Plan` が有料/無料で食い違う → 複数解釈として拒否（fail closed）
  if (jaPlan != null && enPlan != null && isPaidPlan(jaPlan) !== isPaidPlan(enPlan)) {
    return deny(MEMBER_REASON.PLAN_CONFLICT, recordId, sessionVersion, lifetime);
  }

  // 実効プラン: `プラン` を優先し、無ければ `Plan`
  const plan = jaPlan !== undefined ? jaPlan : enPlan;

  if (plan === null) {
    // 値はあるが未知（`Test` など）。退会・期限に関係なく判定不能として拒否する。
    return deny(MEMBER_REASON.UNKNOWN_PLAN, recordId, sessionVersion, lifetime);
  }

  // 退会申請 = 課金の停止であって利用禁止ではない（退会確認メールも
  // 「契約期間終了後は自動的に Free プランに切り替わります」と案内している）。
  // 無料会員としてログインさせる。**有料権限は一切与えない**:
  //   - plan は 'free' 固定（元の Premium / Light 等は返さない）
  //   - lifetime / 無料特典（promotional grant）も見ない＝有料階層へ戻さない
  //   - memberType='free' なので Cookie 発行・refresh・magic link はすべて通らない
  // 判定不能（未知プラン）より後・その他すべてより先に評価する。
  if (withdrawn) {
    return freeResult(recordId, sessionVersion, MEMBER_REASON.WITHDRAWAL_REQUESTED);
  }

  if (plan === undefined) {
    // plan フィールド自体が無い
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    return deny(MEMBER_REASON.MISSING_PLAN, recordId, sessionVersion, lifetime);
  }

  const isPending = PENDING_STATUS.has(status);

  // 無料プラン
  if (!isPaidPlan(plan)) {
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    // 無料会員でもカムバック特典があれば有料相当（課金フィールドは一切見ていない）
    return promoResult() || freeResult(recordId, sessionVersion);
  }

  // 有料プラン候補
  if (isPending) {
    // 入金待ち → 有料化しない（Free 扱い。lifetime / 特典のみ例外）
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    return promoResult() || freeResult(recordId, sessionVersion, MEMBER_REASON.PENDING_PAYMENT_FREE);
  }

  const expiryRaw = readRaw(fields, ['有効期限', 'ValidUntil', 'ExpiryDate', 'ExpirationDate']);
  if (isExpiredDate(expiryRaw, now)) {
    // 三連複の買い切り権（LifetimeSanrenpuku）は課金サイクルと無関係の永久権なので、
    // base プランの期限切れでは失わせない。
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    // カムバック特典（Premium 無料期間 / Light 永久無料）があれば、期限切れでもその範囲で復帰する。
    // ⚠️ 有料契約の `有効期限` は書き換えない。期限切れである事実はそのまま残る。
    //
    // 特典も無ければ **無料会員**（`denied` にしない）。元のプラン名は返さず 'free' 固定なので、
    // Premium / Light / 三連複 / Premium Plus はいずれも閲覧できない。
    // マイページ・保有ポイント・無料コンテンツ・再契約導線だけが使える状態になる。
    return promoResult() || freeResult(recordId, sessionVersion, MEMBER_REASON.EXPIRED);
  }

  // 有効な有料会員
  const v = resolveVenues(fields);
  if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
  return paidResult(plan, v.venues, recordId, sessionVersion, lifetime, MEMBER_REASON.ACTIVE_PAID);
}
