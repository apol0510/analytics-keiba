/**
 * sequenceAudienceFilter.js — 連続配信の tick で「どの出所だけを配るか」を絞る（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-14 の初回実配信から）
 *
 * step2 の初回実配信 150 通は、**全員が Customers 由来**だった。
 * prospect（CSV 取り込み 11,974 名）は 1 人も含まれず、
 * #521 で作った prospect 送信経路が**実配信で 1 度も通っていない**状態が残った。
 *
 * `selectNextDueStep` は due の集合から先頭 N 名を取るだけで、出所は見ない。
 * 母数の並び順しだいで Customers ばかりが選ばれる。
 * そこで **出所で絞る**ための単一源をここに置く。
 *
 * ## 何をして、何をしないか
 *
 *   する   … 既に確定した送信対象から、指定した出所のものだけを残す
 *   しない … 対象を**増やす**こと / 除外条件を緩めること / 新しい送信経路を作ること
 *
 * ⚠️ **絞るだけ**。ここを通っても、配信停止・バウンス・購入済み・反応なし・
 *    `DeliveryKey` の冪等性・送信直前再検証は**一切変わらない**（既存の単一源のまま）。
 * ⚠️ 既定は `all`（従来どおり）。**env を置かない限り挙動は変わらない**。
 */

/** 出所（`deliveryKeySource.js` の `RECIPIENT_SOURCE` と同じ語） */
export const AUDIENCE_FILTER = Object.freeze({
  ALL: 'all',
  PROSPECT: 'prospect',
  CUSTOMER: 'customer',
});

/** env 名（1 か所だけ） */
export const AUDIENCE_FILTER_ENV = 'MARKETING_SEQUENCE_SOURCE_FILTER';

/**
 * env から絞り込みを読む。**壊れた値は `all`**（推測で絞らない）。
 *
 * ⚠️ 「絞る」は送る相手を**減らす**方向にしか働かない。
 *    読めない値で勝手に prospect 限定にすると、Customers の配信が黙って止まる。
 */
export function resolveAudienceFilter(env = process.env) {
  const raw = String((env || {})[AUDIENCE_FILTER_ENV] ?? '').trim().toLowerCase();
  if (raw === AUDIENCE_FILTER.PROSPECT) return AUDIENCE_FILTER.PROSPECT;
  if (raw === AUDIENCE_FILTER.CUSTOMER) return AUDIENCE_FILTER.CUSTOMER;
  return AUDIENCE_FILTER.ALL;
}

const lower = (v) => String(v ?? '').trim().toLowerCase();

/** その対象の出所（prospect の集合に居るかどうかだけで決める） */
export function sourceOfTarget(target, prospectEmails) {
  const email = lower(target && target.fields && target.fields.Email);
  if (!email) return null;
  const isProspect = prospectEmails instanceof Set && prospectEmails.has(email);
  return isProspect ? AUDIENCE_FILTER.PROSPECT : AUDIENCE_FILTER.CUSTOMER;
}

/**
 * 送信対象を出所で絞る。
 *
 * @param {{targets: object[], prospectEmails: Set<string>, filter: string}} input
 * @returns {{kept: object[], dropped: number, bySource: {prospect: number, customer: number, unknown: number},
 *            filter: string}}
 */
export function applyAudienceFilter({ targets, prospectEmails, filter } = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const want = filter === AUDIENCE_FILTER.PROSPECT || filter === AUDIENCE_FILTER.CUSTOMER
    ? filter : AUDIENCE_FILTER.ALL;
  const bySource = { prospect: 0, customer: 0, unknown: 0 };
  const kept = [];
  for (const t of list) {
    const src = sourceOfTarget(t, prospectEmails);
    if (src === null) { bySource.unknown += 1; continue; }
    bySource[src] += 1;
    if (want === AUDIENCE_FILTER.ALL || src === want) kept.push(t);
  }
  return { kept, dropped: list.length - kept.length, bySource, filter: want };
}

/**
 * 下見の要約（**アドレスを含めない**）。
 * 「prospect が確実に含まれるか」を人が目で確かめるための数字。
 */
export function describeAudiencePreview({ bySource, kept, filter, step, campaignId } = {}) {
  const s = bySource || { prospect: 0, customer: 0, unknown: 0 };
  return {
    キャンペーン: String(campaignId || ''),
    ステップ: Number(step) || null,
    絞り込み: String(filter || AUDIENCE_FILTER.ALL),
    'この tick の候補': s.prospect + s.customer + s.unknown,
    'うち prospect': s.prospect,
    'うち Customers': s.customer,
    '出所不明（送らない）': s.unknown,
    '絞り込み後に送る人数': Array.isArray(kept) ? kept.length : 0,
  };
}

export default applyAudienceFilter;
