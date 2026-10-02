/**
 * discontinuedBankProducts.js — 銀行振込で販売を終了した商品の振込報告を見分ける（純粋）
 *
 * 2026-10-02 MK 確定:
 *   - Premium の**月払い**（30 日 ¥18,000）の銀行振込は販売終了 → 月額は Stripe（カード）だけ
 *   - **Light は新規募集停止**。既存の有料 Light 会員の更新・再開だけ銀行振込で受け付ける
 *
 * 振込報告は**入金後**に届くので、ここで拒否しない（お金を受け取ったのに申込が消える方が悪い）。
 * 管理者宛メールに警告を出し、MK が個別に対応（返金・Stripe への案内）できるようにする。
 */
import { normalizePlan } from '../auth/planNormalization.js';

/**
 * @param {{ planName: string, planType: string, fields: object|null }} input
 *   fields: 申込者の Customers レコード（無ければ null = 新規）
 * @returns {string|null} 警告文（対象外なら null）
 */
export function discontinuedBankProductWarning({ planName, planType, fields } = {}) {
  const plan = normalizePlan(String(planName || ''));
  const type = String(planType || '').trim().toLowerCase();
  if (plan === 'premium' && type === 'monthly') {
    return 'Premium 月払い（銀行振込）は 2026-10-02 に販売を終了しています。月額は Stripe（カード・¥4,980/月）のみです。返金または年払いへの振替をご検討ください。';
  }
  if (plan === 'light') {
    const f = fields || {};
    const wasPaidLight = normalizePlan(String(f['プラン'] || '')) === 'light'
      && String(f.PaidAt || '').trim() !== '';
    if (!wasPaidLight) {
      return 'Light は 2026-10-02 に新規募集を停止しています（既存の有料 Light 会員の更新・再開のみ受付）。この申込者は有料 Light 会員ではありません。';
    }
  }
  return null;
}
