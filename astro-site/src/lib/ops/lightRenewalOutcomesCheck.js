/**
 * lightRenewalOutcomesCheck.js — Light 月払いリマインドの成果（更新率・転換率）を定期に記録する
 * （kind: airtable-light-renewal-outcomes）
 *
 * 集計は `src/lib/marketing/lightRenewal/lightRenewalReport.js` が単一源（ここは読んで書式にするだけ）。
 * まだ 1 通も送っていなければ `no_reminder_sent_yet`（待機中。赤にせず翌日再確認）。
 */
import {
  loadLightRenewalReportData, summarizeLightRenewalOutcomes,
} from '../marketing/lightRenewal/lightRenewalReport.js';

export class LightRenewalCheckError extends Error {
  constructor(code, detail) { super(`light_renewal_check:${code}`); this.code = code; this.detail = detail || null; }
}

export async function runLightRenewalOutcomesCheck({ check, token, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  if (!token || !String(token).trim()) throw new LightRenewalCheckError('airtable_token_missing');
  let data;
  try {
    data = await loadLightRenewalReportData({ token, fetchImpl });
  } catch (e) {
    throw new LightRenewalCheckError(e && e.code ? e.code : 'airtable_api_error', e && e.message);
  }
  const s = summarizeLightRenewalOutcomes({ ...data, nowMs: Date.parse(nowIso) });
  if (s.cycles === 0) throw new LightRenewalCheckError('no_reminder_sent_yet', 'Light 月払いリマインドの送信記録がまだ 0 件');
  return { ranAt: nowIso, ...s };
}

export function renderLightRenewalOutcomesMarkdown({ check, result }) {
  const pct = (v) => (v === null ? '—（結論が出た周期が 0）' : `${v}%`);
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks）`,
    '- 単位: 会員 × 周期（有効期限）。PRE / POST の 2 通は 1 件と数える。率の分母は結論が出た周期（更新＋乗り換え＋失効）',
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| リマインドを送った周期 | ${result.cycles} |`,
    `| Light を更新 | ${result.renewed} |`,
    `| Premium へ乗り換え | ${result.converted} |`,
    `| 失効（特典期限を過ぎた）| ${result.lapsed} |`,
    `| 結論前（失効後 30 日以内）| ${result.open} |`,
    `| **Light 更新率** | **${pct(result.renewalRatePct)}** |`,
    `| **Light→Premium 転換率** | **${pct(result.conversionRatePct)}** |`,
  ].join('\n');
}
