/**
 * prospectPhase2EntryProbe.js — 第 2 期の入口判定を**同じ結論のまま軽くする**（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-17 本番実測）
 *
 * 第 2 期の入口は「その prospect が**第 1 期の全 step を配り終えたか**」を鍵で照合する。
 * 素直に書くと **全 prospect × 全 step** の鍵を作って 1 回で問い合わせることになり、
 * 本番では毎 tick これだけ引いていた:
 *
 * | 項目 | 値 |
 * |---|---|
 * | prospect | 約 **11,826** |
 * | 第 1 期の step | **3** |
 * | 問い合わせる鍵 | 約 **35,478** |
 * | Redis 往復（`CHUNK` = 200 / 逐次）| 約 **178 回** |
 * | 実測所要 | 約 **19 秒**（campaign 全体で 22 秒）|
 *
 * しかも第 1 期の完了者は **0 名**なので、この 19 秒は**毎回ゼロ件のために**使われていた。
 * 1 tick の予算は 55 秒なので、これだけで 1/3 を食う。
 *
 * ## ここで決めること — 「最後の step」から先に見る
 *
 * 全 step が揃っているかを知りたいとき、**どれか 1 つでも欠けていれば不成立**。
 * シーケンスは順番に配るので、**最後の step が無い人は必ず未完了**。
 *
 *   ① 各 prospect の**最後の step の鍵だけ**を引く（1 人 1 鍵 = 約 11,826 → 約 60 往復）
 *   ② ①を通過した人だけ、**全 step の鍵**を引く（通常はごく少数、いまは 0 件）
 *
 * ⚠️ **結論は 1 ミリも変わらない。** ①は必要条件で、最終判定は従来どおり
 *    `planPhase2Entry` が**全 step 揃っているか**で行う。
 *    ①を通過しなかった人の鍵は集合に入らないので `done=false` になり、
 *    「最後の step が無い＝未完了」という正しい結論と一致する。
 *
 * ⚠️ **`delivered` の累計で足切りしてはいけない。** この集合は
 *    `claimDelivered`（= **キュー登録時の予約**）で作られる「送った鍵」であって、
 *    webhook で確認した `delivered` とは別物。バウンスすれば
 *    「鍵は 3 つあるが delivered は 1」もあり得るので、累計での足切りは**不正確**。
 *
 * ⚠️ 鍵の作り方は変えない（`buildProspectDeliveryKeys` が唯一の生成元）。
 */

import { getSequenceSteps } from './campaignSequence.js';
import { buildProspectDeliveryKeys } from './prospectSequenceHydration.js';
import { normalizeEmail } from './prospectPolicy.js';

/**
 * ① 最後の step の鍵だけを組み立てる。
 *
 * @param {{prospects: Array, priorCampaign: object, brand: string, fromEmail: string}} input
 * @returns {{ok: boolean, reason?: string, probeKeys: string[], lastStep: number|null,
 *            keyMap: Map, stepCount: number}}
 */
export function buildPhase2Probe({ prospects, priorCampaign, brand, fromEmail } = {}) {
  const steps = getSequenceSteps(priorCampaign);
  if (steps.length === 0) {
    return { ok: false, reason: 'prior_not_a_sequence', probeKeys: [], lastStep: null, keyMap: new Map(), stepCount: 0 };
  }
  const list = Array.isArray(prospects) ? prospects : [];
  const lastStep = steps[steps.length - 1].stepNumber;
  const keyMap = buildProspectDeliveryKeys({
    prospects: list, campaign: priorCampaign, brand, fromEmail,
  });
  const probeKeys = [];
  for (const p of list) {
    const email = normalizeEmail(p && p.email);
    if (!email) continue;
    const byStep = keyMap.get(email);
    const k = byStep && byStep.get(lastStep);
    if (k) probeKeys.push(k);
  }
  return { ok: true, probeKeys, lastStep, keyMap, stepCount: steps.length };
}

/**
 * ② ①を通過した人**だけ**の全 step 鍵を組み立てる。
 *
 * ⚠️ 通過しなかった人の鍵は**意図的に含めない**。含めないことで
 *    `planPhase2Entry` がその人を `prior_sequence_incomplete` と判定する（＝正しい結論）。
 *
 * @param {{prospects: Array, priorCampaign: object, brand: string, fromEmail: string,
 *          lastStepDelivered: Set<string>, probe?: object}} input
 * @returns {{keys: string[], survivors: number}}
 */
export function buildPhase2FullKeys({
  prospects, priorCampaign, brand, fromEmail, lastStepDelivered, probe,
} = {}) {
  const steps = getSequenceSteps(priorCampaign);
  if (steps.length === 0) return { keys: [], survivors: 0 };
  const delivered = lastStepDelivered instanceof Set ? lastStepDelivered : new Set();
  if (delivered.size === 0) return { keys: [], survivors: 0 };

  const list = Array.isArray(prospects) ? prospects : [];
  const lastStep = steps[steps.length - 1].stepNumber;
  // ⚠️ 鍵を 2 度組み立てない（①の結果を使い回す）
  const keyMap = (probe && probe.keyMap instanceof Map && probe.keyMap.size > 0)
    ? probe.keyMap
    : buildProspectDeliveryKeys({ prospects: list, campaign: priorCampaign, brand, fromEmail });

  const keys = [];
  let survivors = 0;
  for (const p of list) {
    const email = normalizeEmail(p && p.email);
    if (!email) continue;
    const byStep = keyMap.get(email);
    if (!byStep) continue;
    const lastKey = byStep.get(lastStep);
    if (!lastKey || !delivered.has(lastKey)) continue;   // ①で落ちた人は引かない
    survivors += 1;
    for (const s of steps) {
      const k = byStep.get(s.stepNumber);
      if (k) keys.push(k);
    }
  }
  return { keys, survivors };
}

/**
 * 軽量化の効果を数える（ログ・応答用。**アドレスも鍵も含めない**）。
 */
export function describePhase2Probe({ probe, survivors, fullKeys, chunkSize = 200 }) {
  const probeKeys = (probe && probe.probeKeys && probe.probeKeys.length) || 0;
  const stepCount = (probe && probe.stepCount) || 0;
  const naive = probeKeys * stepCount;                 // 従来（全員 × 全 step）
  const actual = probeKeys + (fullKeys || 0);
  const trips = (n) => Math.ceil(n / chunkSize);
  return {
    鍵: { 従来: naive, 今回: actual, 削減率: naive === 0 ? 0 : Math.round((1 - actual / naive) * 100) },
    往復: { 従来: trips(naive), 今回: trips(probeKeys) + trips(fullKeys || 0) },
    最終step通過: survivors || 0,
  };
}

export default buildPhase2Probe;
