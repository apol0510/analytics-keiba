/**
 * lightTrialAutoGrant.js — Light 30日無料体験の**入口を自動化する計画**（純粋・I/O なし）
 *
 * ── 新しい付与の実装を作らない ────────────────────────────────
 * 付与の形（どの列に何を書くか）・冪等性・除外理由は
 * **`comebackGrantPlan.js`（`buildComebackPlan`）が単一源**。ここがやるのは
 *   1. 対象コホート（CSV 取り込み）に絞る
 *   2. **過去に同じ無料体験を受けた人を外す**
 *   3. 既存 planner へ渡して計画を作る
 *   4. 付与に成功した人だけを Step1 の送信対象として返す
 * だけ。付与フィールドの組み立ては 1 バイトも複製しない。
 *
 * ── 順序の保証（ここが壊れると「使えないのに案内が届く」）──────────
 *   付与（Customers 書き込み）が**成功した recordId だけ**を Step1 の対象にする。
 *   付与前・付与失敗の相手には**絶対にキュー登録しない**。
 *   部分失敗しても、成功したぶんだけが進む（`operationId` と DeliveryKey が
 *   二重付与・二重送信を防ぐ）。
 *
 * ── 冪等性 ──────────────────────────────────────────────────
 *   付与 … `operationId` が同じなら同じ結果（`buildGrantFields` が
 *          `LightGrantOp` を見て `already_applied` を返す）。
 *          さらに現に有効な付与を持つ人は `already_granted` で落ちる
 *   送信 … DeliveryKey（campaign × version × step × 受信者）で 1 通だけ
 *
 * ── ゲート（1 つでも欠ければ**何も書かない**）────────────────────
 *   1. `COMEBACK_GRANT_FIELDS_READY=1`      … 既存の付与ゲート（列の実在）
 *   2. `COMEBACK_GRANT_ENABLED=true`        … 既存の付与ゲート（実行許可）
 *   3. `LIGHT_TRIAL_AUTOGRANT_ENABLED=true` … 自動化そのものの許可
 *   4. `LIGHT_TRIAL_AUTOGRANT_ARMED=<今日の JST 日付>`（翌日には自動的に閉じる）
 *   5. `MARKETING_CAMPAIGN_ENABLED=true`（Step1 のキュー登録に必要）
 *   6. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（実送信の既存ゲート）
 *
 * ⚠️ 1・2 は**手動付与と同じゲート**を再利用する（自動化のために別の抜け道を作らない）。
 */

import { jstDateString } from '../marketing/campaignSend.js';
import { matchesImportCohort, summarizeCohort, assertCohortObservable } from '../crm/importedCohort.js';
import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';
import { resolveFreeGrantHistory } from '../entitlements/freeGrantStatus.js';

/** 1 回の実行で付与する上限（暴走防止。超えたら**切り捨てずに中止**） */
export const MAX_GRANTS_PER_RUN = 100;

/** 自動付与に使う特典（カタログの正本。ここで日数を書かない） */
export const TRIAL_OFFER_ID = 'light-30d-free';

export const AUTOGRANT_ENV = Object.freeze({
  /** 既存の手動付与と同じゲート（自動化のために別の抜け道を作らない） */
  FIELDS_READY: 'COMEBACK_GRANT_FIELDS_READY',
  GRANT_ENABLED: 'COMEBACK_GRANT_ENABLED',
  ENABLED: 'LIGHT_TRIAL_AUTOGRANT_ENABLED',
  ARMED: 'LIGHT_TRIAL_AUTOGRANT_ARMED',
  ENQUEUE: 'MARKETING_CAMPAIGN_ENABLED',
  DISPATCH: 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
});

export const AUTOGRANT_ABORT = Object.freeze({
  GATES_CLOSED: 'gates_closed',
  COHORT_UNVERIFIABLE: 'cohort_unverifiable',
  NO_CANDIDATES: 'no_candidates',
  OVER_MAX: 'over_max_candidates',
  OFFER_UNAVAILABLE: 'offer_unavailable',
});

