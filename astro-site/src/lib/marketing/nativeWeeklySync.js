/**
 * nativeWeeklySync.js — 元々の会員を週次（`cron-sendgrid-weekly`）の宛先へ入れる**判定と計画**（I/O なし）。
 *
 * 正本: `docs/spec.md`「元々の会員への定期配信 — A を SendGrid Marketing Campaigns で実現する」
 *
 * ## 流れ（1 枠 = 水・土 19:00 JST ごと）
 *
 *   wait      … 枠の `BUILD_LEAD_MS` より前は何もしない（宛先を古くしない）
 *   build     … AK が宛先を判定 → 日付付き list `ak-native-weekly-YYYY-MM-DD` を作り upsert
 *   check     … upsert の job が completed かつ **list 人数 = AK の判定人数** になったら ready
 *   schedule  … ready なら週次 Single Send の宛先へ native list を**足す**
 *   deadline  … 枠の `SCHEDULE_DEADLINE_MS` 前までに ready にならなければ **native を足さずに**予約する
 *               （fail closed。反応した見込み客の週次は止めない）
 *
 * ## 守ること
 *
 * - 判定は既存の単一源だけ（`nativeWeeklyAudience` / `audienceSegments.resolveBaseExclusion` /
 *   `customerMarketingAudience` / `sequenceProgress` / `importCohort`）。ここで基準を作らない
 * - `ak-drm-engaged` に居る人は native list へ入れない（SendGrid の重複排除を安全仕様にしない）
 * - 判定材料（進行・停止リスト・反応済み）が 1 つでも読めなければ **list を作らない**
 * - アドレスは呼び出し内で閉じる。要約・ログは件数と digest だけ
 */

import crypto from 'node:crypto';
import { resolveCohort, COHORT } from './importCohort.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { resolveBaseExclusion } from '../crm/audienceSegments.js';
import { resolveRecipientProgress } from './sequenceProgress.js';
import { resolveNativeWeeklyEligibility } from './nativeWeeklyAudience.js';

import {
  NATIVE_GATE_ENV, NATIVE_LIST_PREFIX, NATIVE_STATE_PREFIX, NATIVE_STATE_LATEST_KEY, isNativeGateOpen,
} from './nativeWeeklyConfig.js';

export { NATIVE_GATE_ENV, NATIVE_LIST_PREFIX, NATIVE_STATE_PREFIX, NATIVE_STATE_LATEST_KEY, isNativeGateOpen };
/** 状態の保持（枠から 14 日で自然に消える） */
export const NATIVE_STATE_TTL_SEC = 14 * 24 * 60 * 60;

/** 宛先を作り始める（枠の 12 時間前から）*/
export const BUILD_LEAD_MS = 12 * 60 * 60 * 1000;
/** ここまでに ready にならなければ native を足さずに予約する（枠の 2 時間前）*/
export const SCHEDULE_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** 古い日付付き list を消すまでの日数（直近の枠の list は残す）*/
export const LIST_RETENTION_DAYS = 7;
/** 1 回の upsert に載せる上限（SendGrid の上限より十分小さく）*/
export const UPSERT_CHUNK = 1000;

export const NATIVE_STAGE = Object.freeze({
  WAIT: 'wait',
  BUILD: 'build',
  CHECK: 'check',
  SCHEDULE_WITH_NATIVE: 'schedule_with_native',
  SCHEDULE_WITHOUT_NATIVE: 'schedule_without_native',
});

export const NATIVE_STATUS = Object.freeze({
  IMPORTING: 'importing',
  READY: 'ready',
  FAILED: 'failed',
  SCHEDULED: 'scheduled',
});

export const NATIVE_FAIL = Object.freeze({
  INPUT_UNAVAILABLE: 'input_unavailable',
  IMPORT_FAILED: 'import_failed',
  COUNT_MISMATCH_AT_DEADLINE: 'count_mismatch_at_deadline',
  EMPTY_AUDIENCE: 'empty_audience',
});

export const nativeListName = (dateKey) => `${NATIVE_LIST_PREFIX}${dateKey}`;
export const nativeStateKey = (dateKey) => `${NATIVE_STATE_PREFIX}slot:${dateKey}`;

/** list 名から枠の日付（YYYY-MM-DD）。native list でなければ null */
export function dateKeyOfNativeList(name) {
  const m = new RegExp(`^${NATIVE_LIST_PREFIX}(\\d{4}-\\d{2}-\\d{2})$`).exec(String(name || ''));
  return m ? m[1] : null;
}

