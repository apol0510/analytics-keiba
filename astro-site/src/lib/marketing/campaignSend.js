/**
 * campaignSend.js — キャンペーン送信対象の確定と冪等性（純粋・I/O なし）
 *
 * 「管理画面のボタンひとつで送れる」UI にしつつ、内部は徹底して fail closed にするための層。
 * ここで**送信対象を最終確定**し、除外を 1 件ずつ理由付きで数える。Function 側はこの
 * 結果をそのまま使い、独自に対象を足したり引いたりしてはいけない。
 *
 * ── 二重送信を防ぐ 4 層 ──────────────────────────────────────────
 *   1. DeliveryKey        受信者 × campaignId × version で一意。CampaignDeliveries に
 *                         performUpsert(fieldsToMergeOn=['DeliveryKey']) するため、
 *                         同じ key は何度実行しても 1 行にしかならない
 *   2. 既送信突合          CampaignDeliveries の sent / queued を事前に除外（skipped-duplicate）
 *   3. planFingerprint     dry-run で確定した「対象集合そのもの」のハッシュ。send は
 *                          このトークン必須で、母集団が 1 人でも変わっていたら 409 で拒否
 *   4. 送信基盤側          ScheduledEmails は PENDING で作られ、実送信は
 *                          NEWSLETTER_AUTOMATION_ENABLED に依存する（本モジュールは送らない）
 *
 * ⚠️ 決済フィールド（PaymentEmailSent / PaymentEmailStatus 等）は**絶対に読まない・書かない**。
 *    マーケティングメールと入金確認メール v2 の状態機械を混同しない。
 */

import { createHash } from 'node:crypto';
import { computeDeliveryKey, normalizeRecipientEmail } from '../newsletter/delivery-key.js';
import { MK_SUPPRESSION_LABEL } from './customerMarketingAudience.js';
import { matchesCampaignAudience } from './campaignCatalog.js';

/** このモジュールが CampaignDeliveries へ書いてよいフィールド（これ以外は構造的に禁止） */
export const CD_WRITABLE_FIELDS = Object.freeze([
  'DeliveryKey', 'CampaignType', 'EmailType', 'RecipientEmail', 'CustomerRecordId',
  'ScheduledEmailJobId', 'ScheduledEmailRecordId', 'Status', 'QueuedAt', 'Metadata',
]);

/**
 * **Customers** で絶対に触れてはいけないフィールド（決済メール v2 / 権限 / 契約 / Plus 販売資格）。
 * このモジュールは Customers へ 1 バイトも書かないが、将来の改変を検知するため名前を固定しておく。
 */
export const MK_FORBIDDEN_CUSTOMER_FIELDS = Object.freeze([
  'PaymentEmailSent', 'PaymentEmailStatus', 'PaymentEmailIdempotencyKey',
  'PaymentEmailProviderMessageId', 'PaymentEmailAttemptCount', 'PaymentEmailLeaseUntil',
  'PaymentConfirmed', 'プラン', 'Plan', 'PlanType', 'Status', 'AccountStatus',
  '有効期限', 'ValidUntil', 'ExpirationDate', 'PaidAt', 'LifetimeSanrenpuku',
  'SanrenpukuPaidAt', 'PremiumPlusEligibility', 'PremiumPlusEligibleAt',
  'PremiumPlusReleaseOverride', 'WithdrawalRequested', 'RequestedPlan',
]);

/**
 * CampaignDeliveries のレコードに現れてはいけない名前。
 * `Status` は CampaignDeliveries 自身の列（queued/sent/…）であり Customers の Status とは
 * 別物なので、許可リストにある名前は自動的に除外する（手で二重管理しない）。
 */
export const MK_FORBIDDEN_DELIVERY_FIELDS = Object.freeze(
  MK_FORBIDDEN_CUSTOMER_FIELDS.filter((f) => !CD_WRITABLE_FIELDS.includes(f)),
);