/** 自動付与の対象外理由（dry-run に必ず件数で出す） */
export const AUTOGRANT_SKIP = Object.freeze({
  NOT_IN_COHORT: 'not_in_cohort',
  PAID_MEMBER: 'paid_member',
  GRANT_ACTIVE: 'grant_active',
  GRANT_LIFETIME: 'grant_lifetime',
  GRANTED_BEFORE: 'granted_before',
  NOT_SENDABLE: 'not_sendable',
});

export const AUTOGRANT_SKIP_LABEL = Object.freeze({
  not_in_cohort: 'CSV 取り込みの会員ではない',
  paid_member: '有料契約が有効（無料体験は不要）',
  grant_active: 'すでに無料期間中',
  grant_lifetime: '期限なしの無料付与を保有',
  granted_before: '過去に無料付与を受けた記録がある（再付与しない）',
  not_sendable: '配信停止・バウンス・停止アカウント等',
});

const str = (v) => String(v ?? '').trim();

/** ゲートの状態。**env の値は返さない**（不足している名前だけ） */
export function readAutoGrantGates(env, nowMs) {
  const e = env || {};
  const fieldsReady = str(e[AUTOGRANT_ENV.FIELDS_READY]) === '1';
  const grantEnabled = e[AUTOGRANT_ENV.GRANT_ENABLED] === 'true';
  const enabled = e[AUTOGRANT_ENV.ENABLED] === 'true';
  const enqueue = e[AUTOGRANT_ENV.ENQUEUE] === 'true';
  const dispatch = e[AUTOGRANT_ENV.DISPATCH] === 'true';
  const today = jstDateString(Number.isFinite(nowMs) ? nowMs : 0);
  const armed = str(e[AUTOGRANT_ENV.ARMED]) === today;
  const missing = [
    !fieldsReady ? AUTOGRANT_ENV.FIELDS_READY : null,
    !grantEnabled ? AUTOGRANT_ENV.GRANT_ENABLED : null,
    !enabled ? AUTOGRANT_ENV.ENABLED : null,
    !armed ? AUTOGRANT_ENV.ARMED : null,
    !enqueue ? AUTOGRANT_ENV.ENQUEUE : null,
    !dispatch ? AUTOGRANT_ENV.DISPATCH : null,
  ].filter(Boolean);
  return {
    fieldsReady, grantEnabled, enabled, armed, enqueue, dispatch, today,
    allOpen: missing.length === 0, missing,
  };
}

/**
 * 1 人ぶんの自動付与可否（**コホートと履歴だけ**を見る）。
 *
 * 退会・強制ログアウト・重複アドレス・アカウント停止などの判定は
 * **`buildComebackPlan` 側の `checkGrantable` が単一源**なので、ここでは重ねない
 * （二重に判定すると理由がズレる）。ここで落とすのは planner が見ない条件だけ。
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function checkAutoGrantCandidate({ fields, marketing, batchIds, nowMs }) {
  const f = fields || {};
  const m = marketing || {};

  if (!matchesImportCohort(f, { batchIds }).ok) {
    return { ok: false, reason: AUTOGRANT_SKIP.NOT_IN_COHORT };
  }
  if (m.sendable !== true) return { ok: false, reason: AUTOGRANT_SKIP.NOT_SENDABLE };
  // 有料契約が有効な人に無料体験は配らない（marketing の paid* は課金契約のみ）
  if (m.premiumActive === true || m.lightActive === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.PAID_MEMBER };
  }

  const grants = resolvePromotionalGrants(f, nowMs);
  if (grants.light.lifetime === true || grants.premium.lifetime === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.GRANT_LIFETIME };
  }
  if (grants.light.active === true || grants.premium.active === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.GRANT_ACTIVE };
  }
  // **過去に受けた人へは原則として再付与しない**（履歴の正本は freeGrantStatus）
  const history = resolveFreeGrantHistory(f, nowMs);
  if (history.light.granted === true || history.premium.granted === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.GRANTED_BEFORE };
  }
  return { ok: true, reason: null };
}

/**
 * 候補の抽出（**書き込みはしない**。dry-run と本実行が同じこの関数を通る）。
 *
 * @param {{ records: Array<{recordId, fields, marketing}>, batchIds?: string[]|null,
 *           nowMs: number, maxGrants?: number }} input
 */