/** アドレス集合の digest（並び順に依らない。アドレスそのものは出さない）*/
export function emailSetDigest(emails) {
  const sorted = [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))].sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };

/**
 * AK が宛先を判定する（純粋）。
 *
 * @param {Partial<{
 *   customers: Array<{id: string, createdTime?: string, fields: object}>,  // 元々の会員（formula で絞った結果）
 *   nowMs: number,
 *   blacklistHard: Set<string>|null, blacklistSoft: Set<string>|null,
 *   providerSuppressed: Set<string>|null,
 *   onboarding: { campaign: object, deliveredIndex: Map|null, brand: string, fromEmail: string, withinDays: number|null },
 *   engagedEmails: Set<string>|null,   // ak-drm-engaged に入っている（入る）見込み客
 * }>} [input]
 * @returns {{ok: true, emails: string[], counts: object, digest: string}
 *          | {ok: false, reason: string, missing: string[]}}
 *   emails はアドレスを含むので**呼び出し内で閉じる**（ログ・応答へ出さない）
 */
export function buildNativeAudience({
  customers, nowMs, blacklistHard, blacklistSoft, providerSuppressed, onboarding, engagedEmails,
} = {}) {
  // 判定材料が 1 つでも無ければ作らない（fail closed。「誰も除外しない」へ倒さない）
  const missing = [];
  if (!(blacklistHard instanceof Set) || !(blacklistSoft instanceof Set)) missing.push('blacklist');
  if (!(providerSuppressed instanceof Set)) missing.push('provider_suppression');
  if (!onboarding || !(onboarding.deliveredIndex instanceof Map) || !onboarding.campaign) missing.push('onboarding_progress');
  if (!onboarding || !Number.isFinite(onboarding.withinDays)) missing.push('onboarding_window');
  if (!(engagedEmails instanceof Set)) missing.push('engaged_list');
  if (!Array.isArray(customers)) missing.push('customers');
  if (missing.length > 0) return { ok: false, reason: NATIVE_FAIL.INPUT_UNAVAILABLE, missing };

  const counts = { records: customers.length, eligible: 0, skip: {}, baseExcluded: {} };
  const emailCount = new Map();
  for (const r of customers) {
    const e = String((r && r.fields && r.fields.Email) || '').trim().toLowerCase();
    if (e) emailCount.set(e, (emailCount.get(e) || 0) + 1);
  }
  const seen = new Set();
  const out = [];
  for (const r of customers) {
    const f = (r && r.fields) || {};
    const e = String(f.Email || '').trim().toLowerCase();
    if (!e) { inc(counts.skip, 'no_email'); continue; }
    if (seen.has(e)) continue;
    seen.add(e);
    if (resolveCohort(f) !== COHORT.EXISTING) { inc(counts.skip, 'not_native'); continue; }

    const mk = resolveCustomerMarketing({ fields: f, nowMs, blacklistEmails: blacklistHard });
    const base = resolveBaseExclusion({
      fields: f, email: e, marketing: mk, duplicate: emailCount.get(e) > 1,
      blacklistHard, blacklistSoft, providerSuppressed,
    });
    const progress = resolveRecipientProgress(/** @type {any} */ ({
      campaign: onboarding.campaign,
      customer: { recordId: r.id, fields: f, marketing: mk },
      deliveredIndex: onboarding.deliveredIndex,
      brand: onboarding.brand, fromEmail: onboarding.fromEmail, nowMs,
      providerSuppressed,
    }));
    const created = Date.parse(String((r && r.createdTime) || ''));
    const verdict = resolveNativeWeeklyEligibility({
      fields: f, marketing: mk, baseExclusion: base, onboardingProgress: progress,
      createdTimeMs: Number.isFinite(created) ? created : null,
      onboardingWithinDays: onboarding.withinDays,
      inEngagedList: engagedEmails.has(e),
      nowMs,
    });
    if (!verdict.eligible) {
      inc(counts.skip, verdict.reason);
      if (verdict.detail) inc(counts.baseExcluded, verdict.detail);
      continue;
    }
    out.push(e);
  }
  out.sort();
  counts.eligible = out.length;
  return { ok: true, emails: out, counts, digest: emailSetDigest(out) };
}

