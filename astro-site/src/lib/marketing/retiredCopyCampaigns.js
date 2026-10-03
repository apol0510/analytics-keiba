/**
 * retiredCopyCampaigns.js — 送信済みで、文面が現行の商品定義と合わなくなった campaign（純粋）
 *
 * 2026-10-03 MK 確定: 三連複（Premium Sanrenpuku）は「点数を絞る／少点数」ではなく
 * 「今日、三連複で狙うべきレースを AI が選別する」商品へ。三連複関連の訴求を全面的に統一する。
 *   - 送信済みの文面は 1 文字も変えない（version を上げると送信済みの全員へ再送になる）
 *   - そのため文面は凍結したまま、**送信計画（buildCampaignPlan）を作らない**ことで止める
 *   - 再開するときは新しい訴求で書き直し、version を上げてからここから外す
 *     （`retiredCopyCampaigns.guard.test.mjs` が旧訴求の残る campaign を外すと落とす）
 * 未送信の文面は直接書き直した（sanrenpuku-upsell-sequence 全 4 通 / free-signup-onboarding step6）。
 */
export const RETIRED_COPY_CAMPAIGNS = Object.freeze({
  'sanrenpuku-offer': '三連複を「点数を絞って狙う設計」と案内（送信済み v3）。レース選別の訴求へ書き直すまで送らない',
  'campaign-discount-premium': 'step1 で三連複を「点数を絞って狙う設計」と案内（送信済み 23 通・割引期間は 2026-09-24 に終了）。再利用前に書き直す',
});

export function isRetiredCopyCampaign(campaignId) {
  return Object.prototype.hasOwnProperty.call(RETIRED_COPY_CAMPAIGNS, String(campaignId || ''));
}