export function selectAutoGrantCandidates({ records, batchIds, nowMs, maxGrants = MAX_GRANTS_PER_RUN }) {
  const rows = Array.isArray(records) ? records : [];
  const cohort = summarizeCohort(rows.map((r) => ({ fields: r.fields })), { batchIds });

  const byReason = {};
  const candidates = [];
  const seenEmail = new Set();
  for (const r of rows) {
    const email = str((r.marketing && r.marketing.email) || (r.fields && r.fields.Email)).toLowerCase();
    const check = checkAutoGrantCandidate({ fields: r.fields, marketing: r.marketing, batchIds, nowMs });
    if (!check.ok) { byReason[check.reason] = (byReason[check.reason] || 0) + 1; continue; }
    // 同一アドレスの重複レコードは 1 人ぶんだけ（planner 側でも弾くが、件数を合わせる）
    if (email && seenEmail.has(email)) continue;
    if (email) seenEmail.add(email);
    candidates.push({ recordId: r.recordId, fields: r.fields });
  }

  return {
    cohort,
    candidates,
    counts: {
      scanned: rows.length,
      cohortTotal: cohort.inCohort,
      candidates: candidates.length,
      byReason,
      cap: maxGrants,
      overMax: candidates.length > maxGrants,
    },
  };
}

/**
 * 実行 1 回ぶんの計画。**ここでも何も書かない**（呼び出し側がゲートの内側で実行する）。
 *
 * @param {{ selection: object, gates: object, offer: object|null, maxGrants?: number }} input
 * @returns {{ok: boolean, abort?: string, candidates?: Array, counts?: object}}
 */
export function planAutoGrantRun({ selection, gates, offer, maxGrants = MAX_GRANTS_PER_RUN } = {}) {
  if (!gates || gates.allOpen !== true) {
    return { ok: false, abort: AUTOGRANT_ABORT.GATES_CLOSED, missing: (gates && gates.missing) || [] };
  }
  if (!offer || offer.offerId !== TRIAL_OFFER_ID) {
    return { ok: false, abort: AUTOGRANT_ABORT.OFFER_UNAVAILABLE };
  }
  const sel = selection || {};
  // **コホートを観測できていなければ誰にも付与しない**
  const observable = assertCohortObservable(sel.cohort || {});
  if (!observable.ok) return { ok: false, abort: AUTOGRANT_ABORT.COHORT_UNVERIFIABLE, counts: sel.counts };

  const list = Array.isArray(sel.candidates) ? sel.candidates : [];
  if (list.length === 0) return { ok: false, abort: AUTOGRANT_ABORT.NO_CANDIDATES, counts: sel.counts };
  // 上限超過は**切り捨てずに中止**（部分実行の曖昧さを作らない）
  if (list.length > maxGrants) {
    return { ok: false, abort: AUTOGRANT_ABORT.OVER_MAX, counts: sel.counts, max: maxGrants };
  }
  return { ok: true, candidates: list, counts: sel.counts };
}

/**
 * 付与結果 → **Step1 を送ってよい recordId**。
 *
 * ⚠️ ここが順序保証の要。`buildComebackPlan` の targets のうち
 *    **実際に書き込みへ成功したもの**だけを返す。付与前・失敗分は 1 件も通さない。
 *
 * @param {{ targets: Array<{recordId}>, writtenRecordIds: Iterable<string> }} input
 */
export function recipientsAfterGrant({ targets, writtenRecordIds }) {
  const ok = new Set([...(writtenRecordIds || [])].map(str).filter(Boolean));
  return (Array.isArray(targets) ? targets : [])
    .map((t) => str(t && t.recordId))
    .filter((id) => id && ok.has(id));
}

/** 実行結果の要約（**アドレスも recordId も含めない**） */
export function summarizeAutoGrantRun({ plan, granted = 0, failed = 0, queued = 0 }) {
  return {
    コホート: plan && plan.counts ? plan.counts.cohortTotal : 0,
    付与候補: plan && plan.counts ? plan.counts.candidates : 0,
    付与成功: granted,
    付与失敗: failed,
    Step1登録: queued,
    中止: plan && plan.ok ? null : (plan && plan.abort) || 'unknown',
  };
}
