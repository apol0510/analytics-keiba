/**
 * paddleFirstSubscriptionCheck.js — Paddle 定期課金（月額・年額・2026-11-02 MK 確定）の本番の初回実購入・初回実更新を read-only で確かめる
 *   kind: paddle-subscription-first-purchase / paddle-subscription-first-renewal
 *
 * 2026-11-02 MK: 「実顧客への試験課金・不要な本番契約作成は行わず、初回の実購入・更新は read-only 監視で確認する方式を維持」。
 * PayPal の監視（paypalFirstPurchaseCheck.js）と同じ仕組み・同じ判定の考え方。読むのは Customers（読み取り専用トークン）だけ:
 *   PaymentMethod=Paddle かつ PlanType=Monthly/Annual かつ PaidAt あり = Paddle の通知を中立サイトが照会し、本番の内部付与が書いた会員
 *   （この経路以外に PaymentMethod=Paddle の定期課金を書く処理は無い＝付与があれば「決済 → 通知 → 付与」が成立している）。
 *   取得する列は権限の項目だけ（メール・氏名は取らない）。顧客の退会・返金は行わない。
 *
 * 判定（初回購入）: 0 件 → 待機中 `no_paddle_subscription_purchase_yet` ／ 権限の形が違う → 失敗 `paddle_grant_mismatch` ／ それ以外 → 成功
 * 判定（初回更新）: 初回分の期限（PaidAt（JST）+ 1 か月 or 12 か月 + 2 日）より 20 日以上先へ延びた会員がいれば成功。
 *   最も早い請求日 + 3 日までは待機中 `paddle_renewal_not_due_yet`、過ぎても延びなければ失敗 `paddle_renewal_not_seen`
 *   （Paddle 側の支払い失敗は延ばさない仕様。失敗 Issue で Claude が Paddle の取引・通知を調査する）。全員が更新前に終了 → 待機中。
 */
import { addMonthsJstYmd } from './paypalFirstPurchaseCheck.js';

const BASE = 'apptmQUPAlgZMmBC9';
const TABLE = 'Customers';
const FIELDS = ['プラン', 'PlanType', 'Status', '有効期限', 'VenueAccess', 'PaymentMethod', 'PaidAt', 'WithdrawalRequested', 'CancelledAt'];
const RENEWAL_GRACE_DAYS = 3;
const RENEWED_MIN_EXTRA_DAYS = 20;

export class PaddleFirstSubscriptionCheckError extends Error {
  constructor(code, detail) { super(`paddle-first-subscription:${code}`); this.code = code; this.detail = detail || null; }
}
const ymd = (v) => String(v || '').slice(0, 10);
const truthy = (v) => v === true || String(v).toLowerCase() === 'true';
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const plusDaysYmd = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthsOf = (f) => (String(f.PlanType || '') === 'Annual' ? 12 : 1);

/** 1 件の権限が Paddle 定期課金の形か（純粋）。問題が無ければ [] */
export function paddleGrantProblems(f) {
  const p = [];
  if (String(f['プラン'] || '') !== 'Premium') p.push('プランが Premium でない');
  if (!['Monthly', 'Annual'].includes(String(f.PlanType || ''))) p.push('PlanType が Monthly / Annual でない');
  if (String(f.PlanType || '') === 'Annual' && String(f.VenueAccess || '') !== '') p.push('年額なのに会場が限定されている');
  if (!['', 'jra', 'nankan'].includes(String(f.VenueAccess || ''))) p.push('VenueAccess が想定外');
  if (truthy(f.WithdrawalRequested) || String(f.CancelledAt || '').trim()) return p; // 退会・解約済みは期間を見ない
  if (String(f.Status || '').toLowerCase() !== 'active') p.push('Status が active でない');
  const paid = ymd(f.PaidAt);
  const exp = ymd(f['有効期限']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) p.push('有効期限が無い');
  else if (/^\d{4}-\d{2}-\d{2}$/.test(paid)) {
    const min = monthsOf(f) === 12 ? 360 : 29;
    const d = daysBetween(paid, exp);
    if (d < min) p.push(`有効期限が支払い日から ${d} 日（1 期間 + 2 日に満たない）`);
  }
  return p;
}

export function judgePaddleFirstPurchase({ rows }) {
  const list = (rows || []).map((r) => r.fields || {});
  if (list.length === 0) throw new PaddleFirstSubscriptionCheckError('no_paddle_subscription_purchase_yet', '本番の Paddle 定期課金の購入（PaidAt あり）がまだ 0 件');
  const problems = list.map(paddleGrantProblems).filter((x) => x.length);
  if (problems.length) throw new PaddleFirstSubscriptionCheckError('paddle_grant_mismatch', `${problems.length} 件: ${[...new Set(problems.flat())].join(' / ')}`);
  const by = {};
  for (const f of list) { const k = `${f.PlanType}/${String(f.VenueAccess || '') || '両方'}`; by[k] = (by[k] || 0) + 1; }
  return {
    purchases: list.length,
    active: list.filter((f) => !truthy(f.WithdrawalRequested) && !String(f.CancelledAt || '').trim()).length,
    ended: list.filter((f) => truthy(f.WithdrawalRequested) || String(f.CancelledAt || '').trim()).length,
    byPlan: by,
    firstPaid: list.map((f) => String(f.PaidAt)).sort()[0],
  };
}

