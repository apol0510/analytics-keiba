/**
 * prospectMigrationPlan.js — CSV 取り込み分を **prospect プールへ戻す**計画（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-08-27 調査）
 *
 * 本来の方針は「**外部 CSV は Customers へ常駐させず prospect プールで配信し、
 * 反応した人だけ Customers へ昇格する**」（`prospectPolicy.js`）。
 * ところが実際の取り込みは `admin-customer-import` 経由で **Customers へ直接 CREATE** した。
 * 本番実測（2026-08-27）:
 *
 *   Customers 15,976 件 ／ うち `Source='customer-import:…'` が **14,489 件**
 *   prospect プールは **0 件**（`writeEnabled:false` のまま一度も使われていない）
 *
 * ## この計画が決めること
 *
 * 1 件ずつ **「prospect へ戻す」か「Customers に残す」か**を決める。判断材料は
 * 取り込み由来か / 有料化したか / 反応があったか の 3 つだけ。
 *
 * | 判定 | 対象 |
 * |---|---|
 * | `keep_not_imported` | 取り込み由来でない（もとからの顧客）|
 * | `keep_converted` | 有料プラン・入金・無料権利など**顧客になった証拠**がある |
 * | `keep_engaged` | 開封・クリックなど**反応があった**（本来の方針でも昇格対象）|
 * | `keep_suppressed` | 配信停止・バウンス・退会。prospect へ戻さず Customers 側で管理を続ける |
 * | `migrate` | 上のどれにも当たらない = **反応が無いまま残っている取り込み分** |
 *
 * ⚠️ **迷ったら残す（keep）。** prospect へ戻すのは「消しても失うものが無い」と
 *    確認できた行だけ。判断材料が欠けていたら移さない（fail closed）。
 * ⚠️ この関数は **Airtable も Redis も触らない**。計画を返すだけで、
 *    削除は別工程・別承認（`docs/PROSPECT_MIGRATION_PLAN.md`）。
 */

import { resolveCohort, COHORT, importBatchId } from './importCohort.js';

export const MIGRATION_DECISION = Object.freeze({
  MIGRATE: 'migrate',
  KEEP_NOT_IMPORTED: 'keep_not_imported',
  KEEP_CONVERTED: 'keep_converted',
  KEEP_ENGAGED: 'keep_engaged',
  KEEP_SUPPRESSED: 'keep_suppressed',
});

export const DECISION_LABEL = Object.freeze({
  migrate: 'prospect へ戻す',
  keep_not_imported: '取り込み由来でない（残す）',
  keep_converted: '顧客になった（残す）',
  keep_engaged: '反応があった（残す）',
  keep_suppressed: '配信停止・バウンス・退会（残す）',
});

const has = (v) => v !== undefined && v !== null && v !== '' && v !== false;
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 顧客になった証拠（1 つでもあれば残す） */
export function hasCustomerEvidence(fields) {
  const f = fields || {};
  const plan = norm(f['プラン'] ?? f.Plan);
  if (plan && plan !== 'free') return true;                 // 有料プラン
  if (has(f.PaidAt) || f.PaymentConfirmed === true) return true; // 入金
  if (has(f.RequestedPlan) || has(f.RequestedAmount)) return true; // 申込中
  if (f.LifetimeSanrenpuku === true) return true;           // 買い切り
  if (f.LightGrantLifetime === true || has(f.LightGrantUntil)) return true;   // 無料権利
  if (f.PremiumGrantLifetime === true || has(f.PremiumGrantUntil)) return true;
  if (has(f.PremiumPlusEligibility)) return true;           // Premium Plus の販売資格
  if (Number(f['ポイント']) > 0) return true;                // ポイント残高
  if (has(f['最終ログイン'])) return true;                   // ログイン実績
  return false;
}

/** 配信を止めている状態（prospect へ戻さず Customers 側で管理を続ける） */
export function isSuppressed(fields) {
  const f = fields || {};
  if (f.UnsubscribedAnalyticsKeiba === true) return true;
  if (f.WithdrawalRequested === true) return true;
  if (f.ForceLogout === true) return true;
  const status = norm(f.Status ?? f.AccountStatus);
  // 日本語表記も拾う（`entitlements/resolveEntitlements.js` の停止 Status と同じ集合）
  return ['suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled', 'closed', 'withdrawn',
    '停止', '無効', '解約', '退会'].includes(status);
}

/**
 * 1 件ぶんの判定。
 *
 * @param {{ fields: object, engagedEmails?: Set<string> }} input
 * @returns {{ decision: string, reason: string|null, batchId: string|null }}
 */
export function decideForRecord({ fields, engagedEmails } = {}) {
  const f = fields || {};
  const batchId = importBatchId(f.Source);
  if (resolveCohort(f) !== COHORT.IMPORTED) {
    return { decision: MIGRATION_DECISION.KEEP_NOT_IMPORTED, reason: 'not_imported', batchId: null };
  }
  if (hasCustomerEvidence(f)) {
    return { decision: MIGRATION_DECISION.KEEP_CONVERTED, reason: 'customer_evidence', batchId };
  }
  if (isSuppressed(f)) {
    return { decision: MIGRATION_DECISION.KEEP_SUPPRESSED, reason: 'suppressed', batchId };
  }
  const email = norm(f.Email);
  if (engagedEmails instanceof Set && email && engagedEmails.has(email)) {
    return { decision: MIGRATION_DECISION.KEEP_ENGAGED, reason: 'engaged', batchId };
  }
  return { decision: MIGRATION_DECISION.MIGRATE, reason: null, batchId };
}

/**
 * 一覧ぶんの計画。**件数と recordId だけ**を返す（アドレスは持ち回らない）。
 *
 * @param {{ records: Array<{id:string, fields:object}>, engagedEmails?: Set<string> }} input
 */
export function buildMigrationPlan({ records, engagedEmails } = {}) {
  const counts = Object.fromEntries(Object.values(MIGRATION_DECISION).map((d) => [d, 0]));
  const byBatch = {};
  const migrateIds = [];
  for (const r of Array.isArray(records) ? records : []) {
    const { decision, batchId } = decideForRecord({ fields: r && r.fields, engagedEmails });
    counts[decision] += 1;
    if (batchId) {
      byBatch[batchId] = byBatch[batchId] || Object.fromEntries(Object.values(MIGRATION_DECISION).map((d) => [d, 0]));
      byBatch[batchId][decision] += 1;
    }
    if (decision === MIGRATION_DECISION.MIGRATE && r && r.id) migrateIds.push(r.id);
  }
  const total = Array.isArray(records) ? records.length : 0;
  const accounted = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    total,
    counts,
    byBatch,
    migrateIds,
    /** 母数 = 判定の合計。**合わなければ計画を使わない**（取りこぼしの検知） */
    balanced: total === accounted,
  };
}

/**
 * 巻き戻しに必要な項目がそろっているか。
 * **prospect へ移す前に、その行を Customers へ戻せることを確かめる。**
 */
export const ROLLBACK_REQUIRED_FIELDS = Object.freeze(['Email', 'Source']);

export function assertRollbackComplete({ records, migrateIds } = {}) {
  const ids = new Set(Array.isArray(migrateIds) ? migrateIds : []);
  const missing = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!ids.has(r && r.id)) continue;
    for (const f of ROLLBACK_REQUIRED_FIELDS) {
      if (!has((r.fields || {})[f])) { missing.push({ id: r.id, field: f }); break; }
    }
  }
  return { ok: missing.length === 0, missing, checked: ids.size };
}
