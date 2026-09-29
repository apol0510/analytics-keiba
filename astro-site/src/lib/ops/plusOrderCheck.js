/**
 * plusOrderCheck.js — Premium Plus の最初の本物の注文を自動で確かめる（kind: premium-plus-first-order）
 *
 * 注文が来るまでは確かめられない。**確認のためだけに販売状態・案内を変えない**（2026-09-29 MK）。
 * 販売再開後に最初の本物の注文が来て、入金確認で新系列にちょうど 1 件入ったことを毎日読むだけで確かめる。
 *
 *   - 本物の注文 0 件 → `no_plus_order_yet`（待機中）
 *   - 注文と購入が不一致（計上漏れ・注文に無い計上・二重計上）→ `plus_purchase_mismatch`（失敗・赤）
 *   - 要修復の注文あり → `plus_order_needs_repair`（失敗・赤）
 *   - 注文はあるが入金確認がまだ → `no_plus_confirmation_yet`（待機中。未確認の通知は毎時の監視が出す）
 *   - 確認済み ≥1・一致・要修復なし → 成功
 *
 * 読むのは admin-payment-funnel の `plusOrdersSummary`（件数だけ・読み取り専用の鍵）。
 */
export class PlusOrderCheckError extends Error {
  constructor(code, detail) { super(`plus-order:${code}`); this.code = code; this.detail = detail || null; }
}

export async function fetchPlusOrderSummary({ siteUrl, secret, fetchImpl = fetch }) {
  if (!secret || !String(secret).trim()) throw new PlusOrderCheckError('funnel_secret_missing');
  const res = await fetchImpl(new URL('/.netlify/functions/admin-payment-funnel', siteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-funnel-read-secret': secret },
    body: JSON.stringify({ action: 'plusOrdersSummary' }),
  });
  if (res.status === 401 || res.status === 403) throw new PlusOrderCheckError('funnel_auth_failed', `HTTP ${res.status}`);
  if (!res.ok) throw new PlusOrderCheckError('plus_order_api_error', `HTTP ${res.status}`);
  return res.json();
}

/** 判定（純粋） */
export function judgeFirstPlusOrder(s) {
  if (!s || !s.real) throw new PlusOrderCheckError('plus_order_api_error', '応答の形が違う');
  if (!s.consistent) {
    const p = s.purchase || {};
    throw new PlusOrderCheckError('plus_purchase_mismatch', `計上漏れ ${p.missing} / 注文に無い計上 ${p.unexpected} / 二重計上 ${p.duplicated ? 'あり' : 'なし'}`);
  }
  if (s.real.needsRepair > 0) throw new PlusOrderCheckError('plus_order_needs_repair', `要修復 ${s.real.needsRepair} 件`);
  if (s.real.total === 0) throw new PlusOrderCheckError('no_plus_order_yet', '本物の Plus 注文がまだ 0 件');
  if (s.real.confirmed === 0) {
    throw new PlusOrderCheckError('no_plus_confirmation_yet', `注文 ${s.real.total} 件・未確認 ${s.real.awaiting} 件（入金確認待ち）`);
  }
  return s;
}

export async function runPlusFirstOrderCheck({ check, secret, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  const s = await fetchPlusOrderSummary({ siteUrl: check.compare.siteUrl, secret, fetchImpl });
  return { ranAt: nowIso, ...judgeFirstPlusOrder(s) };
}

export function renderPlusFirstOrderMarkdown({ check, result }) {
  const r = result.real; const p = result.purchase;
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks）`,
    '- 確認: Plus 注文台帳と新系列の購入（`…:purchase:s2`）の突き合わせ（件数のみ・読み取り専用）',
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| 本物の注文 | ${r.total}（確認済み ${r.confirmed} / 未確認 ${r.awaiting} / 取消 ${r.cancelled + r.revoked}）|`,
    `| 新系列の購入（注文キー）| **${p.recorded}**（期待 ${p.expected}）|`,
    `| 計上漏れ / 注文に無い計上 / 二重計上 | ${p.missing} / ${p.unexpected} / ${p.duplicated ? 'あり' : 'なし'} |`,
    `| 要修復 | ${r.needsRepair} |`,
    '',
    '→ 本物の Plus 注文が入金確認で新系列に 1 注文 1 件だけ入ったことを本番で確認できた。以後の未確認・不一致は毎時の監視（premium-plus-order-monitor.yml）が知らせる。',
  ].join('\n');
}

// ── Premium Plus 案内メールの成果（kind: premium-plus-offer-outcome）──────────────
/** 送信 7 日後に 1 回だけ成果を記録する。計測を読めなければ失敗（0 件と書かない） */
export async function runPlusOfferOutcomeCheck({ check, secret, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  if (!secret || !String(secret).trim()) throw new PlusOrderCheckError('funnel_secret_missing');
  const res = await fetchImpl(new URL('/.netlify/functions/admin-payment-funnel', check.compare.siteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-funnel-read-secret': secret },
    body: JSON.stringify({ action: 'plusOfferOutcome' }),
  });
  if (res.status === 401 || res.status === 403) throw new PlusOrderCheckError('funnel_auth_failed', `HTTP ${res.status}`);
  if (!res.ok) throw new PlusOrderCheckError('plus_order_api_error', `HTTP ${res.status}`);
  const o = await res.json();
  if (!o || !Number.isFinite(o.sent)) throw new PlusOrderCheckError('plus_order_api_error', '応答の形が違う');
  if (o.opened === null || o.reachedPlusPage === null) {
    throw new PlusOrderCheckError('plus_order_api_error', '開封またはページ到達を読めない（0 件とは書かない）');
  }
  return { ranAt: nowIso, ...o };
}

export function renderPlusOfferOutcomeMarkdown({ check, result: o }) {
  const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '—');
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${o.ranAt}（GitHub Actions scheduled-checks）`,
    `- 基準: ${check.compare.baseline}`,
    `- ${o.note}`,
    '',
    '| 段 | 件数 | 前段比 |',
    '|---|---|---|',
    `| 送信（人）| ${o.recipients}（通 ${o.sent}）| — |`,
    `| 配信 | ${o.delivered} | ${pct(o.delivered, o.sent)} |`,
    `| 開封 | ${o.opened} | ${pct(o.opened, o.delivered)} |`,
    `| Plus ページ到達（送信後）| ${o.reachedPlusPage} | ${pct(o.reachedPlusPage, o.recipients)} |`,
    `| 決済開始（振込報告）| ${o.checkoutStarted} | ${pct(o.checkoutStarted, o.reachedPlusPage)} |`,
    `| 注文 | ${o.orders} | — |`,
    `| 入金確認（新系列に計上）| ${o.ordersConfirmed}（新系列 ${o.purchasedNewSeries}）| ${pct(o.ordersConfirmed, o.orders)} |`,
    '',
    '→ 注文の入金確認と二重計上の有無は `premium-plus-first-order-2026` と毎時の監視が別に確かめる。',
  ].join('\n');
}
