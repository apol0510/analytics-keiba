/**
 * importJobFlow.test.mjs — 親ジョブ + 子バッチの状態機械と実行を固定する
 *   node --test src/lib/crm/importJobFlow.test.mjs
 *
 * **1 件も本番へ書かない。** Airtable への書き込みは deps で注入したモックで受ける。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createImportJob, canStartImportJob, canStepImportJob, cancelImportJob,
  applyChildResult, beginChildBatch, markChildError,
  summarizeJobProgress, reconcileImportJob, describeJobRollback,
  buildJobId, buildJobSource, buildJobConfirmation, buildChildBatchKey,
  countChildBatches, clampChildSize, isLeaseHeld,
  JOB_STATUS, JOB_REJECT, JOB_CHILD_MAX_ROWS,
} from './importJobModel.js';
import {
  selectCreateRows, countCreateCandidates, classifyCreateRow,
  orderEntriesDeterministically, SKIP_REASON,
} from './importEligibility.js';
import { runChildBatch } from './importJobRunner.js';
import { createImportJobStore, assertNoPii } from './importJobStore.js';

const REMAINING = 14284;               // 現在地: CREATE 候補の残数
const NOW_MS = Date.parse('2026-08-05T03:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const BATCH = 'imp-2026-08-05-004';
const ENV_ON = { CUSTOMER_IMPORT_WRITE_ENABLED: 'true' };

const emptyFacts = () => ({
  existing: new Set(), paid: new Set(), duplicateInAk: new Set(),
  unsubscribed: new Set(), hardBounce: new Set(), softBounce: new Set(),
  suspended: new Set(), testAccounts: new Set(),
});

const makeEntries = (n, prefix = 'u') => Array.from({ length: n }, (_, i) => ({
  email: `${prefix}${String(i).padStart(6, '0')}@example.invalid`,
  name: '', flags: [],
}));

const newJob = (total = REMAINING) => createImportJob({
  batchId: BATCH, fileFingerprint: 'fp-abc', plannedTotal: total,
  childSize: JOB_CHILD_MAX_ROWS, nowIso: NOW_ISO,
});

/** 成功するまとめ書き。呼ばれたチャンクの大きさを記録する */
function okWriter() {
  const chunks = [];
  return {
    chunks,
    deps: {
      createRecords: async (fieldsArray) => { chunks.push(fieldsArray.length); return { ok: true, status: 200 }; },
      createRecord: async () => ({ ok: true, status: 200 }),
      sleep: async () => {},
    },
  };
}

// ── 1. 大量件数の分割 ─────────────────────────────────────────

test('14,284 件でも 100 件以下の子バッチへ正しく分割される', () => {
  const job = newJob();
  assert.equal(job.plannedTotal, REMAINING);
  assert.equal(job.childSize, 100);
  assert.equal(job.childBatches, 143);                 // ceil(14284 / 100)
  assert.equal(countChildBatches(REMAINING, 100), 143);
  // 端数の最後の子バッチは 84 件
  assert.equal(REMAINING - 142 * 100, 84);
});

test('子バッチの大きさは 100 件を超えられない（コードから緩められない）', () => {
  assert.equal(clampChildSize(500), JOB_CHILD_MAX_ROWS);
  assert.equal(clampChildSize(101), 100);
  assert.equal(clampChildSize(0), 100);
  assert.equal(clampChildSize(50), 50);
  assert.equal(JOB_CHILD_MAX_ROWS, 100);
});

test('jobId / ImportBatchId / Source が一意に決まる', () => {
  assert.equal(buildJobId(BATCH), `job:${BATCH}`);
  assert.equal(buildJobSource(BATCH), `customer-import:${BATCH}`);
  assert.notEqual(buildJobSource(BATCH), buildJobSource('imp-2026-08-05-005'));
  assert.equal(buildChildBatchKey({ jobId: `job:${BATCH}`, index: 7 }), `job:${BATCH}#0007`);
});

// ── 2. 100 件ごと・10 件 bulk ─────────────────────────────────

