/**
 * sendgridMigrationScan.js — prospect 索引を**窓で読み**、通し番号別の件数を出す
 * （Redis I/O は注入。**読み取りのみ・1 バイトも書かない**）
 *
 * ## 何をするか
 *
 * `loadActiveProspects`（既存）で索引を窓ぶん読み、10 通ぶんの `DeliveryKey` を
 * campaign 単位で台帳に照会し、1 人ずつ「次に送るべき通し番号」を決める。
 * 返すのは**件数だけ**（アドレスは含めない）。
 *
 * ## 窓が既存の下見より小さい理由
 *
 * `prospectSequenceCheck` は 1 campaign（3 step）ぶんの鍵しか引かないが、
 * ここは **10 通ぶん**引くので 1 人あたりの照会数が 3 倍を超える。
 * 既定を **500** にして、`nextOffset` で続きから読む（全体は複数回に分けて読む）。
 *
 * ## fail closed
 *
 * - 索引が読めない → 中止（0 件と混同しない）
 * - 台帳が読めない → **その窓を中止**（未送信と見なすと全員へ再送になる）
 * - 窓を跨いでいる間に索引が変わった（`digest` 不一致）→ **最初からやり直す**
 *
 * ⚠️ 集計の合算は **`missing` の合計が 0 のときだけ**信用する
 *    （値を読めなかった人が居る窓を混ぜて「確定」にしない）。
 */

import { loadActiveProspects, AUDIENCE_FAIL } from './prospectAudienceSource.js';
import {
  buildMessagePlan, buildMessageKeys, groupPlanByCampaign, TOTAL_MESSAGES,
} from './sendgridMessagePlan.js';
import {
  resolveNextMessage, summarizeNextMessages, MIGRATION_STATUS,
} from './sendgridNextMessage.js';

/** 1 窓で読む prospect 数（10 通ぶんの鍵を引くので既存の下見より小さく取る） */
export const DEFAULT_SCAN_LIMIT = 500;
export const MAX_SCAN_LIMIT = 2000;

export const SCAN_FAIL = Object.freeze({
  PLAN_UNAVAILABLE: 'plan_unavailable',
  INDEX_UNAVAILABLE: 'prospect_index_unavailable',
  INDEX_CHANGED: 'prospect_index_changed',
  LEDGER_UNAVAILABLE: 'prospect_ledger_unavailable',
  KEY_BUILD_FAILED: 'delivery_key_build_failed',
});

export function resolveScanLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_SCAN_LIMIT;
  return Math.min(MAX_SCAN_LIMIT, n);
}

/**
 * 1 窓ぶんの走査（**読み取りのみ**）。
 *
 * @param {{
 *   store: object,                 // `createProspectStore` 相当
 *   deliveryKeyStore: object,      // `createDeliveryKeyStore` 相当（`filterDelivered`）
 *   brand: string, fromEmail: string,
 *   offset?: number, limit?: number, expectDigest?: string,
 *   plan?: Array,                  // 省略時は catalog から組む
 * }} input
 */
