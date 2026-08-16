/**
 * deliveryEventBackfill.js — 既に届いたイベントを索引へ**後から**入れる計画（純粋）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `deliveryEventIndex` は webhook 受信時に畳む。したがって**索引を作る前に届いた分**
 * （例: 2026-08-16 の 100 通の delivered / open）は入っていない。
 * 正本は Blob の生ログなので、そこから**対象の DeliveryKey だけ**を拾って入れ直す。
 *
 * ── 設計 ──────────────────────────────────────────────────────
 * - **対象を先に決める**（`targetKeys`）。Blob 全件を走査して「ついでに入れる」はしない
 * - 日付で範囲を絞る（Blob の鍵は `ak/email-events/YYYY/MM/DD/...`）
 * - このモジュールは**計画を作るだけ**。Redis への書き込みは呼び出し側
 * - **冪等**: 同じ計画を何度実行しても、索引側の畳み込み（min/max・event id 重複排除）で
 *   結果が変わらない
 *
 * ── conflict とは ─────────────────────────────────────────────
 * 同じ DeliveryKey に、**別の campaign / version が刻まれたイベント**が混ざっている状態。
 * 鍵は campaign × version × step × 受信者から作るので、本来ありえない。
 * 起きていたら**その鍵は書かない**（推測で片付けない）。
 */

import { isSafeDeliveryKey, INDEXED_EVENTS } from './deliveryEventIndex.js';

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Blob の鍵に使う日付プレフィックス（`ak/email-events/YYYY/MM/DD`） */
export function blobDatePrefix(dateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(dateIso));
  if (!m) return null;
  return `ak/email-events/${m[1]}/${m[2]}/${m[3]}`;
}

/** 走査してよい Blob の数の上限（**全件走査させない**） */
export const MAX_BLOBS_PER_RUN = 500;

/**
 * NDJSON 1 本を行の配列へ（壊れた行は捨てる）。
 */
export function parseNdjson(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 壊れた行は捨てる（数だけ呼び出し側で見る） */ }
  }
  return out;
}

/**
 * 生ログの行から、**対象の鍵だけ**を拾って計画を作る。
 *
 * @param {{records: object[], targetKeys: Set<string>|string[]}} input
 * @returns {{plan: Map<string, object>, stats: object}}
 */
export function planBackfill({ records, targetKeys }) {
  const targets = targetKeys instanceof Set ? targetKeys : new Set(targetKeys || []);
  const plan = new Map();
  const conflicts = new Map();
  const stats = {
    scanned: 0,
    matched: 0,
    resolvedDelivered: 0,
    resolvedOpen: 0,
    unresolved: 0,
    otherType: 0,
    notTargeted: 0,
    badKey: 0,
    conflicts: 0,
  };

  for (const r of Array.isArray(records) ? records : []) {
    stats.scanned += 1;
    const key = str(r && r.deliveryKey);
    const type = str(r && r.eventType).toLowerCase();
    const atMs = num(r && r.eventAtMs);

    // resolved（3 点一致）でないイベントは**索引に入れない**
    if (str(r && r.resolutionStatus) !== 'resolved') { stats.unresolved += 1; continue; }
    if (!key) { stats.badKey += 1; continue; }
    if (!isSafeDeliveryKey(key)) { stats.badKey += 1; continue; }
    if (!targets.has(key)) { stats.notTargeted += 1; continue; }
    if (!INDEXED_EVENTS.includes(type)) { stats.otherType += 1; continue; }
    if (atMs === null) { stats.badKey += 1; continue; }

    stats.matched += 1;

    // 同じ鍵に別の campaign / version が混ざっていないか
    const stamp = `${str(r.campaignId)}:v${str(r.campaignVersion)}`;
    const known = conflicts.get(key);
    if (known && known !== stamp) {
      stats.conflicts += 1;
      plan.delete(key);          // 判断できないので**書かない**
      conflicts.set(key, '__conflict__');
      continue;
    }
    if (known === '__conflict__') continue;
    conflicts.set(key, stamp);

    const cur = plan.get(key) || {
      deliveredAtMs: null, firstOpenAtMs: null, lastOpenAtMs: null, openEventIds: [],
    };
    if (type === 'delivered') {
      cur.deliveredAtMs = cur.deliveredAtMs === null ? atMs : Math.min(cur.deliveredAtMs, atMs);
      stats.resolvedDelivered += 1;
    } else {
      cur.firstOpenAtMs = cur.firstOpenAtMs === null ? atMs : Math.min(cur.firstOpenAtMs, atMs);
      cur.lastOpenAtMs = cur.lastOpenAtMs === null ? atMs : Math.max(cur.lastOpenAtMs, atMs);
      const id = str(r.providerEventId);
      if (id && !cur.openEventIds.includes(id)) cur.openEventIds.push(id);
      stats.resolvedOpen += 1;
    }
    plan.set(key, cur);
  }

  return { plan, stats };
}

/**
 * 画面・ログへ出す形（**件数だけ**。鍵・アドレス・recordId は出さない）。
 */
export function describeBackfillPlan({ plan, stats, targetKeys, blobsScanned }) {
  const targets = targetKeys instanceof Set ? targetKeys.size : (targetKeys || []).length;
  let willWriteDelivered = 0;
  let willWriteOpen = 0;
  for (const v of plan.values()) {
    if (v.deliveredAtMs !== null) willWriteDelivered += 1;
    if (v.firstOpenAtMs !== null) willWriteOpen += 1;
  }
  return {
    targetKeys: targets,
    blobsScanned: num(blobsScanned) ?? 0,
    eventsScanned: stats.scanned,
    matched: stats.matched,
    resolvedDelivered: stats.resolvedDelivered,
    resolvedOpen: stats.resolvedOpen,
    unresolved: stats.unresolved,
    conflicts: stats.conflicts,
    /** 実行したら書き込む鍵の数（delivered / open それぞれ 1 件以上ある鍵） */
    willWriteKeys: plan.size,
    willWriteDelivered,
    willWriteOpen,
    /** 対象なのに 1 件も記録が見つからなかった鍵 */
    missingKeys: Math.max(0, targets - plan.size),
  };
}

export default planBackfill;
