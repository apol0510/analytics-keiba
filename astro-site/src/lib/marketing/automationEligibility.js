/**
 * automationEligibility.js — 自動化の**対象判定と snapshot**（純粋・I/O なし）
 *
 * ── 判定は既存 AK の正本を通す ────────────────────────────────
 * 配信可否（配信停止・バウンス・停止アカウント・テストアカウント・アドレス不正）は
 * **`customerMarketingAudience.resolveCustomerMarketing` が単一源**。ここで再実装しない。
 * キャンペーン固有の追加条件は `campaignAudienceRules` を、そのまま使う。
 *
 * 自動化が足すのは **トリガー条件（期限まで何日か / プラン状態）** と
 * **再送間隔** だけ。「送ってよいか」の判定は 1 ミリも緩めない。
 *
 * ── 会員状態を変えない ────────────────────────────────────────
 * このモジュールは Customers を**読むだけ**。プラン・決済・特典・有効期限を
 * 判定に使うが、**書き込む経路を持たない**（I/O 自体が無い）。
 */

import { createHash } from 'node:crypto';
import {
  resolveCustomerMarketing, MK_SEND, MK_CONTRACT,
} from './customerMarketingAudience.js';
import { TRIGGER_KIND } from './automationCatalog.js';

/** 自動化固有の除外理由（既存 suppression コードとは別空間） */
export const AUTO_SKIP = Object.freeze({
  /** 既存 AK の配信可否で落ちた（配信停止・バウンス等。詳細は suppression コード） */
  SUPPRESSED: 'suppressed',
  /** トリガー日に当たらない */
  TRIGGER_NOT_DUE: 'trigger_not_due',
  /** 有効期限が無く、期限起点のトリガーを評価できない */
  NO_EXPIRY: 'no_expiry',
  /** audienceRule（契約状態 / プラン）に合わない */
  AUDIENCE_MISMATCH: 'audience_mismatch',
  /** 直近に同じ自動化で送っている */
  RECENTLY_SENT: 'recently_sent',
  /** すでにこの配信回で登録済み */
  ALREADY_QUEUED: 'already_queued',
  /** 対象になった後に有料化した（案内が不要になった） */
  BECAME_PAID: 'became_paid',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * audienceRule（契約状態 × プラン）に合うか。
 * `enforce:false` のときは絞り込まない（既存 campaignCatalog と同じ意味）。
 */
export function matchesAudienceRule({ rule, marketing }) {
  const r = rule || {};
  if (r.enforce !== true) return true;
  const contracts = Array.isArray(r.contracts) ? r.contracts : [];
  const plans = Array.isArray(r.plans) ? r.plans : [];
  if (contracts.length > 0 && !contracts.includes(marketing.contract)) return false;
  if (plans.length > 0 && !plans.includes(marketing.plan)) return false;
  return true;
}

/**
 * トリガーが今日に当たるか。**JST の暦日**で判定する。
 * `daysToExpiry` は既存正本（`resolveCustomerMarketing`）が返す値をそのまま使う。
 */
export function isTriggerDue({ trigger, marketing }) {
  const t = trigger || {};
  if (t.kind === TRIGGER_KIND.PLAN_STATE || t.kind === TRIGGER_KIND.MANUAL_CONDITION) {
    return { due: true, reason: null };
  }
  const d = marketing.daysToExpiry;
  if (d === null || d === undefined) return { due: false, reason: AUTO_SKIP.NO_EXPIRY };

  if (t.kind === TRIGGER_KIND.DAYS_BEFORE_EXPIRY) {
    // 期限まで残り days 日。0 は当日
    return { due: d === int(t.days), reason: d === int(t.days) ? null : AUTO_SKIP.TRIGGER_NOT_DUE };
  }
  if (t.kind === TRIGGER_KIND.DAYS_AFTER_EXPIRY) {
    // 期限を過ぎて days 日（daysToExpiry は負になる）
    const after = -int(t.days);
    return { due: d === after, reason: d === after ? null : AUTO_SKIP.TRIGGER_NOT_DUE };
  }
  return { due: false, reason: AUTO_SKIP.TRIGGER_NOT_DUE };
}

/**
 * 1 件が対象か。**除外理由を必ず返す**（画面に件数と理由を出すため）。
 *
 * @param {{
 *   fields: object, definition: object, nowMs: number,
 *   blacklistEmails: Set<string>, history: object,
 *   alreadyQueuedKeys?: Set<string>, recipientKey?: string,
 * }} input
 */
export function evaluateRecipient({
  fields, definition, nowMs, blacklistEmails, history, alreadyQueuedKeys, recipientKey,
}) {
  const marketing = resolveCustomerMarketing({ fields, nowMs, blacklistEmails, history });

  // 1) 既存 AK の配信可否（配信停止・バウンス・停止・テスト・アドレス不正）
  //    ⚠️ `resolveCustomerMarketing` は `resolveSendability` の戻り値を**展開して**返すので、
  //       判定に使うのは `sendable` / `sendState` / `suppressionReasons`（`send` という
  //       プロパティは存在しない）。
  if (marketing.sendable !== true || marketing.sendState !== MK_SEND.SENDABLE) {
    return {
      eligible: false,
      reason: AUTO_SKIP.SUPPRESSED,
      suppressionReasons: marketing.suppressionReasons || [],
      marketing,
    };
  }
  // 2) audienceRule
  if (!matchesAudienceRule({ rule: definition.audienceRule, marketing })) {
    return { eligible: false, reason: AUTO_SKIP.AUDIENCE_MISMATCH, marketing };
  }
  // 3) トリガー
  const t = isTriggerDue({ trigger: definition.trigger, marketing });
  if (!t.due) return { eligible: false, reason: t.reason, marketing };
  // 4) 再送間隔
  const minDays = int(definition.minResendIntervalDays);
  const since = marketing.history ? marketing.history.daysSinceLastSent : null;
  if (minDays > 0 && since !== null && since < minDays) {
    return { eligible: false, reason: AUTO_SKIP.RECENTLY_SENT, marketing };
  }
  // 5) この配信回で既に登録済み（冪等）
  if (alreadyQueuedKeys instanceof Set && recipientKey && alreadyQueuedKeys.has(recipientKey)) {
    return { eligible: false, reason: AUTO_SKIP.ALREADY_QUEUED, marketing };
  }
  return { eligible: true, reason: null, marketing };
}

/**
 * 対象集合を作る。**PII を返さない**（呼び出し側が必要な最小限だけ持つ）。
 *
 * @returns {{ recipients, skipped, counts }}
 */
export function buildAudience({
  records, definition, nowMs, blacklistEmails, historyByEmail, alreadyQueuedKeys, buildKey,
}) {
  const recipients = [];
  const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const rec of (records || [])) {
    const fields = rec && rec.fields ? rec.fields : {};
    const email = String(fields.Email ?? '').trim().toLowerCase();
    const recipientKey = email && typeof buildKey === 'function' ? buildKey(email) : '';
    const history = (historyByEmail && email) ? (historyByEmail[email] || null) : null;

    const v = evaluateRecipient({
      fields, definition, nowMs, blacklistEmails, history, alreadyQueuedKeys, recipientKey,
    });
    if (!v.eligible) { bump(v.reason || 'unknown'); continue; }
    recipients.push({ recordId: rec.id, email, recipientKey });
  }

  return {
    recipients,
    skipped,
    counts: {
      母数: (records || []).length,
      対象: recipients.length,
      除外: Object.values(skipped).reduce((a, b) => a + b, 0),
    },
  };
}

/**
 * 対象 snapshot の指紋。**dry-run と本実行で母集団が変わっていないこと**を検知する。
 * アドレスそのものは含めず、**正規化アドレスの sha256 を並べて畳む**（復元不能）。
 */
export function computeAudienceFingerprint({ automationId, occurrenceDate, campaignId, emails }) {
  const hashes = [...(emails || [])]
    .map((e) => createHash('sha256').update(String(e).trim().toLowerCase(), 'utf8').digest('hex'))
    .sort();
  const seed = [str(automationId), str(occurrenceDate), str(campaignId), String(hashes.length), hashes.join('|')].join('::');
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/**
 * dry-run と本実行の差を判定する。
 * **増えていたら止める**（再承認が必要）。減っている分は安全側なので進んでよい。
 */
export function compareSnapshots({ dryRun, current }) {
  const d = dryRun || {}; const c = current || {};
  const same = str(d.fingerprint) === str(c.fingerprint);
  const grew = int(c.count) > int(d.count);
  return {
    same,
    grew,
    dryRunCount: int(d.count),
    currentCount: int(c.count),
    /** 進んでよいか。同一なら可。減っているだけなら可。増えていたら不可 */
    canProceed: same || (!grew && int(c.count) > 0),
    note: same ? '対象は dry-run と同一です。'
      : (grew ? '対象が増えています。再承認が必要です。' : '対象が減っています（安全側）。'),
  };
}

export default evaluateRecipient;
