/**
 * campaignAudienceFormula.js — キャンペーンの宣言から **Airtable 側の絞り込み**を作る（純粋）
 *
 * ## なぜ
 *
 * `handleSequence` / `handlePlan`（引き継ぎ）は Customers を**無フィルタで全件走査**し、
 * `MAX_PAGES=40`（先頭 4,000 件）で黙って打ち切っていた。Customers 15,962 件では
 * **Light 付与 10 名のうち 2 名しか見えない**（2026-08-13 実測）。
 * この状態で queue を積むと **8 名へ案内が飛ばず、関所も開かない**。
 *
 * ## 方針
 *
 * キャンペーンは受信対象を**宣言**している（`requiresActiveGrant` / `requiresImportCohort`）。
 * その宣言をそのまま Airtable の formula へ翻訳し、**必要な候補だけ**を取る。
 * 判定そのものは `sequenceProgress.js` が単一源のまま（ここでは作らない・変えない）。
 *
 * ## 🛡️ 超集合の原則
 *
 * formula は `sequenceProgress` が**停止理由を付けてでも一覧に載せる人**を落としてはいけない。
 * 落とすと集計から人が消え、「送れる人数」も「止まっている理由」も嘘になる。
 *
 * 落としてよいのは、その宣言に照らして**構造的に対象になり得ない人**だけ:
 *   - `requiresActiveGrant` があるのに **無料付与の痕跡が 1 つも無い**人
 *     （= `grant_required`。Customers 15,962 件のうち大半がこれ）
 *   - `requiresImportCohort` があるのに **取り込みコホートでない**人（= `not_in_cohort`）
 *
 * 期限切れ・取消・期限なし付与は**残す**（`grant_expired` / `grant_revoked` /
 * `grant_lifetime` として理由付きで数えたいため）。
 *
 * ⚠️ 配信停止・退会・購入済み・**無反応除外**は formula に入れない。
 *    これらは送信可否の判定であって受信対象の定義ではなく、既存の単一源
 *    （`resolveSendability` / `engagementPolicy` / `sequenceProgress`）が持っている。
 *    **ここで重複実装しない**。特に無反応除外は Customers のフィールドですらない
 *    （Redis 集計 + CampaignDeliveries 由来の配信抑止）。
 *
 * ⚠️ Airtable の `{Field} != BLANK()` は**中身に関係なく常に真**（本番実測）。
 *    「空でない」は必ず `NOT({Field} = BLANK())` と書くこと。
 */

import { COHORT_SOURCE_PREFIX } from '../crm/importedCohort.js';
import { resolveGrantRequirement, resolveExpiredGrantRequirement } from './sequenceProgress.js';

/** tier ごとの Customers 列名（正本は promotionalGrants の運用に合わせる） */
const GRANT_FIELDS = Object.freeze({
  light: Object.freeze({
    grantedAt: 'LightGrantedAt',
    until: 'LightGrantUntil',
    lifetime: 'LightGrantLifetime',
    revokedAt: 'LightGrantRevokedAt',
    op: 'LightGrantOp',
  }),
  premium: Object.freeze({
    grantedAt: 'PremiumGrantedAt',
    until: 'PremiumGrantUntil',
    lifetime: 'PremiumGrantLifetime',
    revokedAt: 'PremiumGrantRevokedAt',
    op: 'PremiumGrantOp',
  }),
});

const notBlank = (f) => `NOT({${f}} = BLANK())`;
const str = (v) => String(v ?? '').trim();

