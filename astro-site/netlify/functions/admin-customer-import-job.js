/**
 * admin-customer-import-job.js — 大量取り込みの**親ジョブ**（開始 1 回・子バッチは 100 件以下）
 *
 * ⚠️ **既定では 1 件も書かない。** 実行には二重のゲートが要る:
 *      1. `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production では未設定のまま）
 *      2. 開始時の確認文字列 `IMPORT-JOB <batchId> <対象総数>`
 *    どちらか一方でも欠ければ **fail closed**（何も書かずに 403 / 409 を返す）。
 *
 * ⚠️ さらに現在は **kill-switch で start / step を封じている**（BLOCKED）。
 *    ADR `docs/decisions.md` 2026-08-05 の承認と Redis canary が済むまで外さない。
 *
 * ── 方針（単発 run と同じ・変更禁止）──────────────────────────
 *   - 作るのは CREATE_CANDIDATE だけ。**UPDATE_CANDIDATE は 1 件も触らない**
 *   - 既存 Customers を上書きしない（**PATCH を組み立てない**）
 *   - EXCLUDED / REVIEW_REQUIRED は書かない
 *   - **子バッチのたびに** Customers を取り直して重複を再判定する（第二防御）
 *   - 課金・特典・決済・配信停止のフィールドには触らない（allow-list で構造的に禁止）
 *   - メールは 1 通も送らない（この Function に送信経路が無い）
 *
 * ── 排他と正本は Redis ────────────────────────────────────────
 *   - **グローバルロック**（AK 全体で同時に 1 ジョブ）を取れなければ Airtable を読まない・書かない
 *   - 親 ImportJob の**正本は Redis**（`importJobAuthority.js`）
 *   - 行 claim は**正規化メール単位でグローバル**（`importClaimStore.js`）
 *   - Redis 異常はすべて **fail-closed**（新規書き込みを全面停止）
 *
 * 1 呼び出し = **子バッチ 1 つ**。画面が完了まで逐次呼び直す（並行に走らせない）。
 */

import { buildImportRows, hashBytes, MAX_FILE_BYTES, CSV_ERROR_LABEL } from '../../src/lib/crm/csvParse.js';
import { mapColumns, normalizeEmail } from '../../src/lib/crm/customerImport.js';
import { mergeImportFiles } from '../../src/lib/crm/importMergePlan.js';
import { buildAkFacts } from '../../src/lib/crm/importAkFacts.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import { orderEntriesDeterministically, countCreateCandidates, summarizeImportPlan } from '../../src/lib/crm/importEligibility.js';
import {
  canStartImportJob, canStepImportJob, cancelImportJob, beginChildBatch, applyChildResult,
  markJobBlocked, markJobRedisUnavailable, summarizeJobProgress, describeJobRollback,
  buildJobId, buildJobSource, buildJobConfirmation, buildOperationId, countChildBatches,
  nextChildIndex, JOB_CHILD_MAX_ROWS, JOB_REJECT, JOB_REJECT_LABEL, JOB_STATUS,
  adoptMeasuredCreated,
  unblockImportJob,
  repairCounterInvariants,
  buildUnblockConfirmation,
} from '../../src/lib/crm/importJobModel.js';
import {
  createClaimStore, emailHash, RedisUnavailableError, LOCK_TTL_MS,
} from '../../src/lib/crm/importClaimStore.js';
import {
  createJobAuthority, buildJobRecord, ORDERING_VERSION, computeSnapshotFingerprint,
} from '../../src/lib/crm/importJobAuthority.js';
import { runChildBatch } from '../../src/lib/crm/importJobRunner.js';
import { verifyWrittenBatch, shouldRunFullReconcile, BATCH_VERIFY } from '../../src/lib/crm/importBatchVerify.js';

import { reconcileImportJob, RECONCILE_VERDICT, shouldRemeasureBeforeBlock } from '../../src/lib/crm/importJobReconcile.js';
import { CREATE_ALLOWED_FIELDS, OPTIONAL_AUDIT_FIELDS } from '../../src/lib/crm/importWritePlan.js';

const CUSTOMERS_TABLE = 'Customers';
/**
 * Customers 全件取得のページ上限。
 *
 * ⚠️ 60（= 6,000 件）だと**取り込みが進むほど数えきれなくなる**。
 *    2026-08-09 の本実行で総件数が 6,088 になった時点で打ち切られ、
 *    実測が過少になって created_matches_airtable が永久に落ちた。
 *    最終的な総件数は 1,688 + 14,279 ≒ 15,967 なので、その 1.5 倍を見込む。
 * ⚠️ **打ち切ったまま突合に使わない**。足りなければ例外にして fail closed にする
 *    （少なく数えた値で「不一致」と判定すると、正しい実行を止めてしまう）。
 */
