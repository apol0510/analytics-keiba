/**
 * productName.js — 画面の商品名を申込の語彙へ読み替える**単一源**（純粋・I/O なし）
 *
 * ## なぜ切り出したか（2026-08-25）
 *
 * `bank-transfer-application.js` の中だけにこの正規化があり、
 * **画面側は同じ計算を持っていなかった**。その結果:
 *
 *   - サーバーは割引後の ¥68,000 を請求額として記録する
 *   - しかしお客様の画面は ¥78,000 のまま
 *
 * という食い違いが起きた（MK 報告）。**見せる金額と請求する金額は
 * 同じ計算から出さなければならない**ので、ここに 1 本化する。
 *
 * ⚠️ 申込 Function と画面（`/api/campaign.json`）は**必ずこの関数を使う**こと。
 *    どちらかが自前で正規化を書いた瞬間に、また食い違う。
 */

/** 画面の商品名 → `RequestedPlan` / `RequestedPlanType` */
export function derivePlanFromProductName(productName) {
  const full = String(productName ?? '').replace(/\s*\(.*\)$/, '').trim();

  let planType = 'Monthly';
  if (full.includes('Lifetime') || full.includes('買い切り')) planType = 'Lifetime';
  else if (full.includes('Annual') || full.includes('年払い')) planType = 'Annual';
  else if (full.includes('Monthly') || full.includes('30日')) planType = 'Monthly';

  let planName = full
    .replace(/\s*\(Standard Upgrade\)/, '')
    .replace(/\s*-\s*Campaign/, '')
    .replace(/\s*\(ライト\)/, '')
    .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|30日)$/, '')
    .trim();

  // 旧プラン名は Airtable Single select から削除済み。すべて "Light" に揃える
  if (planName === 'Standard' || planName === 'standard'
    || planName === 'ライト' || planName === 'light') {
    planName = 'Light';
  }

  return { fullPlanName: full, planName, planType };
}

/**
 * すでに特別価格が付いている商品か（`- Campaign` など）。
 * ⚠️ そこへキャンペーン価格を重ねると、画面の金額と請求額が食い違う。
 */
export function hasOwnSpecialPrice(productName) {
  return /campaign/i.test(String(productName ?? ''));
}
