/**
 * sequenceProgress.js — 「誰がいま何ステップ目か」を**送信の事実から導く**（純粋・I/O なし）
 *
 * ── 進行状態の正本を新しく作らない ────────────────────────────
 * 進行を別テーブルに持つと、送信の事実（`CampaignDeliveries`）とズレた瞬間に
 * 二重送信か送信漏れになる。そこで **状態を保存せず、毎回導出する**:
 *
 *   送った step   = DeliveryKey が `CampaignDeliveries` にある step（sent / queued）
 *   いまの step   = 送った step の最大値
 *   次の step     = いまの step + 1（未送信なら 1）
 *   次回予定      = 直近の送信時刻 + 次 step の delayDays
 *
 * DeliveryKey は campaign × version × **step** × 受信者 で一意なので、
 * 何度実行しても同じ答えになり、二重 queue が構造的に起きない。
 *
 * ── 止める条件（1 つでも当たれば以降のステップを送らない）──────────
 * 強い順に評価し、**最初に当たった理由だけ**を数える（理由の奪い合いをさせない）。
 *   1. 配信停止・ブラックリスト・停止アカウント・アドレス不正（`marketing.sendable`）
 *   2. 配信基盤の suppression / ソフトバウンス
 *   3. **購入済み**（有料契約が有効になった = このシーケンスの目的を達成）
 *   3-b. **無料体験の状態**（`requiresActiveGrant` を宣言したシーケンスだけ）
 *        まだ付与されていない → `grant_required` / 期間が終わった → `grant_expired` /
 *        取り消された → `grant_revoked` / **期限なし（lifetime）** → `grant_lifetime`
 *        （`termedOnly: true` の宣言時。「無料期間は◯日まで」と書けない相手は対象外）
 *        ⚠️ **シーケンスは無料付与を行わない**。付与は管理画面（`admin-comeback-grants`）
 *           だけが行い、`operationId` で冪等。したがって二重付与は構造的に起きない
 *   3-c. **対象コホート**（`requiresImportCohort` を宣言したシーケンスだけ）
 *        CSV 取り込みの会員でなければ `not_in_cohort`
 *   4. 対象条件から外れた（プラン・契約状態の変化。`enforce` のときだけ）
 *   5. **反応なし**（engagement INACTIVE / HARD_INACTIVE）
 *      ⚠️ UNKNOWN・計測不足では**止めない**。判定 Map が渡されなければ素通り
 *   6. 上限到達（maxSends）/ 全ステップ送信済み → 完了
 *   7. キャンペーン停止中
 */

import {
  isSequenceCampaign, getSequenceSteps, resolveMaxSends, resolveSequenceStep,
  computeNextSendAtMs,
} from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { matchesCampaignAudience, isCampaignUsable } from './campaignCatalog.js';
import { classifyEngagement, isBlockedByEngagement } from './engagementPolicy.js';
import { resolveRoutedStep } from '../drm/drmRouting.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';
import { matchesImportCohort, COHORT_SKIP_LABEL } from '../crm/importedCohort.js';

/** 受信者ごとの状態 */
export const SEQ_STATUS = Object.freeze({
  /** いま次のステップを送れる */
  DUE: 'due',
  /** 次のステップはあるが、まだ間隔が空いていない */
  WAITING: 'waiting',
  /** 規定回数まで送り終えた */
  COMPLETED: 'completed',
  /** 途中で止めた（理由つき） */
  STOPPED: 'stopped',
});

/** 停止理由（画面にそのまま出す） */
export const SEQ_STOP = Object.freeze({
  NOT_SENDABLE: 'not_sendable',
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  SOFT_BOUNCE: 'soft_bounce',
  PURCHASED: 'purchased',
  GRANT_REQUIRED: 'grant_required',
  GRANT_EXPIRED: 'grant_expired',
  GRANT_REVOKED: 'grant_revoked',
  GRANT_LIFETIME: 'grant_lifetime',
  /** 終了後フェーズ用: **まだ体験中**（体験中フェーズが担当する） */
  GRANT_STILL_ACTIVE: 'grant_still_active',
  NOT_IN_COHORT: 'not_in_cohort',
  AUDIENCE_MISMATCH: 'audience_mismatch',
  ENGAGEMENT_BLOCKED: 'engagement_blocked',
  CAMPAIGN_DISABLED: 'campaign_disabled',
  MAX_SENDS_REACHED: 'max_sends_reached',
});

