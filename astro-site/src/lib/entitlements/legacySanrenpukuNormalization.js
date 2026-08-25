/**
 * legacySanrenpukuNormalization.js — 旧三連複会員を **Light 永久無料** へ正規化する
 * （純粋・I/O なし。書き込む値を組み立てるだけで、Airtable へは触らない）
 *
 * ## 確定した仕様（2026-08-25 MK）
 *
 * 旧 `Premium Sanrenpuku` / `Premium Combo` で**期限切れ**の会員を、
 * **Light 永久無料会員として再スタート**させる。過去の三連複閲覧権は抹消する。
 *
 * | | 確定内容 |
 * |---|---|
 * | 与えるもの | **Light 永久無料**（`LightGrantLifetime`。無料権利であって課金契約ではない）|
 * | 抹消するもの | 旧三連複ティア（`プラン` を `Free` へ）|
 * | 与えないもの | **`LifetimeSanrenpuku` は付与しない**。馬単 Premium も復活させない |
 * | 退会状態 | **Customers 上に退会履歴を残さない**（`WithdrawalRequested` / `WithdrawalDate` /
 *              `WithdrawalReason` / `CancelledAt` をすべて空にする）|
 * | 消さないもの | `有効期限` / `PaidAt` / ポイント / 決済・入金・監査・メールイベントの
 *                  **履歴データそのもの**は別テーブルに残る（触らない）|
 *
 * ⚠️ **判定式は緩めない。** 旧プラン名だけで自動的に権利を配る実装にはしない
 *    （`resolveEntitlements` の `legacySanrenpukuTierGrantsView` は不変）。
 *    与えるのは**このレコードに書いた権利**だけで、誰に与えたかがデータに残る。
 *
 * ## なぜ書き込みが 2 種類に分かれるのか
 *
 * 無料権利の付与経路（`promotionalGrants.js`）は、`プラン` / `Status` / `有効期限` /
 * `WithdrawalRequested` などを **構造的に書けない**（`PROMO_FORBIDDEN_FIELDS`）。
 * 課金契約と無料特典を混ぜないための設計なので、ここでもその境界は壊さない。
 *
 *   1. **契約側の正規化** … `プラン` / `PlanType` / `WithdrawalRequested`
 *   2. **無料権利の付与** … `buildGrantFields`（Light / lifetime）が組み立てた値
 *
 * 本モジュールは 2 つを 1 回分の書き込みとしてまとめるが、**どちらの規約も破らない**
 * （書いてよい列を allow-list で固定し、それ以外が混ざったら `null` を返す）。
 */

import { buildGrantFields, PROMO_TIER } from './promotionalGrants.js';

/** 正規化の対象になる旧プラン名（`プラン` の生値） */
export const LEGACY_SANRENPUKU_PLANS = Object.freeze(['Premium Sanrenpuku', 'Premium Combo']);

/** 正規化後の会員ランク。**Light 永久無料は「無料権利」なので `プラン` は Free** */
export const NORMALIZED_PLAN = 'Free';

/**
 * この正規化で付ける施策名（`ComebackGrantSource` に入る）。
 *
 * ⚠️ **案内メールの対象判定がこの値を見る**（`marketing/campaignAudienceRules.js`）。
 *    正規化に成功したレコードにしか入らないので、
 *    「Light 永久無料化が成功した人にだけ送る」が**構造的に**保証される。
 *    値を変えるときは両方を同時に直すこと（テストが一致を固定している）。
 */
export const RESTART_GRANT_SOURCE = 'legacy-sanrenpuku-to-light-lifetime';

/** 契約側で書いてよい列（これ以外は 1 つも書かない） */
export const CONTRACT_WRITABLE_FIELDS = Object.freeze(['プラン', 'PlanType']);

/**
 * **退会状態の列**（2026-08-25 MK 確定）。対象者は「再スタート」なので、
 * Customers の日常運用データに退会日・退会理由を残さない。
 * 残すと、以後の作業のたびに「過去に退会した会員」として問題視される
 * （カルテ `customerDossier.js` と タイムライン `customerTimeline.js` が実際に表示する）。
 *
 * ⚠️ **監査に必要な履歴は別データとして残る**。ここで消すのは Customers の
 *    運用フィールドだけで、決済・入金・メールイベント・操作履歴のテーブルには触れない。
 * ⚠️ 既存の入金確認フローも再開時に同じ 3 列を空にしている
 *    （`payments/bankPaymentFlow.js` / `send-payment-confirmation-auto.js`）。
 *    本正規化はその前例と同じ扱いで、新しい概念を持ち込まない。
 * ⚠️ `CancelledAt` は Customers に存在するがコードからは 1 か所も読まれておらず、
 *    対象 18 名は全員空（本番 read-only 実測）。値があるときだけ空にする。
 */
export const WITHDRAWAL_STATE_FIELDS = Object.freeze([
  'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason', 'CancelledAt',
]);

/**
 * **絶対に書かない列**。履歴・課金・三連複買い切り・Premium Plus 販売資格。
 * ここに 1 つでも混ざったら組み立て自体を失敗させる。
 */