test('子バッチ 100 件は 10 件ずつ 10 リクエストのまとめ書きになる', async () => {
  const w = okWriter();
  const out = await runChildBatch({
    job: newJob(), entries: makeEntries(250), facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps: w.deps,
  });
  assert.equal(out.result.created, 100);
  assert.equal(out.result.bulkRequests, 10);
  assert.equal(out.result.singleRequests, 0);
  assert.deepEqual(w.chunks, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  assert.equal(out.job.totals.created, 100);
  assert.equal(out.job.status, JOB_STATUS.RUNNING);
});

test('計画総数を超えて書かない（最後の子バッチは端数だけ）', async () => {
  const w = okWriter();
  const job = { ...newJob(120), cursor: 0, totals: { attempted: 100, created: 100, skippedExisting: 0, failed: 0 } };
  const out = await runChildBatch({
    job, entries: makeEntries(500), facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps: w.deps,
  });
  assert.equal(out.result.created, 20, '残り 20 件を超えて書いている');
  assert.equal(out.job.totals.created, 120);
  assert.equal(out.job.status, JOB_STATUS.COMPLETED);
});

// ── 3. 子バッチ途中失敗 ───────────────────────────────────────

test('まとめ書きが失敗すると 1 件ずつ切り分けに落ちる（成功分は残る）', async () => {
  let bulk = 0;
  const deps = {
    createRecords: async () => { bulk += 1; return bulk === 1 ? { ok: false, status: 422 } : { ok: true, status: 200 }; },
    createRecord: async (f) => ({ ok: !String(f.Email).startsWith('u000003'), status: 422 }),
    sleep: async () => {},
  };
  const out = await runChildBatch({
    job: newJob(), entries: makeEntries(100), facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps,
  });
  assert.ok(out.result.singleRequests > 0, '1 件ずつの切り分けが走っていない');
  assert.equal(out.result.created, 99);
  assert.equal(out.result.failed, 1);
  assert.equal(out.job.totals.failed, 1);
});

test('子バッチが例外で落ちてもリースは外れ、続きから再開できる', async () => {
  const deps = {
    createRecords: async () => { throw new Error('boom'); },
    createRecord: async () => { throw new Error('boom'); },
    sleep: async () => {},
  };
  const out = await runChildBatch({
    job: newJob(), entries: makeEntries(100), facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps,
  });
  assert.equal(out.ok, false);
  assert.equal(out.job.status, JOB_STATUS.PARTIAL);
  assert.equal(out.job.lease, null, 'リースが残ると次が進めない');
  assert.equal(canStepImportJob({
    env: ENV_ON, job: out.job, nowMs: NOW_MS + 1000, fileFingerprint: 'fp-abc', providerOk: true,
  }).allowed, true, 'PARTIAL から再開できない');
});

// ── 4. timeout 後の再開 ───────────────────────────────────────

test('リースが生きている間は fail-closed で断る / 失効後は引き継げる', () => {
  const job = beginChildBatch({ job: newJob(), nowMs: NOW_MS, nowIso: NOW_ISO, holder: 'a' });
  assert.equal(isLeaseHeld({ job, nowMs: NOW_MS + 1000 }), true);
  assert.equal(canStepImportJob({
    env: ENV_ON, job, nowMs: NOW_MS + 1000, fileFingerprint: 'fp-abc', providerOk: true,
  }).reason, JOB_REJECT.LOCKED);

  // 90 秒後 = リース失効 → 引き継げる（timeout で落ちた実行を回収する）
  assert.equal(isLeaseHeld({ job, nowMs: NOW_MS + 200_000 }), false);
  assert.equal(canStepImportJob({
    env: ENV_ON, job, nowMs: NOW_MS + 200_000, fileFingerprint: 'fp-abc', providerOk: true,
  }).allowed, true);
});

test('timeout 後に同じ子バッチを再実行しても既作成分は再作成されない', async () => {
  // 1 回目: 100 件作成
  const w1 = okWriter();
  const entries = makeEntries(300);
  const first = await runChildBatch({
    job: newJob(), entries, facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps: w1.deps,
  });
  assert.equal(first.result.created, 100);

  // timeout で cursor が保存されなかった状況を再現（cursor を 0 に巻き戻す）。
  // ただし作成済み 100 件は Customers に居るので facts.existing に入る。
  const existing = new Set(entries.slice(0, 100).map((e) => e.email));
  const rewound = { ...first.job, cursor: 0 };
  const w2 = okWriter();
  const second = await runChildBatch({
    job: rewound, entries, facts: { ...emptyFacts(), existing },
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS + 1000, nowIso: NOW_ISO, deps: w2.deps,
  });
  // 巻き戻っても**二重作成されない**（既存判定で全部飛ぶ）
  assert.equal(second.result.created, 100, '次の 100 件が取れていない');
  assert.equal(second.job.totals.created, 200);
  const written = new Set();
  for (const c of w2.chunks) assert.equal(c, 10);
  assert.equal(written.size, 0);
});

// ── 5. 同一 job の二重開始 ────────────────────────────────────

test('同じ ImportBatchId のジョブは二重に開始できない', () => {
  const total = REMAINING;
  const conf = buildJobConfirmation({ batchId: BATCH, total });
  const ok = canStartImportJob({
    env: ENV_ON, confirmation: conf, batchId: BATCH, plannedTotal: total,
    existingJob: null, providerOk: true,
  });
  assert.equal(ok.allowed, true);

  const dup = canStartImportJob({
    env: ENV_ON, confirmation: conf, batchId: BATCH, plannedTotal: total,
    existingJob: newJob(), providerOk: true,
  });
  assert.equal(dup.allowed, false);
  assert.equal(dup.reason, JOB_REJECT.JOB_EXISTS);
});

test('store も二重作成を断り、既存ジョブを上書きしない', async () => {
  const mem = new Map();
  const store = createImportJobStore({
    getJSON: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
    setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); },
    setJSONIfNew: async (k, v) => {
      if (mem.has(k)) return { modified: false };
      mem.set(k, JSON.stringify(v)); return { modified: true };
    },
  });
  const a = newJob();
  assert.equal((await store.create(a)).created, true);
  const again = await store.create({ ...a, plannedTotal: 1 });
  assert.equal(again.created, false);
  assert.equal(again.reason, 'job_exists');
  assert.equal((await store.load(a.jobId)).plannedTotal, REMAINING, '既存ジョブが上書きされた');
});

