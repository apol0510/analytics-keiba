/**
 * stripeActivationCheck.js — AK 用 Stripe アカウントの本番決済が有効になったか（kind: stripe-live-activation）
 *
 * 2026-10-02: 本番鍵で確認したところ Stripe の審査中（disabled_reason=under_review・card_payments inactive）。
 * 有効になるまで Stripe 定期購読（PR #677）を本番へ出せない（出すと月額が誰も買えなくなる）。
 * 人の記憶に頼らず、scheduled-checks が毎日 `GET /v1/account` を**読むだけ**で確認する。
 *
 * 成功: charges_enabled かつ card_payments=active → 結果を Issue に記録して完了
 * 待機: まだ → `stripe_charges_not_enabled`（待機中 Issue を更新・翌日再確認）
 *
 * ⚠️ 返すのは状態の要約だけ（鍵・口座・本人情報は記録しない）。
 */
export class StripeActivationError extends Error {
  constructor(code, detail) { super(`stripe:${code}`); this.code = code; this.detail = detail || null; }
}

/** アカウント → 要約（純粋） */
export function summarizeAccount(a) {
  const r = a?.requirements || {};
  return {
    chargesEnabled: a?.charges_enabled === true,
    payoutsEnabled: a?.payouts_enabled === true,
    cardPayments: a?.capabilities?.card_payments || 'unknown',
    disabledReason: r.disabled_reason || null,
    currentlyDue: (r.currently_due || []).length,
    pendingVerification: (r.pending_verification || []).length,
  };
}

export async function runStripeActivationCheck({ key, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  if (!key || !/^(sk|rk)_live_/.test(String(key).trim())) throw new StripeActivationError('stripe_key_missing');
  const res = await fetchImpl('https://api.stripe.com/v1/account', { headers: { Authorization: `Bearer ${String(key).trim()}` } });
  if (res.status === 401 || res.status === 403) throw new StripeActivationError('stripe_auth_failed', `HTTP ${res.status}`);
  if (!res.ok) throw new StripeActivationError('stripe_api_error', `HTTP ${res.status}`);
  const s = summarizeAccount(await res.json());
  if (!(s.chargesEnabled && s.cardPayments === 'active')) {
    throw new StripeActivationError('stripe_charges_not_enabled',
      `charges_enabled=${s.chargesEnabled} / card_payments=${s.cardPayments} / disabled_reason=${s.disabledReason || '-'} / 要対応 ${s.currentlyDue} 件 / 審査中 ${s.pendingVerification} 件`);
  }
  return { ranAt: nowIso, ...s };
}

export function renderStripeActivationMarkdown({ check, result }) {
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks・GET /v1/account を読むだけ）`,
    '',
    '| 項目 | 値 |',
    '|---|---|',
    `| 決済（charges_enabled） | **${result.chargesEnabled ? '有効' : '無効'}** |`,
    `| カード決済 | ${result.cardPayments} |`,
    `| 入金（payouts_enabled） | ${result.payoutsEnabled ? '有効' : '無効'} |`,
    '',
    '**次の作業**: PR #677（Stripe 定期購読）を merge → 本番デプロイ → 本番スモーク（`astro-site/docs/STRIPE_BILLING.md`）。',
  ].join('\n');
}