const MAX_PAGES = 250;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

// ── Upstash Redis（REST）。入金確認メール v2 と同じ経路 ──────────
function redisCmd(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return Promise.reject(new Error('upstash_not_configured'));
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const j = await res.json();
    return j.result;
  });
}


/**
 * 名指しでレコードを引く（**全件走査しない**）。
 *
 * ⚠️ 2026-08-09: Customers 15,967 件で全件取得に約 170 秒かかり Function タイムアウトを
 *    超えた（実測 160 ページ × 約 1 秒。列を絞っても変わらない）。
 *    対象 100 件の名指しクエリは **1 コール 1.7 秒**。
 * ⚠️ formula が長くなるので `listRecords`（POST）を使う。
 * ⚠️ 失敗は握りつぶさず throw（空配列で返すと除外が効かず二重作成しうる）。
 */
async function fetchByEmails({ KEY, BASE, table, emails }) {
  const { chunkEmails } = await import('../../src/lib/crm/importTargetedSelect.js');
  const out = [];
  for (const group of chunkEmails(emails)) {
    if (group.length === 0) continue;
    const formula = `OR(${group.map((e) => `LOWER(TRIM({Email}))='${String(e).replace(/'/g, "\\'")}'`).join(',')})`;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/listRecords`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${table} targeted fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
    } while (offset && pages < 20);
  }
  return out;
}

async function fetchAllReadOnly({ KEY, BASE, table }) {
  const out = [];
  let offset; let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset; pages += 1;
      if (offset && pages >= MAX_PAGES) {
        // ⚠️ 打ち切った配列を突合に使うと「実測が少ない」と誤判定する。数え切れないなら止める。
        throw new Error(`${table} fetch truncated at ${pages} pages (MAX_PAGES=${MAX_PAGES})`);
      }
  } while (offset);
  return out;
}

async function loadBlacklistSets({ KEY, BASE }) {
  try {
    const records = await fetchEmailBlacklistReadOnly(BASE, KEY);
    const hard = buildBlacklistEmailSet(records);
    const soft = new Set();
    for (const r of records) {
      const email = normalizeEmail(r?.fields?.Email);
      const status = String(r?.fields?.Status || '').toUpperCase().trim();
      if (email && !hard.has(email) && status) soft.add(email);
    }
    return { ok: true, hard, soft };
  } catch {
    return { ok: false, hard: new Set(), soft: new Set() };
  }
}

async function loadAvailableFields({ KEY, BASE }) {
  try {
    const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const t = (j.tables || []).find((x) => x.name === CUSTOMERS_TABLE);
    if (!t) return null;
    return new Set((t.fields || []).map((f) => f.name));
  } catch {
    return null;   // 読めないときは監査列を書かない（fail closed）
  }
}

/** Customers 全体の正規化メール重複組数（突合の 4 点目） */
function countDuplicateEmailPairs(records) {
  const counts = new Map();
  for (const r of (records || [])) {
    const e = normalizeEmail(r?.fields?.Email);
    if (e) counts.set(e, (counts.get(e) || 0) + 1);
  }
  return [...counts.values()].filter((n) => n > 1).length;
}

const int0 = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const countBySource = (records, source) =>
  (records || []).filter((r) => String(r?.fields?.Source || '') === source).length;

/**
 * CSV → 統合 → 決定的な並び + **その時点の** Customers 由来の事実。
 * **子バッチのたびに呼ぶ**（既存アドレスを取り直すため）。
 */
/**
 * @param {{ skipAllRecords?: boolean }} opt
 *   skipAllRecords=true のとき Customers の**全件取得を行わない**。
 *   step は名指し取得（fetchByEmails）で足りるため既定でこれを使う。
 *   全件が要るのは plan / 全体突合 / unblock のみ。
 */