export const NEVER_WRITE_FIELDS = Object.freeze([
  '有効期限', 'ValidUntil', 'ExpiryDate', 'ExpirationDate',
  'LifetimeSanrenpuku', '三連複Lifetime', 'SanrenpukuPaidAt',
  'PaidAt', 'PaymentConfirmed', 'PaymentMethod', 'RequestedPlan', 'RequestedPlanType', 'RequestedAmount',
  'PremiumPlusEligibility', 'PremiumPlusEligibleAt', 'PremiumPlusReleaseOverride', 'PremiumPlusSalePaused',
  'PremiumGrantLifetime', 'PremiumGrantUntil',
  'ポイント', 'Email', '氏名', 'Status', 'AccountStatus', 'ForceLogout',
  'UnsubscribedAnalyticsKeiba',
]);

/** アカウント全体を止めている Status（この会員は正規化しない＝人が判断する） */
const SUSPENDED_STATUS = new Set([
  'suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled', 'closed', 'withdrawn',
  '停止', '無効', '解約', '退会',
]);

export const NORMALIZE_SKIP = Object.freeze({
  NOT_LEGACY_PLAN: 'not_legacy_plan',
  HAS_LIFETIME_SANRENPUKU: 'has_lifetime_sanrenpuku',
  LIFETIME_BILLING: 'lifetime_billing',
  NOT_EXPIRED: 'not_expired',
  NO_EXPIRY: 'no_expiry',
  SUSPENDED_STATUS: 'suspended_status',
});

const str = (v) => String(v ?? '').trim();

function expiryMs(fields) {
  const raw = fields['有効期限'] ?? fields.ValidUntil ?? fields.ExpiryDate ?? fields.ExpirationDate;
  if (raw === undefined || raw === null || raw === '') return null;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * この会員が正規化の対象か（**fail closed**。判断できないものは対象にしない）。
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function isNormalizationTarget(fields, nowMs = Date.now()) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const no = (reason) => ({ ok: false, reason });

  if (!LEGACY_SANRENPUKU_PLANS.includes(str(f['プラン']))) return no(NORMALIZE_SKIP.NOT_LEGACY_PLAN);
  // 買い切りを持っている会員は触らない（恒久権はそのまま維持する）
  if (f.LifetimeSanrenpuku === true || f['三連複Lifetime'] === true) {
    return no(NORMALIZE_SKIP.HAS_LIFETIME_SANRENPUKU);
  }
  if (str(f.PlanType).toLowerCase() === 'lifetime') return no(NORMALIZE_SKIP.LIFETIME_BILLING);

  const ms = expiryMs(f);
  if (ms === null) return no(NORMALIZE_SKIP.NO_EXPIRY);
  if (ms > nowMs) return no(NORMALIZE_SKIP.NOT_EXPIRED);

  // 停止アカウントは自動で戻さない（退会申請とは別。人が判断する）
  if (SUSPENDED_STATUS.has(str(f.Status ?? f.AccountStatus).toLowerCase())) {
    return no(NORMALIZE_SKIP.SUSPENDED_STATUS);
  }
  return { ok: true, reason: null };
}

/** 書いてよい列だけか（1 つでも外れたら組み立てを捨てる） */
function assertAllowed(out, grantKeys) {
  const allowed = new Set([...CONTRACT_WRITABLE_FIELDS, ...WITHDRAWAL_STATE_FIELDS, ...grantKeys]);
  for (const k of Object.keys(out)) {
    if (!allowed.has(k)) return false;
    if (NEVER_WRITE_FIELDS.includes(k)) return false;
  }
  return true;
}

/**
 * 1 レコード分の書き込みを組み立てる。
 *
 * @param {{ fields: object, now: Date|number, operationId: string,
 *           actor?: string, source?: string }} input
 * @returns {{ fields: object, changes: Array<{field:string,before:unknown,after:unknown}> }
 *           | { skipped: string } | null}
 */
export function buildLegacySanrenpukuNormalization({
  fields, now, operationId, actor, source = RESTART_GRANT_SOURCE,
}) {
  const f = fields && typeof fields === 'object' ? fields : null;
  if (!f) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return null;
  if (!str(operationId)) return null;

  const target = isNormalizationTarget(f, nowMs);
  if (!target.ok) return { skipped: target.reason };

  // ① 無料権利（Light 永久無料）。既存の付与経路が組み立てる値をそのまま使う。
  //    30 日無料を持っている会員は「期限付き → 無期限」の強化として上書きされる。
  const grant = buildGrantFields({
    tier: PROMO_TIER.LIGHT, lifetime: true, fields: f, now: nowMs, operationId, actor, source,
  });
  if (!grant || !grant.fields) return null; // 強化にならない/組み立て失敗は書かない（fail closed）

  // ② 契約側の正規化。**変わる列だけ**書く（不要な更新で監査を汚さない）
  const out = { ...grant.fields };
  const changes = Object.entries(grant.fields).map(([field, after]) => ({ field, before: f[field] ?? null, after }));

  const setIfChanged = (field, after) => {
    const before = f[field] ?? null;
    const same = typeof after === 'boolean'
      ? (before === true) === (after === true)
      : str(before) === str(after);
    if (same) return;
    out[field] = after;
    changes.push({ field, before, after });
  };
  setIfChanged('プラン', NORMALIZED_PLAN);
  setIfChanged('PlanType', '');

  // ③ 退会状態を残さない（値が入っている列だけ空にする）
  if (f.WithdrawalRequested === true) setIfChanged('WithdrawalRequested', false);
  for (const field of ['WithdrawalDate', 'WithdrawalReason', 'CancelledAt']) {
    const before = f[field];
    if (before === undefined || before === null || before === '') continue;
    out[field] = null;
    changes.push({ field, before, after: null });
  }

  if (!assertAllowed(out, Object.keys(grant.fields))) return null;
  return { fields: out, changes };
}
