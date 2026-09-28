/**
 * paymentFunnelCheck.js — 決済ファネルのサーバー側計測が**本番の実申込・実入金確認で記録されたか**を確かめる
 * （kind: payment-funnel-first-record）
 *
 * 2026-09-29 に申込受理（bank-transfer-application）と入金確認（confirm-bank-payment）へ計測を足した
 * （正本 astro-site/docs/GA4_CONVERSION_FUNNEL.md §10）。実際の申込・入金確認が起きるまで確かめられないため、
 * scheduled-checks が毎日**読むだけ**で確認する。
 *
 * 突き合わせ: Airtable Customers の `PaidAt`（反映以降の入金確認の件数・PaidAt 1 項目だけ取得）と、
 *             計測側の `payment_confirmed`（admin-payment-funnel・集計値だけ）。
 *   - Airtable に反映以降の入金確認があるのに計測が 0 → `funnel_missing_confirmation`（記録漏れ＝失敗）
 *   - 申込受理も入金確認もまだ 0 → `no_application_yet`（待機中）
 *   - 申込受理はあるが入金確認がまだ → `no_confirmation_yet`（待機中）
 *   - 両方 1 件以上 → 成功（申込 → 入金確認の両端が本番で記録された）
 */

const BASE = 'apptmQUPAlgZMmBC9';
const TABLE = 'Customers';

export class PaymentFunnelCheckError extends Error {
  constructor(code, detail) { super(`payment-funnel:${code}`); this.code = code; this.detail = detail || null; }
}

/** Airtable の PaidAt が since 以降の件数（純粋）*/
export function countPaidSince(rows, since) {
  return (rows || []).filter((r) => {
    const at = r?.fields?.PaidAt;
    return typeof at === 'string' && at >= since;
  }).length;
}

/** 判定（純粋）。成功なら結果、未発生・記録漏れなら例外 */
export function judgePaymentFunnel({ funnel, paidSince }) {
  const received = Number(funnel?.received) || 0;
  const confirmed = Number(funnel?.confirmed) || 0;
  if (paidSince > 0 && confirmed === 0) {
    throw new PaymentFunnelCheckError('funnel_missing_confirmation', `Airtable では反映以降の入金確認が ${paidSince} 件あるのに、計測の payment_confirmed が 0 件`);
  }
  if (received === 0 && confirmed === 0) {
    throw new PaymentFunnelCheckError('no_application_yet', '反映以降の申込受理・入金確認がまだ 0 件');
  }
  if (confirmed === 0) {
    throw new PaymentFunnelCheckError('no_confirmation_yet', `申込受理 ${received} 件・入金確認はまだ 0 件`);
  }
  return { received, confirmed, paidSince };
}

async function fetchFunnel({ siteUrl, secret, fetchImpl }) {
  if (!secret || !String(secret).trim()) throw new PaymentFunnelCheckError('funnel_secret_missing');
  const res = await fetchImpl(new URL('/.netlify/functions/admin-payment-funnel', siteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-funnel-read-secret': secret },
    body: JSON.stringify({ action: 'summary', days: 90 }),
  });
  if (res.status === 401 || res.status === 403) throw new PaymentFunnelCheckError('funnel_auth_failed', `HTTP ${res.status}`);
  if (res.status === 503) throw new PaymentFunnelCheckError('funnel_measurement_unavailable', 'Redis 未設定');
  if (!res.ok) throw new PaymentFunnelCheckError('funnel_api_error', `HTTP ${res.status}`);
  return res.json();
}

async function fetchPaidRows({ token, since, fetchImpl }) {
  if (!token || !String(token).trim()) throw new PaymentFunnelCheckError('airtable_token_missing');
  const rows = [];
  let offset;
  let pages = 0;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`);
    u.searchParams.set('filterByFormula', `IS_AFTER({PaidAt}, '${since}')`);
    u.searchParams.append('fields[]', 'PaidAt');
    u.searchParams.set('pageSize', '100');
    if (offset) u.searchParams.set('offset', offset);
    // eslint-disable-next-line no-await-in-loop -- ページ送りは直列
    const res = await fetchImpl(u, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) throw new PaymentFunnelCheckError('airtable_auth_failed', `HTTP ${res.status}`);
    if (!res.ok) throw new PaymentFunnelCheckError('airtable_api_error', `HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const j = await res.json();
    rows.push(...(j.records || []));
    offset = j.offset;
    pages += 1;
    if (pages > 50) throw new PaymentFunnelCheckError('too_many_pages');
  } while (offset);
  return rows;
}

export async function runPaymentFunnelCheck({ check, token, secret, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  const since = check.compare.since;
  const funnel = await fetchFunnel({ siteUrl: check.compare.siteUrl, secret, fetchImpl });
  const rows = await fetchPaidRows({ token, since, fetchImpl });
  const paidSince = countPaidSince(rows, since);
  const r = judgePaymentFunnel({ funnel, paidSince });
  return {
    ranAt: nowIso,
    ...r,
    receivedByPlan: funnel.receivedByPlan || {},
    confirmedByPlan: funnel.confirmedByPlan || {},
    confirmLead: funnel.confirmLead || {},
    open: funnel.open || null,
  };
}

export function renderPaymentFunnelMarkdown({ check, result }) {
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks）`,
    `- 確認: admin-payment-funnel の集計値（読み取りのみ）と Airtable \`PaidAt\`（${check.compare.since} 以降・1 項目だけ取得）`,
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| 申込受理（計測）| **${result.received}** |`,
    `| 入金確認（計測）| **${result.confirmed}** |`,
    `| 入金確認（Airtable PaidAt）| ${result.paidSince} |`,
    `| 入金確認待ち（いま）| ${result.open ? result.open.count : '-'} |`,
    '',
    `商品別（申込）: ${JSON.stringify(result.receivedByPlan)}`,
    `商品別（入金確認）: ${JSON.stringify(result.confirmedByPlan)}`,
    `報告→入金確認の日数: ${JSON.stringify(result.confirmLead)}`,
    '',
    '→ 申込受理と入金確認の両端が本番で記録された。以後の集計は admin-payment-funnel（GA4_CONVERSION_FUNNEL.md §10）。',
  ].join('\n');
}