/**
 * いまこの枠で何をするか（純粋）。
 *
 * @param {Partial<{nowMs: number, slotMs: number, state: object|null}>} [input]
 * @returns {{stage: string, reason?: string}}
 */
export function planNativeStage({ nowMs, slotMs, state } = {}) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(slotMs)) return { stage: NATIVE_STAGE.WAIT, reason: 'bad_time' };
  const untilSlot = slotMs - nowMs;
  if (untilSlot > BUILD_LEAD_MS) return { stage: NATIVE_STAGE.WAIT, reason: 'before_build_window' };
  const st = state && state.status;
  if (st === NATIVE_STATUS.SCHEDULED) return { stage: NATIVE_STAGE.WAIT, reason: 'already_scheduled' };
  if (st === NATIVE_STATUS.READY) return { stage: NATIVE_STAGE.SCHEDULE_WITH_NATIVE };
  if (st === NATIVE_STATUS.FAILED) return { stage: NATIVE_STAGE.SCHEDULE_WITHOUT_NATIVE, reason: state.reason || 'failed' };
  if (untilSlot <= SCHEDULE_DEADLINE_MS) {
    return { stage: NATIVE_STAGE.SCHEDULE_WITHOUT_NATIVE, reason: st ? 'deadline_not_ready' : 'deadline_not_built' };
  }
  if (st === NATIVE_STATUS.IMPORTING) return { stage: NATIVE_STAGE.CHECK };
  return { stage: NATIVE_STAGE.BUILD };
}

/**
 * upsert の結果から ready か（純粋）。
 * **job が completed で、かつ list 人数が AK の判定人数と一致**したときだけ ready。
 *
 * @param {Partial<{jobs: Array<{status?: string}>, listCount: number|null, expected: number}>} [input]
 * @returns {{status: 'ready'|'pending'|'failed', reason: string|null}}
 */
export function evaluateImport({ jobs, listCount, expected } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) return { status: 'failed', reason: 'no_jobs' };
  const st = list.map((j) => String((j && j.status) || '').toLowerCase());
  if (st.some((s) => s === 'failed' || s === 'errored')) return { status: 'failed', reason: NATIVE_FAIL.IMPORT_FAILED };
  if (!st.every((s) => s === 'completed')) return { status: 'pending', reason: 'job_pending' };
  if (!Number.isFinite(listCount)) return { status: 'pending', reason: 'count_unavailable' };
  if (listCount !== expected) return { status: 'pending', reason: 'count_mismatch' };
  return { status: 'ready', reason: null };
}

/**
 * 週次 Single Send の宛先（純粋）。native は **ready のときだけ**足す。
 * @returns {string[]}
 */
export function buildSendToListIds({ engagedListId, nativeListId, nativeReady }) {
  const ids = [];
  if (engagedListId) ids.push(String(engagedListId));
  if (nativeReady === true && nativeListId) ids.push(String(nativeListId));
  return [...new Set(ids)];
}

/**
 * 消してよい古い native list（純粋）。
 * - 名前が `ak-native-weekly-YYYY-MM-DD` のものだけ
 * - 枠の日付が `LIST_RETENTION_DAYS` より前
 * - 予約中・下書きの Single Send が参照していない
 *
 * @param {Partial<{lists: Array<{id: string, name: string}>, referencedListIds: Set<string>, nowMs: number}>} [input]
 * @returns {string[]} list id
 */
export function planListCleanup({ lists, referencedListIds, nowMs } = {}) {
  const refs = referencedListIds instanceof Set ? referencedListIds : null;
  if (!refs) return [];                          // 参照を読めなければ消さない
  const cutoff = Number(nowMs) - LIST_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const ids = [];
  for (const l of Array.isArray(lists) ? lists : []) {
    const dk = dateKeyOfNativeList(l && l.name);
    if (!dk) continue;
    const ms = Date.parse(`${dk}T10:00:00Z`);
    if (!Number.isFinite(ms) || ms >= cutoff) continue;
    if (refs.has(String(l.id))) continue;
    ids.push(String(l.id));
  }
  return ids;
}

/** ログ・応答用の要約（件数と digest だけ）*/
export function summarizeNativeAudience(built) {
  if (!built || built.ok !== true) return { ok: false, reason: built && built.reason, missing: built && built.missing };
  return { ok: true, eligible: built.counts.eligible, records: built.counts.records, skip: built.counts.skip, baseExcluded: built.counts.baseExcluded, digest: built.digest };
}

export default buildNativeAudience;
