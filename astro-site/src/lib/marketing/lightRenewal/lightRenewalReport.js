/**
 * lightRenewalReport.js — リマインドを送った周期ごとの結果（Light 更新率・Light→Premium 転換率）（純粋）
 *
 * 単位は「会員 × 周期（有効期限）」。同じ周期で PRE と POST の 2 通を送っても 1 件と数える。
 *   - converted: Premium へ乗り換えた（`PremiumConvertedAt` が最初の送信以降、または
 *                プランが Premium で `PremiumConvertedFrom` が `Light/` で始まる）
 *   - renewed  : まだ Light で、有効期限が周期より後に延びている
 *   - open     : どちらでもなく、失効後 30 日（乗り換え特典の期限）をまだ過ぎていない＝結論前
 *   - lapsed   : どちらでもなく、失効後 30 日を過ぎた
 * 率は結論が出た周期（renewed + converted + lapsed）を分母にする。
 */
import { normalizePlan } from '../../auth/planNormalization.js';
import { parseCycle, switchDeadlineFor, jstDate, LIGHT_RENEWAL_CAMPAIGN_TYPE } from './lightRenewalPolicy.js';

export const OUTCOME = Object.freeze({ RENEWED: 'renewed', CONVERTED: 'converted', LAPSED: 'lapsed', OPEN: 'open' });

function parseMeta(raw) {
  try { const m = JSON.parse(String(raw || '')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

/**
 * @param {{deliveries: Array<{id?: string, fields: object}>, customersById: Map<string, object>, nowMs?: number}} input
 */
export function summarizeLightRenewalOutcomes({ deliveries, customersById, nowMs = Date.now() }) {
  const today = jstDate(nowMs);
  const groups = new Map();
  for (const r of deliveries || []) {
    const f = r.fields || {};
    if (String(f.CampaignType || '') !== LIGHT_RENEWAL_CAMPAIGN_TYPE) continue;
    if (String(f.Status || '') !== 'sent') continue;
    const cycle = parseMeta(f.Metadata).cycle;
    const rid = String(f.CustomerRecordId || '');
    if (!cycle || !rid) continue;
    const key = `${rid}|${cycle}`;
    const sentAt = String(f.SentAt || '');
    const g = groups.get(key) || { recordId: rid, cycle, firstSentAt: sentAt, stages: new Set() };
    if (sentAt && (!g.firstSentAt || sentAt < g.firstSentAt)) g.firstSentAt = sentAt;
    g.stages.add(parseMeta(f.Metadata).stage || '');
    groups.set(key, g);
  }
  const counts = { renewed: 0, converted: 0, lapsed: 0, open: 0 };
  for (const g of groups.values()) {
    const c = customersById.get(g.recordId) || {};
    const plan = normalizePlan(c['プラン']);
    const convAt = String(c.PremiumConvertedAt || '');
    const converted = (convAt && (!g.firstSentAt || convAt >= g.firstSentAt))
      || (plan === 'premium' && /^Light\//.test(String(c.PremiumConvertedFrom || '')));
    const nowCycle = parseCycle(c['有効期限']);
    let outcome;
    if (converted) outcome = OUTCOME.CONVERTED;
    else if (plan === 'light' && nowCycle && nowCycle > g.cycle) outcome = OUTCOME.RENEWED;
    else if (today > switchDeadlineFor(g.cycle)) outcome = OUTCOME.LAPSED;
    else outcome = OUTCOME.OPEN;
    counts[outcome] += 1;
  }
  const decided = counts.renewed + counts.converted + counts.lapsed;
  const rate = (n) => (decided > 0 ? Math.round((n / decided) * 1000) / 10 : null);
  return {
    cycles: groups.size,
    ...counts,
    decided,
    renewalRatePct: rate(counts.renewed),
    conversionRatePct: rate(counts.converted),
  };
}

/**
 * 集計に要るデータを**読むだけ**で集める（Airtable。読み取り専用トークンでも動く）。
 * 取得するのは配信行の 6 項目と、該当会員の 4 項目だけ（メール・氏名は読まない）。
 */
export function loadLightRenewalReportData({ token, baseId, fetchImpl } = {}) {
  return loadRenewalReportData({
    token, baseId, fetchImpl, campaignType: LIGHT_RENEWAL_CAMPAIGN_TYPE,
    customerFields: ['プラン', '有効期限', 'PremiumConvertedAt', 'PremiumConvertedFrom'],
  });
}

/** 共通: キャンペーンの送信済み配信行と、該当会員の指定項目だけを読む（Premium 月払いでも使う） */
export async function loadRenewalReportData({
  token, baseId = 'apptmQUPAlgZMmBC9', fetchImpl = fetch, campaignType, customerFields,
}) {
  const h = { Authorization: `Bearer ${token}` };
  const list = async (table, formula, fields) => {
    const out = [];
    let offset;
    for (let page = 0; page < 20; page += 1) {
      const u = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
      u.searchParams.set('filterByFormula', formula);
      fields.forEach((f) => u.searchParams.append('fields[]', f));
      if (offset) u.searchParams.set('offset', offset);
      // eslint-disable-next-line no-await-in-loop -- ページ送り
      const res = await fetchImpl(u, { headers: h });
      if (!res.ok) {
        const err = new Error(`airtable_http_${res.status}`);
        err.code = res.status === 401 || res.status === 403 ? 'airtable_auth_failed' : 'airtable_api_error';
        throw err;
      }
      // eslint-disable-next-line no-await-in-loop
      const j = await res.json();
      out.push(...(j.records || []));
      offset = j.offset;
      if (!offset) return out;
    }
    const err = new Error('too_many_pages'); err.code = 'too_many_pages'; throw err;
  };
  const deliveries = await list('CampaignDeliveries',
    `AND({CampaignType}='${campaignType}',{Status}='sent')`,
    ['CampaignType', 'Status', 'Metadata', 'CustomerRecordId', 'SentAt', 'StepNumber']);
  const ids = [...new Set(deliveries.map((r) => String(r.fields?.CustomerRecordId || '')).filter((x) => /^rec[A-Za-z0-9]{14}$/.test(x)))];
  const customersById = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    // eslint-disable-next-line no-await-in-loop -- 20 件ずつ名指し
    const rows = await list('Customers', `OR(${part.map((id) => `RECORD_ID()='${id}'`).join(',')})`,
      customerFields);
    for (const r of rows) customersById.set(r.id, r.fields || {});
  }
  return { deliveries, customersById };
}