async function buildJobContext({ req, KEY, BASE, now, skipAllRecords = false }) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) return { ok: false, status: 400, error: 'CSV が指定されていません' };

  const parsedFiles = [];
  let totalBytes = 0;
  for (const f of files) {
    const name = String(f && f.name ? f.name : '').slice(0, 80);
    let bytes;
    try { bytes = new Uint8Array(Buffer.from(String((f && f.contentBase64) || ''), 'base64')); }
    catch { return { ok: false, status: 400, error: 'ファイルを読み取れませんでした' }; }
    totalBytes += bytes.length;
    if (totalBytes > MAX_FILE_BYTES) return { ok: false, status: 413, error: CSV_ERROR_LABEL.file_too_large };
    const parsed = buildImportRows({ bytes, mapColumnsFn: mapColumns });
    if (!parsed.ok) {
      return { ok: false, status: 400, error: CSV_ERROR_LABEL[parsed.error] || '必須列が見つかりません' };
    }
    parsedFiles.push({ name, bytes, parsed });
  }

  const fileHashes = parsedFiles.map((p) => hashBytes(p.bytes));
  const fileFingerprint = hashBytes(new TextEncoder().encode(fileHashes.join('|')));

  const merged = mergeImportFiles({
    files: parsedFiles.map((p) => ({
      name: p.name, rows: p.parsed.rows,
      hasStatusColumn: (p.parsed.detectedColumns || []).includes('status'),
    })),
  });

  const [records, blacklist, provider, availableFields] = await Promise.all([
    skipAllRecords ? Promise.resolve(null) : fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE }),
    loadBlacklistSets({ KEY, BASE }),
    fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now }).catch(() => ({ ok: false })),
    loadAvailableFields({ KEY, BASE }),
  ]);
  const facts = records === null ? null : buildAkFacts({
    records, nowMs: now, blacklistHard: blacklist.hard, blacklistSoft: blacklist.soft,
    testRecipients: parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients,
  });

  const entries = orderEntriesDeterministically(merged.entries);
  const providerOk = !!(provider && provider.ok);

  return {
    ok: true, entries, facts, records,
    /** 名指し取得で facts を組み直すために必要（step は全件を持たない） */
    blacklistHard: blacklist.hard, blacklistSoft: blacklist.soft,
    testRecipients: parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients,
    providerEmails: providerOk ? provider.emails : new Set(),
    providerOk, availableFields, fileHashes, fileFingerprint,
    /** snapshot 用の決定的な hash 列（**PII を含まない**） */
    orderedHashes: entries.map((e) => emailHash(e.email)).filter(Boolean),
  };
}

// ── action: plan（read-only・書き込み 0・Redis も触らない）───────
async function handlePlan({ req, KEY, BASE, now }) {
  const ctx = await buildJobContext({ req, KEY, BASE, now });
  if (!ctx.ok) return json(ctx.status, { error: ctx.error });

  const batchId = String(req.batchId || '').trim();
  const total = countCreateCandidates({
    entries: ctx.entries, facts: ctx.facts, providerEmails: ctx.providerEmails,
  });
  const have = ctx.availableFields || new Set();

  return json(200, {
    mode: 'import-job-plan',
    sideEffects: 'none',
    writeEnabled: process.env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true',
    plan: {
      jobId: buildJobId(batchId),
      ImportBatchId: batchId,
      Source: buildJobSource(batchId),
      対象総数: total,
      子バッチ数: countChildBatches(total, JOB_CHILD_MAX_ROWS),
      子バッチ上限: JOB_CHILD_MAX_ROWS,
      'まとめ書き（1リクエスト）': 10,
      対象ファイルhash: ctx.fileHashes,
      ファイル指紋: ctx.fileFingerprint,
      並び順の版: ORDERING_VERSION,
      書き込む列: CREATE_ALLOWED_FIELDS.filter((f) => !OPTIONAL_AUDIT_FIELDS.includes(f) || have.has(f)),
      停止リスト取得: ctx.providerOk ? '取得できた' : '取得できない（実行しない）',
      現在の重複メール組数: countDuplicateEmailPairs(ctx.records),
      // ── 本実行前の内訳（read-only・件数のみ。アドレス・氏名は返さない）──
      //    countCreateCandidates と**同じ classifyCreateRow** を通すので、
      //    CREATE の数と内訳の合計は必ず一致する（別ロジックが混ざらない）。
      内訳: (() => {
        const sum = summarizeImportPlan({
          entries: ctx.entries, facts: ctx.facts, providerEmails: ctx.providerEmails,
        });
        return {
          CSV行数: sum.total,
          CREATE: sum.create,
          EXISTING: sum.existing,
          EXCLUDED: sum.excluded,
          REVIEW_REQUIRED: sum.reviewRequired,
          CSV内の正規化メール重複: sum.duplicateInCsv,
          理由別: sum.skippedByReason,
          合計一致: sum.create + sum.existing + sum.excluded + sum.reviewRequired === sum.total,
        };
      })(),
      // 開始時に固定される snapshot 指紋と同一。**この時点では Redis へ書かない**
      snapshot指紋: computeSnapshotFingerprint(ctx.orderedHashes),
    },
    confirmationPhrase: buildJobConfirmation({ batchId, total }),
    rollback: describeJobRollback({ batchId, source: buildJobSource(batchId) }),
    notice: 'これは開始前の確認です。**まだ 1 件も作成していません。**',
  });
}

