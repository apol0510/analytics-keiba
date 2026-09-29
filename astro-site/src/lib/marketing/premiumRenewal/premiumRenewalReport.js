/**
 * premiumRenewalReport.js — リマインドを送った周期ごとの結果（更新率・復帰率）（純粋＋読み取り）
 *
 * 単位は「会員 × 周期（有効期限）」。PRE と POST の 2 通を送っても 1 件。
 *   - renewed : 有効期限が周期より後に延び、最新の入金確認（PaidAt）が**周期の終わりまで**＝期限内に更新
 *   - returned: 有効期限が延びたが、入金確認が**失効後**＝復帰（再開）
 *   - lapsed  : 延びないまま失効後 30 日を過ぎた
 *   - open    : どちらでもなく、失効後 30 日以内＝結論前
 * 年払い等へ切り替えて延びた場合も renewed / returned に数え、`switchedPlanType` に内訳を出す。
 * 率は結論が出た周期（renewed + returned + lapsed）を分母にする。
 */
import { normalizePlan } from '../../auth/planNormalization.js';
import { parseCycle, jstDate, postDeadlineFor, PREMIUM_RENEWAL_CAMPAIGN_TYPE } from './premiumRenewalPolicy.js';
import { loadRenewalReportData } from '../lightRenewal/lightRenewalReport.js';

export const OUTCOME = Object.freeze({ RENEWED: 'renewed', RETURNED: 'returned', LAPSED: 'lapsed', OPEN: 'open' });

function parseMeta(raw) {
  try { const m = JSON.parse(String(raw || '')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

export function summarizePremiumRenewalOutcomes({ deliveries, customersById, nowMs = Date.now() }) {
  const today = jstDate(nowMs);
  const groups = new Map();
  for (const r of deliveries || []) {
    const f = r.fields || {};
    if (String(f.CampaignType || '') !== PREMIUM_RENEWAL_CAMPAIGN_TYPE) continue;
    if (String(f.Status || '') !== 'sent') continue;
    const cycle = parseMeta(f.Metadata).cycle;
    const rid = String(f.CustomerRecordId || '');
    if (!cycle || !rid) continue;
    groups.set(`${rid}|${cycle}`, { recordId: rid, cycle });
  }
  const counts = { renewed: 0, returned: 0, lapsed: 0, open: 0, switchedPlanType: 0 };
  for (const g of groups.values()) {
    const c = customersById.get(g.recordId) || {};
    const nowCycle = parseCycle(c['有効期限']);
    const extended = normalizePlan(c['プラン']) === 'premium' && nowCycle && nowCycle > g.cycle;
    let outcome;
    if (extended) {
      const paidDay = parseCycle(c.PaidAt);
      outcome = paidDay && paidDay > g.cycle ? OUTCOME.RETURNED : OUTCOME.RENEWED;
      if (String(c.PlanType || '').trim().toLowerCase() !== 'monthly') counts.switchedPlanType += 1;
    } else if (today > postDeadlineFor(g.cycle)) outcome = OUTCOME.LAPSED;
    else outcome = OUTCOME.OPEN;
    counts[outcome] += 1;
  }
  const decided = counts.renewed + counts.returned + counts.lapsed;
  const rate = (n) => (decided > 0 ? Math.round((n / decided) * 1000) / 10 : null);
  return {
    cycles: groups.size, ...counts, decided,
    renewalRatePct: rate(counts.renewed),
    returnRatePct: rate(counts.returned),
  };
}

/** 集計に要るデータを読むだけで集める（読み取り専用トークンでも動く・メール / 氏名は読まない） */
export function loadPremiumRenewalReportData({ token, baseId, fetchImpl } = {}) {
  return loadRenewalReportData({
    token, baseId, fetchImpl, campaignType: PREMIUM_RENEWAL_CAMPAIGN_TYPE,
    customerFields: ['プラン', 'PlanType', '有効期限', 'PaidAt'],
  });
}
