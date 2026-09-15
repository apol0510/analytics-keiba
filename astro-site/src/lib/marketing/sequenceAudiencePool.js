/**
 * sequenceAudiencePool.js — **候補の母集団を出所で切り、公平に並べる**（判定の単一源）
 *
 * ## なぜ要るか（2026-09-15 の本番実測）
 *
 * `campaign-discount-free` の canary を `sourceFilter=prospect` で 1 tick 回したところ、
 * **prospect が 1 人も選ばれなかった**。原因は絞り込みを掛ける位置。
 *
 * ```
 * selected = [...customerRows, ...entryRows, ...prospectRows]   ← Customers が先頭
 * selectNextDueStep(progress)                                    ← 配列順のまま
 * planSequenceTick → next.recordIds.slice(0, maxRecipients)      ← 先頭 N で打ち切り
 * applyAudienceFilter(dueTargets, filter)                        ← ★ 打ち切りの「後」
 * ```
 *
 * 打ち切りの**後**で絞るので、due な Customers が N 人以上先に並んでいれば
 * `prospect` 指定は**構造的に 0 件**になる。実測では prospect の step2 due が
 * **11,643 名**居たのに、選ばれたのは Customers 50 名（うち 47 名は既 queue）だった。
 *
 * 同じ理由で、絞り込み無し（`all`）の**定期配信でも prospect は永久に選ばれない**。
 * 正本 `docs/spec.md`「prospect にも実際に送る」が成立していなかった。
 *
 * ## ここで決めること
 *
 *   1. `sourceFilter` は**計画より手前**で母集団に掛ける（打ち切りが絞り込み後に効く）
 *   2. `all` のときは**出所を交互に並べる**ので、どちらの出所も枯れない
 *
 * ⚠️ どちらも**減らす・並べ替えるだけ**。除外条件・`DeliveryKey`・予約・
 *    送信直前の再検証には一切触れない（`DeliveryKey` を作り直さない）。
 * ⚠️ 出所の判定は `sequenceAudienceFilter.js` の `sourceOfTarget` と**同じ語**を使う。
 */

import { AUDIENCE_FILTER, sourceOfTarget } from './sequenceAudienceFilter.js';

/**
 * 母集団を出所で切る。**`all` なら 1 件も減らさない。**
 *
 * ⚠️ 出所が分からない相手（`unknown`）は、絞り込みを指定したとき**残さない**
 *    （`applyAudienceFilter` と同じ向き＝推測で送らない）。
 *
 * @param {{rows: Array, prospectEmails: Set<string>, filter: string}} input
 * @returns {{rows: Array, dropped: number, bySource: {prospect:number, customer:number, unknown:number}}}
 */
export function scopeAudiencePool({ rows, prospectEmails, filter } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const bySource = { prospect: 0, customer: 0, unknown: 0 };
  for (const r of list) {
    const s = sourceOfTarget(r, prospectEmails);
    bySource[s === null ? 'unknown' : s] += 1;
  }
  if (filter !== AUDIENCE_FILTER.PROSPECT && filter !== AUDIENCE_FILTER.CUSTOMER) {
    return { rows: list, dropped: 0, bySource };
  }
  const kept = list.filter((r) => sourceOfTarget(r, prospectEmails) === filter);
  return { rows: kept, dropped: list.length - kept.length, bySource };
}

/**
 * 出所ごとに**交互に**並べる（どちらの出所も枯れないようにする）。
 *
 * ⚠️ 並べ替えるだけで、**1 件も足さない・減らさない**。
 * ⚠️ 同じ入力なら同じ並びになる（安定）。運が絡む要素を入れない。
 *
 * 例: Customers 5 名 + prospect 3 名 →
 *     C, P, C, P, C, P, C, C（短い側が尽きたら残りをそのまま続ける）
 *
 * @param {{rows: Array, prospectEmails: Set<string>}} input
 * @returns {Array} 並べ替えた行
 */
export function interleaveBySource({ rows, prospectEmails } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  /** 出所ごとの待ち行列。**元の順序は出所の中で保つ** */
  const lanes = new Map();
  const order = [];
  for (const r of list) {
    const s = sourceOfTarget(r, prospectEmails);
    const key = s === null ? 'unknown' : s;
    if (!lanes.has(key)) { lanes.set(key, []); order.push(key); }
    lanes.get(key).push(r);
  }
  const out = [];
  let remaining = list.length;
  while (remaining > 0) {
    let moved = false;
    for (const key of order) {
      const lane = lanes.get(key);
      if (lane && lane.length > 0) { out.push(lane.shift()); remaining -= 1; moved = true; }
    }
    if (!moved) break;  // 念のため（無限ループを作らない）
  }
  return out;
}

export default scopeAudiencePool;