// ── action: start（ジョブ正本 + snapshot を作る。書き込みは step）──
async function handleStart({ req, KEY, BASE, now, claims, authority }) {
  const lock = await claims.acquireGlobalLock({ ttlMs: LOCK_TTL_MS });
  if (!lock.ok) {
    // ⚠️ ロックが取れない = Airtable を**一切読まない・書かない**
    return json(409, {
      mode: 'import-job-start', written: 0,
      error: JOB_REJECT_LABEL[JOB_REJECT.LOCKED], code: JOB_REJECT.LOCKED,
    });
  }
  try {
    const ctx = await buildJobContext({ req, KEY, BASE, now });
    if (!ctx.ok) return json(ctx.status, { error: ctx.error });

    const batchId = String(req.batchId || '').trim();
    const jobId = buildJobId(batchId);
    const total = countCreateCandidates({
      entries: ctx.entries, facts: ctx.facts, providerEmails: ctx.providerEmails,
    });
    const existing = await authority.load(jobId);

    const gate = canStartImportJob({
      env: process.env, confirmation: req.confirmation, batchId,
      plannedTotal: total, existingJob: existing, providerOk: ctx.providerOk,
      lockAcquired: true,
    });
    if (!gate.allowed) {
      return json(gate.reason === JOB_REJECT.WRITE_DISABLED ? 403 : 409, {
        mode: 'import-job-start', written: 0,
        error: JOB_REJECT_LABEL[gate.reason] || '開始できません', code: gate.reason,
        confirmationPhrase: buildJobConfirmation({ batchId, total }),
        job: existing ? summarizeJobProgress(existing) : null,
      });
    }

    // snapshot を chunk 分割して固定（開始後の差し替えを検知できるようにする）
    const snapMeta = await authority.writeSnapshot({ jobId, orderedHashes: ctx.orderedHashes });

    const job = buildJobRecord({
      jobId, batchId, source: buildJobSource(batchId),
      fileFingerprint: ctx.fileFingerprint,
      snapshotFingerprint: snapMeta.snapshotFingerprint,
      plannedTotal: total,
      fencingToken: lock.token,
      operationId: buildOperationId({ jobId, index: 0 }),
      nowIso: new Date(now).toISOString(),
    });
    job.childSize = JOB_CHILD_MAX_ROWS;
    job.duplicateEmailPairsBaseline = countDuplicateEmailPairs(ctx.records);

    const res = await authority.create(job);
    if (!res.created) {
      return json(409, {
        mode: 'import-job-start', written: 0,
        error: JOB_REJECT_LABEL[JOB_REJECT.JOB_EXISTS], code: JOB_REJECT.JOB_EXISTS,
      });
    }
    return json(200, {
      mode: 'import-job-start', written: 0,
      job: summarizeJobProgress(job),
      snapshot: { 件数: snapMeta.total, chunk数: snapMeta.chunks, 指紋: snapMeta.snapshotFingerprint },
      rollback: describeJobRollback(job),
      notice: 'ジョブを開始しました。**まだ 1 件も作成していません。**',
    });
  } finally {
    await claims.releaseGlobalLock(lock.token).catch(() => {});
  }
}

