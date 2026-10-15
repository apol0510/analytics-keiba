/**
 * paypalFirstPurchaseCheck.js — PayPal 月額の本番の初回実購入を read-only で確かめる（kind: paypal-monthly-first-purchase）
 *
 * 2026-10-15 MK: 「販売者本人による PayPal 自己決済テストは行いません。Sandbox E2E は完了済みです。本番の初回実購入が
 * 発生した際に、決済・Webhook・権限付与を read-only で確認してください。顧客の退会操作は行わず、未検証事項は PROGRESS に残してください。」
 *
 * 読むもの（どちらも読むだけ・書かない）:
 *   1. Customers（読み取り専用トークン）: PaymentMethod=PayPal かつ PlanType=Monthly かつ PaidAt あり
 *      = 決済が成立し（PayPal の last_payment が金額・通貨とも一致したときだけ書かれる）権限が付与された会員。
 *      取得する列は権限の 8 項目だけ（メール・氏名は取らない）。
 *   2. admin-payment-funnel `paypalSubscriptionWebhooks`（件数だけ）: 署名検証を通った月額の Webhook を処理した件数。
 *
 * 判定:
 *   - 購入 0 件 → 待機中 `no_paypal_monthly_purchase_yet`（毎日再確認）
 *   - 権限が月額の形と合わない → 失敗 `paypal_grant_mismatch`
 *   - Webhook 0 件 → 最初の PaidAt から 48 時間は待機中 `paypal_webhook_not_seen_yet`、過ぎたら失敗 `paypal_webhook_not_seen`
 *   - それ以外 → 成功（件数・権限の内訳・Webhook の内訳を Issue に記録）
 * 顧客の退会操作は行わない（退会の本番確認は、顧客自身が退会したときに観測する）。
 */

const BASE = 'apptmQUPAlgZMmBC9';
const TABLE = 'Customers';
const FIELDS = ['プラン', 'PlanType', 'Status', '有効期限', 'VenueAccess', 'PaymentMethod', 'PaidAt', 'WithdrawalRequested'];
const WEBHOOK_GRACE_MS = 48 * 3600 * 1000;

export class PaypalFirstPurchaseCheckError extends Error {
  constructor(code, detail) { super(`paypal-first-purchase:${code}`); this.code = code; this.detail = detail || null; }
}

const ymd = (v) => String(v || '').slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const truthy = (v) => v === true || String(v).toLowerCase() === 'true';

/** 1 件の権限が月額の形か（純粋）。問題が無ければ [] */
export function grantProblems(f) {
  const p = [];
  if (String(f['プラン'] || '') !== 'Premium') p.push('プランが Premium でない');
  if (String(f.PlanType || '') !== 'Monthly') p.push('PlanType が Monthly でない');
  if (!['', 'jra', 'nankan'].includes(String(f.VenueAccess || ''))) p.push('VenueAccess が想定外');
  if (truthy(f.WithdrawalRequested)) return p; // 退会済み（顧客自身の退会）: 期限は前日に縮むので期間は見ない
  if (String(f.Status || '').toLowerCase() !== 'active') p.push('Status が active でない');
  const paid = ymd(f.PaidAt);
  const exp = ymd(f['有効期限']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) p.push('有効期限が無い');
  else if (/^\d{4}-\d{2}-\d{2}$/.test(paid)) {
    const d = daysBetween(paid, exp);
    // 支払い日 + 1 ヶ月 + 猶予 2 日（更新があれば先へ延びる）
    if (d < 29) p.push(`有効期限が支払い日から ${d} 日（1 ヶ月 + 2 日に満たない）`);
  }
  return p;
}

/** 集計と判定（純粋）*/
export function judgePaypalFirstPurchase({ rows, webhooks, nowMs }) {
  const list = (rows || []).map((r) => r.fields || {});
  if (list.length === 0) throw new PaypalFirstPurchaseCheckError('no_paypal_monthly_purchase_yet', '本番の PayPal 月額の購入（PaidAt あり）がまだ 0 件');
  const problems = list.map(grantProblems).filter((x) => x.length);
  if (problems.length) throw new PaypalFirstPurchaseCheckError('paypal_grant_mismatch', `${problems.length} 件: ${[...new Set(problems.flat())].join(' / ')}`);
  const firstPaid = list.map((f) => String(f.PaidAt)).sort()[0];
  const total = Number(webhooks?.total) || 0;
  if (total === 0) {
    const late = nowMs - Date.parse(firstPaid) > WEBHOOK_GRACE_MS;
    throw new PaypalFirstPurchaseCheckError(late ? 'paypal_webhook_not_seen' : 'paypal_webhook_not_seen_yet', `購入 ${list.length} 件（最初 ${firstPaid}）・処理した Webhook 0 件`);
  }
  const byVenue = {};
  for (const f of list) { const v = String(f.VenueAccess || '') || '両方'; byVenue[v] = (byVenue[v] || 0) + 1; }
  return {
    purchases: list.length,
    active: list.filter((f) => !truthy(f.WithdrawalRequested)).length,
    withdrawn: list.filter((f) => truthy(f.WithdrawalRequested)).length,
    byVenue,
    firstPaid,
    webhooks: { total, byEvent: webhooks.byEvent || {} },
  };
}