export const SEQ_STOP_LABEL = Object.freeze({
  not_sendable: '配信停止・バウンス・停止アカウント等で送れない',
  provider_suppressed: '配信基盤の停止リストに載っている',
  soft_bounce: 'ソフトバウンス履歴あり',
  purchased: '購入・契約が有効になったため停止',
  grant_required: '無料体験がまだ始まっていない（無料付与が必要）',
  grant_expired: '無料体験の期間が終了した',
  grant_revoked: '無料付与が取り消されている',
  grant_lifetime: '期限なしの無料付与（30日体験の案内は送らない）',
  grant_still_active: 'まだ無料体験中（終了後の案内はまだ送らない）',
  not_in_cohort: '対象コホート外（CSV 取り込みの会員ではない）',
  audience_mismatch: '対象条件から外れた（プラン・契約状態の変化）',
  engagement_blocked: '反応なしが続いているため停止',
  campaign_disabled: 'キャンペーンが停止中',
  max_sends_reached: '規定回数まで配信済み',
});

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();

/** 送信済みとみなす CampaignDeliveries の状態 */
const SENT_STATUSES = new Set(['sent', 'queued']);

/**
 * `CampaignDeliveries` の行 → `DeliveryKey → {status, atMs}`。
 * **`EmailType='campaign'` 以外は見ない**（取引メールを進行に混ぜない）。
 */
export function indexDeliveries(deliveries) {
  const byKey = new Map();
  for (const rec of Array.isArray(deliveries) ? deliveries : []) {
    const f = (rec && rec.fields) || {};
    if (str(f.EmailType) !== 'campaign') continue;
    const key = str(f.DeliveryKey);
    if (!key) continue;
    const status = lower(f.Status);
    if (!SENT_STATUSES.has(status)) continue;
    const at = Date.parse(str(f.SentAt) || str(f.QueuedAt) || '');
    const atMs = Number.isFinite(at) ? at : null;
    const cur = byKey.get(key);
    if (!cur || (atMs !== null && (cur.atMs === null || atMs > cur.atMs))) {
      byKey.set(key, { status, atMs });
    }
  }
  return byKey;
}

/**
 * 無料体験（promotional grant）の状態を見る。
 * **判定を作らない**。既存の単一源が出した値をそのまま使う。
 *
 * @returns {string|null} 停止理由（問題なければ null）
 */
export function resolveGrantRequirement(campaign) {
  const raw = campaign && campaign.requiresActiveGrant;
  if (!raw) return null;
  if (typeof raw === 'string') return { tier: raw === 'premium' ? 'premium' : 'light', termedOnly: false };
  const tier = String(raw.tier || 'light') === 'premium' ? 'premium' : 'light';
  return { tier, termedOnly: raw.termedOnly === true };
}

/**
 * `requiresExpiredGrant` の宣言を読む（**体験が終わった人だけ**へ送るフェーズ用）。
 *
 * ⚠️ `requiresActiveGrant` の逆。両方を同時に宣言することはない
 *    （同じ人が「体験中」かつ「体験終了」にはならない）。
 */
export function resolveExpiredGrantRequirement(campaign) {
  const raw = campaign && campaign.requiresExpiredGrant;
  if (!raw) return null;
  if (typeof raw === 'string') return { tier: raw === 'premium' ? 'premium' : 'light' };
  return { tier: String(raw.tier || 'light') === 'premium' ? 'premium' : 'light' };
}

/**
 * 体験が**終わっている**か。終わっていなければ止める理由を返す。
 *
 * 送ってよいのは「参加した痕跡があり、期限が切れている」人だけ:
 *   - 痕跡が無い            → `grant_required`（そもそも体験していない）
 *   - まだ有効             → `grant_still_active`（体験中フェーズの担当）
 *   - 期限なし（lifetime）  → `grant_lifetime`（終わる期間が無い）
 *   - 取り消された          → `grant_revoked`（明確な対象外）
 */
function checkExpiredGrantState({ fields, requirement, nowMs }) {
  const t = requirement.tier;
  const raw = resolvePromotionalGrants(fromAirtableFields(fields).promoFields, nowMs);
  const g = raw[t] || {};
  const grantedAtMs = Number(g.grantedAtMs);
  const untilMs = Number(g.untilMs);

  // 取消は最優先（明確な対象外）
  if (Number.isFinite(g.revokedAtMs)) return SEQ_STOP.GRANT_REVOKED;
  // 参加した痕跡が無い（付与日も終了日も無い）
  if (!Number.isFinite(grantedAtMs) && !Number.isFinite(untilMs)) return SEQ_STOP.GRANT_REQUIRED;
  // 期限なし付与は「終了後」にならない
  if (g.lifetime === true || !Number.isFinite(untilMs)) return SEQ_STOP.GRANT_LIFETIME;
  // まだ期間内 → 体験中フェーズの担当（**脱落ではない**）
  if (untilMs > Number(nowMs)) return SEQ_STOP.GRANT_STILL_ACTIVE;
  return null;   // 期限切れ = このフェーズの対象
}

