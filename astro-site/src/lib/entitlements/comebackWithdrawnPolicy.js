/**
 * comebackWithdrawnPolicy.js — 退会者へのカムバック特典を**この施策に限って**認める（純粋・I/O なし）
 *
 * ── 何が間違っていたか ────────────────────────────────────────────
 * AK における `WithdrawalRequested` は **旧 Stripe の課金を止め、契約を終える**ための状態で、
 * メール受信の拒否でも利用禁止でもない（退会受付メールも「メルマガは引き続き配信されます」
 * 「契約期間終了後は自動的に Free プランに切り替わります」と本人へ案内している）。
 * `docs/spec.md`「カムバック施策の対象条件」も **退会済み = カムバック対象 / 付与できる / 送れる**
 * と書いている。
 *
 * ところが実装は 3 か所で退会者を締め出しており、仕様と食い違っていた:
 *
 *   1. `comebackGrantPlan.checkGrantable` … 退会を `withdrawal_blocked` で弾く（付与できない）
 *   2. `auth/memberResolution`            … 退会を無料特典より**先**に評価する（付与しても効かない）
 *   3. `entitlements/resolveEntitlements` … 退会で `canLogin=false` → 特典が常に無効
 *
 * 実害: 元の対象者 65 名のうち 28 名（期限切れ）だけが Light 30 日無料を受け取り、
 * **退会済みの元有料会員 37 名は 1 人も対象にできなかった**。
 *
 * ── この修正の考え方 ──────────────────────────────────────────
 * 「退会者にも無料付与を解禁する」のではない。**この 1 つの施策の形にだけ**穴を開ける。
 *
 *   - 施策は `light-30d-free`（= キャンペーン `comeback-light-30d-granted`）だけ
 *   - **期間限定の Light のみ**。永久無料・Premium は退会者へ出せない
 *   - 期間は 30 日以内。長期の権利を退会者へ配らない
 *   - `WithdrawalRequested` は**書き換えない**。退会・課金停止の履歴はそのまま残る
 *   - 与えるのは **Light の閲覧権だけ**。三連複買い切り・Premium・購入資格は戻らない
 *   - 期間が終われば自動的に無料会員へ戻る（会員資格の自動復帰ではない）
 *   - 再入金・正式な再契約の復帰処理（`confirm-bank-payment`）とは無関係
 *
 * ── 絶対に緩めないもの（fail closed のまま）──────────────────────
 *   `ForceLogout` / アカウント停止 / テストアカウント / メール不正 /
 *   `UnsubscribedAnalyticsKeiba` / provider suppression / blacklist
 *
 * `ForceLogout` は**課金の状態ではなく安全上の措置**なので、退会と同じには扱わない。
 * この施策でも必ず弾く。
 */

import { resolvePromotionalGrants } from './promotionalGrants.js';

/** この特典（offerId）だけが退会者へ出せる。`GRANT_CAMPAIGN_BY_OFFER` と 1 対 1 で対応する。 */
export const WITHDRAWN_GRANT_OFFER_ID = 'light-30d-free';

/** 対応する案内キャンペーン（送信側の確認用） */
export const WITHDRAWN_GRANT_CAMPAIGN_ID = 'comeback-light-30d-granted';

/** 退会者へ出せる上限日数。これを超える付与は施策の形が違う。 */
export const WITHDRAWN_GRANT_MAX_DAYS = 30;

/** 退会者へ出せるティア */
export const WITHDRAWN_GRANT_TIER = 'light';

const str = (v) => String(v ?? '').trim();

/** Airtable のチェックボックス相当（文字列 'true' 等も拾う） */
function isTruthyFlag(v) {
  return v === true || v === 1
    || (typeof v === 'string' && ['true', '1', 'yes', 'checked', 'on'].includes(v.trim().toLowerCase()));
}

/**
 * この付与内容なら**退会者にも出してよい**か。
 *
 * 呼び出し側は付与 1 件ごとに評価する。true を返したときだけ
 * `checkGrantable(fields, { allowWithdrawn: true })` を使ってよい。
 *
 * @param {{ offerId?: string, targetTier?: string, isLifetime?: boolean, duration?: number|null }} offer
 * @returns {boolean}
 */
export function isWithdrawnGrantAllowed(offer) {
  const o = offer && typeof offer === 'object' ? offer : null;
  if (!o) return false;
  if (str(o.offerId) !== WITHDRAWN_GRANT_OFFER_ID) return false;
  // offerId だけを信じない。中身も施策の形と一致していること（定義を書き換えられても通さない）
  if (str(o.targetTier) !== WITHDRAWN_GRANT_TIER) return false;
  if (o.isLifetime === true) return false;
  const days = Number(o.duration);
  if (!Number.isFinite(days) || days <= 0 || days > WITHDRAWN_GRANT_MAX_DAYS) return false;
  return true;
}

/** 認めなかった理由（表示・テスト用） */
export const WITHDRAWN_HONOR_BLOCK = Object.freeze({
  NOT_WITHDRAWN: 'not_withdrawn',
  FORCE_LOGOUT: 'force_logout',
  NO_GRANT: 'no_grant',
  LIFETIME: 'lifetime',
  NO_OPERATION: 'no_operation',
  INCONSISTENT: 'inconsistent',
});

/**
 * 退会者のログイン時に、**その Light 無料特典を有効なものとして扱ってよい**か。
 *
 * 付与側（`isWithdrawnGrantAllowed`）と対になる、権限側の判定。付与が書けても
 * ここが false なら特典は効かないので、両方を同じ 1 つのモジュールに置く。
 *
 * 認める条件（すべて満たすときだけ）:
 *   - 期間内の Light 無料特典がある
 *   - **永久無料ではない**（退会者へ無期限の権利は与えない）
 *   - `LightGrantOp` がある＝管理操作で付与された記録が残っている
 *     （フィールドの手編集や移行データを権限の根拠にしない）
 *   - 取消・不整合ではない
 *   - `ForceLogout` ではない（安全措置は課金状態と別。ここは緩めない）
 *
 * ⚠️ アカウント停止・テストアカウントは**呼び出し側の拒否ゲートが先に弾く**ため
 *    ここでは判定しない（二重に持つと基準がずれる）。
 *
 * @param {{ fields: object|null, nowMs: number }} input
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function honorsLightGrantDespiteWithdrawal({ fields, nowMs } = {}) {
  const f = fields && typeof fields === 'object' ? fields : null;
  const no = (reason) => ({ ok: false, reason });
  if (!f) return no(WITHDRAWN_HONOR_BLOCK.NO_GRANT);
  if (isTruthyFlag(f.ForceLogout)) return no(WITHDRAWN_HONOR_BLOCK.FORCE_LOGOUT);

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const grants = resolvePromotionalGrants(f, now);
  const light = grants && grants.light;
  if (!light || light.active !== true) return no(WITHDRAWN_HONOR_BLOCK.NO_GRANT);
  if (light.lifetime === true) return no(WITHDRAWN_HONOR_BLOCK.LIFETIME);
  if (grants.inconsistent === true || light.inconsistent === true) return no(WITHDRAWN_HONOR_BLOCK.INCONSISTENT);
  if (!str(light.operationId)) return no(WITHDRAWN_HONOR_BLOCK.NO_OPERATION);

  return { ok: true, reason: null };
}

export default isWithdrawnGrantAllowed;