export async function scanMigrationWindow({
  store, deliveryKeyStore, brand, fromEmail, offset, limit, expectDigest, plan: givenPlan,
} = {}) {
  const planResult = Array.isArray(givenPlan) && givenPlan.length === TOTAL_MESSAGES
    ? { ok: true, plan: givenPlan }
    : buildMessagePlan();
  if (!planResult.ok) {
    return {
      ok: false, reason: SCAN_FAIL.PLAN_UNAVAILABLE, detail: planResult.reason || null,
    };
  }
  const plan = planResult.plan;

  const from = Number.isInteger(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
  const size = resolveScanLimit(limit);

  const loaded = await loadActiveProspects({
    store, maxRecipients: size, offset: from, expectDigest,
  });
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.reason === AUDIENCE_FAIL.INDEX_CHANGED
        ? SCAN_FAIL.INDEX_CHANGED : SCAN_FAIL.INDEX_UNAVAILABLE,
      detail: loaded.reason,
      digest: loaded.digest || null,
      indexSize: loaded.indexSize ?? null,
    };
  }

  const prospects = loaded.prospects;
  const window = {
    offset: from,
    limit: size,
    indexSize: loaded.indexSize,
    returned: prospects.length,
    scanned: loaded.scanned,
    missing: loaded.missing ?? 0,
    digest: loaded.digest,
    nextOffset: from + loaded.scanned < loaded.indexSize ? from + loaded.scanned : null,
  };

  if (prospects.length === 0) {
    return {
      ok: true,
      window,
      results: [],
      summary: summarizeNextMessages([]),
    };
  }

  // 1) 1 人ぶんの「通し番号 → 鍵」（**鍵の作り方は変えない**）
  const keysByEmail = new Map();
  for (const p of prospects) {
    const email = String((p && p.email) || '').trim().toLowerCase();
    if (!email || keysByEmail.has(email)) continue;
    const keys = buildMessageKeys({ plan, email, brand, fromEmail });
    // ⚠️ 1 つでも作れなければ**その人は判定不能**にする（推測で埋めない）
    keysByEmail.set(email, keys);
  }

  // 2) campaign ごとに台帳へ照会（**読めなければ窓ごと中止**）
  const deliveredKeys = new Set();
  for (const group of groupPlanByCampaign(plan)) {
    const wanted = [];
    for (const [, keys] of keysByEmail) {
      if (!keys) continue;
      for (const entry of group.entries) {
        const k = keys.get(entry.messageNumber);
        if (k) wanted.push(k);
      }
    }
    if (wanted.length === 0) continue;
    let found;
    try {
      // eslint-disable-next-line no-await-in-loop -- campaign は 2 本だけ
      found = await deliveryKeyStore.filterDelivered({
        brand, campaignId: group.campaignId, version: group.version, keys: wanted,
      });
    } catch {
      return { ok: false, reason: SCAN_FAIL.LEDGER_UNAVAILABLE, detail: group.campaignId, window };
    }
    if (!Array.isArray(found)) {
      return { ok: false, reason: SCAN_FAIL.LEDGER_UNAVAILABLE, detail: group.campaignId, window };
    }
    for (const k of found) deliveredKeys.add(k);
  }

  // 3) 1 人ずつ判定（**アドレスは results に持つが、集計には出さない**）
  const results = [];
  for (const p of prospects) {
    const email = String((p && p.email) || '').trim().toLowerCase();
    const keys = email ? keysByEmail.get(email) : null;
    let sent = null;
    if (keys) {
      sent = new Set();
      for (const [messageNumber, key] of keys) {
        if (deliveredKeys.has(key)) sent.add(messageNumber);
      }
    }
    const r = resolveNextMessage({ prospect: p, deliveredMessageNumbers: sent });
    results.push({
      ...r,
      email,
      hash: (p && p.hash) || null,
      delivered: Number(p && p.delivered) || 0,
    });
  }

  return { ok: true, window, results, summary: summarizeNextMessages(results) };
}

/**
 * 窓ごとの集計を足し合わせる（**`missing` が 1 件でもあれば「確定」にしない**）。
 *
 * @param {Array<{window: object, summary: object}>} windows
 */
export function mergeScanSummaries(windows) {
  const list = Array.isArray(windows) ? windows : [];
  const byNextMessage = {};
  for (let n = 1; n <= TOTAL_MESSAGES; n += 1) byNextMessage[n] = 0;
  const excluded = {}; const unresolved = {};
  let ready = 0; let completed = 0; let gaps = 0; let missing = 0; let scanned = 0;
  const digests = new Set();

  for (const w of list) {
    const s = (w && w.summary) || {};
    ready += Number(s['移行対象']) || 0;
    completed += Number(s['配り終えた']) || 0;
    gaps += Number(s['穴あき']) || 0;
    for (const [k, v] of Object.entries(s['次に送る番号別'] || {})) {
      byNextMessage[k] = (byNextMessage[k] || 0) + (Number(v) || 0);
    }
    for (const [k, v] of Object.entries(s['除外の内訳'] || {})) {
      excluded[k] = (excluded[k] || 0) + (Number(v) || 0);
    }
    for (const [k, v] of Object.entries(s['判定不能の内訳'] || {})) {
      unresolved[k] = (unresolved[k] || 0) + (Number(v) || 0);
    }
    const win = (w && w.window) || {};
    missing += Number(win.missing) || 0;
    scanned += Number(win.scanned) || 0;
    if (win.digest) digests.add(String(win.digest));
  }

  const excludedTotal = Object.values(excluded).reduce((a, b) => a + b, 0);
  const unresolvedTotal = Object.values(unresolved).reduce((a, b) => a + b, 0);
  return {
    窓数: list.length,
    走査済み: scanned,
    値なし: missing,
    /** **確定と呼んでよいか**（読めなかった人が 0 かつ索引が変わっていない）*/
    確定: missing === 0 && digests.size <= 1,
    索引digest: digests.size === 1 ? [...digests][0] : null,
    移行対象: ready,
    配り終えた: completed,
    除外: excludedTotal,
    判定不能: unresolvedTotal,
    次に送る番号別: byNextMessage,
    除外の内訳: excluded,
    判定不能の内訳: unresolved,
    穴あき: gaps,
  };
}

/** 変換層へ渡す形（`ready` だけ）。**呼び出し側が SendGrid へ送る直前にだけ使う** */
export function toExportEntries(results) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.status === MIGRATION_STATUS.READY)
    .map((r) => ({
      email: r.email,
      hash: r.hash || null,
      status: r.status,
      nextMessageNumber: r.nextMessageNumber,
      highestSent: r.highestSent,
      delivered: r.delivered,
    }));
}

export default scanMigrationWindow;