function checkGrantState({ fields, marketing, requirement, nowMs }) {
  const t = requirement.tier;
  // `resolveCustomerMarketing` が既に解いた値を使う（顧客ごとに解き直さない）。
  // 無い場合だけ entitlement を解く（cron など marketing を持たない経路のため）。
  const m = marketing || null;
  const active = m
    ? (t === 'premium' ? m.promoPremiumActive === true : m.promoLightActive === true)
    : (() => {
      const ent = resolveEntitlements(fromAirtableFields(fields), nowMs);
      return t === 'premium' ? ent.promo.premiumActive : ent.promo.lightActive;
    })();

  const raw = resolvePromotionalGrants(fromAirtableFields(fields).promoFields, nowMs);
  const g = raw[t] || {};

  if (active) {
    // ⚠️ **期限なし（lifetime）は「30日体験」の案内対象ではない。**
    //    「無料期間は◯日まで」と書けないし、体験からの転換という前提も成り立たない。
    if (requirement.termedOnly && g.lifetime === true) return SEQ_STOP.GRANT_LIFETIME;
    if (requirement.termedOnly && !Number.isFinite(g.untilMs)) return SEQ_STOP.GRANT_LIFETIME;
    return null;
  }

  // 止まった理由を区別する（案内の意味が違う）
  if (Number.isFinite(g.revokedAtMs)) return SEQ_STOP.GRANT_REVOKED;
  if (g.expired || Number.isFinite(g.untilMs)) return SEQ_STOP.GRANT_EXPIRED;
  return SEQ_STOP.GRANT_REQUIRED;
}

/** 購入済み（このシーケンスの目的を達成した）か */
function hasPurchased(marketing) {
  const m = marketing || {};
  return m.premiumActive === true || m.lightActive === true;
}

/**
 * 1 人ぶんの進行を出す。
 *
 * @returns {{recordId, email, sentSteps:number[], currentStep:number, nextStep:number|null,
 *            nextSendAtMs:number|null, status:string, stopReason:string|null}}
 */
