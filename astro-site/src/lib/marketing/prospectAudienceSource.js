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

import { createHash } from 'node:crypto';
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
  /** 窓を跨いでいる間に索引が変わった（**最初からやり直す**） */
  INDEX_CHANGED: 'prospect_index_changed',
});

/**
 * 索引の並びを**決定的**にする。
 *
 * ⚠️ `SMEMBERS` は **順序を保証しない**。返ってきた配列にそのまま `offset` / `limit` を
 *    掛けると、窓を跨いだときに並びが変わり、**同じ人を 2 回読んだり読み落としたり**する。
 *    昇順に並べ替えてから切ること。hash は 64 桁の hex なので辞書順が安定する。
 * ⚠️ 念のため重複も落とす（集合なので普通は起きないが、起きたら窓がずれる）。
 */
export function stableIndexOrder(hashes) {
  return [...new Set((Array.isArray(hashes) ? hashes : []).map(String))].sort();
}

/**
 * 索引の指紋。**全部の窓で同じであること**を確かめるために使う。
 *
 * 途中で誰かが増減すると指紋が変わる。変わったまま読み進めると窓がずれるので、
 * 呼び出し側は `INDEX_CHANGED` を受けたら**最初からやり直す**（fail closed）。
 */
export function indexDigest(hashes) {
  const ordered = stableIndexOrder(hashes);
  const h = createHash('sha256');
  h.update(`${ordered.length}:`, 'utf8');
  for (const x of ordered) h.update(x, 'utf8');
  return h.digest('hex').slice(0, 32);
}

/**
 * 送信候補の prospect を読む。**途中で失敗したら部分結果を返さない**。
 *
 * `offset` / `maxRecipients` は**索引の窓**。移行後の検証で 1 万件超を
 * 1 回の実行で見ようとすると Function の実行時間を超えるため、分割して呼べるようにする
 * （2026-08-27 に本番で 504）。配信の順序ではなく、あくまで読み出しの窓。
 *
 * ⚠️ **`SMEMBERS` の並びに依存しない。** 昇順へ並べ替えてから切る（`stableIndexOrder`）。
 *    素の応答へ `offset` を掛けると、窓を跨いだときに並びが変わって
 *    **同じ人を 2 回読んだり読み落としたり**する。
 * ⚠️ `expectDigest` を渡すと、**索引が途中で変わっていないか**を確かめる。
 *    変わっていたら `INDEX_CHANGED` を返し、呼び出し側は**最初からやり直す**。
 * ⚠️ 窓を掛けるのは**索引を読み切ったあと**。`indexSize` は常に全体を指す。
 * ⚠️ **次の窓は `scanned` だけ進める**（`prospects.length` ではない）。
 *    `loadMany` は**値を読めなかった hash を落とす**ので、読めた件数で進めると
 *    その分だけ窓が巻き戻り、**同じ人を 2 回読む**。1 窓まるごと読めなければ
 *    `nextOffset` が動かず**進まなくなる**。索引を何件消費したかで進めること。
 *
 * @param {{store: object, maxRecipients?: number, offset?: number, expectDigest?: string}} input
 * @returns {Promise<{ok, reason?, prospects, indexSize, digest, scanned, missing}>}
 */
