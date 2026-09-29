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