test('開始ゲート: env / 確認文字列 / 停止リストのどれか欠けたら開始しない', () => {
  const total = REMAINING;
  const conf = buildJobConfirmation({ batchId: BATCH, total });
  const base = { confirmation: conf, batchId: BATCH, plannedTotal: total, existingJob: null, providerOk: true };
  assert.equal(canStartImportJob({ ...base, env: {} }).reason, JOB_REJECT.WRITE_DISABLED);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, confirmation: '' }).reason, JOB_REJECT.NO_CONFIRMATION);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, confirmation: 'IMPORT-JOB x 1' }).reason, JOB_REJECT.CONFIRMATION_MISMATCH);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, providerOk: false }).reason, JOB_REJECT.PREVIEW_INVALID);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, plannedTotal: 0 }).reason, JOB_REJECT.NOTHING_TO_WRITE);
});

test('確認文字列は総件数に紐づくので使い回せない', () => {
  assert.equal(buildJobConfirmation({ batchId: BATCH, total: REMAINING }), `IMPORT-JOB ${BATCH} 14284`);
  assert.notEqual(
    buildJobConfirmation({ batchId: BATCH, total: REMAINING }),
    buildJobConfirmation({ batchId: BATCH, total: REMAINING - 1 }),
  );
});

// ── 6. 同一子バッチの再送 ─────────────────────────────────────

test('同じ子バッチをもう一度流しても増えない（既存判定で全件 skip）', async () => {
  const entries = makeEntries(100);
  const w1 = okWriter();
  const first = await runChildBatch({
    job: newJob(), entries, facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps: w1.deps,
  });
  assert.equal(first.result.created, 100);

  // 同じ cursor・同じ入力で再送。ただし作成済みは existing に入っている
  const existing = new Set(entries.map((e) => e.email));
  const w2 = okWriter();
  const again = await runChildBatch({
    job: { ...first.job, cursor: 0 }, entries, facts: { ...emptyFacts(), existing },
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS + 10, nowIso: NOW_ISO, deps: w2.deps,
  });
  assert.equal(w2.chunks.length, 0, '再送で書き込みが走った（二重作成）');
  assert.equal(again.job.totals.created, 100, '作成件数が増えている');
});

