/**
 * lightTrialSelection.js — 無料体験の候補を **Airtable 側で絞って必要な分だけ**取る（純粋）
 *
 * ── なぜ作ったか ────────────────────────────────────────────
 * 旧実装は Customers を**全件走査**していた。コホートが 14,489 件に育った結果:
 *   - cron: `MAX_PAGES=60`(6,000件) を超えて `customers_fetch_truncated` で**必ず落ちる**
 *   - 管理画面の下見: `MAX_PAGES=40`(4,000件) で**黙って打ち切り**、
 *     コホート 3,629 / 候補 3,588 と過少表示していた（真値 14,489 / 14,320）
 * 145 ページの取得は実測 ~41 秒で、Netlify の関数タイムアウトにも収まらない。
 *
 * ── 方針 ────────────────────────────────────────────────────
 * 「**全体を数える**」のをやめ、「**次の N 人を取る**」に変える。
 *   1. Airtable の formula で候補になり得ない人を落とす（下の**超集合の原則**）
 *   2. `Email` 昇順で並べる（重複解消済みで一意 = 順序が決定的）
 *   3. N 人ぶん埋まるまでページを進め、埋まったら**そこで止める**
 *
 * 付与すると `LightGrantedAt` が入って formula から外れるため、次回は自然に次の N 人になる。
 * **offset を保存しない**ので、途中で止まっても状態が壊れない。
 *
 * ── 🛡️ 超集合の原則（ここが安全性の要）──────────────────────
 * formula は **`checkAutoGrantCandidate` が通す人を 1 人も落としてはいけない**。
 * 落とすと、その人は**永久に候補へ出てこない**（誰も気づけない）。
 * 逆に余分に取るのは安全（JS 側の判定で落ちるだけ）。
 * この向きだけの性質を `lightTrialSelection.test.mjs` の総当たりで固定している。
 *
 * そのため formula には「列だけで**無条件に**失格と言える条件」しか書かない:
 *   - コホート外（`Source` 接頭辞）… 定義そのもの
 *   - 付与履歴あり（`*GrantedAt` / `*GrantUntil` / `*GrantLifetime`）… `tierEvidence` と一致
 *   - メール空 / 配信停止 … `resolveSendability` が無条件に落とす列
 *
 * ## ⚠️ Airtable の `!= BLANK()` は使わない（2026-08-12 本番実測）
 *
 * `{Field} != BLANK()` は**中身に関係なく常に真**になる。本番 Customers 15,962 件で:
 *
 * | formula | 件数 |
 * |---|---|
 * | `{LightGrantedAt} = BLANK()` | 15,897 ✅ |
 * | `NOT({LightGrantedAt})` | 15,897 ✅ |
 * | `{LightGrantedAt}`（truthy） | 65 ✅ |
 * | `{LightGrantedAt} != BLANK()` | **15,962（全件・壊れている）** |
 *
 * 「空でない」を書きたいときは **`NOT({Field} = BLANK())`** を使うこと。
 * `!= BLANK()` は静かに条件を無効化するので、テストで禁止している。
 *
 * ⚠️ **`isImportedCustomer` は `Source` 以外に `ImportBatchId` / `CreatedBy` も見る**が、
 *    この Base の Customers には**その 2 列が存在しない**（87 列を実測）。存在しない列を
 *    formula に書くと Airtable は 422 を返すため、`Source` だけで絞っている。
 *    **将来どちらかの列を追加したら、この formula と鏡も必ず更新すること**
 *    （更新しないと、その列でしか判別できない人が永久に候補へ出てこない）。
 *
 * ⚠️ **退会（WithdrawalRequested）は書かない。**`resolveSendability` は退会を
 *    suppression にしていない（契約状態であってメール拒否ではない）。formula に足すと
 *    送れるはずの人を永久に除外する。
 * ⚠️ **有料判定も書かない。**`premiumActive` / `lightActive` は `resolveEntitlements` が
 *    プラン・有効期限・PlanType を組み合わせて出す。列だけの近似は過剰除外になりやすく、
 *    実測でも paid はコホート 14,489 中 1 人しかいない。JS 側で落とせば十分。
 */

import { COHORT_SOURCE_PREFIX } from '../crm/importedCohort.js';
import { checkAutoGrantCandidate } from './lightTrialAutoGrant.js';
import { AUTOGRANT_SOURCE } from './lightTrialBarrier.js';

