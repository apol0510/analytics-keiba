/**
 * 移行の可否を判定する突合（純粋関数）。
 *
 * **切り替えてよいのは「両側が一致している」と機械で言えたときだけ。**
 * 目視や件数の一致だけでは足りない（件数が同じでも中身が違えば二重送信になる）。
 * したがって集合そのものを比べる。
 */

/** 判定コード。人向け文言と分けておく（ログへ理由コードだけ出せるように）。 */
export const RECON_STATUS = Object.freeze({
  MATCH: 'match',
  REDIS_MISSING: 'redis_missing',       // Airtable にあるが Redis に無い（← 危険。二重送信になる）
  REDIS_EXTRA: 'redis_extra',           // Redis にあるが Airtable に無い（← 安全側。送らないだけ）
  BOTH_DIFFER: 'both_differ',
  UNAVAILABLE: 'unavailable',           // 片側を読めなかった。**一致とみなさない**
});

const asSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

/**
 * DeliveryKey 集合の突合。
 *
 * @param {{ airtableKeys?: Set<string>|string[]|null, redisKeys?: Set<string>|string[]|null }} input
 * @returns {{
 *   status: string, airtable: number, redis: number,
 *   missingInRedis: number, extraInRedis: number, safeToSwitch: boolean,
 * }}
 */
export function reconcileDeliveryKeys({ airtableKeys, redisKeys } = {}) {
  if (airtableKeys === null || airtableKeys === undefined
    || redisKeys === null || redisKeys === undefined) {
    return {
      status: RECON_STATUS.UNAVAILABLE,
      airtable: 0, redis: 0, missingInRedis: 0, extraInRedis: 0, safeToSwitch: false,
    };
  }
  const a = asSet(airtableKeys);
  const r = asSet(redisKeys);
  let missingInRedis = 0;
  for (const k of a) if (!r.has(k)) missingInRedis += 1;
  let extraInRedis = 0;
  for (const k of r) if (!a.has(k)) extraInRedis += 1;

  let status = RECON_STATUS.MATCH;
  if (missingInRedis > 0 && extraInRedis > 0) status = RECON_STATUS.BOTH_DIFFER;
  else if (missingInRedis > 0) status = RECON_STATUS.REDIS_MISSING;
  else if (extraInRedis > 0) status = RECON_STATUS.REDIS_EXTRA;

  return {
    status,
    airtable: a.size,
    redis: r.size,
    missingInRedis,
    extraInRedis,
    // ⚠️ **Redis に足りない鍵が 1 つでもあれば切り替えない**（その相手へ再送してしまう）。
    //    余分（extra）は「送らない」方向なので切替を止めない。
    safeToSwitch: status === RECON_STATUS.MATCH || status === RECON_STATUS.REDIS_EXTRA,
  };
}

/**
 * イベントの突合。種別ごとの件数が Airtable と Blob で一致するか。
 *
 * @param {{ airtableCounts?: object|null, blobCounts?: object|null }} input
 */
export function reconcileEventCounts({ airtableCounts, blobCounts } = {}) {
  if (!airtableCounts || !blobCounts) {
    return { status: RECON_STATUS.UNAVAILABLE, byType: {}, safeToSwitch: false };
  }
  const types = new Set([...Object.keys(airtableCounts), ...Object.keys(blobCounts)]);
  const byType = {};
  let allMatch = true;
  let blobShort = 0;
  for (const t of types) {
    const a = Number(airtableCounts[t] || 0);
    const b = Number(blobCounts[t] || 0);
    byType[t] = { airtable: a, blob: b, diff: b - a };
    if (a !== b) allMatch = false;
    if (b < a) blobShort += a - b;
  }
  return {
    status: allMatch ? RECON_STATUS.MATCH : RECON_STATUS.BOTH_DIFFER,
    byType,
    blobShort,
    // Blob 側が少ない = 監査記録が欠ける。多い分（重複記録）は切替を止めない
    safeToSwitch: blobShort === 0,
  };
}

/**
 * 切替可否の総合判定。**両方が安全なときだけ true**。
 * 片方でも `unavailable` なら false（読めないものを「一致」と扱わない）。
 */
export function summarizeSwitchReadiness({ deliveryRecon, eventRecon } = {}) {
  const blockers = [];
  if (!deliveryRecon || !deliveryRecon.safeToSwitch) {
    blockers.push(`delivery:${deliveryRecon ? deliveryRecon.status : RECON_STATUS.UNAVAILABLE}`);
  }
  if (!eventRecon || !eventRecon.safeToSwitch) {
    blockers.push(`events:${eventRecon ? eventRecon.status : RECON_STATUS.UNAVAILABLE}`);
  }
  return { ready: blockers.length === 0, blockers };
}
