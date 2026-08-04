/**
 * comebackPolicy.js — カムバック施策の**宣言を読むだけ**の単一源（純粋・I/O なし）
 *
 * ── なぜ作ったか ────────────────────────────────────────────────
 * 「退会した元会員へ Light 30 日無料を配る」を実現するのに、当初は
 * **offerId を直接見る例外**（`offerId === 'light-30d-free'` なら退会者可）を書いた。
 * これだと施策を 1 つ増やすたびにコード修正 → PR → merge → deploy が要る。
 *
 * そこで判定材料を**特典カタログの宣言（`offer.comeback`）へ移す**。
 * このモジュールは宣言を読んで正規化するだけで、施策名を 1 つも知らない。
 *
 *   新しい施策を足す = `promotionOfferCatalog.js` の該当 offer に
 *   `comeback: {...}` を書く。**それだけ**（コード修正・PR は不要）。
 *
 * ── 誰がこの判定を使うか（重複実装しない）────────────────────────
 *   一覧表示      `comeback/comebackAudience.js`
 *   dry-run / 付与 `comeback/comebackGrantPlan.js`
 *   ログイン権限   `auth/memberResolution.js` / `entitlements/resolveEntitlements.js`
 *   案内メール     `comeback/comebackGrantCampaign.js`（offerId → campaignId）
 *
 * ── 安全側の原則 ──────────────────────────────────────────────
 * - 宣言が無い / 壊れている施策は**退会者へ出せない**（fail closed）
 * - 宣言できるのは「緩める方向」だけ。`ForceLogout` / 停止 / テスト /
 *   配信停止 / provider suppression / blacklist は**宣言では緩められない**
 * - `restoresPaidContract` は false 以外を受け付けない。課金契約の復帰は
 *   入金確認フロー（`confirm-bank-payment`）だけが行う
 * - `preserveWithdrawalRequested` は true 以外を受け付けない。退会・課金停止の
 *   記録は施策では書き換えない
 */

import { resolvePromotionalGrants } from './promotionalGrants.js';
import { PROMOTION_OFFERS, OFFER_KIND } from '../promotions/promotionOfferCatalog.js';

/** カムバックの対象区分（`entitlements/comebackAudience.js` の SEGMENT と同じ語彙） */
export const CB_SEGMENT = Object.freeze({
  EXPIRED: 'expired',
  WITHDRAWN: 'withdrawn',
  DORMANT: 'dormant',
});

/** 管理画面に出す区分名。**「退会」だけだと配信拒否と読み違えられる**ので明示する。 */
export const CB_SEGMENT_LABEL = Object.freeze({
  [CB_SEGMENT.EXPIRED]: '期限切れ',
  [CB_SEGMENT.WITHDRAWN]: '退会・課金停止',
  [CB_SEGMENT.DORMANT]: '休眠・長期未ログイン',
});

/** 区分の意味（画面の補足文。色や語感に頼らせない） */
export const CB_SEGMENT_NOTE = Object.freeze({
  [CB_SEGMENT.EXPIRED]: '元有料会員で有効期限が過ぎた方。',
  [CB_SEGMENT.WITHDRAWN]:
    '退会手続きで課金を停止した元会員。**メール配信停止とは別**で、退会だけを理由に送信対象から外しません。'
    + '配信を止める意思表示は「配信停止」と配信基盤の停止リストが担います。',
  [CB_SEGMENT.DORMANT]: '契約が無い / 長期間ログインしていない方。',
});

/** 特典が与えうる権利の種類（`allowedEntitlements` / `forbiddenEntitlements` の語彙） */
export const CB_ENTITLEMENT = Object.freeze({
  LIGHT: 'light',
  PREMIUM: 'premium',
  SANRENPUKU: 'sanrenpuku',
  PURCHASE: 'purchase',
});

/** 宣言が使えない理由（固定コード） */
export const CB_POLICY_INVALID = Object.freeze({
  MISSING: 'policy_missing',
  NOT_GRANT: 'not_a_grant_offer',
  BAD_SEGMENTS: 'bad_audience_segments',
  BAD_TIER: 'bad_grant_tier',
  BAD_DURATION: 'bad_duration_days',
  BAD_CAMPAIGN: 'bad_campaign',
  RESTORES_PAID: 'restores_paid_contract_not_allowed',
  CLEARS_WITHDRAWAL: 'must_preserve_withdrawal_requested',
  BAD_ENTITLEMENTS: 'bad_entitlements',
  TIER_NOT_ALLOWED: 'grant_tier_not_in_allowed_entitlements',
  TIER_FORBIDDEN: 'grant_tier_in_forbidden_entitlements',
});