/** Airtable の 1 ページ件数（API 上限） */
export const PAGE_SIZE = 100;

/**
 * 候補取得のページ上限。**超えたら黙って打ち切らず fail closed**。
 * batch 100 なら通常 1〜2 ページで埋まる。届かないのは formula 側の異常なので止める。
 */
export const CANDIDATE_MAX_PAGES = 40;

/**
 * 関所（付与済みで案内待ち）の取得ページ上限。
 * 無料期間 30 日 × 1 日 100 件 = 定常でも 3,000 件程度に収まる想定。
 * 超えたら「outstanding を数え切れていない」ので **付与しない**（fail closed）。
 */
export const BARRIER_MAX_PAGES = 60;

/** 並び順の正本。`Email` は重複解消済み（2026-08-12）で一意なので決定的に並ぶ */
export const SELECTION_SORT = Object.freeze([
  Object.freeze({ field: 'Email', direction: 'asc' }),
]);

/** 取得を打ち切った理由（**silent truncation を作らない**ためのコード） */
export const SELECTION_ABORT = Object.freeze({
  CANDIDATE_SCAN_LIMIT: 'candidate_scan_limit',
  BARRIER_SCAN_LIMIT: 'barrier_scan_limit',
});

const str = (v) => String(v ?? '').trim();
const isBlank = (v) => str(v) === '';

/**
 * 候補になり得ない人を Airtable 側で落とす formula。
 *
 * ⚠️ 条件を足すときは**必ず**「その列だけで無条件に失格と言えるか」を確認し、
 *    `lightTrialSelection.test.mjs` の超集合テストを通すこと。
 */
export function buildCandidateFormula() {
  return [
    'AND(',
    [
      // コホート（取り込み時に必ず書かれる Source の接頭辞）
      `FIND('${COHORT_SOURCE_PREFIX}', {Source}) = 1`,
      // メールが無ければ送れない（resolveSendability: NO_EMAIL）
      // ⚠️ `!= BLANK()` は使わない（下の注記参照。本番で**常に真**になる）
      'NOT({Email} = BLANK())',
      // 配信停止（resolveSendability: UNSUBSCRIBED）
      'NOT({UnsubscribedAnalyticsKeiba})',
      // 付与履歴（tierEvidence.granted = grantedAt / until / lifetime / active）
      '{LightGrantedAt} = BLANK()',
      '{LightGrantUntil} = BLANK()',
      'NOT({LightGrantLifetime})',
      '{PremiumGrantedAt} = BLANK()',
      '{PremiumGrantUntil} = BLANK()',
      'NOT({PremiumGrantLifetime})',
    ].join(', '),
    ')',
  ].join('');
}

/**
 * 上の formula と**同じ判定**を JS で行う（テスト用の鏡）。
 * これが false なら Airtable も返さない、を総当たりで突き合わせる。
 */
export function candidateFormulaAccepts(fields) {
  const f = fields || {};
  if (!str(f.Source).startsWith(COHORT_SOURCE_PREFIX)) return false;
  if (isBlank(f.Email)) return false;
  if (f.UnsubscribedAnalyticsKeiba === true) return false;
  if (!isBlank(f.LightGrantedAt)) return false;
  if (!isBlank(f.LightGrantUntil)) return false;
  if (f.LightGrantLifetime === true) return false;
  if (!isBlank(f.PremiumGrantedAt)) return false;
  if (!isBlank(f.PremiumGrantUntil)) return false;
  if (f.PremiumGrantLifetime === true) return false;
  return true;
}

/**
 * 関所の対象（自動付与で配って**まだ体験中**の人）だけを取る formula。
 *
 * 体験が終わった人は `evaluateStep1Barrier` が `grant_ended` で片付け扱いにするので、
 * 取ってこなくても `outstanding` は変わらない（集合を小さく保つ）。
 */
export function buildBarrierFormula() {
  const active = [
    '{LightGrantLifetime}',
    'AND(NOT({LightGrantUntil} = BLANK()), IS_AFTER({LightGrantUntil}, NOW()))',
  ].join(', ');
  return `AND({ComebackGrantSource} = '${AUTOGRANT_SOURCE}', OR(${active}))`;
}