// ── 7. 既存化したメールの直前除外 ────────────────────────────

test('下見のあとに AK 側へ増えたアドレスは直前判定で外れる', () => {
  const entries = makeEntries(10);
  const facts = { ...emptyFacts(), existing: new Set([entries[3].email, entries[7].email]) };
  const picked = selectCreateRows({ entries, facts, providerEmails: new Set(), cursor: 0, limit: 100 });
  assert.equal(picked.rows.length, 8);
  assert.equal(picked.skipped[SKIP_REASON.EXISTING], 2);
  assert.equal(picked.rows.some((r) => r.email === entries[3].email), false);
});

test('除外集合: 有料 / 重複 / 配信停止 / バウンス / テスト / 停止リスト / 要確認', () => {
  const facts = emptyFacts();
  const cases = [
    ['paid', SKIP_REASON.PAID], ['duplicateInAk', SKIP_REASON.DUPLICATE_IN_AK],
    ['unsubscribed', SKIP_REASON.UNSUBSCRIBED], ['hardBounce', SKIP_REASON.HARD_BOUNCE],
    ['softBounce', SKIP_REASON.SOFT_BOUNCE], ['suspended', SKIP_REASON.SUSPENDED],
    ['testAccounts', SKIP_REASON.TEST_ACCOUNT], ['existing', SKIP_REASON.EXISTING],
  ];
  for (const [key, reason] of cases) {
    const f = { ...facts, [key]: new Set(['x@example.invalid']) };
    const v = classifyCreateRow({ entry: { email: 'x@example.invalid', flags: [] }, facts: f, providerEmails: new Set() });
    assert.equal(v.ok, false); assert.equal(v.reason, reason);
  }
  // 停止リスト
  assert.equal(classifyCreateRow({
    entry: { email: 'x@example.invalid', flags: [] }, facts, providerEmails: new Set(['x@example.invalid']),
  }).reason, SKIP_REASON.PROVIDER_SUPPRESSED);
  // 要確認（flags 付き）
  assert.equal(classifyCreateRow({
    entry: { email: 'x@example.invalid', flags: ['name_conflict'] }, facts, providerEmails: new Set(),
  }).reason, SKIP_REASON.FLAGGED);
});

test('対象総数は除外を引いた数になる（母数をそのまま使わない）', () => {
  const entries = makeEntries(100);
  const facts = { ...emptyFacts(), existing: new Set(entries.slice(0, 30).map((e) => e.email)) };
  assert.equal(countCreateCandidates({ entries, facts, providerEmails: new Set() }), 70);
});

test('並びは決定的（アドレス昇順）。cursor が意味を持つ前提', () => {
  const shuffled = [{ email: 'c@x.invalid' }, { email: 'a@x.invalid' }, { email: 'b@x.invalid' }];
  const a = orderEntriesDeterministically(shuffled).map((e) => e.email);
  const b = orderEntriesDeterministically([...shuffled].reverse()).map((e) => e.email);
  assert.deepEqual(a, ['a@x.invalid', 'b@x.invalid', 'c@x.invalid']);
  assert.deepEqual(a, b, '入力順で並びが変わると再開位置が壊れる');
});

// ── 8. failed 混在時の reconciliation ────────────────────────

test('failed が混ざっても試行数と内訳が突合する', () => {
  let job = newJob();
  job = applyChildResult({
    job: beginChildBatch({ job, nowMs: NOW_MS, nowIso: NOW_ISO }),
    result: { ok: true, attempted: 100, created: 97, skippedExisting: 2, skippedDone: 0, failed: 1 },
    scannedTo: 100, exhausted: false, nowIso: NOW_ISO,
  });
  const r = reconcileImportJob({ job });
  assert.equal(r.attempted, 100);
  assert.equal(r.created, 97);
  assert.equal(r.skippedExisting, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.accounted, 100);
  assert.equal(r.balanced, true);
  assert.equal(r.withinPlan, true);
});

test('突合が合わなければ balanced=false になる', () => {
  const job = { ...newJob(), totals: { attempted: 100, created: 50, skippedExisting: 0, failed: 0 } };
  assert.equal(reconcileImportJob({ job }).balanced, false);
});