export const CB_POLICY_INVALID_LABEL = Object.freeze({
  policy_missing: 'カムバック施策として宣言されていません',
  not_a_grant_offer: '無料付与の特典ではありません',
  bad_audience_segments: '対象区分（audienceSegments）の指定が不正です',
  bad_grant_tier: '付与ティア（grantTier）の指定が不正です',
  bad_duration_days: '付与日数（durationDays）の指定が不正です',
  bad_campaign: '案内キャンペーン（campaignId / campaignVersion）の指定が不正です',
  restores_paid_contract_not_allowed: '施策で課金契約を復帰させることはできません',
  must_preserve_withdrawal_requested: '施策で退会状態を書き換えることはできません',
  bad_entitlements: '権利（allowedEntitlements / forbiddenEntitlements）の指定が不正です',
  grant_tier_not_in_allowed_entitlements: '付与ティアが allowedEntitlements に含まれていません',
  grant_tier_in_forbidden_entitlements: '付与ティアが forbiddenEntitlements に入っています',
});

/** 施策で配ってよい上限日数（暴走宣言の歯止め）。無期限は宣言では許可しない。 */
export const CB_MAX_POLICY_DAYS = 365;

const str = (v) => String(v ?? '').trim();
const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : null);
const DAY_MS = 86400000;

function isTruthyFlag(v) {
  return v === true || v === 1
    || (typeof v === 'string' && ['true', '1', 'yes', 'checked', 'on'].includes(v.trim().toLowerCase()));
}

/**
 * 宣言を検証して正規化する。**1 つでも条件を外れたら使えない**（fail closed）。
 *
 * @param {object|null} offer カタログの offer（`resolveOffer(...).offer` でも定義そのままでも可）
 * @returns {{ok: true, policy: object} | {ok: false, reason: string, label: string}}
 */
export function resolveComebackPolicy(offer) {
  const no = (reason) => ({ ok: false, reason, label: CB_POLICY_INVALID_LABEL[reason] || reason });
  const o = offer && typeof offer === 'object' ? offer : null;
  if (!o) return no(CB_POLICY_INVALID.MISSING);
  const c = o.comeback && typeof o.comeback === 'object' ? o.comeback : null;
  if (!c) return no(CB_POLICY_INVALID.MISSING);
  if (o.kind !== undefined && o.kind !== OFFER_KIND.GRANT) return no(CB_POLICY_INVALID.NOT_GRANT);

  const segments = arr(c.audienceSegments);
  const known = new Set(Object.values(CB_SEGMENT));
  if (!segments || segments.length === 0 || segments.some((x) => !known.has(x))) {
    return no(CB_POLICY_INVALID.BAD_SEGMENTS);
  }

  const grantTier = str(c.grantTier);
  if (grantTier !== CB_ENTITLEMENT.LIGHT && grantTier !== CB_ENTITLEMENT.PREMIUM) {
    return no(CB_POLICY_INVALID.BAD_TIER);
  }
  // 宣言できるのは**期間限定だけ**。無期限を宣言で配れるようにはしない
  const days = Number(c.durationDays);
  if (!Number.isInteger(days) || days <= 0 || days > CB_MAX_POLICY_DAYS) {
    return no(CB_POLICY_INVALID.BAD_DURATION);
  }
  // 特典定義の中身と食い違う宣言は通さない（定義すり替え対策）
  if (o.targetTier !== undefined && str(o.targetTier) !== grantTier) return no(CB_POLICY_INVALID.BAD_TIER);
  if (o.isLifetime === true) return no(CB_POLICY_INVALID.BAD_DURATION);
  if (o.duration !== undefined && o.duration !== null && Number(o.duration) !== days) {
    return no(CB_POLICY_INVALID.BAD_DURATION);
  }

  const campaignId = str(c.campaignId);
  const campaignVersion = Number(c.campaignVersion);
  if (!campaignId || !Number.isInteger(campaignVersion) || campaignVersion <= 0) {
    return no(CB_POLICY_INVALID.BAD_CAMPAIGN);
  }

  // 「緩める方向」以外は宣言できない
  if (c.restoresPaidContract !== false) return no(CB_POLICY_INVALID.RESTORES_PAID);
  if (c.preserveWithdrawalRequested !== true) return no(CB_POLICY_INVALID.CLEARS_WITHDRAWAL);

  const allowed = arr(c.allowedEntitlements);
  const forbidden = arr(c.forbiddenEntitlements) || [];
  const ents = new Set(Object.values(CB_ENTITLEMENT));
  if (!allowed || allowed.length === 0
    || allowed.some((x) => !ents.has(x)) || forbidden.some((x) => !ents.has(x))) {
    return no(CB_POLICY_INVALID.BAD_ENTITLEMENTS);
  }
  if (!allowed.includes(grantTier)) return no(CB_POLICY_INVALID.TIER_NOT_ALLOWED);
  if (forbidden.includes(grantTier)) return no(CB_POLICY_INVALID.TIER_FORBIDDEN);

  return {
    ok: true,
    policy: Object.freeze({
      offerId: str(o.offerId),
      audienceSegments: Object.freeze(segments),
      allowWithdrawn: c.allowWithdrawn === true,
      grantTier,
      durationDays: days,
      campaignId,
      campaignVersion,
      requiresSuccessfulGrant: c.requiresSuccessfulGrant !== false,
      restoresPaidContract: false,
      preserveWithdrawalRequested: true,
      allowedEntitlements: Object.freeze(allowed),
      forbiddenEntitlements: Object.freeze(forbidden),
    }),
  };
}

