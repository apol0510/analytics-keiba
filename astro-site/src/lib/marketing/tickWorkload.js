/**
 * tickWorkload.js — 1 tick の仕事量を**既存の安全単位**に収める（純粋・I/O なし）
 *
 * ── 何が起きたか（2026-08-21 の本番）────────────────────────────
 * `rolloutResume` したあと、cron の tick は 15 分・6 回連続で
 * `skip / reason: tick_busy` しか出さず、**ジョブも配信行も 1 件も作られなかった**。
 * 各スロットで 1 本が tick 排他を取り、**ログを 1 行も残さずに終わっていた**
 * （排他は TTL 110 秒で自然に切れるので、次のスロットがまた取って同じことを繰り返す）。
 *
 * 実測（read-only）:
 *   - `action=sequence` は **1 フェーズ 19〜21 秒**。tick は毎回**両フェーズを直列**に読むので
 *     それだけで **約 41 秒**
 *   - さらに follow-up は **due 全件**（当時 396 名、その後 593 名）を 1 tick で
 *     dry-run → queue → 読み戻し → 印外し まで行う
 *   - kill 前の「送信起動だけ」の tick でも実測 47〜59 秒かかっていた
 *
 * ⚠️ **当該 invocation のログが無いため「実行時間切れ」と確定はできない。**
 *    ただし 1 tick の仕事量が上限に近いことは実測で確かなので、**仕事量を減らす**。
 *
 * ── ここが守ること ────────────────────────────────────────────
 * ⚠️ **新しい件数仕様を作らない。** 1 tick で積むのは既存の
 *    `RECIPIENTS_PER_JOB`（= ScheduledEmails 1 ジョブぶん）まで。
 *    残りは**次の tick が単一源から取り直して続き**を積む（1 tick 1 段階は変えない）。
 * ⚠️ **due 判定を独自実装しない。** 対象は `action=sequence` が返した順序のまま先頭から取る。
 *    間隔・頻度・購入・配信停止・suppression の判定は単一源のまま。
 * ⚠️ 積んだ人は次の tick では due から外れる（`DeliveryKey` が `queued` になるため）ので、
 *    **同じ人を二度積まない**。
 */

import { chunkRecipients, RECIPIENTS_PER_JOB } from './campaignSend.js';

/**
 * この tick で積む宛先を**1 ジョブぶん**に切る。
 *
 * @param {string[]} recordIds 単一源（`action=sequence` の `next.recordIds`）の順序のまま
 * @returns {{take: string[], remaining: number, bounded: boolean, limit: number}}
 */
export function boundQueueBatch(recordIds) {
  const list = (Array.isArray(recordIds) ? recordIds : []).filter(Boolean);
  if (list.length === 0) return { take: [], remaining: 0, bounded: false, limit: RECIPIENTS_PER_JOB };
  // 既存の分割契約をそのまま使う（1 ジョブ = RECIPIENTS_PER_JOB 件）
  const take = chunkRecipients(list)[0] || [];
  return {
    take,
    remaining: Math.max(0, list.length - take.length),
    bounded: list.length > take.length,
    limit: RECIPIENTS_PER_JOB,
  };
}

/**
 * フェーズの期日読みを**必要な分だけ**にする。
 *
 * `readNextDueStep` は「体験中 → 終了後」の順に見て、**最初に due がある方**を採用する。
 * つまり**体験中フェーズに due があるなら、終了後フェーズを読んでも結論は変わらない**。
 * 1 フェーズ 19〜21 秒かかるので、結論が変わらない読みは飛ばす。
 *
 * ⚠️ **fail closed は維持**。読めなかったフェーズがあれば呼び出し側が `null` を返す
 *    （「読めた分だけで やることなし」と誤認しない）。
 * ⚠️ due が無いフェーズは**次のフェーズを必ず読む**（取りこぼさない）。
 *
 * @param {{step: number|null, due: number}|null} phase 直前に読んだフェーズの結果
 * @returns {boolean} これ以上フェーズを読む必要があるか
 */
export function needsMorePhases(phase) {
  if (!phase) return false;                       // 読めていない = 呼び出し側が fail closed
  return !(phase.step && Number(phase.due) > 0);  // due があれば以降は読まなくてよい
}

export default boundQueueBatch;