export function resolveRecipientProgress({
  campaign, customer, deliveredIndex, brand, fromEmail, nowMs,
  providerSuppressed, softBounced, engagementByEmail, engagementThresholds,
  /**
   * 反応で次の訴求を変えるための入力（**任意**）。
   * ⚠️ `campaign.sequence.responseRoutes` が宣言されている campaign でだけ効く。
   *    渡さない / 宣言が無い場合は**従来どおり完全に線形**（既存挙動を 1 ミリも変えない）。
   */
  responseByEmail,
}) {
  const recordId = str(customer && customer.recordId);
  const mk = (customer && customer.marketing) || null;
  const email = lower(mk && mk.email ? mk.email : (customer && customer.fields && customer.fields.Email));
  const steps = getSequenceSteps(campaign);
  const max = resolveMaxSends(campaign);

  const base = {
    recordId, email, sentSteps: [], currentStep: 0, nextStep: null,
    nextSendAtMs: null, status: SEQ_STATUS.STOPPED, stopReason: null,
  };

  // ── 送信済みステップ（事実）──────────────────────────────────
  const sentSteps = [];
  let lastSentAtMs = null;
  if (email) {
    for (const s of steps) {
      const effective = resolveSequenceStep(campaign, s.stepNumber);
      if (!effective) continue;
      const key = computeCampaignDeliveryKey({
        campaign: effective, recipientEmail: email, brand, fromEmail,
      });
      const hit = key ? deliveredIndex.get(key) : null;
      if (!hit) continue;
      sentSteps.push(s.stepNumber);
      if (hit.atMs !== null && (lastSentAtMs === null || hit.atMs > lastSentAtMs)) lastSentAtMs = hit.atMs;
    }
  }
  const currentStep = sentSteps.length ? Math.max(...sentSteps) : 0;
  const stop = (reason) => ({ ...base, sentSteps, currentStep, status: SEQ_STATUS.STOPPED, stopReason: reason });

  // ── 停止条件（強い順）────────────────────────────────────────
  if (!isCampaignUsable(campaign)) return stop(SEQ_STOP.CAMPAIGN_DISABLED);
  if (!email || !mk || mk.sendable !== true) return stop(SEQ_STOP.NOT_SENDABLE);
  if (providerSuppressed instanceof Set && providerSuppressed.has(email)) {
    return stop(SEQ_STOP.PROVIDER_SUPPRESSED);
  }
  if (softBounced instanceof Set && softBounced.has(email)) return stop(SEQ_STOP.SOFT_BOUNCE);
  if (hasPurchased(mk)) return stop(SEQ_STOP.PURCHASED);

  // ── 無料体験の状態（宣言したシーケンスだけ）──────────────────────
  // 判定は既存の単一源だけを使う（`resolveEntitlements` / `resolvePromotionalGrants`）。
  // **ここで付与はしない**（付与は admin-comeback-grants の operationId 冪等な経路のみ）。
  // ── 対象コホート（宣言したシーケンスだけ）──────────────────────
  // 「外部リストから取り込んだ会員だけ」に限定する。判定の正本は取り込み時の
  // `Source`（`crm/importedCohort.js`）。**推測で新しい旗を作らない**。
  const cohort = campaign.requiresImportCohort;
  if (cohort) {
    const batchIds = Array.isArray(cohort.batchIds) ? cohort.batchIds : null;
    const m = matchesImportCohort((customer && customer.fields) || {}, { batchIds });
    if (!m.ok) return stop(SEQ_STOP.NOT_IN_COHORT);
  }

  const requirement = resolveGrantRequirement(campaign);
  if (requirement) {
    const g = checkGrantState({
      fields: (customer && customer.fields) || {}, marketing: mk, requirement, nowMs,
    });
    if (g) return stop(g);
  }

  // ── 無料体験が**終わった**人だけのフェーズ（宣言したシーケンスだけ）──────
  //    判定は同じ単一源（`resolvePromotionalGrants`）を使う。ここで付与も延長もしない。
  const expiredRequirement = resolveExpiredGrantRequirement(campaign);
  if (expiredRequirement) {
    const g = checkExpiredGrantState({
      fields: (customer && customer.fields) || {}, requirement: expiredRequirement, nowMs,
    });
    if (g) return stop(g);
  }

  const audience = matchesCampaignAudience(campaign, mk);
  if (!audience.ok && audience.enforced) return stop(SEQ_STOP.AUDIENCE_MISMATCH);

  // 反応なし。**Map が渡されたときだけ**評価する（UNKNOWN・計測不足では止まらない）
  if (engagementByEmail instanceof Map) {
    const { state } = classifyEngagement(engagementByEmail.get(email) || {}, { thresholds: engagementThresholds });
    if (isBlockedByEngagement(state)) return stop(SEQ_STOP.ENGAGEMENT_BLOCKED);
  }

  // ── 次のステップ ────────────────────────────────────────────
  //    ⚠️ ここへ来た時点で**停止条件は全部通過している**（購入・退会・停止リスト・
  //       バウンス・対象外・engagement は上で `stop()` 済み）。
  //       反応による行き先の変更は**その後**にしか効かない（停止を上書きしない）。
  const linearStep = currentStep + 1;
  let nextStep = linearStep;
  let routed = null;
  const routes = (campaign && campaign.sequence && campaign.sequence.responseRoutes) || null;
  if (Array.isArray(routes) && routes.length > 0) {
    routed = resolveRoutedStep({
      routes,
      response: responseByEmail instanceof Map ? responseByEmail.get(email) : null,
      sentSteps,
      linearStep,
      maxSends: max,
    });
    if (routed && Number.isInteger(routed.step)) nextStep = routed.step;
  }
  if (nextStep > max) {
    return { ...base, sentSteps, currentStep, status: SEQ_STATUS.COMPLETED, stopReason: SEQ_STOP.MAX_SENDS_REACHED };
  }
  const nextSendAtMs = computeNextSendAtMs({ campaign, stepNumber: nextStep, lastSentAtMs, nowMs });
  const due = nextSendAtMs !== null && nextSendAtMs <= Number(nowMs);
  return {
    ...base, sentSteps, currentStep, nextStep, nextSendAtMs,
    status: due ? SEQ_STATUS.DUE : SEQ_STATUS.WAITING,
    stopReason: null,
    /** 反応で選んだ場合だけ入る（**宣言が無ければ null**） */
    routedBy: routed ? routed.routeId : null,
    variant: routed ? routed.variant : null,
    angle: routed ? routed.angle : null,
  };
}

/**
 * シーケンス全体の進行。**下見・自動配信・管理画面がすべてこの 1 関数を使う**
 * （別々に数えると画面の人数と実際に送る人数がズレる）。
 *
 * @returns {{ok, error?, campaignId, version, maxSends, steps, rows, summary}}
 */