/** カタログ上の**有効な**カムバック施策すべて（宣言が壊れているものは含まない） */
export function listComebackPolicies() {
  const out = [];
  for (const def of PROMOTION_OFFERS) {
    if (def.enabled === false) continue;
    const r = resolveComebackPolicy(def);
    if (r.ok) out.push(r.policy);
  }
  return out;
}

/** offerId → 施策（無ければ null） */
export function getComebackPolicyByOfferId(offerId) {
  const id = str(offerId);
  if (!id) return null;
  return listComebackPolicies().find((p) => p.offerId === id) || null;
}

/**
 * この特典を**退会・課金停止の元会員へ出してよい**か。
 * 判断材料は宣言だけ。施策名は 1 つも見ない。
 */
export function isWithdrawnAllowedForOffer(offer) {
  const r = resolveComebackPolicy(offer);
  if (!r.ok) return false;
  return r.policy.allowWithdrawn === true
    && r.policy.audienceSegments.includes(CB_SEGMENT.WITHDRAWN);
}

/**
 * 管理画面にそのまま出せる可否表示。
 * @returns {{allowed: boolean, label: string, note: string, policy: object|null}}
 */
export function describeWithdrawnAvailability(offer) {
  const r = resolveComebackPolicy(offer);
  if (!r.ok) {
    return {
      allowed: false,
      label: '退会・課金停止の方へは配れません',
      note: `${r.label}。この特典を退会者へ配るには、特典カタログに施策として宣言してください。`,
      policy: null,
    };
  }
  const p = r.policy;
  if (!p.allowWithdrawn || !p.audienceSegments.includes(CB_SEGMENT.WITHDRAWN)) {
    return {
      allowed: false,
      label: '退会・課金停止の方へは配れません',
      note: 'この施策は退会・課金停止を対象区分に含めていません（allowWithdrawn が有効ではありません）。',
      policy: p,
    };
  }
  return {
    allowed: true,
    label: '退会・課金停止の方へも配れます',
    note: `${p.grantTier === CB_ENTITLEMENT.LIGHT ? 'Light' : 'Premium'} を ${p.durationDays} 日間だけ開放します。`
      + '退会状態・課金履歴・元のプランは変更しません。期間が終われば自動的に無料会員へ戻ります。',
    policy: p,
  };
}

/** 施策が想定している対象区分か（画面の警告用） */
export function policyCoversSegment(policy, segment) {
  if (!policy || !Array.isArray(policy.audienceSegments)) return false;
  return policy.audienceSegments.includes(str(segment));
}