/** 除外理由（suppression 由来のものは MK_SUPPRESSION をそのまま使う） */
export const MK_EXCLUSION = Object.freeze({
  /** SendGrid 側で suppression 済み（bounce / block / spam / invalid / unsubscribe） */
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  /** AK の EmailBlacklist に SOFT_BOUNCE として記録がある（販促メールでは送らない） */
  SOFT_BOUNCE: 'soft_bounce',
  /** 既に同じ campaign/version で送信済み or 送信予約済み */
  ALREADY_DELIVERED: 'already_delivered',
  /** 同一アドレスが選択内で重複 */
  DUPLICATE: 'duplicate',
  /** キャンペーンの想定対象と契約状態が合わない */
  CONTRACT_MISMATCH: 'contract_mismatch',
  /** キャンペーンの想定対象とプランが合わない */
  PLAN_MISMATCH: 'plan_mismatch',
  /** 選択された recordId が Customers に存在しない */
  UNKNOWN_CUSTOMER: 'unknown_customer',
});

export const MK_EXCLUSION_LABEL = Object.freeze({
  ...MK_SUPPRESSION_LABEL,
  provider_suppressed: 'SendGrid 側で配信停止済み',
  soft_bounce: 'ソフトバウンス履歴あり',
  already_delivered: '送信済み（同一キャンペーン）',
  duplicate: '重複アドレス',
  contract_mismatch: '契約状態が対象外',
  plan_mismatch: 'プランが対象外',
  unknown_customer: '顧客レコード不明',
});

/** 1 回の送信で許可する最大件数（暴走防止。超えたら計画自体を作らない） */
export const MAX_RECIPIENTS_PER_SEND = 500;

/** ScheduledEmails 1 ジョブあたりの宛先数（既存 step 送信と同じ粒度に合わせる） */
export const RECIPIENTS_PER_JOB = 100;

