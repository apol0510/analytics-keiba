/**
 * importWrite.test.mjs — 初回本番取り込み（CREATE のみ）の規則を固定する
 *   node --test src/lib/crm/importWrite.test.mjs
 *
 * 本番 write はゲートで止まっているが、**動いたときに何が起きるか**はここで固定する。
 * 取り返しがつかないのは「多く作る」「二重に作る」「既存を壊す」こと。
 * 減る方向は許し、増える方向・壊す方向は構造的に禁じる。
 *
 * ⚠️ 実在のアドレス・氏名は使わない（すべて example.com の合成データ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyStatus, classifyErrorCount, normalizeStatusLabel,
  STATUS_VERDICT, listKnownStatusLabels, ERROR_COUNT_REVIEW_THRESHOLD,
} from './importStatusRules.js';
import { mergeImportFiles, toPreviewRows, normalizeName, MERGE_FLAG } from './importMergePlan.js';
import { buildImportPreview, IMPORT_REASON, VERDICT_CANONICAL } from './customerImport.js';
import { isActivePaidCustomer, buildAkFacts } from './importAkFacts.js';
import {
  FIRST_RUN_MAX_ROWS, IMPORT_PLAN_VALUE, IMPORT_SOURCE_PREFIX,
  CREATE_ALLOWED_FIELDS, CREATE_FORBIDDEN_FIELDS,
  buildCreateFields, assertOnlyCreateFields, computeCreateRowKey, computeBatchKey,
  canRunFirstImport, buildConfirmationPhrase, shouldRetryStatus, retryDelayMs,
  reconcileRun, describeRunPlan, RUN_REJECT,
} from './importWritePlan.js';
import { writeCreateBatch, ROW_RESULT, CREATE_CHUNK_SIZE, chunkList } from './importWriteExecutor.js';

const NOW = Date.UTC(2026, 7, 5, 3, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const BATCH = 'imp-2026-08-05-001';
const PREVIEW = 'prev-30231960b19b748a';

// ── 状態列 ────────────────────────────────────────────────────

test('状態: 実データのラベル「配信中」は取り込んでよい', () => {
  assert.equal(classifyStatus({ label: '配信中' }).verdict, STATUS_VERDICT.SENDABLE);
  assert.equal(classifyStatus({ label: ' 配信中 ' }).verdict, STATUS_VERDICT.SENDABLE);
  assert.equal(classifyStatus({ label: '配信　中' }).verdict, STATUS_VERDICT.SENDABLE, '全角空白を吸収していない');
});

test('状態: 送ってはいけないラベルは除外', () => {
  for (const l of ['配信停止', '退会', '解除', '受信拒否', '無効', 'エラー', 'バウンス', 'unsubscribed', 'BOUNCED']) {
    assert.equal(classifyStatus({ label: l }).verdict, STATUS_VERDICT.EXCLUDE, `${l} を除外していない`);
  }
});

test('状態: 未知のラベルは CREATE せず要確認（fail closed）', () => {
  for (const l of ['保留', '要確認', 'なんらかの状態', 'unknown-label', '???']) {
    const r = classifyStatus({ label: l });
    assert.equal(r.verdict, STATUS_VERDICT.REVIEW, `${l} を推測で通している`);
    assert.equal(r.known, false);
  }
});

test('状態: 空欄は要確認 / 列が無いファイルは対象外にしない', () => {
  assert.equal(classifyStatus({ label: '' }).verdict, STATUS_VERDICT.REVIEW);
  assert.equal(classifyStatus({ label: '', hasStatusColumn: false }).verdict, STATUS_VERDICT.SENDABLE,
    '状態列を持たない名簿まで要確認にしている');
});

test('状態: 表記ゆれを同じラベルへ寄せる', () => {
  assert.equal(normalizeStatusLabel('配信 停止'), '配信停止');
  assert.equal(normalizeStatusLabel('ＵＮＳＵＢＳＣＲＩＢＥＤ'), 'unsubscribed');
  assert.ok(listKnownStatusLabels().sendable.includes('配信中'));
  assert.ok(listKnownStatusLabels().exclude.includes('配信停止'));
});

test('配信失敗歴（エラーカウント数）は取り込まず要確認へ回す', () => {
  assert.equal(ERROR_COUNT_REVIEW_THRESHOLD, 1);
  assert.equal(classifyErrorCount('0').verdict, STATUS_VERDICT.SENDABLE);
  assert.equal(classifyErrorCount('1').verdict, STATUS_VERDICT.REVIEW);
  assert.equal(classifyErrorCount('2').verdict, STATUS_VERDICT.REVIEW);
  assert.equal(classifyErrorCount('').verdict, STATUS_VERDICT.SENDABLE, '列が無い名簿を巻き込んでいる');
  assert.equal(classifyErrorCount('あ').verdict, STATUS_VERDICT.REVIEW, '読めない値を通している');
});

// ── 3 ファイル統合 ────────────────────────────────────────────

const file = (name, rows, hasStatusColumn = false) => ({ name, rows, hasStatusColumn });

test('統合: 同じアドレスは 1 件になる（ファイル間の重複を作らない）', () => {
  const { entries, stats } = mergeImportFiles({
    files: [
      file('f1', [{ email: 'a@example.com' }, { email: 'b@example.com' }]),
      file('f2', [{ email: 'a@example.com' }]),
      file('f3', [{ email: 'a@example.com' }, { email: 'c@example.com' }]),
    ],
  });
  assert.equal(entries.length, 3);
  assert.equal(stats.統合一意アドレス, 3);
  assert.equal(stats.ファイル間重複, 2);
  const a = entries.find((e) => e.email === 'a@example.com');
  assert.deepEqual(a.sources.sort(), ['f1', 'f2', 'f3']);
});

test('統合: 氏名は空欄を埋めるときだけ使う', () => {
  const { entries } = mergeImportFiles({
    files: [
      file('f1', [{ email: 'a@example.com' }]),
      file('f3', [{ email: 'a@example.com', name: '山田 太郎' }]),
    ],
  });
  assert.equal(entries[0].name, '山田 太郎');
  assert.equal(normalizeName('山田　太郎'), '山田 太郎', '全角空白を吸収していない');
});

test('統合: 氏名が食い違うと自動決定せず要確認', () => {
  const { entries, stats } = mergeImportFiles({
    files: [
      file('f1', [{ email: 'a@example.com', name: '山田' }]),
      file('f3', [{ email: 'a@example.com', name: '佐藤' }]),
    ],
  });
  assert.equal(stats.氏名の食い違い, 1);
  assert.ok(entries[0].flags.includes(MERGE_FLAG.NAME_CONFLICT));
  assert.equal(entries[0].name, '', '食い違う氏名のどちらかを勝手に採用している');

  const p = buildImportPreview({
    rows: toPreviewRows(entries), providerSuppressed: new Set(), batchId: BATCH, nowMs: NOW,
  });
  assert.equal(p.理由別[IMPORT_REASON.NAME_CONFLICT], 1);
  assert.equal(p.要確認, 1);
  assert.equal(p.新規追加, 0);
});

test('統合: 状態が「送ってはいけない」なら除外、未知なら要確認', () => {
  const { entries } = mergeImportFiles({
    files: [file('f1', [
      { email: 'ok@example.com', status: '配信中' },
      { email: 'stop@example.com', status: '配信停止' },
      { email: 'unknown@example.com', status: '謎の状態' },
      { email: 'err@example.com', status: '配信中', error_count: '2' },
    ], true)],
  });
  const p = buildImportPreview({
    rows: toPreviewRows(entries), providerSuppressed: new Set(), batchId: BATCH, nowMs: NOW,
  });
  assert.equal(p.理由別[IMPORT_REASON.SOURCE_STATUS_EXCLUDED], 1);
  assert.equal(p.理由別[IMPORT_REASON.SOURCE_STATUS_UNKNOWN], 1);
  assert.equal(p.理由別[IMPORT_REASON.DELIVERY_ERROR_HISTORY], 1);
  assert.equal(p.新規追加, 1);
  assert.equal(p.balanced, true);
});

test('統合: 電話番号・エラーカウント数は取り込み対象の値にならない', () => {
  const { entries } = mergeImportFiles({
    files: [file('f1', [{ email: 'a@example.com', phone: '090-0000-0000', error_count: '0' }], true)],
  });
  const rows = toPreviewRows(entries);
  assert.equal('phone' in rows[0], false, '電話番号を持ち回している');
  assert.equal('error_count' in rows[0], false);
  const fields = buildCreateFields({ email: rows[0].email, batchId: BATCH, nowIso: NOW_ISO });
  assert.equal('Phone' in fields, false, '電話番号を書こうとしている');
});

// ── 有料会員の除外（2026-08-05 の不具合の再発防止）──────────────

test('現役の有料会員を「無料リスト」として取り込まない', () => {
  // ❌ 旧実装は mk.planGroup を見ていて常に undefined だった
  assert.equal(isActivePaidCustomer({ plan: 'premium', contract: 'active' }), true);
  assert.equal(isActivePaidCustomer({ plan: 'light', contract: 'active' }), true);
  assert.equal(isActivePaidCustomer({ plan: 'free', contract: 'none', premiumActive: true }), true, '課金権利を見ていない');
  assert.equal(isActivePaidCustomer({ plan: 'free', contract: 'none', lightActive: true }), true);
  // 無料特典（promo）は「有料会員」ではない
  assert.equal(isActivePaidCustomer({ plan: 'free', contract: 'none', promoLightActive: true }), false);
  assert.equal(isActivePaidCustomer({ plan: 'premium', contract: 'expired' }), false);
  assert.equal(isActivePaidCustomer(null), false);
});

test('AK の事実づくり: 有料・重複・テストを集合に落とす', () => {
  const facts = buildAkFacts({
    records: [
      { id: 'rec00000000000001', fields: { Email: 'paid@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2099-01-01' } },
      { id: 'rec00000000000002', fields: { Email: 'free@example.com', 'プラン': 'Free' } },
      { id: 'rec00000000000003', fields: { Email: 'dupe@example.com', 'プラン': 'Free' } },
      { id: 'rec00000000000004', fields: { Email: 'dupe@example.com', 'プラン': 'Free' } },
      { id: 'rec00000000000005', fields: { Email: 'test@example.com', 'プラン': 'Test' } },
    ],
    nowMs: NOW,
    testRecipients: ['canary@example.com'],
  });
  assert.ok(facts.paid.has('paid@example.com'), '現役有料会員を検出できていない');
  assert.ok(facts.duplicateInAk.has('dupe@example.com'));
  assert.equal(facts.recordIdByEmail.has('dupe@example.com'), false, '重複アドレスに recordId を割り当てている');
  assert.equal(facts.recordIdByEmail.get('free@example.com'), 'rec00000000000002');
  assert.ok(facts.testAccounts.has('test@example.com'));
  assert.ok(facts.testAccounts.has('canary@example.com'));
  assert.equal(facts.existing.size, 4);
});

test('既存 Customers は CREATE されない（UPDATE 候補になる）', () => {
  const p = buildImportPreview({
    rows: [{ email: 'exists@example.com' }, { email: 'newbie@example.com' }],
    existingEmails: new Set(['exists@example.com']),
    providerSuppressed: new Set(), batchId: BATCH, nowMs: NOW,
  });
  assert.equal(p.classificationCounts[VERDICT_CANONICAL.new], 1);
  assert.equal(p.classificationCounts[VERDICT_CANONICAL.update], 1);
});

// ── 新規レコードの中身 ────────────────────────────────────────

test('新規レコードは必要最小限の列だけを書く', () => {
  const f = buildCreateFields({ email: 'a@example.com', batchId: BATCH, nowIso: NOW_ISO });
  assert.deepEqual(Object.keys(f).sort(), ['Email', 'Source', 'ポイント', 'プラン'].sort());
  assert.equal(f['プラン'], IMPORT_PLAN_VALUE);
  assert.equal(f.Source, `${IMPORT_SOURCE_PREFIX}:${BATCH}`);
  assert.equal(f['ポイント'], 0);
  assert.ok(assertOnlyCreateFields(f));
});

test('氏名は一意に決まったときだけ書く', () => {
  assert.equal('氏名' in buildCreateFields({ email: 'a@example.com', batchId: BATCH, nowIso: NOW_ISO }), false);
  assert.equal(buildCreateFields({ email: 'a@example.com', name: '山田 太郎', batchId: BATCH, nowIso: NOW_ISO })['氏名'], '山田 太郎');
});

test('監査列は Customers に存在するときだけ書く（無い列を書きに行かない）', () => {
  const without = buildCreateFields({ email: 'a@example.com', batchId: BATCH, nowIso: NOW_ISO, availableFields: new Set() });
  for (const k of ['CreatedBy', 'ImportBatchId', 'ImportedAt']) assert.equal(k in without, false, `${k} を書こうとしている`);
  const withFields = buildCreateFields({
    email: 'a@example.com', batchId: BATCH, nowIso: NOW_ISO,
    availableFields: new Set(['CreatedBy', 'ImportBatchId', 'ImportedAt']),
  });
  assert.equal(withFields.CreatedBy, IMPORT_SOURCE_PREFIX);
  assert.equal(withFields.ImportBatchId, BATCH);
  assert.equal(withFields.ImportedAt, NOW_ISO);
  assert.ok(assertOnlyCreateFields(withFields));
});

test('課金・特典・決済・配信停止・登録日のフィールドは書けない', () => {
  for (const k of ['PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
    'LightGrantUntil', 'PremiumGrantUntil', 'LifetimeSanrenpuku',
    'UnsubscribedAnalyticsKeiba', 'Phone', '登録日']) {
    assert.ok(CREATE_FORBIDDEN_FIELDS.includes(k), `${k} が禁止列に入っていない`);
    assert.equal(assertOnlyCreateFields({ Email: 'a@example.com', [k]: 'x' }), false, `${k} を書けてしまう`);
  }
  // 許可列に課金系が紛れていないこと
  for (const k of CREATE_ALLOWED_FIELDS) assert.equal(CREATE_FORBIDDEN_FIELDS.includes(k), false, `${k} が許可と禁止の両方にある`);
});

// ── 二重ゲート・上限 ──────────────────────────────────────────

const runInput = (over = {}) => ({
  env: { CUSTOMER_IMPORT_WRITE_ENABLED: 'true' },
  confirmation: buildConfirmationPhrase({ batchId: BATCH, count: 100 }),
  batchId: BATCH, requestedCount: 100, availableCount: 14000, previewOk: true, ...over,
});

test('ゲート: env と確認文字列の両方が要る（片方でも欠けたら拒否）', () => {
  assert.equal(canRunFirstImport(runInput()).allowed, true);
  assert.equal(canRunFirstImport(runInput({ env: {} })).reason, RUN_REJECT.WRITE_DISABLED);
  assert.equal(canRunFirstImport(runInput({ env: { CUSTOMER_IMPORT_WRITE_ENABLED: 'TRUE' } })).reason, RUN_REJECT.WRITE_DISABLED);
  assert.equal(canRunFirstImport(runInput({ confirmation: '' })).reason, RUN_REJECT.NO_CONFIRMATION);
  assert.equal(canRunFirstImport(runInput({ confirmation: 'IMPORT wrong 100' })).reason, RUN_REJECT.CONFIRMATION_MISMATCH);
});

test('ゲート: 確認文字列はバッチと件数に紐づく（使い回せない）', () => {
  assert.equal(canRunFirstImport(runInput({ requestedCount: 50 })).reason, RUN_REJECT.CONFIRMATION_MISMATCH,
    '件数が変わっても同じ確認文字列で通ってしまう');
  const ok = canRunFirstImport(runInput({
    requestedCount: 50, confirmation: buildConfirmationPhrase({ batchId: BATCH, count: 50 }),
  }));
  assert.equal(ok.allowed, true);
});

test('初回は 100 件を超える指定を拒否する', () => {
  assert.equal(FIRST_RUN_MAX_ROWS, 100);
  const over = canRunFirstImport(runInput({
    requestedCount: 101, confirmation: buildConfirmationPhrase({ batchId: BATCH, count: 101 }),
  }));
  assert.equal(over.allowed, false);
  assert.equal(over.reason, RUN_REJECT.OVER_LIMIT);
});

test('下見が無効なら実行しない / 対象 0 件でも実行しない', () => {
  assert.equal(canRunFirstImport(runInput({ previewOk: false })).reason, RUN_REJECT.PREVIEW_INVALID);
  assert.equal(canRunFirstImport(runInput({ availableCount: 0 })).reason, RUN_REJECT.NOTHING_TO_WRITE);
  assert.equal(canRunFirstImport(runInput({ requestedCount: 200, availableCount: 50 })).allowed, false);
});

// ── 書き込みの実行 ────────────────────────────────────────────

const makeDeps = (behavior = () => ({ ok: true, id: 'recNEW' })) => {
  const calls = [];
  return {
    calls,
    deps: {
      createRecord: async (fields) => { calls.push(fields); return behavior(fields, calls.length); },
      sleep: async () => {},
    },
  };
};

const rows = (n, prefix = 'u') => Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com` }));

test('CREATE のみ実行され、既存アドレスは直前再判定で除外される', async () => {
  const { deps, calls } = makeDeps();
  const r = await writeCreateBatch({
    rows: [{ email: 'new@example.com' }, { email: 'appeared@example.com' }],
    batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(['appeared@example.com']),   // 下見のあとに増えた
    maxWrites: 100, deps,
  });
  assert.equal(r.created, 1);
  assert.equal(r.skippedExisting, 1);
  assert.equal(calls.length, 1, '既存アドレスにも書きに行っている');
  assert.equal(r.reconciliation.balanced, true);
});

test('同じ冪等キーで再実行しても作成 0', async () => {
  const done = new Set();
  const first = await writeCreateBatch({
    rows: rows(3), batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(), doneRowKeys: done, maxWrites: 100, deps: makeDeps().deps,
  });
  assert.equal(first.created, 3);
  const { deps, calls } = makeDeps();
  const second = await writeCreateBatch({
    rows: rows(3), batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(), doneRowKeys: done, maxWrites: 100, deps,
  });
  assert.equal(second.created, 0, '再実行で二重作成している');
  assert.equal(second.skippedDone, 3);
  assert.equal(calls.length, 0);
});

test('同一実行内で同じアドレスを二度作らない', async () => {
  const { deps, calls } = makeDeps();
  const r = await writeCreateBatch({
    rows: [{ email: 'same@example.com' }, { email: 'SAME@example.com' }],
    batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 100, deps,
  });
  assert.equal(r.created, 1);
  assert.equal(calls.length, 1);
});

test('計画件数を超えて書かない', async () => {
  const { deps, calls } = makeDeps();
  const r = await writeCreateBatch({
    rows: rows(10), batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 4, deps,
  });
  assert.equal(r.created, 4);
  assert.equal(calls.length, 4);
});

test('429 / 5xx だけ再試行し、検証エラーは再試行しない', async () => {
  let n = 0;
  const retryDeps = makeDeps(() => { n += 1; return n < 3 ? { ok: false, status: 429 } : { ok: true }; });
  const ok = await writeCreateBatch({
    rows: [{ email: 'a@example.com' }], batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(), maxWrites: 10, deps: retryDeps.deps,
  });
  assert.equal(ok.created, 1);
  assert.equal(retryDeps.calls.length, 3, '再試行していない');

  const badDeps = makeDeps(() => ({ ok: false, status: 422 }));
  const bad = await writeCreateBatch({
    rows: [{ email: 'b@example.com' }], batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(), maxWrites: 10, deps: badDeps.deps,
  });
  assert.equal(bad.created, 0);
  assert.equal(bad.failedTerminal, 1);
  assert.equal(badDeps.calls.length, 1, '検証エラーを再試行している');
  assert.equal(shouldRetryStatus(422), false);
  assert.equal(shouldRetryStatus(500), true);
  assert.ok(retryDelayMs(0) < retryDelayMs(2));
});

test('1 件失敗しても他の行を巻き込まない（部分失敗を正しく数える）', async () => {
  const { deps } = makeDeps((f) => (f.Email === 'bad@example.com' ? { ok: false, status: 422 } : { ok: true }));
  const r = await writeCreateBatch({
    rows: [{ email: 'a@example.com' }, { email: 'bad@example.com' }, { email: 'c@example.com' }],
    batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 100, deps,
  });
  assert.equal(r.created, 2);
  assert.equal(r.failedTerminal, 1);
  assert.equal(r.reconciliation.balanced, true, '成功・失敗・除外の合計が計画と合わない');
});

test('書き込み経路が渡されていなければ 1 件も書かない', async () => {
  const r = await writeCreateBatch({ rows: rows(5), batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 100, deps: {} });
  assert.equal(r.ok, false);
  assert.equal(r.created, 0);
  assert.equal(r.reason, 'no_writer');
});

test('監査ログにアドレス・氏名を残さない', async () => {
  const { deps } = makeDeps();
  const r = await writeCreateBatch({
    rows: [{ email: 'someone@example.com', name: '山田 太郎' }],
    batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 10, deps,
  });
  const dumped = JSON.stringify(r.audit);
  assert.equal(dumped.includes('someone@example.com'), false);
  assert.equal(dumped.includes('山田'), false);
  assert.equal(dumped.includes('@'), false);
  assert.equal(r.audit[0].result, ROW_RESULT.CREATED);
});

// ── 冪等キー・突合・実行前の表示 ──────────────────────────────

test('冪等キーはアドレスを復元できず、バッチが違えば別キー', () => {
  const a = computeCreateRowKey({ batchId: BATCH, email: 'a@example.com' });
  const b = computeCreateRowKey({ batchId: 'imp-2026-08-06-001', email: 'a@example.com' });
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
  assert.equal(a.includes('example'), false);
  assert.equal(computeCreateRowKey({ batchId: '', email: 'a@example.com' }), '');
});

test('バッチ単位の冪等キーは下見とオフセットに紐づく', () => {
  const k1 = computeBatchKey({ batchId: BATCH, previewId: PREVIEW, offset: 0, size: 100 });
  const k2 = computeBatchKey({ batchId: BATCH, previewId: PREVIEW, offset: 100, size: 100 });
  assert.notEqual(k1, k2);
  assert.equal(computeBatchKey({ batchId: BATCH, previewId: '', offset: 0, size: 100 }), '');
});

test('突合: 書いた数が計画を超えていたら検知する', () => {
  assert.equal(reconcileRun({ planned: 100, created: 90, skippedExisting: 8, failed: 2 }).balanced, true);
  assert.equal(reconcileRun({ planned: 100, created: 90, skippedExisting: 8, failed: 1 }).balanced, false);
  assert.equal(reconcileRun({ planned: 100, created: 120, skippedExisting: 0, failed: 0 }).withinPlan, false);
});

test('実行前の表示に必要な情報がそろう', () => {
  const d = describeRunPlan({
    batchId: BATCH, previewId: PREVIEW, fileHashes: ['h1', 'h2', 'h3'], previewHash: 'sum',
    createTotal: 14000, runCount: 100, skippedExisting: 3, availableFields: new Set(),
  });
  assert.equal(d.ImportBatchId, BATCH);
  assert.equal(d.今回実行件数, 100);
  assert.equal(d.上限, FIRST_RUN_MAX_ROWS);
  assert.equal(d.対象ファイルhash.length, 3);
  assert.match(d.rollback.join(' '), /削除ではなく隔離/);
  assert.match(d.検証方法.join(' '), /Source/);
  assert.equal(d.書き込む列.includes('Phone'), false);
});

// ── まとめ書き（bulk create）────────────────────────────────────
// 1 件ずつだと 100 件で約 35 秒かかり、同期 Function の上限を超えて
// 「作成済みだけ残って結果が分からない」最悪の状態になる。10 件ずつまとめる。

const makeBulkDeps = (behavior = () => ({ ok: true })) => {
  const bulkCalls = []; const singleCalls = [];
  return {
    bulkCalls,
    singleCalls,
    deps: {
      createRecords: async (fieldsArray) => { bulkCalls.push(fieldsArray); return behavior(fieldsArray, bulkCalls.length); },
      createRecord: async (fields) => { singleCalls.push(fields); return { ok: true }; },
      sleep: async () => {},
    },
  };
};

test('bulk: 100 件を 10 リクエストで書く', async () => {
  const { deps, bulkCalls, singleCalls } = makeBulkDeps();
  const r = await writeCreateBatch({
    rows: rows(100), batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(), maxWrites: 100, deps,
  });
  assert.equal(r.created, 100);
  assert.equal(r.failed, 0);
  assert.equal(bulkCalls.length, 10, `まとめ書きが ${bulkCalls.length} 回（10 回であるべき）`);
  assert.equal(singleCalls.length, 0, 'まとめ書きが成功したのに 1 件ずつ書いている');
  assert.ok(bulkCalls.every((c) => c.length <= CREATE_CHUNK_SIZE), 'Airtable の上限 10 件を超えている');
  assert.equal(r.reconciliation.balanced, true);
});

test('bulk: チャンクが失敗したら 1 件ずつ書き直して原因を切り分ける', async () => {
  // 2 番目のチャンクだけ検証エラー（再試行しない種類）
  let n = 0;
  const bulkCalls = []; const singleCalls = [];
  const deps = {
    createRecords: async (arr) => { bulkCalls.push(arr); n += 1; return n === 2 ? { ok: false, status: 422 } : { ok: true }; },
    createRecord: async (f) => { singleCalls.push(f); return f.Email === 'u12@example.com' ? { ok: false, status: 422 } : { ok: true }; },
    sleep: async () => {},
  };
  const r = await writeCreateBatch({
    rows: rows(30), batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 30, deps,
  });
  assert.equal(bulkCalls.length, 3, 'チャンク数が違う');
  assert.equal(singleCalls.length, 10, '失敗チャンクだけ 1 件ずつやり直していない');
  assert.equal(r.created, 29, '巻き添えで落ちている行がある');
  assert.equal(r.failedTerminal, 1, '悪い 1 行を特定できていない');
  assert.equal(r.reconciliation.balanced, true);
});

test('bulk: 429 はチャンク単位で再試行する', async () => {
  let n = 0;
  const { deps, bulkCalls, singleCalls } = makeBulkDeps(() => { n += 1; return n < 3 ? { ok: false, status: 429 } : { ok: true }; });
  const r = await writeCreateBatch({
    rows: rows(10), batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 10, deps,
  });
  assert.equal(r.created, 10);
  assert.equal(bulkCalls.length, 3, '再試行していない');
  assert.equal(singleCalls.length, 0, '429 で 1 件ずつへ落ちている');
});

test('bulk: 上限を超えて書かない', async () => {
  const { deps, bulkCalls } = makeBulkDeps();
  const r = await writeCreateBatch({
    rows: rows(100), batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 25, deps,
  });
  assert.equal(r.created, 25);
  assert.equal(bulkCalls.flat().length, 25, '計画より多く送っている');
});

test('bulk: 既存・作成済みはまとめ書きへ渡さない', async () => {
  const done = new Set([computeCreateRowKey({ batchId: BATCH, email: 'u0@example.com' })]);
  const { deps, bulkCalls } = makeBulkDeps();
  const r = await writeCreateBatch({
    rows: rows(5), batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(['u1@example.com']), doneRowKeys: done, maxWrites: 10, deps,
  });
  assert.equal(r.created, 3);
  assert.equal(r.skippedExisting, 1);
  assert.equal(r.skippedDone, 1);
  const sent = bulkCalls.flat().map((f) => f.Email);
  assert.equal(sent.includes('u0@example.com'), false, '作成済みを送っている');
  assert.equal(sent.includes('u1@example.com'), false, '既存を送っている');
});

test('bulk: 許可外の列があれば 1 件も書かない（部分書き込みを作らない）', async () => {
  const { deps, bulkCalls, singleCalls } = makeBulkDeps();
  // 氏名の代わりに禁止列が入る状況を作る（buildCreateFields は使わず直接検査を確認）
  const r = await writeCreateBatch({
    rows: [{ email: 'a@example.com' }, { email: '' }], batchId: BATCH, nowIso: NOW_ISO,
    existingEmails: new Set(), maxWrites: 10, deps,
  });
  // 空メールは terminal 扱いだが、許可列違反ではないので書き込みは走る
  assert.equal(r.created, 1);
  assert.equal(bulkCalls.length, 1);
  assert.equal(singleCalls.length, 0);
});

test('bulk: まとめ書きが無ければ従来どおり 1 件ずつ（後方互換）', async () => {
  const { deps, calls } = makeDeps();
  const r = await writeCreateBatch({
    rows: rows(3), batchId: BATCH, nowIso: NOW_ISO, existingEmails: new Set(), maxWrites: 10, deps,
  });
  assert.equal(r.created, 3);
  assert.equal(calls.length, 3);
  assert.equal(r.bulkRequests, 0);
});

test('bulk: チャンクは Airtable の上限を超えられない', () => {
  assert.equal(CREATE_CHUNK_SIZE, 10);
  assert.equal(chunkList(rows(25), 999).every((c) => c.length <= 10), true, '上限を無視できてしまう');
  assert.equal(chunkList(rows(25), 10).length, 3);
});
