/**
 * prospectAudienceSource.js — prospect プールを**配信の受信対象として読み出す**
 * （Redis I/O は注入。判定は一切しない）
 *
 * ## 何のために要るか
 *
 * CSV 取り込み分を Customers から prospect プールへ移すと、連続配信の受信対象を
 * Airtable から引けなくなる。**移した瞬間に 2 通目が止まる**ので、
 * 移す前に「prospect からも受信対象を作れる」状態にしておく必要がある。
 *
 * ここが返すのは既存の配信計算がそのまま食える 3 つ:
 *
 *   - `rows`             … `buildSequenceProgress()` の `selected` 相当
 *   - `deliveries`       … `CampaignDeliveries` 相当（Redis 台帳から復元）
 *   - `providerSuppressed` / `engagementByEmail` … 停止条件の材料
 *
 * 判定・打ち切り・進行の導出は**すべて既存の関数**が行う（ここでは何も決めない）。
 *
 * ## fail closed
 *
 * 索引も台帳も**読めなかったら中止する**。「読めない」を「0 件」と扱うと、
 *   - 索引が読めない → 対象 0 人 → **2 通目が黙って止まる**
 *   - 台帳が読めない → 全員未送信 → **全員へ再送**
 * のどちらかになる。どちらも黙って起きてはいけない。
 */

import { buildProspectSequenceRows } from './prospectSequenceAdapter.js';
import {
  hydrateProspectSequenceInputs, buildProspectDeliveryKeys,
} from './prospectSequenceHydration.js';

/** 1 回の MGET で読む件数（`prospectStore.loadMany` の上限に合わせる） */
export const LOAD_CHUNK = 500;

export const AUDIENCE_FAIL = Object.freeze({
  INDEX_UNAVAILABLE: 'prospect_index_unavailable',
  LOAD_FAILED: 'prospect_load_failed',
  LEDGER_UNAVAILABLE: 'prospect_ledger_unavailable',
  HYDRATION_FAILED: 'prospect_hydration_failed',
});

/**
 * 送信候補の prospect をすべて読む。**途中で失敗したら部分結果を返さない**。
 *
 * @param {{store: object, maxRecipients?: number}} input
 * @returns {Promise<{ok:boolean, reason?:string, prospects:object[], indexSize:number}>}
 */
export async function loadActiveProspects({ store, maxRecipients } = {}) {
  if (!store || typeof store.activeHashes !== 'function') {
    return { ok: false, reason: AUDIENCE_FAIL.INDEX_UNAVAILABLE, prospects: [], indexSize: 0 };
  }
  let hashes;
  try {
    hashes = await store.activeHashes();
  } catch {
    return { ok: false, reason: AUDIENCE_FAIL.INDEX_UNAVAILABLE, prospects: [], indexSize: 0 };
  }
  const indexSize = hashes.length;
  // ⚠️ 上限は**索引を読み切ったあと**に掛ける（読めた人数は正しく数える）
  const target = Number.isInteger(maxRecipients) && maxRecipients > 0
    ? hashes.slice(0, maxRecipients) : hashes;
  const out = [];
  for (let i = 0; i < target.length; i += LOAD_CHUNK) {
    const group = target.slice(i, i + LOAD_CHUNK);
    try {
      // eslint-disable-next-line no-await-in-loop -- Redis の 1 コマンド上限に合わせて分割
      const loaded = await store.loadMany(group);
      out.push(...loaded);
    } catch {
      return { ok: false, reason: AUDIENCE_FAIL.LOAD_FAILED, prospects: [], indexSize };
    }
  }
  return { ok: true, prospects: out, indexSize };
}

/**
 * prospect プール → 配信計算の入力一式。
 *
 * @param {{store, deliveryKeyStore, campaign, brand, fromEmail, nowMs,
 *          blacklistEmails?: Set<string>, maxRecipients?: number}} input
 */