export function buildSequenceProgress({
  campaign, selected, deliveries, brand, fromEmail, nowMs,
  providerSuppressed, softBounced, engagementByEmail, engagementThresholds,
  responseByEmail,
}) {
  if (!campaign || !isSequenceCampaign(campaign)) {
    return { ok: false, error: 'not_a_sequence' };
  }
  const deliveredIndex = indexDeliveries(deliveries);
  const steps = getSequenceSteps(campaign);
  const max = resolveMaxSends(campaign);

  const rows = [];
  const seen = new Set();
  for (const c of Array.isArray(selected) ? selected : []) {
    const row = resolveRecipientProgress({
      campaign, customer: c, deliveredIndex, brand, fromEmail, nowMs,
      providerSuppressed, softBounced, engagementByEmail, engagementThresholds,
      responseByEmail,
    });
    // 同一アドレスの重複レコードは 1 人として数える（2 通送らない）
    if (row.email) {
      if (seen.has(row.email)) continue;
      seen.add(row.email);
    }
    rows.push(row);
  }

  const summary = {
    total: rows.length,
    due: 0,
    waiting: 0,
    completed: 0,
    stopped: 0,
    /** 停止理由別 */
    byStopReason: {},
    /** step 別の「いま送れる人数」 */
    dueByStep: {},
    /** step 別の「送信済み人数」（queue 済みを含む） */
    sentByStep: {},
    /** 何通目まで進んだかの分布 */
    byCurrentStep: {},
  };
  for (const s of steps) { summary.dueByStep[s.stepNumber] = 0; summary.sentByStep[s.stepNumber] = 0; }

  for (const r of rows) {
    for (const s of r.sentSteps) summary.sentByStep[s] = (summary.sentByStep[s] || 0) + 1;
    summary.byCurrentStep[r.currentStep] = (summary.byCurrentStep[r.currentStep] || 0) + 1;
    if (r.status === SEQ_STATUS.DUE) {
      summary.due += 1;
      summary.dueByStep[r.nextStep] = (summary.dueByStep[r.nextStep] || 0) + 1;
    } else if (r.status === SEQ_STATUS.WAITING) summary.waiting += 1;
    else if (r.status === SEQ_STATUS.COMPLETED) summary.completed += 1;
    else {
      summary.stopped += 1;
      const k = r.stopReason || 'unknown';
      summary.byStopReason[k] = (summary.byStopReason[k] || 0) + 1;
    }
  }
  // 数え方の検算（崩れていたら画面に出さない）
  summary.balanced = summary.total === summary.due + summary.waiting + summary.completed + summary.stopped;

  return {
    ok: true,
    campaignId: campaign.campaignId,
    version: campaign.version,
    maxSends: max,
    steps: steps.map((s) => s.stepNumber),
    rows,
    summary,
  };
}

/**
 * 次に流すステップと、その対象 recordId。
 *
 * **1 回の実行で送るのは 1 ステップだけ**にする（複数ステップを混ぜると、
 * 1 人に 2 通同時に届く事故が起きうる）。いちばん小さい due ステップを返す。
 *
 * `minStep` を渡すと、それ未満のステップは**候補から外す**。
 * 初回接触（step1）を自動で撃たない運用のとき、step1 待ちの人が居るせいで
 * **step2 以降が永久に止まる**のを避けるために使う。
 *
 * @returns {{step:number|null, recordIds:string[], emails:string[], counts:object}}
 */
export function selectNextDueStep(progress, { maxRecipients, minStep } = {}) {
  if (!progress || progress.ok !== true) return { step: null, recordIds: [], emails: [], counts: {} };
  const floor = Number.isInteger(minStep) && minStep > 0 ? minStep : 1;
  const due = progress.rows.filter((r) => r.status === SEQ_STATUS.DUE
    && Number.isInteger(r.nextStep) && r.nextStep >= floor);
  if (due.length === 0) return { step: null, recordIds: [], emails: [], counts: progress.summary.dueByStep };

  const step = Math.min(...due.map((r) => r.nextStep));
  let picked = due.filter((r) => r.nextStep === step);
  const cap = Number(maxRecipients);
  const truncated = Number.isFinite(cap) && cap > 0 && picked.length > cap;
  if (truncated) picked = picked.slice(0, cap);

  return {
    step,
    recordIds: picked.map((r) => r.recordId).filter(Boolean),
    emails: picked.map((r) => r.email).filter(Boolean),
    counts: progress.summary.dueByStep,
    truncated,
  };
}
