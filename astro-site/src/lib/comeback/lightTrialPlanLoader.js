/**
 * lightTrialPlanLoader.js — 下見（管理画面）と実行（cron）が通る**唯一の読み込み経路**
 *
 * ここが 1 本しかないので、`formula` / `sort` / 関所の集合 / `planFingerprint` が
 * 下見と実行でズレることが**構造的に起きない**。
 * 片方だけ直すと壊れるので、**新しい呼び出し側もこの関数を使うこと**。
 *
 * ## 書き込み
 * **しない。** ここは Airtable を読むだけ。付与（PATCH）は cron 側の `applyGrants` だけが行う。
 *
 * ## 全件走査しない
 * Customers は 15,962 件・コホートは 14,489 件あり、全件読むと関数タイムアウトに収まらない。
 * 候補は `Email` 昇順で**必要な分だけ**、関所は「自動付与で配って体験中の人」だけを読む。
 * 上限に達したら**黙って打ち切らず** `abort` を返す（fail closed）。
 */

import {
  buildCandidateFormula, buildBarrierFormula, SELECTION_SORT, PAGE_SIZE,
  selectCandidatesBounded, fetchBarrierRecords, CANDIDATE_MAX_PAGES, BARRIER_MAX_PAGES,
} from './lightTrialSelection.js';
import { buildPlanFromSelection, resolveBatchSize, DEFAULT_BATCH_SIZE } from './lightTrialAutoGrant.js';
import { TRIAL_SEQUENCE_ID } from './lightTrialAutoGrant.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { loadBlacklistEmails } from '../newsletter/airtable-fetch.js';
import { getCampaign } from '../marketing/campaignCatalog.js';
import { getBrandConfig } from '../newsletter/brand-config.js';
import { fetchProviderSuppression } from '../marketing/providerSuppression.js';
import { resolveImportBatchId } from '../crm/importedCohort.js';

export const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
/** 配信履歴のページ上限（キャンペーン単位に絞ってあるので小さい） */
const DELIVERIES_MAX_PAGES = 60;

