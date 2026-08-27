/**
 * prospectIndexAudit.js — 「投入したはずの人が索引に居るか」を突き合わせる（純粋・I/O なし）
 *
 * ## なぜ要るか
 *
 * 移行後の検証（`prospectVerification.js`）は **索引に居る hash しか見ない**。
 * `missing`（値が読めない）は拾えるが、**索引から丸ごと欠けている人は拾えない**。
 *
 * 2026-08-27 の本番検証で `indexSize = 11,975`（投入 11,976）となり 1 件足りなかった。
 * 原因は `addManyIfAbsent()` が **`existed`（既存レコード）を数えるだけで
 * `SADD ACTIVE_INDEX` しない**こと。既に索引に居る前提で数えていたが、
 * 既存 89 のうち 1 件は**どの索引にも居なかった**。
 *
 * ここは「期待した hash 一覧」と「実際の 3 索引」を突き合わせ、
 * **どこにも居ない hash** と **送信候補ではない hash** を分けて返す。
 *
 * ## ⚠️ アドレスは扱わない
 *
 * 入出力は **hash だけ**。生アドレスをこの経路に通さない
 * （突き合わせに要らないし、端末やログへ PII を落とす理由が無い）。
 */

/** 索引のどこに居るか */
export const INDEX_PLACE = Object.freeze({
  ACTIVE: 'active',       // 送信候補
  ENGAGED: 'engaged',     // 反応済み
  BLOCKED: 'blocked',     // 永久除外
  NOWHERE: 'nowhere',     // ⚠️ どの索引にも居ない（これが事故）
});

const HASH_RE = /^[0-9a-f]{64}$/;

/** 64 桁 hex だけを通す（順序を保ち、重複は落とす）*/
export function normalizeHashes(hashes) {
  const out = [];
  const seen = new Set();
  for (const h of Array.isArray(hashes) ? hashes : []) {
    const s = String(h ?? '').trim().toLowerCase();
    if (!HASH_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 期待した hash 一覧を 3 索引と突き合わせる。
 *
 * @param {{expected: string[], active: string[], engaged?: string[], blocked?: string[]}} input
 * @returns {{
 *   checked: number,
 *   counts: {active, engaged, blocked, nowhere},
 *   placeByHash: Map<string, string>,
 *   nowhere: string[],          // ⚠️ どの索引にも居ない（復元手段が無い）
 *   notActive: string[],        // 送信候補ではない（engaged / blocked / nowhere）
 *   indexSizes: {active, engaged, blocked},
 *   unexpectedActive: string[], // 索引に居るが期待一覧に無い
 * }}
 */
export function auditProspectIndex({ expected, active, engaged, blocked } = {}) {
  const exp = normalizeHashes(expected);
  const activeSet = new Set(normalizeHashes(active));
  const engagedSet = new Set(normalizeHashes(engaged));
  const blockedSet = new Set(normalizeHashes(blocked));

  const placeByHash = new Map();
  const counts = { active: 0, engaged: 0, blocked: 0, nowhere: 0 };
  const nowhere = [];
  const notActive = [];

  for (const h of exp) {
    let place;
    // ⚠️ active を最優先で見る（送信候補かどうかが判断の本体）
    if (activeSet.has(h)) place = INDEX_PLACE.ACTIVE;
    else if (blockedSet.has(h)) place = INDEX_PLACE.BLOCKED;
    else if (engagedSet.has(h)) place = INDEX_PLACE.ENGAGED;
    else place = INDEX_PLACE.NOWHERE;

    placeByHash.set(h, place);
    counts[place] += 1;
    if (place !== INDEX_PLACE.ACTIVE) notActive.push(h);
    if (place === INDEX_PLACE.NOWHERE) nowhere.push(h);
  }

  // 期待一覧に無いのに送信候補になっている hash（逆向きのズレ）
  const expSet = new Set(exp);
  const unexpectedActive = [...activeSet].filter((h) => !expSet.has(h));

  return {
    checked: exp.length,
    counts,
    placeByHash,
    nowhere,
    notActive,
    indexSizes: { active: activeSet.size, engaged: engagedSet.size, blocked: blockedSet.size },
    unexpectedActive,
  };
}

/** レコードから**アドレスを除いた**安全なフィールドだけ取り出す */
export const SAFE_RECORD_FIELDS = Object.freeze([
  'state', 'sends', 'delivered', 'opens', 'clicks', 'lastSentAt', 'lastDeliveredAt',
  'engagedAt', 'engagedKind', 'promotedAt', 'suppressedAt', 'suppressedReason',
  'addedAt', 'batchId', 'source',
]);

/**
 * ⚠️ `email` を**絶対に通さない**。突き合わせに要らない。
 * @returns {object|null} レコードが無ければ null
 */
export function safeRecordView(record) {
  if (!record || typeof record !== 'object') return null;
  const out = {};
  for (const f of SAFE_RECORD_FIELDS) {
    if (record[f] !== undefined) out[f] = record[f];
  }
  return out;
}