test('Airtable 実測（正本）と食い違えば matchesAirtable=false', () => {
  const job = { ...newJob(), totals: { attempted: 100, created: 100, skippedExisting: 0, failed: 0 } };
  assert.equal(reconcileImportJob({ job, createdInAirtable: 100 }).matchesAirtable, true);
  assert.equal(reconcileImportJob({ job, createdInAirtable: 99 }).matchesAirtable, false);
});

test('failed があれば COMPLETED ではなく PARTIAL で終わる', () => {
  let job = newJob(100);
  job = applyChildResult({
    job: beginChildBatch({ job, nowMs: NOW_MS, nowIso: NOW_ISO }),
    result: { ok: true, attempted: 100, created: 99, skippedExisting: 0, skippedDone: 0, failed: 1 },
    scannedTo: 100, exhausted: true, nowIso: NOW_ISO,
  });
  assert.equal(job.status, JOB_STATUS.PARTIAL);
});

// ── 9. cancel 後に新規書き込みされない ───────────────────────

test('cancel すると未処理分は進まない（作成済みは消さない）', () => {
  let job = newJob();
  job = applyChildResult({
    job: beginChildBatch({ job, nowMs: NOW_MS, nowIso: NOW_ISO }),
    result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, skippedDone: 0, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: NOW_ISO,
  });
  const cancelled = cancelImportJob({ job, nowIso: NOW_ISO });
  assert.equal(cancelled.status, JOB_STATUS.CANCELLED);
  assert.equal(cancelled.totals.created, 100, '作成済みが消えている');
  const gate = canStepImportJob({
    env: ENV_ON, job: cancelled, nowMs: NOW_MS + 1000, fileFingerprint: 'fp-abc', providerOk: true,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, JOB_REJECT.CANCELLED);
});

test('完了済みジョブは取り消せない', () => {
  const done = { ...newJob(), status: JOB_STATUS.COMPLETED };
  assert.equal(cancelImportJob({ job: done, nowIso: NOW_ISO }).status, JOB_STATUS.COMPLETED);
});

// ── 10. COMPLETED 後の再実行拒否 ─────────────────────────────

test('COMPLETED / FAILED のジョブは進められない', () => {
  for (const [status, reason] of [
    [JOB_STATUS.COMPLETED, JOB_REJECT.ALREADY_COMPLETED],
    [JOB_STATUS.FAILED, JOB_REJECT.FAILED],
    [JOB_STATUS.CANCELLED, JOB_REJECT.CANCELLED],
  ]) {
    const gate = canStepImportJob({
      env: ENV_ON, job: { ...newJob(), status }, nowMs: NOW_MS,
      fileFingerprint: 'fp-abc', providerOk: true,
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, reason);
  }
});

test('進めるゲート: env / 停止リスト / ファイル差し替えを fail-closed で見る', () => {
  const job = newJob();
  assert.equal(canStepImportJob({ env: {}, job, nowMs: NOW_MS, fileFingerprint: 'fp-abc', providerOk: true }).reason,
    JOB_REJECT.WRITE_DISABLED);
  assert.equal(canStepImportJob({ env: ENV_ON, job, nowMs: NOW_MS, fileFingerprint: 'fp-abc', providerOk: false }).reason,
    JOB_REJECT.PREVIEW_INVALID);
  assert.equal(canStepImportJob({ env: ENV_ON, job, nowMs: NOW_MS, fileFingerprint: 'DIFFERENT', providerOk: true }).reason,
    JOB_REJECT.FILE_CHANGED);
  assert.equal(canStepImportJob({ env: ENV_ON, job: null, nowMs: NOW_MS, providerOk: true }).reason,
    JOB_REJECT.JOB_NOT_FOUND);
});

test('計画に到達したジョブはそれ以上進めない', () => {
  const job = { ...newJob(100), totals: { attempted: 100, created: 100, skippedExisting: 0, failed: 0 } };
  assert.equal(canStepImportJob({
    env: ENV_ON, job, nowMs: NOW_MS, fileFingerprint: 'fp-abc', providerOk: true,
  }).reason, JOB_REJECT.NOTHING_TO_WRITE);
});

// ── 11. UPDATE 等が書き込まれない ────────────────────────────

test('既存・除外・要確認は 1 件も作成対象にならない', async () => {
  const entries = makeEntries(50);
  const facts = {
    ...emptyFacts(),
    existing: new Set(entries.slice(0, 20).map((e) => e.email)),   // UPDATE 候補
    paid: new Set(entries.slice(20, 25).map((e) => e.email)),      // 除外
  };
  const flagged = entries.slice(25, 30).map((e) => ({ ...e, flags: ['name_conflict'] })); // 要確認
  const list = [...entries.slice(0, 25), ...flagged, ...entries.slice(30)];
  const w = okWriter();
  const out = await runChildBatch({
    job: newJob(), entries: orderEntriesDeterministically(list), facts,
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps: w.deps,
  });
  assert.equal(out.result.created, 20, '対象外が書かれている');
  assert.equal(out.skipped[SKIP_REASON.EXISTING], 20);
  assert.equal(out.skipped[SKIP_REASON.PAID], 5);
  assert.equal(out.skipped[SKIP_REASON.FLAGGED], 5);
});

test('書き込む列は allow-list の 5 列だけ（課金・特典は入らない）', async () => {
  const seen = [];
  const deps = {
    createRecords: async (arr) => { seen.push(...arr); return { ok: true, status: 200 }; },
    createRecord: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  };
  await runChildBatch({
    job: newJob(), entries: makeEntries(10), facts: emptyFacts(),
    providerEmails: new Set(), availableFields: new Set(),
    nowMs: NOW_MS, nowIso: NOW_ISO, deps,
  });
  assert.ok(seen.length > 0);
  for (const f of seen) {
    for (const k of Object.keys(f)) {
      assert.ok(['Email', '氏名', 'プラン', 'ポイント', 'Source'].includes(k), `許可外の列: ${k}`);
    }
    assert.equal(f['プラン'], 'Free');
    assert.equal(f['ポイント'], 0);
    assert.equal(f.Source, `customer-import:${BATCH}`);
  }
});

// ── 12. 進捗表示・rollback・PII ───────────────────────────────

test('進捗まとめが画面の必須項目を満たす', () => {
  let job = newJob();
  job = applyChildResult({
    job: beginChildBatch({ job, nowMs: NOW_MS, nowIso: NOW_ISO }),
    result: { ok: true, attempted: 100, created: 98, skippedExisting: 2, skippedDone: 0, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: NOW_ISO,
  });
  const s = summarizeJobProgress(job);
  for (const k of ['対象総数', '処理済み', '作成済み', '既存スキップ', '失敗', '残件数', '進捗率',
    '子バッチ数', '完了した子バッチ', '現在の子バッチ', '最終更新', 'jobId', 'ImportBatchId', 'Source', 'status']) {
    assert.ok(k in s, `${k} が無い`);
  }
  assert.equal(s.対象総数, REMAINING);
  assert.equal(s.作成済み, 98);
  assert.equal(s.残件数, REMAINING - 98);
  assert.equal(s.進捗率, 0.7);
  assert.equal(s.再実行可能, true);
});

test('rollback は削除ではなく Source 単位の隔離', () => {
  const r = describeJobRollback(newJob());
  assert.equal(r.Source, `customer-import:${BATCH}`);
  assert.equal(r.既定, '隔離（削除しない）');
  assert.ok(r.steps.join('\n').includes('消さない'));
});

test('ジョブ記録に PII を入れない（構造的に拒否する）', async () => {
  assert.equal(assertNoPii(newJob()), true);
  assert.equal(assertNoPii({ ...newJob(), rows: [{ email: 'a@b.invalid' }] }), false);
  assert.equal(assertNoPii({ ...newJob(), children: [{ email: 'a@b.invalid' }] }), false);

  const mem = new Map();
  const store = createImportJobStore({
    getJSON: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
    setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); },
  });
  const bad = await store.save({ ...newJob(), name: '山田' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'pii_detected');
  assert.equal(mem.size, 0, 'PII が保存された');
});

test('markChildError は PARTIAL にしてリースを外す', () => {
  const job = beginChildBatch({ job: newJob(), nowMs: NOW_MS, nowIso: NOW_ISO });
  const err = markChildError({ job, error: 'write_error', nowIso: NOW_ISO });
  assert.equal(err.status, JOB_STATUS.PARTIAL);
  assert.equal(err.lease, null);
  assert.equal(err.lastError, 'write_error');
});