/** Airtable の 1 ページを読む（**read-only**）。formula が長いので listRecords(POST) */
async function readPage({ apiKey, baseId, table, formula, sort, offset }) {
  const body = { pageSize: PAGE_SIZE };
  if (formula) body.filterByFormula = formula;
  if (sort) body.sort = sort;
  if (offset) body.offset = offset;
  const res = await fetch(
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/listRecords`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`${table}_fetch_${res.status}`);
  const data = await res.json();
  return { records: data.records || [], offset: data.offset };
}

/** 配信履歴（そのキャンペーンぶんだけ）。上限を超えたら例外（黙って減らさない） */
async function readDeliveries({ apiKey, baseId, campaignType }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    // eslint-disable-next-line no-await-in-loop -- offset 方式
    const page = await readPage({
      apiKey,
      baseId,
      table: DELIVERIES_TABLE,
      formula: `AND({EmailType}='campaign',{CampaignType}='${campaignType}')`,
      offset,
    });
    out.push(...page.records);
    offset = page.offset;
    pages += 1;
    if (offset && pages >= DELIVERIES_MAX_PAGES) throw new Error('deliveries_fetch_truncated');
  } while (offset);
  return out;
}

/**
 * 下見・実行の共通ロード。**1 バイトも書かない。**
 *
 * @param {{
 *   env: object, nowMs: number, gates?: object,
 *   batchSizeOverride?: number|null,  // 下見でだけ使う「もし N 件なら」（実行では使わない）
 *   deps?: object,                    // テスト用の差し替え
 * }} input
 */
export async function loadAndPlanLightTrial({
  env = process.env, nowMs = Date.now(), gates, batchSizeOverride = null, deps = {},
  /** そのバッチの通し番号（同じ日の 2 バッチ目以降は operationId が枝番になる） */
  batchSeq = 1,
} = {}) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) return { ok: false, abort: 'airtable_not_configured', sideEffects: 'none' };

  const page = deps.readPage || readPage;
  const deliveriesReader = deps.readDeliveries || readDeliveries;
  const blacklistReader = deps.loadBlacklistEmails || loadBlacklistEmails;
  const suppressionReader = deps.fetchProviderSuppression || fetchProviderSuppression;

  // 下見の「もし N 件なら」は env を直接書き換えず、この呼び出しの中だけで効かせる
  const effectiveEnv = Number.isInteger(batchSizeOverride) && batchSizeOverride > 0
    ? { ...env, LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE: String(batchSizeOverride) }
    : env;
  const batch = resolveBatchSize(effectiveEnv);
  const wanted = batch.ok ? batch.size : DEFAULT_BATCH_SIZE;

  const { emails: blacklistEmails } = await blacklistReader({ brand: BRAND, baseId, apiKey });
  const toRow = (rec) => {
    const fields = (rec && rec.fields) || {};
    return {
      recordId: rec.id,
      fields,
      marketing: resolveCustomerMarketing({ fields, nowMs, blacklistEmails }),
    };
  };

  // ① 候補（**必要な分だけ**・Email 昇順）
  const candidateFormula = buildCandidateFormula();
  const selected = await selectCandidatesBounded({
    fetchPage: ({ offset }) => page({
      apiKey, baseId, table: CUSTOMERS_TABLE, formula: candidateFormula, sort: SELECTION_SORT, offset,
    }),
    toRow,
    batchSize: wanted,
    nowMs,
  });
  if (!selected.ok) {
    return {
      ok: false,
      abort: selected.abort,
      sideEffects: 'none',
      fetch: {
        pagesFetched: selected.pagesFetched,
        recordsFetched: selected.recordsFetched,
        maxPages: CANDIDATE_MAX_PAGES,
      },
    };
  }

  // ② 関所（自動付与で配って**体験中**の人だけ）
  const barrierFormula = buildBarrierFormula();
  const barrierFetch = await fetchBarrierRecords({
    fetchPage: ({ offset }) => page({
      apiKey, baseId, table: CUSTOMERS_TABLE, formula: barrierFormula, sort: SELECTION_SORT, offset,
    }),
    toRow,
  });
  if (!barrierFetch.ok) {
    // 数え切れていない = outstanding が 0 だと言えない → **付与しない**
    return {
      ok: false,
      abort: barrierFetch.abort,
      sideEffects: 'none',
      fetch: { barrierPagesFetched: barrierFetch.pagesFetched, maxPages: BARRIER_MAX_PAGES },
    };
  }

  const campaign = getCampaign(TRIAL_SEQUENCE_ID);
  const campaignType = campaign ? `${campaign.campaignId}:v${campaign.version}` : null;
  const deliveries = campaignType
    ? await deliveriesReader({ apiKey, baseId, campaignType })
    : [];
  const provider = await suppressionReader({ apiKey: env.SENDGRID_API_KEY, nowMs, now: nowMs });

  // ③ 観測できたコホート（**全体数ではない**。取得できた範囲の内訳）
  const byBatch = {};
  for (const row of selected.batch) {
    const id = resolveImportBatchId(row.fields) || '(unknown)';
    byBatch[id] = (byBatch[id] || 0) + 1;
  }

  const selection = {
    cohort: {
      total: selected.recordsFetched,
      // formula がコホートで絞っているので、取得できた件数がそのまま観測数
      inCohort: selected.recordsFetched,
      byBatch,
      /** 全体を数えていないことを呼び出し側へ明示する */
      partial: true,
    },
    candidates: selected.batch,
    batch: selected.batch,
    counts: {
      bounded: true,
      scanned: selected.recordsFetched,
      pagesFetched: selected.pagesFetched,
      recordsFetched: selected.recordsFetched,
      candidates: selected.batch.length,
      batchSize: selected.batch.length,
      remainingExact: null,
      moreAvailable: selected.moreAvailable,
      byReason: selected.skippedByReason,
      cap: wanted,
    },
  };

  const planned = buildPlanFromSelection({
    selection,
    env: effectiveEnv,
    nowMs,
    gates,
    sequenceCampaign: campaign,
    deliveries,
    providerSuppressed: provider && provider.ok ? provider.emails : null,
    brand: BRAND,
    fromEmail: getBrandConfig(BRAND).defaultFromEmail,
    barrierRecords: barrierFetch.rows,
    batchSeq,
  });

  return {
    ok: true,
    planned,
    selection,
    campaign,
    fetch: {
      candidateFormula,
      barrierFormula,
      sort: SELECTION_SORT,
      pagesFetched: selected.pagesFetched,
      recordsFetched: selected.recordsFetched,
      barrierPagesFetched: barrierFetch.pagesFetched,
      barrierRecords: barrierFetch.rows.length,
      moreAvailable: selected.moreAvailable,
      remainingExact: null,
    },
  };
}