export function paddleRenewalState(f) {
  if (truthy(f.WithdrawalRequested) || String(f.CancelledAt || '').trim()) return { state: 'ended' };
  const paid = String(f.PaidAt || '');
  const exp = ymd(f['有効期限']);
  if (!Number.isFinite(Date.parse(paid)) || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return { state: 'unknown' };
  const due = addMonthsJstYmd(paid, monthsOf(f));
  const firstExp = plusDaysYmd(due, 2);
  return daysBetween(firstExp, exp) >= RENEWED_MIN_EXTRA_DAYS ? { state: 'renewed', due, firstExp, exp } : { state: 'waiting', due, firstExp, exp };
}

export function judgePaddleFirstRenewal({ rows, nowMs }) {
  const list = (rows || []).map((r) => r.fields || {});
  if (list.length === 0) throw new PaddleFirstSubscriptionCheckError('no_paddle_subscription_purchase_yet', '本番の Paddle 定期課金の購入（PaidAt あり）がまだ 0 件');
  const states = list.map(paddleRenewalState);
  const n = (k) => states.filter((x) => x.state === k).length;
  const summary = { purchases: list.length, renewed: n('renewed'), waiting: n('waiting'), ended: n('ended'), unknown: n('unknown') };
  if (summary.renewed > 0) {
    const first = states.filter((x) => x.state === 'renewed').sort((a, b) => a.due.localeCompare(b.due))[0];
    return { ...summary, firstRenewalDue: first.due, firstRenewedExpiration: first.exp };
  }
  const waiting = states.filter((x) => x.state === 'waiting').sort((a, b) => a.due.localeCompare(b.due));
  if (waiting.length === 0) throw new PaddleFirstSubscriptionCheckError('paddle_no_renewal_candidate', `購入 ${list.length} 件・全員が更新前に退会または解約`);
  const due = waiting[0].due;
  if (nowMs <= Date.parse(`${plusDaysYmd(due, RENEWAL_GRACE_DAYS)}T23:59:59+09:00`)) {
    throw new PaddleFirstSubscriptionCheckError('paddle_renewal_not_due_yet', `更新を待つ会員 ${waiting.length} 件・最も早い請求日 ${due}（JST・+${RENEWAL_GRACE_DAYS} 日まで待つ）`);
  }
  throw new PaddleFirstSubscriptionCheckError('paddle_renewal_not_seen', `請求日 ${due} + ${RENEWAL_GRACE_DAYS} 日を過ぎても期限が延びた会員 0 件（Paddle の取引・通知を調査）`);
}

async function fetchRows({ token, fetchImpl }) {
  if (!token || !String(token).trim()) throw new PaddleFirstSubscriptionCheckError('airtable_token_missing');
  const rows = [];
  let offset; let pages = 0;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`);
    u.searchParams.set('filterByFormula', 'AND({PaymentMethod} = "Paddle", OR({PlanType} = "Monthly", {PlanType} = "Annual"), NOT({PaidAt} = ""))');
    for (const f of FIELDS) u.searchParams.append('fields[]', f);
    u.searchParams.set('pageSize', '100');
    if (offset) u.searchParams.set('offset', offset);
    // eslint-disable-next-line no-await-in-loop -- ページ送りは直列
    const res = await fetchImpl(u, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) throw new PaddleFirstSubscriptionCheckError('airtable_auth_failed', `HTTP ${res.status}`);
    if (!res.ok) throw new PaddleFirstSubscriptionCheckError('airtable_api_error', `HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const j = await res.json();
    rows.push(...(j.records || []));
    offset = j.offset; pages += 1;
    if (pages > 20) throw new PaddleFirstSubscriptionCheckError('too_many_pages');
  } while (offset);
  return rows;
}

export async function runPaddleFirstPurchaseCheck({ token, fetchImpl = fetch, now = new Date() }) {
  const rows = await fetchRows({ token, fetchImpl });
  return { ranAt: now.toISOString(), ...judgePaddleFirstPurchase({ rows }) };
}
export async function runPaddleFirstRenewalCheck({ token, fetchImpl = fetch, now = new Date() }) {
  const rows = await fetchRows({ token, fetchImpl });
  return { ranAt: now.toISOString(), ...judgePaddleFirstRenewal({ rows, nowMs: now.getTime() }) };
}

export function renderPaddleFirstPurchaseMarkdown({ check, result }) {
  return [
    `## ${check.title}`, '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks・読み取りのみ）`,
    '- 確認: Customers の Paddle 定期課金（PaidAt あり・権限の項目だけ取得）。この値を書くのは Paddle の通知を照会した本番の内部付与だけ', '',
    '| 指標 | 値 |', '|---|---|',
    `| 決済が成立し権限が付与された会員 | **${result.purchases}**（利用中 ${result.active}・退会/解約 ${result.ended}） |`,
    `| 商品の内訳 | ${JSON.stringify(result.byPlan)} |`,
    `| 最初の支払い | ${result.firstPaid} |`, '',
    '→ 本番の初回実購入で「Paddle の決済 → 通知 → 中立サイトの照会 → 本番の付与」が成立したことを read-only で確認した。GA4 の参照元（checkout.tirol.link の除外）も確認し、docs/progress.md の監視項目を閉じる。',
  ].join('\n');
}
export function renderPaddleFirstRenewalMarkdown({ check, result }) {
  return [
    `## ${check.title}`, '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks・読み取りのみ）`, '',
    '| 指標 | 値 |', '|---|---|',
    `| 更新された会員（2 回目の支払いで期限が延びた） | **${result.renewed}** |`,
    `| 更新待ち / 更新前に退会・解約 / 判定不能 | ${result.waiting} / ${result.ended} / ${result.unknown} |`,
    `| 最初の更新の請求日（JST） | ${result.firstRenewalDue} → 期限 ${result.firstRenewedExpiration} |`, '',
    '→ 本番の初回実更新（Paddle の自動課金 → 通知 → 期限延長）を read-only で確認した。docs/progress.md の監視項目を閉じる。',
  ].join('\n');
}
