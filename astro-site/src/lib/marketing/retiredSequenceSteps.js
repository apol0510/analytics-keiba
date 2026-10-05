/**
 * retiredSequenceSteps.js — 今後は送らない連続配信の step（純粋）
 *
 * ## なぜ要るか（2026-10-02 MK 確定: Light 新規募集停止に伴うメール横断監査）
 *
 * 送信済みの step は文面を 1 文字も変えられない（version を上げると全員へ再送になる）。
 * 一方で、文面に**新規募集を停止した商品（Light）**の案内を含む step を、これから来る人へ送るわけにはいかない。
 * そこで「その step を**今後の送信対象から外す**」だけを宣言する（文面・version・送信済み履歴は変えない）。
 *
 * - 定期 tick（cron-campaign-sequence）はこの step を選ばない（`skipSteps` の既存の仕組みに渡す）
 * - 文面を新仕様に書き直して送るなら、新しい step / campaign を作る（MK 判断）
 */
export const RETIRED_SEQUENCE_STEPS = Object.freeze({
  // step5「無料・Light・Premium で見られる範囲の違い」: 無料会員へ Light を案内している（送信済みの可能性あり＝文面は凍結）
  'free-signup-onboarding': Object.freeze({ 5: 'light_signup_closed_2026-10-02' }),
});

/** その campaign で今後送らない step 番号の配列 */
export function retiredStepsFor(campaignId) {
  const m = RETIRED_SEQUENCE_STEPS[String(campaignId || '')];
  return m ? Object.keys(m).map(Number).filter(Number.isInteger) : [];
}