// ── action: step（子バッチをちょうど 1 つ進める）────────────────
async function handleStep({ req, KEY, BASE, now, claims, authority }) {
  const lock = await claims.acquireGlobalLock({ ttlMs: LOCK_TTL_MS });
  if (!lock.ok) {
    return json(409, {
      mode: 'import-job-step', written: 0,
      error: JOB_REJECT_LABEL[JOB_REJECT.LOCKED], code: JOB_REJECT.LOCKED,
    });
  }
  try {
    const jobId = buildJobId(String(req.batchId || '').trim());
    const job = await authority.load(jobId);
    if (!job) {
      return json(404, {
        mode: 'import-job-step', written: 0,
        error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND,
      });
    }

    // ⚠️ step は **Customers を全件取得しない**（15,967 件で約 170 秒 → Function タイムアウト）。
    //    候補メールだけを名指しで引く。
    const ctx = await buildJobContext({ req, KEY, BASE, now, skipAllRecords: true });
    if (!ctx.ok) return json(ctx.status, { error: ctx.error });

    const snap = await authority.verifySnapshot({ jobId, currentOrderedHashes: ctx.orderedHashes });
    const gate = canStepImportJob({
      env: process.env, job, fileFingerprint: ctx.fileFingerprint,
      snapshotOk: snap.ok, providerOk: ctx.providerOk, lockAcquired: true,
    });
    if (!gate.allowed) {
      // ⚠️ ここで止まる＝**書き込みゼロ**
      return json(gate.reason === JOB_REJECT.WRITE_DISABLED ? 403 : 409, {
        mode: 'import-job-step', written: 0,
        error: JOB_REJECT_LABEL[gate.reason] || '進められません', code: gate.reason,
        job: summarizeJobProgress(job),
      });
    }

    const nowIso = new Date(now).toISOString();
    const index = nextChildIndex(job);
    const operationId = buildOperationId({ jobId, index });
    // ── 再開時の counters 追いつき（**最初の子バッチの前に 1 回だけ**）──
    //    2026-08-09 の障害で「Airtable に 100 件あるのに正本は created=0」という
    //    状態が生じた。そのまま進めると reconciler が必ず BLOCKED になるため、
    //    実測へ追いつかせてから走らせる。増やす方向のみ・childHistory が空のときだけ。
    let jobForStep = repairCounterInvariants({ job, nowIso }).job;
    // ⚠️ 追いつきは Airtable 実測が要る。step では全件を引かないので、
    //    childHistory が空（= 取り残しがありうる初回）だけ全件を引いて確認する。
    const adopt = (jobForStep.childHistory || []).length === 0
      ? adoptMeasuredCreated({
        job: jobForStep,
        airtableSourceCount: countBySource(
          await fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE }), jobForStep.source,
        ),
        nowIso,
      })
      : { job: jobForStep, adopted: 0, reason: 'not_first_step' };
    if (adopt.adopted > 0) {
      const savedAdopt = await authority.saveFenced({ job: adopt.job, fencingToken: lock.token });
      if (!savedAdopt.ok) {
        return json(409, {
          mode: 'import-job-step', written: 0,
          error: '正本の counters を実測へ追いつかせられませんでした。',
          code: savedAdopt.reason,
        });
      }
      jobForStep = adopt.job;
      console.log(`🔧 [customer-import-job] ${JSON.stringify({ event: 'counters_adopted', from: adopt.job.countersAdopted.from, to: adopt.job.countersAdopted.to })}`);
    }

    const running = beginChildBatch({ job: jobForStep, nowIso, operationId, fencingToken: lock.token });

    const out = await runChildBatch({
      job: running, entries: ctx.entries, currentOrderedHashes: ctx.orderedHashes,
      facts: ctx.facts, providerEmails: ctx.providerEmails, availableFields: ctx.availableFields,
      selectRows: async ({ entries, providerEmails, cursor, limit }) => selectCreateRowsTargeted({
        entries, cursor, limit, providerEmails, selectFn: selectCreateRows,
        loadFacts: async (emails) => buildAkFacts({
          records: await fetchByEmails({ KEY, BASE, table: CUSTOMERS_TABLE, emails }),
          nowMs: now, blacklistHard: ctx.blacklistHard, blacklistSoft: ctx.blacklistSoft,
          testRecipients: ctx.testRecipients,
        }),
      }),
      lockToken: lock.token, operationId, nowMs: now, nowIso,
      claims, authority,
      deps: {
        // まとめ書き（Airtable は 1 リクエスト 10 件まで）
        createRecords: async (fieldsArray) => {
          const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: fieldsArray.map((fields) => ({ fields })) }),
          });
          return { ok: res.ok, status: res.status };
        },
        // まとめ書きが失敗したチャンクを 1 件ずつ切り分けるための経路
        createRecord: async (fields) => {
          const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields }] }),
          });
          return { ok: res.ok, status: res.status };
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
    });

    if (out.stopped) {
      // stale writer の上書きを避ける（自分より新しい正本があれば書かない）
      await authority.saveFenced({
        job: { ...running, currentChild: null, updatedAt: nowIso },
        fencingToken: lock.token,
      });
      return json(409, {
        mode: 'import-job-step', written: 0,
        error: out.note || '進められません', code: out.stopped,
        job: summarizeJobProgress(running),
      });
    }

    // ⚠️ `writeCreateBatch` は `attempted` を返さない。**runner の `out.attempted`
    //    （= 実際に書きに行った行数）を渡す**こと。渡さないと counters_balanced
    //    （created + skipped + failed === attempted）が必ず落ちて BLOCKED になる
    //    （2026-08-09 の再開時に実際に発生）。
    let next = applyChildResult({
      job: running,
      result: {
        ...(out.result || { ok: true, created: 0, skippedExisting: 0, failed: 0 }),
        attempted: Number.isFinite(out.attempted) ? out.attempted : 0,
      },
      scannedTo: out.scannedTo, exhausted: out.exhausted, nowIso,
      claimedNotCreated: out.claimedNotCreated,
    });

    // ── 検証（全件走査を毎回やらない）─────────────────────────
    // ⚠️ 2026-08-09: Customers 15,967 件で全件取得に約 170 秒。毎 step は不可能。
    //    per-batch は**書いたメールを名指しで**検証し、全体突合は cadence + **完了時必須**。
    // ⚠️ audit は PII 回避で rowKey しか持たない。runner が持つ createdEmails を使う。
    //    **メモリ上だけ**。ログ・レスポンス・正本へは入れない。
    const writtenEmails = Array.isArray(out.createdEmails) ? out.createdEmails : [];
    const isFinal = next.status === JOB_STATUS.COMPLETED || next.status === JOB_STATUS.PARTIAL
      || out.exhausted === true;

    let batchVerify = null;
    if (writtenEmails.length > 0) {
      let recs = null;
      try {
        recs = await fetchByEmails({ KEY, BASE, table: CUSTOMERS_TABLE, emails: writtenEmails });
      } catch { recs = null; }   // 引けなければ verifyWrittenBatch が fail closed にする
      batchVerify = verifyWrittenBatch({
        writtenEmails, records: recs, expectedSource: next.source,
      });
      console.log(`🔎 [customer-import-job] ${JSON.stringify({ event: 'batch_verify', code: batchVerify.code, found: batchVerify.found, missing: batchVerify.missing, duplicates: batchVerify.duplicates, foreign: batchVerify.foreign })}`);
      if (!batchVerify.ok) {
        // 二重 CREATE / 取りこぼし / 他 Source 混入は**その場で止める**
        next = markJobBlocked({
          job: next,
          reconciliation: { verdict: RECONCILE_VERDICT.BLOCKED, failedChecks: [`batch_${batchVerify.code}`], note: 'per-batch 検証で不一致' },
          nowIso,
        });
      }
    }
    next.batchVerify = batchVerify ? { code: batchVerify.code, found: batchVerify.found } : null;

    // 全体突合は cadence ごと + **完了時は必ず**（一度も通さず COMPLETED にしない）
    if (next.status !== JOB_STATUS.BLOCKED
      && shouldRunFullReconcile({ isFinal, childIndex: (next.childHistory || []).length })) {
      const after = await fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE });
      const recon = reconcileImportJob({
        job: next,
        claimCounts: { CLAIMED: out.claimedNotCreated || 0, CREATED: next.created, RELEASE_PENDING: 0 },
        airtableSourceCount: countBySource(after, next.source),
        duplicateEmailPairs: countDuplicateEmailPairs(after),
        duplicateEmailPairsBaseline: next.duplicateEmailPairsBaseline,
      });
      // ⚠️ 書き込み中のページングは**少なく数える**ことがある（2026-08-09: 4400 vs 4333）。
      //    件数系だけが落ちていて実測が少ないときは、一度だけ測り直してから判定する。
      let recon2 = recon;
      if (shouldRemeasureBeforeBlock({
        failedChecks: recon.failedChecks, created: next.created,
        airtableSourceCount: countBySource(after, next.source),
      })) {
        await new Promise((r) => setTimeout(r, 2500));
        const after2 = await fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE });
        recon2 = reconcileImportJob({
          job: next,
          claimCounts: { CLAIMED: out.claimedNotCreated || 0, CREATED: next.created, RELEASE_PENDING: 0 },
          airtableSourceCount: countBySource(after2, next.source),
          duplicateEmailPairs: countDuplicateEmailPairs(after2),
          duplicateEmailPairsBaseline: next.duplicateEmailPairsBaseline,
        });
        console.log(`🔁 [customer-import-job] ${JSON.stringify({ event: 'reconcile_remeasured', before: recon.verdict, after: recon2.verdict })}`);
      }
      next.reconciliation = recon2;
      next.lastFullReconcileAt = nowIso;
      if (recon2.verdict === RECONCILE_VERDICT.BLOCKED) next = markJobBlocked({ job: next, reconciliation: recon2, nowIso });
    } else if (next.status !== JOB_STATUS.BLOCKED) {
      // 全体突合を省いた回は、**省いたことを正本に残す**（黙って OK にしない）
      next.reconciliation = {
        verdict: RECONCILE_VERDICT.OK, failedChecks: [], checks: [],
        note: 'per-batch 検証のみ（全体突合は cadence と完了時に実施）',
        deferredFullReconcile: true,
      };
    }

    const saved = await authority.saveFenced({ job: next, fencingToken: lock.token });
    if (!saved.ok) {
      console.warn('⚠️ [customer-import-job] 正本の保存を拒否:', { jobId: next.jobId, reason: saved.reason });
      return json(409, {
        mode: 'import-job-step', written: next.created - running.created,
        error: 'この実行は古くなっています（別の実行が先に正本を更新しました）。画面を再読み込みしてください。',
        code: saved.reason,
        job: summarizeJobProgress(next),
      });
    }

    console.log('✅ [customer-import-job] 子バッチ完了:', {
      jobId: next.jobId, status: next.status, created: next.created, failed: next.failed,
      verdict: recon.verdict,
    });

    return json(200, {
      mode: 'import-job-step',
      job: summarizeJobProgress(next),
      child: out.result ? {
        created: out.result.created,
        skippedExisting: out.result.skippedExisting,
        failed: out.result.failed,
        bulkRequests: out.result.bulkRequests,
        singleRequests: out.result.singleRequests,
      } : null,
      claim: out.claimed ? {
        確保: out.claimed.won.length, 自分の既存claim: out.claimed.mine.length,
        作成済み: out.claimed.created.length, 他が確保: out.claimed.taken.length,
      } : null,
      除外内訳: out.skipped || {},
      reconciliation: recon,
      完了: [JOB_STATUS.COMPLETED, JOB_STATUS.PARTIAL, JOB_STATUS.BLOCKED].includes(next.status),
      続行可能: recon.canContinue,
    });
  } finally {
    await claims.releaseGlobalLock(lock.token).catch(() => {});
  }
}