/** 施策 → 案内キャンペーン（`comebackGrantCampaign` はこれを使う） */
export function campaignForOfferId(offerId) {
  const p = getComebackPolicyByOfferId(offerId);
  return p ? { campaignId: p.campaignId, campaignVersion: p.campaignVersion } : null;
}

/** 認めなかった理由（表示・テスト用） */
export const CB_HONOR_BLOCK = Object.freeze({
  FORCE_LOGOUT: 'force_logout',
  NO_GRANT: 'no_grant',
  LIFETIME: 'lifetime',
  NO_OPERATION: 'no_operation',
  INCONSISTENT: 'inconsistent',
  OUT_OF_POLICY: 'out_of_policy',
});

/**
 * 退会者のログイン時に、その無料特典を**有効なものとして扱ってよい**か。
 *
 * 付与側（`isWithdrawnAllowedForOffer`）と対になる権限側の判定。
 * 付与できても、ここが false なら特典は効かない ―― つまり
 * 「付与しました」という案内メールが嘘になる。だから**同じモジュールに置く**。
 *
 * 施策名は見ない。**宣言された施策のどれかと形が一致するか**だけで決める:
 *   - その施策のティアの特典が期間内にある
 *   - 無期限ではない（宣言で無期限は許可しないため、そもそも一致しない）
 *   - 付与期間が施策の `durationDays` を超えていない（＋1 日の丸め許容）
 *   - 付与操作の記録（`*GrantOp`）がある＝管理操作で付いたもの
 *   - 取消・不整合ではない
 *   - `ForceLogout` ではない（安全措置は課金状態と別軸。宣言では緩められない）
 *
 * @param {{ fields: object|null, nowMs: number }} input
 * @returns {{ok: boolean, reason: string|null, tier: string|null,
 *            policyOfferId: string|null, allowedEntitlements: string[]}}
 */
export function honorsGrantDespiteWithdrawal({ fields, nowMs } = {}) {
  const no = (reason) => ({ ok: false, reason, tier: null, policyOfferId: null, allowedEntitlements: [] });
  const f = fields && typeof fields === 'object' ? fields : null;
  if (!f) return no(CB_HONOR_BLOCK.NO_GRANT);
  if (isTruthyFlag(f.ForceLogout)) return no(CB_HONOR_BLOCK.FORCE_LOGOUT);

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const grants = resolvePromotionalGrants(f, now);
  if (grants.inconsistent === true) return no(CB_HONOR_BLOCK.INCONSISTENT);

  const policies = listComebackPolicies().filter((p) => p.allowWithdrawn === true
    && p.audienceSegments.includes(CB_SEGMENT.WITHDRAWN));
  if (policies.length === 0) return no(CB_HONOR_BLOCK.OUT_OF_POLICY);

  let lastReason = CB_HONOR_BLOCK.NO_GRANT;
  for (const p of policies) {
    const g = grants[p.grantTier];
    if (!g || g.active !== true) { lastReason = CB_HONOR_BLOCK.NO_GRANT; continue; }
    if (g.lifetime === true) { lastReason = CB_HONOR_BLOCK.LIFETIME; continue; }
    if (g.inconsistent === true) { lastReason = CB_HONOR_BLOCK.INCONSISTENT; continue; }
    if (!str(g.operationId)) { lastReason = CB_HONOR_BLOCK.NO_OPERATION; continue; }
    if (!Number.isFinite(g.untilMs)) { lastReason = CB_HONOR_BLOCK.NO_GRANT; continue; }

    // 宣言した期間を超える付与は認めない（+1 日は日付丸めの許容）
    const startMs = Number.isFinite(g.grantedAtMs) ? g.grantedAtMs : now;
    const spanDays = (g.untilMs - startMs) / DAY_MS;
    if (spanDays > p.durationDays + 1) { lastReason = CB_HONOR_BLOCK.OUT_OF_POLICY; continue; }

    return {
      ok: true,
      reason: null,
      tier: p.grantTier,
      policyOfferId: p.offerId,
      allowedEntitlements: [...p.allowedEntitlements],
    };
  }
  return no(lastReason);
}

export default resolveComebackPolicy;
