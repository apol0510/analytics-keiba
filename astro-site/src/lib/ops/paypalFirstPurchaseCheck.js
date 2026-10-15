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
 *
 * ## 初回の実更新（kind: paypal-monthly-first-renewal・2026-10-15 MK「初回の実更新も適切に確認」）
 * 同じ 2 つを読む（同じ取得関数・同じ登録簿の仕組み。別の監視は作らない）。PayPal は暦の 1 か月ごとの自動課金。
 *   - 会員ごとに「初回だけの期限」= PaidAt（JST）+ 1 か月 + 2 日。
 *     期限がそれより 20 日以上先 → 更新された（2 回目の支払いを PayPal から照会して延ばした）
 *     退会・解約（WithdrawalRequested / CancelledAt）→ 更新の対象外。それ以外 → 更新待ち（請求日 = PaidAt + 1 か月）
 *   - 更新された会員が 1 人でもいれば成功（件数・Webhook の内訳を Issue に記録）
 *   - 更新待ちの最も早い請求日 + 3 日までは待機中 `paypal_renewal_not_due_yet`
 *   - それを過ぎても延びていない: 支払い失敗・停止・解約の Webhook があれば待機中 `paypal_renewal_payment_failed`
 *     （お客様側の決済の失敗。期限は延ばさない仕様どおり）、無ければ失敗 `paypal_renewal_not_seen`
 *   - 全員が更新前に退会・解約 → 待機中 `paypal_no_renewal_candidate`
 */

const BASE = 'apptmQUPAlgZMmBC9';
const TABLE = 'Customers';
const FIELDS = ['プラン', 'PlanType', 'Status', '有効期限', 'VenueAccess', 'PaymentMethod', 'PaidAt', 'WithdrawalRequested', 'CancelledAt'];
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