// ── action: status（read-only）──────────────────────────────────
async function handleStatus({ req, KEY, BASE, authority }) {
  const jobId = buildJobId(String(req.batchId || '').trim());
  const job = await authority.load(jobId);
  if (!job) {
    return json(404, {
      mode: 'import-job-status',
      error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND,
    });
  }
  let recon = null;
  try {
    const records = await fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE });
    recon = reconcileImportJob({
      job,
      claimCounts: { CLAIMED: 0, CREATED: job.created, RELEASE_PENDING: 0 },
      airtableSourceCount: countBySource(records, job.source),
      duplicateEmailPairs: countDuplicateEmailPairs(records),
      duplicateEmailPairsBaseline: job.duplicateEmailPairsBaseline,
    });
  } catch { recon = null; }

  return json(200, {
    mode: 'import-job-status',
    sideEffects: 'none',
    writeEnabled: process.env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true',
    job: summarizeJobProgress(job),
    reconciliation: recon,
    rollback: describeJobRollback(job),
  });
}

// ── action: cancel（未処理分だけ止める。作成済みは消さない）─────
/**
 * BLOCKED を解除する。**その場で取り直した実測で reconcile が OK のときだけ。**
 * counters は書き換えない（追いつきは step 側の adoptMeasuredCreated が行う）。
 */
