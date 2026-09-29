/**
 * premiumRenewalOutcomesCheck.js — Premium 月払いリマインドの成果（更新率・復帰率）を定期に記録する
 * （kind: airtable-premium-renewal-outcomes）
 *
 * 集計は `src/lib/marketing/premiumRenewal/premiumRenewalReport.js` が単一源（ここは読んで書式にするだけ）。
 * まだ 1 通も送っていなければ `no_reminder_sent_yet`（待機中。赤にせず翌日再確認）。
 */
import {
  loadPremiumRenewalReportData, summarizePremiumRenewalOutcomes,
} from '../marketing/premiumRenewal/premiumRenewalReport.js';

export class PremiumRenewalCheckError extends Error {
  constructor(code, detail) { super(`premium_renewal_check:${code}`); this.code = code; this.detail = detail || null; }
}

export async function runPremiumRenewalOutcomesCheck({ check, token, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  if (!token || !String(token).trim()) throw new PremiumRenewalCheckError('airtable_token_missing');
  let data;
  try {
    data = await loadPremiumRenewalReportData({ token, fetchImpl });
  } catch (e) {
    throw new PremiumRenewalCheckError(e && e.code ? e.code : 'airtable_api_error', e && e.message);
  }
  const s = summarizePremiumRenewalOutcomes({ ...data, nowMs: Date.parse(nowIso) });
  if (s.cycles === 0) throw new PremiumRenewalCheckError('no_reminder_sent_yet', 'Premium 月払いリマインドの送信記録がまだ 0 件');
  if (check.compare && check.compare.requireDecided === true && s.decided === 0) {
    throw new PremiumRenewalCheckError('data_not_ready', `送信 ${s.cycles} 周期・結論が出た周期はまだ 0（失効後 30 日待ち）`);
  }
  return { ranAt: nowIso, ...s };
}

export function renderPremiumRenewalOutcomesMarkdown({ check, result }) {
  const pct = (v) => (v === null ? '—（結論が出た周期が 0）' : `${v}%`);
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks）`,
    '- 単位: 会員 × 周期（有効期限）。PRE / POST の 2 通は 1 件。率の分母は結論が出た周期（期限内更新＋復帰＋失効）',
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| リマインドを送った周期 | ${result.cycles} |`,
    `| 期限内に更新 | ${result.renewed} |`,
    `| 失効後に復帰 | ${result.returned} |`,
    `| うち年払い等へ切り替え | ${result.switchedPlanType} |`,
    `| 失効（30 日を過ぎた）| ${result.lapsed} |`,
    `| 結論前（失効後 30 日以内）| ${result.open} |`,
    `| **更新率** | **${pct(result.renewalRatePct)}** |`,
    `| **復帰率** | **${pct(result.returnRatePct)}** |`,
  ].join('\n');
}
