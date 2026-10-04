/**
 * lightSignupClosedCampaigns.js — 文面が Light の新規募集・継続を案内しているため、**送らない** campaign（純粋）
 *
 * 2026-10-02 MK 確定（Light 新規募集停止・Stripe 月額への再編に伴うメール横断監査）:
 *   - 送信済みの文面は 1 文字も変えない（version を上げると全員へ再送になる）
 *   - そのため文面は凍結したまま、**送信計画（buildCampaignPlan）を作らない**ことで止める
 *     （管理画面からの単発送信・連続配信の定期 tick・rollout の queue はすべて buildCampaignPlan を通る）
 *   - 再開するなら新料金体系（中央版 ¥2,980 / 南関版 ¥2,980 / Premium ¥4,980・Light は既存有料会員だけ）へ
 *     書き直し、version を上げてからここから外す（guard テストが文面を検査する）
 *   - 一覧・集計・管理画面の表示には影響しない（isCampaignUsable は変えない）
 * 一部の step だけが該当し campaign 自体は動かすもの（free-signup-onboarding）は `retiredSequenceSteps.js`。
 */
export const LIGHT_SIGNUP_CLOSED_CAMPAIGNS = Object.freeze({
  'campaign-discount-free': '無料向け割引: Light 月額 500円OFF を案内（2026-09-24 期間終了）',
  'campaign-discount-light': 'Light 会員向け: 「Light プランはそのままご利用いただけます」（同額 Premium への変更を主にする前の文面）',
  'campaign-prospect-phase2': 'step7: 無料向け割引一覧に Light を含む',
  'light-trial-to-premium-sequence': 'step3: 無料体験後の Light 継続（＝新規購入）を銀行振込で案内',
  'light-to-premium-sequence': '未送信: Light のまま利用を勧める文面',
});

/**
 * ⚠️ **テスト専用**。送信の仕組み（rollout・連続配信・queue の冪等性など）を、これらの campaign を
 *    題材にして検査している既存テストだけが呼ぶ。本番コードから呼ばない（guard テストが検査する）。
 */
let allowForTests = false;
export function __allowLightSignupClosedCampaignsForTests(v) { allowForTests = v === true; }

export function isLightSignupClosedCampaign(campaignId) {
  if (allowForTests) return false;
  return Object.prototype.hasOwnProperty.call(LIGHT_SIGNUP_CLOSED_CAMPAIGNS, String(campaignId || ''));
}
