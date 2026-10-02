/**
 * discontinuedBankProducts.js — 銀行振込で販売を終了した商品の申込を止める（純粋）
 *
 * 2026-10-02 MK 確定:
 *   - Premium の**月払い**（30 日 ¥18,000）の銀行振込は新規受付停止 → 月額は Stripe（カード）だけ
 *   - **Light は新規募集停止**。既存の**有料 Light 会員**の更新・再開だけ銀行振込で受け付ける
 *     （永久無料 Light・無償付与の Light は「有料 Light 会員」ではない＝購入導線とは分離。既存の閲覧権は変えない）
 *
 * 当初は「入金後の報告なので拒否せず管理者へ警告」だったが、2026-10-02 の CTA 横断監査の確定仕様で
 * **URL 直打ち・旧ページからの申込もサーバー側で成立させない（fail closed）**に変更した。
 * 万一入金済みの方には、問い合わせ（返金・Stripe への切替）へ案内する。
 */
import { normalizePlan } from '../auth/planNormalization.js';

export const DISCONTINUED_CODE = Object.freeze({
  PREMIUM_MONTHLY: 'premium_monthly_bank_discontinued',
  LIGHT_NEW: 'light_new_signup_closed',
  LIGHT_UNVERIFIED: 'light_membership_unverified',
});

/** 既存の**有料** Light 会員か（プラン=Light かつ実際に支払った PaidAt がある）。無料付与は含まない */
export function isPaidLightMember(fields) {
  const f = fields || {};
  return normalizePlan(String(f['プラン'] || '')) === 'light' && String(f.PaidAt || '').trim() !== '';
}

/**
 * 申込を受け付けてよいか。
 * @param {{ planName: string, planType: string, fields: object|null, lookupFailed?: boolean }} input
 *   fields: 申込者の Customers（無ければ null）/ lookupFailed: 照会に失敗した（Light は判定できない＝止める）
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function decideBankProductAvailability({ planName, planType, fields, lookupFailed = false } = {}) {
  const plan = normalizePlan(String(planName || ''));
  const type = String(planType || '').trim().toLowerCase();
  if (plan === 'premium' && type === 'monthly') {
    return {
      ok: false,
      code: DISCONTINUED_CODE.PREMIUM_MONTHLY,
      message: 'Premium の月額プランは、料金ページからクレジットカードでお申し込みください（銀行振込の月払いは受付を終了しました）。既にお振込み済みの場合はお問い合わせください。',
    };
  }
  if (plan === 'light') {
    if (lookupFailed) {
      return {
        ok: false,
        code: DISCONTINUED_CODE.LIGHT_UNVERIFIED,
        message: 'ただいまご契約状況を確認できませんでした。時間をおいて再度お試しいただくか、お問い合わせください。',
      };
    }
    if (!isPaidLightMember(fields)) {
      return {
        ok: false,
        code: DISCONTINUED_CODE.LIGHT_NEW,
        message: 'Light プランは新規のお申し込みを終了しました。料金ページの Premium（中央版・南関版）をご覧ください。既にお振込み済みの場合はお問い合わせください。',
      };
    }
  }
  return { ok: true };
}

/** 管理者向けの警告（旧 API 互換）。止める対象なら文言、それ以外は null */
export function discontinuedBankProductWarning(input) {
  const d = decideBankProductAvailability(input);
  return d.ok ? null : d.message;
}
