// メルマガ配信オーディエンス解決（純粋関数、副作用ゼロ）
//
// 役割: countAudience と **完全同一の 5-tier 除外** を行いつつ、
//       matched な顧客の email 配列を返す。
//       preview の matchedCount と、send の対象件数が構造的に一致することを保証する。
//
// countAudience との関係:
//   - countAudience（audience-counter.js）: 件数のみ返す。preview の READ-ONLY count に使う。
//   - resolveAudienceRecipients（本関数）: 件数 + matched email 配列を返す。実送信パスに使う。
//   - 除外条件・優先順は同一（withdrawn → unsubscribe → blacklist → audienceTypeFilter）
//
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §6 / §7
// 2026-05-19 新規作成（safety audit D1/D2/D5 対応）

import { normalizeAudienceType } from '../../../scripts/newsletter/lib/plan-normalizer.mjs';
import { resolveStatus } from '../../../scripts/newsletter/lib/status-resolver.mjs';
import {
  resolvePlanRaw,
  resolveExpiryDate,
  resolveWithdrawalFlag,
  resolveEmail,
  resolveUnsubscribed,
} from '../../../scripts/newsletter/lib/customer-field-resolver.mjs';

/**
 * brand → Airtable Base 名のマッピング
 *   - analytics-keiba ブランドの Customers は analytics-keiba Base に存在
 *   - keiba-intelligence ブランドの Customers は keiba-intelligence Base に存在
 *
 * 2026-05-19: audience-counter.js から移動。
 *   audience-counter.js は本ファイルの薄いラッパーになったため、
 *   定数の所在を「実ロジック側」に揃えて循環 import を避ける。
 */
export const BRAND_TO_BASE_NAME = {
  'analytics-keiba': 'analytics-keiba',
  'keiba-intelligence': 'keiba-intelligence',
};

/**
 * 除外ポリシーの説明（レスポンスに含めて運用透明性を確保）
 * UI / 監査ログ用、計算には使わない
 */
export const EXCLUSION_POLICY = {
  withdrawn: 'SuggestedStatus=withdrawn を除外',
  unsubscribe: 'brand 別 UnsubscribedAnalyticsKeiba / UnsubscribedKeibaIntelligence = true を除外',
  blacklist: 'EmailBlacklist Status が HARD_BOUNCE / COMPLAINT の email を除外',
  blacklistCriteria: ['HARD_BOUNCE', 'COMPLAINT'],
  order: ['withdrawn', 'unsubscribe', 'blacklist', 'audienceTypeFilter'],
};

/**
 * 旧 admin UI の targetPlan / targetMailingList から audienceTypeFilter を計算する。
 *
 * 入力（旧仕様）:
 *   - targetPlan: 'all' | 'free' | 'standard' | 'premium' | 'expired' | 'test' | undefined
 *   - targetMailingList: 'all' | 'expired' | 'test' | MailingList 文字列 | undefined
 *
 * 出力:
 *   - audienceTypeFilter: '*' | 'free' | 'light' | 'standard' | 'premium' | 'premium-combo'
 *                        | 'expired' | 'admin-test'
 *   - 不明値は '*'（safe default = 全 audienceType）にフォールバック
 *
 * 注意: 旧 admin の "退会者" mailingList は意図的にサポートしない。
 *       理由: 退会済みユーザーへの送信は 5-tier 除外の最優先除外ルール（D1）に反する。
 *       期限切れ会員への再エンゲージメントは 'expired' audienceType を使うこと。
 *       'standard' は旧 admin で Premium も含む混乱があったが、新仕様では standard のみ。
 *
 * @param {object} options
 * @param {string|null|undefined} options.targetPlan
 * @param {string|null|undefined} options.targetMailingList
 * @returns {string} audienceTypeFilter
 */
export function mapLegacyTargetToAudienceType({ targetPlan, targetMailingList } = {}) {
  // targetMailingList が 'expired' / 'test' を指す場合は最優先
  const ml = (typeof targetMailingList === 'string' ? targetMailingList.trim().toLowerCase() : '');
  if (ml === 'expired') return 'expired';
  if (ml === 'test') return 'admin-test';

  const tp = (typeof targetPlan === 'string' ? targetPlan.trim().toLowerCase() : '');
  if (tp === 'all' || tp === '*' || tp === '') return '*';
  if (tp === 'free') return 'free';
  if (tp === 'light') return 'light';
  if (tp === 'standard') return 'standard';
  if (tp === 'premium') return 'premium';
  if (tp === 'premium-combo' || tp === 'premium combo') return 'premium-combo';
  if (tp === 'expired') return 'expired';
  if (tp === 'test') return 'admin-test';
  return '*';
}