export async function loadActiveProspects({ store, maxRecipients, offset, expectDigest } = {}) {
  if (!store || typeof store.activeHashes !== 'function') {
    return {
      ok: false, reason: AUDIENCE_FAIL.INDEX_UNAVAILABLE, prospects: [], indexSize: 0, scanned: 0,
    };
  }
  let raw;
  try {
    raw = await store.activeHashes();
  } catch {
    return {
      ok: false,
      reason: AUDIENCE_FAIL.INDEX_UNAVAILABLE,
      prospects: [],
      indexSize: 0,
      digest: null,
      scanned: 0,
    };
  }
  // ⚠️ **並びを決めてから切る**（`SMEMBERS` の順に依存しない）
  const hashes = stableIndexOrder(raw);
  const indexSize = hashes.length;
  const digest = indexDigest(hashes);
  // ⚠️ 窓を跨いでいる間に集合が変わっていたら**やり直す**（部分結果を混ぜない）
  if (expectDigest && expectDigest !== digest) {
    return {
      ok: false, reason: AUDIENCE_FAIL.INDEX_CHANGED, prospects: [], indexSize, digest, scanned: 0,
    };
  }
  // ⚠️ 窓は**索引を読み切ったあと**に掛ける（読めた人数は正しく数える）
  const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const window = hashes.slice(from);
  const target = Number.isInteger(maxRecipients) && maxRecipients > 0
    ? window.slice(0, maxRecipients) : window;
  const out = [];
  for (let i = 0; i < target.length; i += LOAD_CHUNK) {
    const group = target.slice(i, i + LOAD_CHUNK);
    try {
      // eslint-disable-next-line no-await-in-loop -- Redis の 1 コマンド上限に合わせて分割
      const loaded = await store.loadMany(group);
      out.push(...loaded);
    } catch {
      return {
        ok: false, reason: AUDIENCE_FAIL.LOAD_FAILED, prospects: [], indexSize, digest, scanned: 0,
      };
    }
  }
  // ⚠️ **索引を何件消費したか**を返す。読めた件数（`out.length`）で窓を進めてはいけない
  //    （`loadMany` が値を読めなかった hash を落とすため、その分だけ窓が巻き戻る）。
  return {
    ok: true,
    prospects: out,
    indexSize,
    digest,
    scanned: target.length,
    missing: target.length - out.length,
  };
}

/**
 * prospect プール → 配信計算の入力一式。
 *
 * @param {{store, deliveryKeyStore, campaign, brand, fromEmail, nowMs,
 *          blacklistEmails?: Set<string>, maxRecipients?: number}} input
 */
export async function loadProspectSequenceInputs({
  store, deliveryKeyStore, campaign, brand, fromEmail, nowMs,
  blacklistEmails, maxRecipients, offset, expectDigest,
} = {}) {
  const loaded = await loadActiveProspects({ store, maxRecipients, offset, expectDigest });
  if (!loaded.ok) {
    return {
      ok: false, reason: loaded.reason, rows: [], deliveries: [],
      indexSize: loaded.indexSize, digest: loaded.digest, scanned: 0,
    };
  }
  const prospects = loaded.prospects;

  // 送信候補が 0 人でも**それは事実**なので中止しない（読めなかったのとは違う）
  if (prospects.length === 0) {
    return {
      ok: true, rows: [], deliveries: [], prospects: [],
      providerSuppressed: new Set(), engagementByEmail: new Map(),
      indexSize: loaded.indexSize,
      digest: loaded.digest,
      // ⚠️ 1 件も読めなくても**索引は消費している**。0 にすると窓が進まなくなる
      scanned: loaded.scanned,
      missing: loaded.missing,
      counts: { 索引: loaded.indexSize, 読み込み: 0, 変換: 0, 値なし: loaded.missing }, skipped: {},
    };
  }

  // 既送信の鍵（**読めなければ中止**。未送信と見なすと全員へ再送する）
  let deliveredKeys = null;
  try {
    deliveredKeys = await readDeliveredKeys({
      deliveryKeyStore, campaign, brand, fromEmail, prospects,
    });
  } catch {
    return {
      ok: false, reason: AUDIENCE_FAIL.LEDGER_UNAVAILABLE, rows: [], deliveries: [], scanned: 0,
    };
  }
  if (!(deliveredKeys instanceof Set)) {
    return {
      ok: false, reason: AUDIENCE_FAIL.LEDGER_UNAVAILABLE, rows: [], deliveries: [], scanned: 0,
    };
  }

  const hydrated = hydrateProspectSequenceInputs({
    prospects, campaign, brand, fromEmail, deliveredKeys,
  });
  if (!hydrated.ok) {
    return {
      ok: false, reason: AUDIENCE_FAIL.HYDRATION_FAILED, rows: [], deliveries: [], scanned: 0,
    };
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
    /** 索引全体の件数（窓を掛けても**全体**を指す） */
    indexSize: loaded.indexSize,
    /** 索引の指紋。**全窓で同じであること**を呼び出し側が確かめる */
    digest: loaded.digest,
    /** ⚠️ この窓で**索引を消費した件数**。次の窓はこれだけ進める（読めた件数ではない）*/
    scanned: loaded.scanned,
    /** 索引にはあるが値を読めなかった件数（窓は消費済みとして進める）*/
    missing: loaded.missing,
    counts: {
      索引: loaded.indexSize,
      読み込み: prospects.length,
      値なし: loaded.missing,
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