const RENEWAL_GRACE_DAYS = 3;
const RENEWED_MIN_EXTRA_DAYS = 20;
const plusDaysYmd = (ymdStr, n) => { const d = new Date(`${ymdStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** JST の暦日で n か月後（月末は丸める）。bankPaymentFlow.addMonthsJst と同じ規則（ops は Node 単体で動かすため依存しない） */
export function addMonthsJstYmd(iso, months) {
  const j = new Date(Date.parse(iso) + 9 * 3600 * 1000);
  const y = j.getUTCFullYear(); const m = j.getUTCMonth(); const d = j.getUTCDate();
  const ty = y + Math.floor((m + months) / 12); const tm = ((m + months) % 12 + 12) % 12;
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

/** 会員 1 件の更新の状態（純粋）*/
export function renewalState(f) {
  if (truthy(f.WithdrawalRequested) || String(f.CancelledAt || '').trim()) return { state: 'ended' };
  const paid = String(f.PaidAt || '');
  const exp = ymd(f['有効期限']);
  if (!Number.isFinite(Date.parse(paid)) || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return { state: 'unknown' };
  const due = addMonthsJstYmd(paid, 1);
  const firstExp = plusDaysYmd(due, 2);
  if (daysBetween(firstExp, exp) >= RENEWED_MIN_EXTRA_DAYS) return { state: 'renewed', due, firstExp, exp };
  return { state: 'waiting', due, firstExp, exp };
}

const countResults = (byEvent, types) => types.reduce((n, t) => n + (Number(byEvent?.[t]?.count) || 0), 0);

/** 初回の実更新の判定（純粋）*/
export function judgePaypalFirstRenewal({ rows, webhooks, nowMs }) {
  const list = (rows || []).map((r) => r.fields || {});
  if (list.length === 0) throw new PaypalFirstPurchaseCheckError('no_paypal_monthly_purchase_yet', '本番の PayPal 月額の購入（PaidAt あり）がまだ 0 件');
  const states = list.map(renewalState);
  const n = (k) => states.filter((x) => x.state === k).length;
  const byEvent = webhooks?.byEvent || {};
  const summary = { purchases: list.length, renewed: n('renewed'), waiting: n('waiting'), ended: n('ended'), unknown: n('unknown'), webhooks: { total: Number(webhooks?.total) || 0, byEvent } };
  if (summary.renewed > 0) {
    const first = states.filter((x) => x.state === 'renewed').sort((a, b) => a.due.localeCompare(b.due))[0];
    return { ...summary, firstRenewalDue: first.due, firstRenewedExpiration: first.exp };
  }
  const waiting = states.filter((x) => x.state === 'waiting').sort((a, b) => a.due.localeCompare(b.due));
  if (waiting.length === 0) throw new PaypalFirstPurchaseCheckError('paypal_no_renewal_candidate', `購入 ${list.length} 件・全員が更新前に退会または解約（更新を待つ会員 0）`);
  const due = waiting[0].due;
  const deadline = Date.parse(`${plusDaysYmd(due, RENEWAL_GRACE_DAYS)}T23:59:59+09:00`);
  if (nowMs <= deadline) throw new PaypalFirstPurchaseCheckError('paypal_renewal_not_due_yet', `更新を待つ会員 ${waiting.length} 件・最も早い請求日 ${due}（JST・+${RENEWAL_GRACE_DAYS} 日まで待つ）`);
  const failures = countResults(byEvent, ['BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.CANCELLED']);
  if (failures > 0) throw new PaypalFirstPurchaseCheckError('paypal_renewal_payment_failed', `請求日 ${due} + ${RENEWAL_GRACE_DAYS} 日を過ぎても延びていない会員 ${waiting.length} 件・支払い失敗/停止/解約の Webhook ${failures} 件（お客様側の決済失敗は期限を延ばさない仕様どおり）`);
  throw new PaypalFirstPurchaseCheckError('paypal_renewal_not_seen', `請求日 ${due} + ${RENEWAL_GRACE_DAYS} 日を過ぎても期限が延びた会員 0 件・支払い失敗の Webhook も 0 件`);
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

export async function runPaypalFirstRenewalCheck({ check, token, secret, fetchImpl = fetch, now = new Date() }) {
  const rows = await fetchRows({ token, fetchImpl });
  if (rows.length === 0) return judgePaypalFirstRenewal({ rows, webhooks: null, nowMs: now.getTime() });
  const webhooks = await fetchWebhooks({ siteUrl: check.compare.siteUrl, secret, fetchImpl });
  return { ranAt: now.toISOString(), ...judgePaypalFirstRenewal({ rows, webhooks, nowMs: now.getTime() }) };
}

export function renderPaypalFirstRenewalMarkdown({ check, result }) {
  const ev = Object.entries(result.webhooks.byEvent)
    .map(([t, e]) => `| ${t} | ${e.count} | ${Object.entries(e.results || {}).map(([r, n]) => `${r}: ${n}`).join(', ')} | ${e.last || '-'} |`);
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks・読み取りのみ）`,
    '- 確認: Customers の PayPal 月額（権限の項目だけ取得）の期限が初回分（PaidAt + 1 か月 + 2 日）より先へ延びたか、と署名検証済み Webhook の処理件数',
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| 更新された会員（2 回目の支払いで期限が延びた） | **${result.renewed}** |`,
    `| 更新待ち / 更新前に退会・解約 / 判定不能 | ${result.waiting} / ${result.ended} / ${result.unknown} |`,
    `| 最初の更新の請求日（JST） | ${result.firstRenewalDue} → 期限 ${result.firstRenewedExpiration} |`,
    `| 処理した Webhook | **${result.webhooks.total}** |`,
    '',
    '| Webhook の種別 | 件数 | 処理結果 | 最終受信 |',
    '|---|---|---|---|',
    ...ev,
    '',
    '→ 本番の初回実更新（暦の 1 か月ごとの自動課金 → PAYMENT.SALE.COMPLETED → 期限延長）を read-only で確認した。docs/progress.md の未検証事項を更新する。',
  ].join('\n');
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