/**
 * Airtable records を 5-tier 除外して matched email 配列 + 件数を返す（純粋関数）。
 *
 * 除外順（countAudience と同一）:
 *   1. withdrawn  (SuggestedStatus=withdrawn)
 *   2. unsubscribe (brand 別 Unsubscribed* checkbox=true)
 *   3. blacklist  (EmailBlacklist Status ∈ HARD_BOUNCE/COMPLAINT)
 *   4. audienceType フィルタ不一致
 *   5. 全て通過 → matched に追加
 *
 * Email 重複は最後に Set で dedupe（同一アドレスが Customers に複数行存在する場合の保険）。
 *
 * @param {object} options
 * @param {Array<{id: string, fields: object}>} options.records - Airtable records
 * @param {string} options.brand - 'analytics-keiba' | 'keiba-intelligence'
 * @param {string} options.audienceTypeFilter - 'free' | 'light' | ... | '*'
 * @param {string} options.today - YYYY-MM-DD
 * @param {Set<string>} [options.blacklistEmails] - normalized email Set
 * @returns {{
 *   emails: string[],
 *   counts: {
 *     totalCustomers: number,
 *     matchedCount: number,
 *     withdrawnExcluded: number,
 *     unsubscribeExcluded: number,
 *     blacklistExcluded: number,
 *     audienceTypeMismatchSkipped: number,
 *     invalidEmailSkipped: number,
 *     dedupedFromMatched: number,
 *   },
 *   audienceTypeBreakdown: Record<string, number>,
 *   matchedStatusBreakdown: Record<string, number>,
 * }}
 */
export function resolveAudienceRecipients({
  records,
  brand,
  audienceTypeFilter,
  today,
  blacklistEmails = new Set(),
}) {
  if (!Array.isArray(records)) {
    throw new Error('records must be an array');
  }
  const baseName = BRAND_TO_BASE_NAME[brand];
  if (!baseName) {
    throw new Error(`unknown brand: ${brand}`);
  }
  if (!(blacklistEmails instanceof Set)) {
    throw new Error('blacklistEmails must be a Set');
  }
  const isAnalyticsKeiba = baseName === 'analytics-keiba';
  const filterAll = audienceTypeFilter === '*' || audienceTypeFilter === 'all';

  const audienceTypeBreakdown = {};
  const matchedStatusBreakdown = {};
  const matchedEmailsRaw = [];

  let withdrawnExcluded = 0;
  let unsubscribeExcluded = 0;
  let blacklistExcluded = 0;
  let audienceTypeMismatchSkipped = 0;
  let invalidEmailSkipped = 0;

  for (const record of records) {
    const f = record?.fields || {};
    const planRaw = resolvePlanRaw(f);
    const expiryDate = resolveExpiryDate(f, baseName);
    const withdrawalFlag = resolveWithdrawalFlag(f, baseName);
    const currentStatus = (f.Status ?? null) || null;

    const { audienceType } = normalizeAudienceType(planRaw, {
      status: currentStatus,
      expiryDate,
      today,
    });
    const statusResult = resolveStatus({
      currentStatus,
      withdrawalRequested: withdrawalFlag,
      expiryDate,
      today,
      isAnalyticsKeiba,
    });

    const atKey = audienceType ?? '(null/unknown)';
    audienceTypeBreakdown[atKey] = (audienceTypeBreakdown[atKey] || 0) + 1;

    // 1. 退会候補（D1: 旧コードでは送られていた経路）
    if (statusResult.suggestedStatus === 'withdrawn') {
      withdrawnExcluded += 1;
      continue;
    }
    // 2. 配信停止（D1: 旧 unsubscribeFilter="" バグの解消）
    if (resolveUnsubscribed(f, brand)) {
      unsubscribeExcluded += 1;
      continue;
    }
    // 3. EmailBlacklist (HARD_BOUNCE / COMPLAINT)
    const normalizedEmail = resolveEmail(f);
    if (blacklistEmails.size > 0 && normalizedEmail && blacklistEmails.has(normalizedEmail)) {
      blacklistExcluded += 1;
      continue;
    }
    // 4. AudienceType フィルタ不一致
    const matches = filterAll ? audienceType !== null : audienceType === audienceTypeFilter;
    if (!matches) {
      audienceTypeMismatchSkipped += 1;
      continue;
    }
    // 5. matched
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      invalidEmailSkipped += 1;
      continue;
    }
    matchedEmailsRaw.push(normalizedEmail);
    const sKey = currentStatus || '(null/unknown)';
    matchedStatusBreakdown[sKey] = (matchedStatusBreakdown[sKey] || 0) + 1;
  }

  // dedupe（同一 email が複数 Customers レコードに存在しても 1 通だけ送る）
  const emailSet = new Set(matchedEmailsRaw);
  const emails = Array.from(emailSet);
  const dedupedFromMatched = matchedEmailsRaw.length - emails.length;

  return {
    emails,
    counts: {
      totalCustomers: records.length,
      matchedCount: emails.length,
      withdrawnExcluded,
      unsubscribeExcluded,
      blacklistExcluded,
      audienceTypeMismatchSkipped,
      invalidEmailSkipped,
      dedupedFromMatched,
    },
    audienceTypeBreakdown,
    matchedStatusBreakdown,
  };
}