/** JST の YYYY-MM-DD（DeliveryKey の campaignDate に使う） */
export function jstDateString(nowMs) {
  const d = new Date(nowMs + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * キャンペーンの DeliveryKey。
 *
 * ⚠️ campaignDate を含めない（extraKey に campaign:version を入れる代わりに
 *    campaignDate スロットは固定値にする）。日付を入れると翌日に再送できてしまい、
 *    「同じ内容が二度届かない」という保証が消える。**再送したいときは version を上げる。**
 */
export function computeCampaignDeliveryKey({ campaign, recipientEmail, brand, fromEmail }) {
  if (!campaign || !campaign.campaignId) return null;
  const version = Number(campaign.version);
  if (!Number.isFinite(version)) return null;
  try {
    return computeDeliveryKey({
      brand: String(brand || 'analytics-keiba'),
      serviceType: 'marketing',
      campaignType: String(campaign.campaignId),
      // 日付非依存にするための固定トークン（再送は version でのみ表現する）
      campaignDate: 'fixed',
      audienceType: 'admin-selected',
      recipientEmail: String(recipientEmail || ''),
      contentHash: `v${version}`,
      fromEmail: String(fromEmail || ''),
      extraKey: `campaign:${campaign.campaignId}:v${version}`,
    });
  } catch {
    return null; // 必須項目欠落 → 計画に含めない（fail closed）
  }
}

/**
 * 送信対象を最終確定する（純粋関数）。
 *
 * ⚠️ `providerSuppressed` は **必須**。SendGrid 側 suppression を確認できないまま送信計画を
 *    作ってはいけない（AK の EmailBlacklist は Webhook 稼働以降の分しか持たず、実測で
 *    42 名の乖離があった）。未指定・確認失敗のときは `ok:false` で計画自体を作らない。
 *
 * @param {{
 *   campaign: object,
 *   selected: Array<{ recordId: string, fields: object, marketing: object }>,
 *   deliveredKeys?: Set<string>,   既に sent/queued の DeliveryKey
 *   providerSuppressed: Set<string>|null,  SendGrid suppression（null = 確認できなかった）
 *   softBounced?: Set<string>,     AK EmailBlacklist の SOFT_BOUNCE
 *   brand?: string,
 *   fromEmail: string,
 *   nowMs: number,
 * }} input
 * @returns {{
 *   ok: boolean, error?: string,
 *   recipients: Array<{ recordId, email, name, deliveryKey }>,
 *   excluded: Array<{ recordId, reason }>,
 *   counts: { selected, recipients, excluded, byReason: Record<string, number> },
 *   planFingerprint: string,
 * }}
 */
export function buildCampaignPlan({
  campaign, selected, deliveredKeys, providerSuppressed, softBounced, brand, fromEmail, nowMs,
}) {
  const empty = (error) => ({
    ok: false, error, recipients: [], excluded: [],
    counts: { selected: 0, recipients: 0, excluded: 0, byReason: {} },
    planFingerprint: '',
  });
  if (!campaign || !campaign.campaignId) return empty('unknown_campaign');
  if (!Array.isArray(selected)) return empty('invalid_selection');
  if (!fromEmail) return empty('missing_from_email');
  // provider suppression を確認できないまま計画を作らない（fail closed）
  if (!(providerSuppressed instanceof Set)) return empty('provider_suppression_unavailable');

  const delivered = deliveredKeys instanceof Set ? deliveredKeys : new Set();
  const soft = softBounced instanceof Set ? softBounced : new Set();
  const recipients = [];
  const excluded = [];
  const byReason = {};
  const seenEmails = new Set();

  const exclude = (recordId, reason) => {
    excluded.push({ recordId, reason });
    byReason[reason] = (byReason[reason] || 0) + 1;
  };

  for (const item of selected) {
    const recordId = item && item.recordId ? String(item.recordId) : '';
    const m = item && item.marketing;
    if (!recordId || !m) { exclude(recordId, MK_EXCLUSION.UNKNOWN_CUSTOMER); continue; }

    // 1. suppression（配信停止 / blacklist / 退会 / 停止 / test / email 不正）
    if (!m.sendable) {
      exclude(recordId, m.suppressionReasons[0] || MK_EXCLUSION.UNKNOWN_CUSTOMER);
      continue;
    }

    // 2. キャンペーンの想定対象（enforce のときだけ除外。それ以外は通す）
    const audience = matchesCampaignAudience(campaign, m);
    if (!audience.ok && audience.enforced) {
      exclude(recordId, audience.reason === 'plan_mismatch'
        ? MK_EXCLUSION.PLAN_MISMATCH : MK_EXCLUSION.CONTRACT_MISMATCH);
      continue;
    }

    const email = normalizeRecipientEmail(m.email || '');

    // 3. provider 側 suppression（AK の台帳より広い。ここが最後の砦ではなく最初の砦）
    if (providerSuppressed.has(email)) { exclude(recordId, MK_EXCLUSION.PROVIDER_SUPPRESSED); continue; }
    // 3-b. AK 台帳のソフトバウンス。販促メールは送らない側へ倒す（取引メールとは基準を分ける）
    if (soft.has(email)) { exclude(recordId, MK_EXCLUSION.SOFT_BOUNCE); continue; }

    // 4. 選択内の重複アドレス
    if (seenEmails.has(email)) { exclude(recordId, MK_EXCLUSION.DUPLICATE); continue; }

    // 5. 既送信（同一 campaignId × version）
    const deliveryKey = computeCampaignDeliveryKey({ campaign, recipientEmail: email, brand, fromEmail });
    if (!deliveryKey) { exclude(recordId, MK_EXCLUSION.UNKNOWN_CUSTOMER); continue; }
    if (delivered.has(deliveryKey)) { exclude(recordId, MK_EXCLUSION.ALREADY_DELIVERED); continue; }

    seenEmails.add(email);
    recipients.push({
      recordId,
      email,
      name: (item.fields && (item.fields['氏名'] || '')) || '',
      deliveryKey,
    });
  }

  if (recipients.length > MAX_RECIPIENTS_PER_SEND) {
    return empty(`too_many_recipients:${recipients.length}>${MAX_RECIPIENTS_PER_SEND}`);
  }

  return {
    ok: true,
    recipients,
    excluded,
    counts: {
      selected: selected.length,
      recipients: recipients.length,
      excluded: excluded.length,
      byReason,
    },
    planFingerprint: computePlanFingerprint({ campaign, recipients }),
  };
}

/**
 * dry-run → send の受け渡しトークン。
 * 対象集合・キャンペーン・version のいずれかが変わればトークンも変わる。
 * send は管理画面から渡されたトークンが再計算値と一致しないと実行しない（TOCTOU 防止）。
 */
export function computePlanFingerprint({ campaign, recipients }) {
  const keys = (recipients || []).map((r) => r.deliveryKey).sort();
  const seed = [
    String(campaign?.campaignId || ''),
    `v${campaign?.version ?? ''}`,
    String(keys.length),
    ...keys,
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/** fields が CampaignDeliveries の許可フィールドだけで構成されているか（PATCH 直前の最終防衛） */
export function assertOnlyDeliveryFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  const allow = new Set(CD_WRITABLE_FIELDS);
  return keys.every((k) => allow.has(k));
}

/**
 * CampaignDeliveries へ upsert する records を組み立てる（Customers は触らない）。
 * Status は 'queued'（実送信は送信基盤が行い、reconcile が sent へ進める）。
 */
export function buildDeliveryRecords({ campaign, recipients, jobIdByEmail, nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const out = [];
  for (const r of recipients || []) {
    const job = (jobIdByEmail && jobIdByEmail.get(r.email)) || null;
    const fields = {
      DeliveryKey: r.deliveryKey,
      CampaignType: `${campaign.campaignId}:v${campaign.version}`,
      EmailType: 'campaign',
      RecipientEmail: r.email,
      CustomerRecordId: r.recordId,
      Status: 'queued',
      QueuedAt: nowIso,
      Metadata: JSON.stringify({ source: 'admin-marketing', campaignId: campaign.campaignId, version: campaign.version }),
    };
    if (job) {
      fields.ScheduledEmailJobId = job.jobId;
      if (job.recordId) fields.ScheduledEmailRecordId = job.recordId;
    }
    if (!assertOnlyDeliveryFields(fields)) continue; // 許可外が混ざったら書かない
    out.push({ fields });
  }
  return out;
}

/** 宛先を ScheduledEmails ジョブ単位に分割する（1 ジョブ RECIPIENTS_PER_JOB 件） */
export function chunkRecipients(recipients, size = RECIPIENTS_PER_JOB) {
  const out = [];
  const list = recipients || [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * CampaignDeliveries レコード群 → 顧客ごとの送信履歴サマリ（純粋）。
 * provider 受理・実配信は区別する（Status='sent' は「送信基盤が処理した」であって配信完了ではない）。
 */
export function summarizeHistory(deliveryRecords) {
  const byEmail = new Map();
  for (const rec of deliveryRecords || []) {
    const f = rec?.fields || {};
    if (f.EmailType !== 'campaign') continue; // step / race_main は対象外
    const email = normalizeRecipientEmail(String(f.RecipientEmail || ''));
    if (!email) continue;
    const sentAt = f.SentAt || f.QueuedAt || null;
    const ms = sentAt ? Date.parse(sentAt) : NaN;
    const cur = byEmail.get(email) || { lastSentAtMs: null, lastCampaignId: null, sentCount: 0 };
    if (f.Status === 'sent' || f.Status === 'queued') {
      cur.sentCount += 1;
      if (Number.isFinite(ms) && (cur.lastSentAtMs === null || ms > cur.lastSentAtMs)) {
        cur.lastSentAtMs = ms;
        cur.lastCampaignId = String(f.CampaignType || '') || null;
      }
    }
    byEmail.set(email, cur);
  }
  return byEmail;
}

/** キャンペーン単位の集計（管理画面の履歴表示用）。 */
export function summarizeCampaignRuns(deliveryRecords) {
  const byCampaign = new Map();
  for (const rec of deliveryRecords || []) {
    const f = rec?.fields || {};
    if (f.EmailType !== 'campaign') continue;
    const key = String(f.CampaignType || '(unknown)');
    const cur = byCampaign.get(key) || { campaignType: key, queued: 0, sent: 0, failed: 0, skipped: 0, lastAt: null };
    const s = String(f.Status || '');
    if (s === 'queued') cur.queued += 1;
    else if (s === 'sent') cur.sent += 1;
    else if (s === 'failed') cur.failed += 1;
    else if (s.startsWith('skipped')) cur.skipped += 1;
    const at = f.SentAt || f.QueuedAt || null;
    if (at && (!cur.lastAt || at > cur.lastAt)) cur.lastAt = at;
    byCampaign.set(key, cur);
  }
  return [...byCampaign.values()].sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}