async function fetchRows({ token, fetchImpl }) {
  if (!token || !String(token).trim()) throw new PaypalFirstPurchaseCheckError('airtable_token_missing');
  const rows = [];
  let offset; let pages = 0;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`);
    u.searchParams.set('filterByFormula', 'AND({PaymentMethod} = "PayPal", {PlanType} = "Monthly", NOT({PaidAt} = ""))');
    for (const f of FIELDS) u.searchParams.append('fields[]', f);
    u.searchParams.set('pageSize', '100');
    if (offset) u.searchParams.set('offset', offset);
    // eslint-disable-next-line no-await-in-loop -- ページ送りは直列
    const res = await fetchImpl(u, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) throw new PaypalFirstPurchaseCheckError('airtable_auth_failed', `HTTP ${res.status}`);
    if (!res.ok) throw new PaypalFirstPurchaseCheckError('airtable_api_error', `HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const j = await res.json();
    rows.push(...(j.records || []));
    offset = j.offset; pages += 1;
    if (pages > 20) throw new PaypalFirstPurchaseCheckError('too_many_pages');
  } while (offset);
  return rows;
}

async function fetchWebhooks({ siteUrl, secret, fetchImpl }) {
  if (!secret || !String(secret).trim()) throw new PaypalFirstPurchaseCheckError('funnel_secret_missing');
  const res = await fetchImpl(new URL('/.netlify/functions/admin-payment-funnel', siteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-funnel-read-secret': secret },
    body: JSON.stringify({ action: 'paypalSubscriptionWebhooks' }),
  });
  if (res.status === 401 || res.status === 403) throw new PaypalFirstPurchaseCheckError('funnel_auth_failed', `HTTP ${res.status}`);
  if (!res.ok) throw new PaypalFirstPurchaseCheckError('funnel_api_error', `HTTP ${res.status}`);
  return res.json();
}

export async function runPaypalFirstPurchaseCheck({ check, token, secret, fetchImpl = fetch, now = new Date() }) {
  const rows = await fetchRows({ token, fetchImpl });
  // 購入が無ければ Webhook は読まない（待機中で終わる）
  if (rows.length === 0) return judgePaypalFirstPurchase({ rows, webhooks: null, nowMs: now.getTime() });
  const webhooks = await fetchWebhooks({ siteUrl: check.compare.siteUrl, secret, fetchImpl });
  return { ranAt: now.toISOString(), ...judgePaypalFirstPurchase({ rows, webhooks, nowMs: now.getTime() }) };
}

export function renderPaypalFirstPurchaseMarkdown({ check, result }) {
  const ev = Object.entries(result.webhooks.byEvent)
    .map(([t, e]) => `| ${t} | ${e.count} | ${Object.entries(e.results).map(([r, n]) => `${r}: ${n}`).join(', ')} | ${e.last || '-'} |`);
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks・読み取りのみ）`,
    '- 確認: Customers の PayPal 月額（PaidAt あり・権限 8 項目だけ取得）と、署名検証済み Webhook の処理件数（識別子なし）',
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| 決済が成立し権限が付与された会員 | **${result.purchases}**（利用中 ${result.active}・顧客自身の退会 ${result.withdrawn}） |`,
    `| 会場の内訳 | ${JSON.stringify(result.byVenue)} |`,
    `| 最初の支払い | ${result.firstPaid} |`,
    `| 処理した Webhook | **${result.webhooks.total}** |`,
    '',
    '| Webhook の種別 | 件数 | 処理結果 | 最終受信 |',
    '|---|---|---|---|',
    ...ev,
    '',
    '→ 本番の初回実購入で「決済 → Webhook → 権限付与」が成立したことを read-only で確認した。退会は顧客の操作を待って観測する（Claude は退会させない）。docs/progress.md の未検証事項を更新する。',
  ].join('\n');
}