export async function loadProspectSequenceInputs({
  store, deliveryKeyStore, campaign, brand, fromEmail, nowMs,
  blacklistEmails, maxRecipients,
} = {}) {
  const loaded = await loadActiveProspects({ store, maxRecipients });
  if (!loaded.ok) return { ok: false, reason: loaded.reason, rows: [], deliveries: [] };
  const prospects = loaded.prospects;

  // 送信候補が 0 人でも**それは事実**なので中止しない（読めなかったのとは違う）
  if (prospects.length === 0) {
    return {
      ok: true, rows: [], deliveries: [], prospects: [],
      providerSuppressed: new Set(), engagementByEmail: new Map(),
      counts: { 索引: loaded.indexSize, 読み込み: 0, 変換: 0 }, skipped: {},
    };
  }

  // 既送信の鍵（**読めなければ中止**。未送信と見なすと全員へ再送する）
  let deliveredKeys = null;
  try {
    deliveredKeys = await readDeliveredKeys({
      deliveryKeyStore, campaign, brand, fromEmail, prospects,
    });
  } catch {
    return { ok: false, reason: AUDIENCE_FAIL.LEDGER_UNAVAILABLE, rows: [], deliveries: [] };
  }
  if (!(deliveredKeys instanceof Set)) {
    return { ok: false, reason: AUDIENCE_FAIL.LEDGER_UNAVAILABLE, rows: [], deliveries: [] };
  }

  const hydrated = hydrateProspectSequenceInputs({
    prospects, campaign, brand, fromEmail, deliveredKeys,
  });
  if (!hydrated.ok) {
    return { ok: false, reason: AUDIENCE_FAIL.HYDRATION_FAILED, rows: [], deliveries: [] };
  }
  const rows = buildProspectSequenceRows({ prospects, nowMs, blacklistEmails });
  return {
    ok: true,
    prospects,
    rows: rows.rows,
    skipped: rows.skipped,
    deliveries: hydrated.deliveries,
    providerSuppressed: hydrated.providerSuppressed,
    engagementByEmail: hydrated.engagementByEmail,
    counts: {
      索引: loaded.indexSize,
      読み込み: prospects.length,
      変換: rows.rows.length,
      既送信復元: hydrated.counts['復元'],
    },
  };
}

/**
 * この campaign について「既に送った鍵」を Redis から引く。
 *
 * 候補鍵を作ってから `filterDelivered` に掛ける（集合を丸ごと読まない）。
 * **判定できなければ throw**（呼び出し側が中止する）。
 */
async function readDeliveredKeys({ deliveryKeyStore, campaign, brand, fromEmail, prospects }) {
  if (!deliveryKeyStore || typeof deliveryKeyStore.filterDelivered !== 'function') {
    throw new Error('prospect_ledger_unavailable');
  }
  const byEmail = buildProspectDeliveryKeys({ prospects, campaign, brand, fromEmail });
  const all = [];
  for (const [, byStep] of byEmail) for (const [, k] of byStep) all.push(k);
  if (all.length === 0) return new Set();
  const found = await deliveryKeyStore.filterDelivered({
    brand, campaignId: campaign.campaignId, version: campaign.version, keys: all,
  });
  return new Set(found);
}

/**
 * 受信者に「出所」を付ける。台帳の書き分け（`deliveryKeySource.js`）がこれを見る。
 *
 * ⚠️ **prospect のアドレス集合で判定する**（recordId ではなく）。
 *    `buildCampaignPlan` が recordId を落としても出所を見失わないようにするため。
 */
export function tagRecipientSources({ recipients, prospectEmails } = {}) {
  const set = prospectEmails instanceof Set ? prospectEmails : new Set();
  return (Array.isArray(recipients) ? recipients : []).map((r) => {
    const email = String((r && r.email) || '').trim().toLowerCase();
    return { ...r, 出所: set.has(email) ? 'prospect' : 'customer' };
  });
}

export default loadProspectSequenceInputs;