async function handleUnblock({ req, KEY, BASE, now, claims, authority }) {
  const lock = await claims.acquireGlobalLock({ ttlMs: LOCK_TTL_MS });
  if (!lock.ok) return json(409, { mode: 'import-job-unblock', error: JOB_REJECT_LABEL[JOB_REJECT.LOCKED], code: JOB_REJECT.LOCKED });
  try {
    const batchId = String(req.batchId || '').trim();
    const job = await authority.load(buildJobId(batchId));
    if (!job) return json(404, { mode: 'import-job-unblock', error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND });

    const records = await fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE });
    // ⚠️ 突合の前に**算術的な不変条件**だけ回復する（attempted >= created+skipped+failed）。
    //    created 等の実測値は触らない。ここを直さないと、記録漏れのせいで
    //    counters_balanced が永久に落ちて BLOCKED から出られない。
    const rep = repairCounterInvariants({ job, nowIso: new Date(now).toISOString() });
    const jobR = rep.job;
    if (rep.repaired > 0) {
      console.log(`🔧 [customer-import-job] ${JSON.stringify({ event: 'counters_repaired', attemptedFrom: jobR.countersRepaired.attemptedFrom, attemptedTo: jobR.countersRepaired.attemptedTo })}`);
    }
    const recon = reconcileImportJob({
      job: jobR,
      claimCounts: { CLAIMED: 0, CREATED: int0(jobR.created), RELEASE_PENDING: 0 },
      airtableSourceCount: countBySource(records, jobR.source),
      duplicateEmailPairs: countDuplicateEmailPairs(records),
      duplicateEmailPairsBaseline: jobR.duplicateEmailPairsBaseline,
    });
    const r = unblockImportJob({ job: jobR, reconciliation: recon, confirmation: req.confirmation, nowIso: new Date(now).toISOString() });
    if (!r.ok) {
      return json(409, {
        mode: 'import-job-unblock', error: '解除できません。', code: r.reason,
        failedChecks: r.failedChecks || recon.failedChecks, verdict: recon.verdict,
        confirmationPhrase: buildUnblockConfirmation(batchId),
      });
    }
    const saved = await authority.saveFenced({ job: r.job, fencingToken: lock.token });
    if (!saved.ok) return json(409, { mode: 'import-job-unblock', error: '正本を保存できませんでした。', code: saved.reason });
    console.log(`🔓 [customer-import-job] ${JSON.stringify({ event: 'unblocked', verdict: recon.verdict })}`);
    return json(200, { mode: 'import-job-unblock', job: summarizeJobProgress(r.job), verdict: recon.verdict });
  } catch (e) {
    if (e instanceof RedisUnavailableError) return json(503, { mode: 'import-job-unblock', error: 'Redis を確認できません', code: e.code });
    throw e;
  } finally {
    await claims.releaseGlobalLock(lock.token).catch(() => {});
  }
}