/** Airtable の文字列リテラルへ安全に埋める */
export function escapeFormulaValue(v) {
  return str(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 「その tier の無料付与の痕跡が 1 つでもある」= 期限切れ・取消も含む */
function grantTraceClause(tier) {
  const f = GRANT_FIELDS[tier] || GRANT_FIELDS.light;
  return `OR(${[notBlank(f.grantedAt), notBlank(f.until), `{${f.lifetime}}`, notBlank(f.revokedAt)].join(', ')})`;
}

/** JS 鏡: 痕跡があるか */
function hasGrantTrace(fields, tier) {
  const f = GRANT_FIELDS[tier] || GRANT_FIELDS.light;
  const x = fields || {};
  return str(x[f.grantedAt]) !== '' || str(x[f.until]) !== ''
    || x[f.lifetime] === true || str(x[f.revokedAt]) !== '';
}

/**
 * キャンペーンの受信対象を Airtable formula にする。
 * 絞り込めない（宣言が無い）場合は **null** を返す。呼び出し側は
 * null を「全件走査へ落とす」ではなく **fail closed** として扱うこと。
 *
 * @param {object} campaign
 * @returns {{formula: string, clauses: string[]}|null}
 */
export function buildCampaignAudienceFormula(campaign) {
  if (!campaign) return null;
  const clauses = [];

  const grant = resolveGrantRequirement(campaign);
  if (grant) clauses.push(grantTraceClause(grant.tier));

  // ⚠️ 終了後フェーズも**痕跡がある人**まで（期限内 / 期限切れの別は formula で判定しない）。
  //    「期限が切れているか」は日付比較なので、**判定の単一源**
  //    （`sequenceProgress` の `checkExpiredGrantState`）に任せる。
  //    ここで日付を比較すると、Airtable 側と JS 側で 2 つの判定が生まれる。
  const expiredGrant = resolveExpiredGrantRequirement(campaign);
  if (expiredGrant) clauses.push(grantTraceClause(expiredGrant.tier));

  const cohort = campaign.requiresImportCohort;
  if (cohort) {
    clauses.push(`FIND('${COHORT_SOURCE_PREFIX}', {Source}) = 1`);
    const ids = Array.isArray(cohort.batchIds) ? cohort.batchIds.filter(Boolean) : [];
    if (ids.length > 0) {
      const ors = ids.map((id) => `{Source} = '${COHORT_SOURCE_PREFIX}${escapeFormulaValue(id)}'`);
      clauses.push(`OR(${ors.join(', ')})`);
    }
  }

  if (clauses.length === 0) return null;
  return {
    formula: clauses.length === 1 ? clauses[0] : `AND(${clauses.join(', ')})`,
    clauses,
  };
}

/** 上の formula と同じ判定を JS で行う（テスト用の鏡） */
export function campaignAudienceFormulaAccepts(campaign, fields) {
  const built = buildCampaignAudienceFormula(campaign);
  if (!built) return true;                 // 絞り込まない = 全員通す
  const f = fields || {};

  const grant = resolveGrantRequirement(campaign);
  if (grant && !hasGrantTrace(f, grant.tier)) return false;

  const expiredGrant = resolveExpiredGrantRequirement(campaign);
  if (expiredGrant && !hasGrantTrace(f, expiredGrant.tier)) return false;

  const cohort = campaign.requiresImportCohort;
  if (cohort) {
    const src = str(f.Source);
    if (!src.startsWith(COHORT_SOURCE_PREFIX)) return false;
    const ids = Array.isArray(cohort.batchIds) ? cohort.batchIds.filter(Boolean) : [];
    if (ids.length > 0 && !ids.some((id) => src === `${COHORT_SOURCE_PREFIX}${id}`)) return false;
  }
  return true;
}

/**
 * 付与の引き継ぎ（`grantOperationId`）で「その回に付与された人」だけを引く formula。
 * 全件走査して operationId を突き合わせる必要は無い。
 */
export function buildGrantOperationFormula(operationId) {
  const op = escapeFormulaValue(operationId);
  if (!op) return null;
  return `OR({${GRANT_FIELDS.light.op}} = '${op}', {${GRANT_FIELDS.premium.op}} = '${op}')`;
}

/** JS 鏡 */
export function grantOperationFormulaAccepts(operationId, fields) {
  const op = str(operationId);
  if (!op) return false;
  const f = fields || {};
  return str(f[GRANT_FIELDS.light.op]) === op || str(f[GRANT_FIELDS.premium.op]) === op;
}

export { GRANT_FIELDS };