/** 上の barrier formula の JS 鏡（テスト用） */
export function barrierFormulaAccepts(fields, nowMs) {
  const f = fields || {};
  if (str(f.ComebackGrantSource).toLowerCase() !== AUTOGRANT_SOURCE) return false;
  if (f.LightGrantLifetime === true) return true;
  const until = Date.parse(str(f.LightGrantUntil));
  return Number.isFinite(until) && until > (Number.isFinite(nowMs) ? nowMs : Date.now());
}

/**
 * 候補を**必要な分だけ**集める。1 ページで足りなければ次のページへ進む。
 *
 * `fetchPage` は `{ records, offset }` を返す関数（Airtable でもテストの偽物でもよい）。
 * この関数自身は **1 バイトも書かない**。
 *
 * @param {{
 *   fetchPage: (arg: {offset: string|undefined}) => Promise<{records: object[], offset?: string}>,
 *   toRow: (rec: object) => {recordId: string, fields: object, marketing: object},
 *   batchSize: number, nowMs: number, batchIds?: string[]|null, maxPages?: number,
 * }} input
 */
export async function selectCandidatesBounded({
  fetchPage, toRow, batchSize, nowMs, batchIds = null, maxPages = CANDIDATE_MAX_PAGES,
}) {
  const want = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 0;
  const batch = [];
  const skippedByReason = {};
  const seenEmail = new Set();
  let offset;
  let pagesFetched = 0;
  let recordsFetched = 0;
  /** 打ち切った時点で「まだ先がある」か */
  let moreAvailable = false;

  while (batch.length < want) {
    if (pagesFetched >= maxPages) {
      // **黙って打ち切らない**。数え切れていないことを呼び出し側へ返す
      return {
        ok: false,
        abort: SELECTION_ABORT.CANDIDATE_SCAN_LIMIT,
        pagesFetched, recordsFetched, maxPages,
        batch: [], skippedByReason, moreAvailable: true, remainingExact: null,
      };
    }

    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式で直列にしか進めない
    const page = await fetchPage({ offset });
    const records = (page && page.records) || [];
    pagesFetched += 1;
    recordsFetched += records.length;

    for (let i = 0; i < records.length; i += 1) {
      if (batch.length >= want) {
        // このページに未消化が残っている = まだ先がある
        moreAvailable = true;
        break;
      }
      const row = toRow(records[i]);
      const check = checkAutoGrantCandidate({
        fields: row.fields, marketing: row.marketing, batchIds, nowMs,
      });
      if (!check.ok) {
        skippedByReason[check.reason] = (skippedByReason[check.reason] || 0) + 1;
        continue;
      }
      const email = str((row.marketing && row.marketing.email) || (row.fields && row.fields.Email))
        .toLowerCase();
      if (email && seenEmail.has(email)) continue;
      if (email) seenEmail.add(email);
      batch.push({ recordId: row.recordId, fields: row.fields });
    }

    offset = page && page.offset;
    if (!offset) break;          // 全部見た（これ以上は無い）
    if (batch.length >= want) { moreAvailable = true; break; }
  }

  // offset が残ったまま埋まった場合も「まだ先がある」
  if (offset && batch.length >= want) moreAvailable = true;

  return {
    ok: true,
    batch,
    skippedByReason,
    pagesFetched,
    recordsFetched,
    moreAvailable,
    /** 全件走査をやめたので**正確な残数は出さない**（UI にもそう出す） */
    remainingExact: null,
  };
}

/**
 * 関所の対象者を集める。件数が想定を超えたら **fail closed**（付与しない）。
 *
 * @param {{fetchPage: Function, toRow: Function, maxPages?: number}} input
 */
export async function fetchBarrierRecords({ fetchPage, toRow, maxPages = BARRIER_MAX_PAGES }) {
  const rows = [];
  let offset;
  let pagesFetched = 0;

  do {
    if (pagesFetched >= maxPages) {
      return {
        ok: false,
        abort: SELECTION_ABORT.BARRIER_SCAN_LIMIT,
        pagesFetched, maxPages, rows: [],
      };
    }
    // eslint-disable-next-line no-await-in-loop -- offset 方式
    const page = await fetchPage({ offset });
    for (const rec of (page && page.records) || []) rows.push(toRow(rec));
    pagesFetched += 1;
    offset = page && page.offset;
  } while (offset);

  return { ok: true, rows, pagesFetched };
}