async function handleCancel({ req, now, claims, authority }) {
  const lock = await claims.acquireGlobalLock({ ttlMs: LOCK_TTL_MS });
  if (!lock.ok) {
    return json(409, {
      mode: 'import-job-cancel',
      error: JOB_REJECT_LABEL[JOB_REJECT.LOCKED], code: JOB_REJECT.LOCKED,
    });
  }
  try {
    const jobId = buildJobId(String(req.batchId || '').trim());
    const job = await authority.load(jobId);
    if (!job) {
      return json(404, {
        mode: 'import-job-cancel',
        error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND,
      });
    }
    const cancelled = cancelImportJob({ job, nowIso: new Date(now).toISOString() });
    // cancel は「進行中の実行より新しい意思」なので、保持しているロック token で書く
    const savedCancel = await authority.saveFenced({ job: cancelled, fencingToken: lock.token });
    if (!savedCancel.ok) {
      return json(409, {
        mode: 'import-job-cancel',
        error: '別の実行が先に正本を更新しました。画面を再読み込みしてから取り消してください。',
        code: savedCancel.reason,
      });
    }
    return json(200, {
      mode: 'import-job-cancel',
      job: summarizeJobProgress(cancelled),
      note: cancelled.cancelNote || null,
      rollback: describeJobRollback(cancelled),
    });
  } finally {
    await claims.releaseGlobalLock(lock.token).catch(() => {});
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'plan';
  const now = Date.now();

  try {
    // plan は read-only（Redis も Airtable 書き込みも無し）
    if (action === 'plan') return await handlePlan({ req, KEY, BASE, now });

    // ⚠️【二重ゲート】書き込み経路は **2 つの env が両方 'true' のときだけ**開く。
    //
    //   1. CUSTOMER_IMPORT_JOB_APPROVED  … 本実行そのものの承認（人の判断）
    //   2. CUSTOMER_IMPORT_WRITE_ENABLED … 書き込みの有効化（既存ゲート・実行時だけ開ける）
    //
    //   どちらも **production 未設定**。片方でも欠ければ 403 で止まる（fail closed）。
    //   Redis canary は 2026-08-08 に隔離 Upstash で PASS 済み（Phase 0/1/2 全通過）だが、
    //   それだけでは開かない。**env を開けるまで書き込みは構造的に不可能**。
    if (action === 'start' || action === 'step') {
      const approved = process.env.CUSTOMER_IMPORT_JOB_APPROVED === 'true';
      const writeOn = process.env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true';
      if (!approved || !writeOn) {
        return json(403, {
          mode: `import-job-${action}`,
          written: 0,
          error: '取り込みジョブの書き込みは停止中です（BLOCKED）。',
          code: 'blocked_by_design',
          blocked: {
            未設定のゲート: [
              !approved ? 'CUSTOMER_IMPORT_JOB_APPROVED' : null,
              !writeOn ? 'CUSTOMER_IMPORT_WRITE_ENABLED' : null,
            ].filter(Boolean),
            設計: 'グローバルロック + 正規化メール単位のグローバル行 claim（Redis）',
            canary: '2026-08-08 隔離 Upstash で PASS（Phase 0/1/2）',
          },
        });
      }
    }

    const claims = createClaimStore({ cmd: redisCmd });
    const authority = createJobAuthority({ cmd: redisCmd });

    // ⚠️ 上の二重ゲートが両方 'true' のときだけここへ到達する。
    //    さらに canStartImportJob / canStepImportJob が CUSTOMER_IMPORT_WRITE_ENABLED を
    //    再確認するので、ゲートは合計 2 段（Function 入口 + 判定の単一源）。
    if (action === 'start') return await handleStart({ req, KEY, BASE, now, claims, authority });
    if (action === 'step') return await handleStep({ req, KEY, BASE, now, claims, authority });
    if (action === 'status') return await handleStatus({ req, KEY, BASE, authority });
    if (action === 'unblock') return await handleUnblock({ req, KEY, BASE, now, claims, authority });
    if (action === 'cancel') return await handleCancel({ req, now, claims, authority });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ Redis 異常は**必ず fail-closed** として返す（黙って続行しない）
    if (e instanceof RedisUnavailableError) {
      console.error('❌ [customer-import-job] Redis 異常のため新規書き込みを停止:', e.code);
      return json(503, {
        mode: 'import-job',
        written: 0,
        error: JOB_REJECT_LABEL[JOB_REJECT.REDIS_UNAVAILABLE],
        code: JOB_REJECT.REDIS_UNAVAILABLE,
        redisFailure: e.code,
      });
    }
    // ⚠️ 例外メッセージに CSV の値が混ざりうるので**そのまま返さない**
    console.error('❌ [customer-import-job] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
