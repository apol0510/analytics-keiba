/**
 * lightTrialSelection.test.mjs — Airtable 側で絞る選択が**安全で決定的**であること
 *   node --test src/lib/comeback/lightTrialSelection.test.mjs
 *
 * いちばん大事なのは【超集合】。formula が落とした人は永久に候補へ出てこないので、
 * 「JS が通す人を formula が落としていない」ことを総当たりで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidateFormula, candidateFormulaAccepts,
  buildBarrierFormula, barrierFormulaAccepts,
  selectCandidatesBounded, fetchBarrierRecords,
  SELECTION_SORT, CANDIDATE_MAX_PAGES, BARRIER_MAX_PAGES, SELECTION_ABORT, PAGE_SIZE,
} from './lightTrialSelection.js';
import { checkAutoGrantCandidate } from './lightTrialAutoGrant.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';

const NOW = Date.parse('2026-08-12T10:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString();

const toRow = (rec) => ({
  recordId: rec.id,
  fields: rec.fields,
  marketing: resolveCustomerMarketing({ fields: rec.fields, nowMs: NOW, blacklistEmails: new Set() }),
});

/** 候補になる最小の人 */
const okFields = (i = 1) => ({
  Email: `u${String(i).padStart(4, '0')}@example.com`,
  Source: 'customer-import:imp-2026-08-09-001',
});

const rec = (i, extra = {}) => ({ id: `rec${String(i).padStart(4, '0')}`, fields: { ...okFields(i), ...extra } });

// ── 🛡️ 超集合（ここが壊れると人が静かに消える）──────────────────
test('【最重要】JS が通す人を formula が落とさない（総当たり）', () => {
  // Customers に実在する列だけで組み合わせを作る
  const axes = {
    Source: ['customer-import:imp-2026-08-09-001', 'manual', ''],
    Email: ['a@example.com', ''],
    UnsubscribedAnalyticsKeiba: [undefined, true, false],
    WithdrawalRequested: [undefined, true],
    LightGrantedAt: [undefined, day(-10)],
    LightGrantUntil: [undefined, day(-1), day(10)],
    LightGrantLifetime: [undefined, true],
    PremiumGrantedAt: [undefined, day(-10)],
    PremiumGrantUntil: [undefined, day(10)],
    PremiumGrantLifetime: [undefined, true],
    Status: [undefined, 'active', 'withdrawn'],
  };
  const keys = Object.keys(axes);
  let checked = 0;
  let violations = 0;

  const walk = (idx, acc) => {
    if (idx === keys.length) {
      const fields = {};
      for (const [k, v] of Object.entries(acc)) if (v !== undefined) fields[k] = v;
      const marketing = resolveCustomerMarketing({ fields, nowMs: NOW, blacklistEmails: new Set() });
      const js = checkAutoGrantCandidate({ fields, marketing, batchIds: null, nowMs: NOW });
      const formula = candidateFormulaAccepts(fields);
      checked += 1;
      // JS が通すのに formula が落とす = **過剰除外**（許されない）
      if (js.ok && !formula) {
        violations += 1;
        assert.fail(`過剰除外: ${JSON.stringify(fields)}`);
      }
      return;
    }
    for (const v of axes[keys[idx]]) walk(idx + 1, { ...acc, [keys[idx]]: v });
  };
  walk(0, {});

  assert.ok(checked > 1000, `総当たりが少なすぎる: ${checked}`);
  assert.equal(violations, 0);
});

test('【退会】退会者を formula で落としていない（送信可否とは別軸）', () => {
  const f = { ...okFields(), WithdrawalRequested: true, Status: 'withdrawn' };
  assert.equal(candidateFormulaAccepts(f), true, '退会を除外すると送れる人を永久に失う');
});

test('formula は必要な列だけを見る（存在しない列を参照しない）', () => {
  const formula = buildCandidateFormula();
  const referenced = [...formula.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const REAL_COLUMNS = new Set([
    'Source', 'Email', 'UnsubscribedAnalyticsKeiba',
    'LightGrantedAt', 'LightGrantUntil', 'LightGrantLifetime',
    'PremiumGrantedAt', 'PremiumGrantUntil', 'PremiumGrantLifetime',
  ]);
  for (const col of referenced) {
    assert.ok(REAL_COLUMNS.has(col), `Customers に無い列を参照している: ${col}`);
  }
  // 存在しない列を書くと Airtable は 422 を返す（本番で下見が落ちる）
  assert.equal(/ImportBatchId|CreatedBy/.test(formula), false);
});

test('付与済み・期限なし付与・配信停止は formula で落ちる', () => {
  assert.equal(candidateFormulaAccepts({ ...okFields(), LightGrantedAt: day(-1) }), false);
  assert.equal(candidateFormulaAccepts({ ...okFields(), LightGrantUntil: day(5) }), false);
  assert.equal(candidateFormulaAccepts({ ...okFields(), LightGrantLifetime: true }), false);
  assert.equal(candidateFormulaAccepts({ ...okFields(), PremiumGrantedAt: day(-1) }), false);
  assert.equal(candidateFormulaAccepts({ ...okFields(), UnsubscribedAnalyticsKeiba: true }), false);
  assert.equal(candidateFormulaAccepts({ ...okFields(), Source: 'manual' }), false);
});

// ── 決定的な順序 ────────────────────────────────────────────
test('並び順は Email 昇順で固定（重複解消済みなので一意）', () => {
  assert.deepEqual(SELECTION_SORT, [{ field: 'Email', direction: 'asc' }]);
});

// ── bounded fetch ───────────────────────────────────────────
/** ページャの偽物。`rows` を pageSize ごとに返す */
function fakePager(rows, pageSize = PAGE_SIZE) {
  let calls = 0;
  return {
    get calls() { return calls; },
    fetchPage: async ({ offset }) => {
      calls += 1;
      const start = offset ? Number(offset) : 0;
      const slice = rows.slice(start, start + pageSize);
      const next = start + pageSize;
      return { records: slice, offset: next < rows.length ? String(next) : undefined };
    },
  };
}

test('【要件】14,489 件相当でも全件取得しない（batch 10 なら 1 ページ）', async () => {
  const rows = Array.from({ length: 14489 }, (_, i) => rec(i + 1));
  const pager = fakePager(rows);
  const out = await selectCandidatesBounded({
    fetchPage: pager.fetchPage, toRow, batchSize: 10, nowMs: NOW,
  });
  assert.equal(out.ok, true);
  assert.equal(out.batch.length, 10);
  assert.equal(out.pagesFetched, 1, '1 ページで足りるのに余分に読んでいる');
  assert.equal(out.recordsFetched, 100);
  assert.equal(out.moreAvailable, true);
  assert.equal(out.remainingExact, null, 'exact な残数を出してはいけない');
  assert.ok(pager.calls <= 1);
});

test('skip が混ざっても次ページから補充する', async () => {
  // 先頭 95 件を配信停止にして 1 ページ目で 5 件しか取れないようにする
  const rows = Array.from({ length: 300 }, (_, i) => (
    i < 95 ? rec(i + 1, { UnsubscribedAnalyticsKeiba: true }) : rec(i + 1)
  ));
  const pager = fakePager(rows);
  const out = await selectCandidatesBounded({
    fetchPage: pager.fetchPage, toRow, batchSize: 10, nowMs: NOW,
  });
  assert.equal(out.ok, true);
  assert.equal(out.batch.length, 10);
  assert.equal(out.pagesFetched, 2, '1 ページで足りないのに次を読んでいない');
  assert.equal(out.skippedByReason.not_sendable, 95);
});

test('同じ状態なら同じ batch が選ばれる（決定的）', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => rec(i + 1));
  const a = await selectCandidatesBounded({ fetchPage: fakePager(rows).fetchPage, toRow, batchSize: 10, nowMs: NOW });
  const b = await selectCandidatesBounded({ fetchPage: fakePager(rows).fetchPage, toRow, batchSize: 10, nowMs: NOW });
  assert.deepEqual(a.batch.map((t) => t.recordId), b.batch.map((t) => t.recordId));
});

test('全部見終わったら moreAvailable=false（嘘をつかない）', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => rec(i + 1));
  const out = await selectCandidatesBounded({
    fetchPage: fakePager(rows).fetchPage, toRow, batchSize: 10, nowMs: NOW,
  });
  assert.equal(out.batch.length, 7);
  assert.equal(out.moreAvailable, false);
});

test('【silent truncation 禁止】上限に達したら fail closed', async () => {
  // 全員 skip されるので永久に埋まらない → 上限で止まる
  const rows = Array.from({ length: 100000 }, (_, i) => rec(i + 1, { UnsubscribedAnalyticsKeiba: true }));
  const out = await selectCandidatesBounded({
    fetchPage: fakePager(rows).fetchPage, toRow, batchSize: 10, nowMs: NOW,
  });
  assert.equal(out.ok, false);
  assert.equal(out.abort, SELECTION_ABORT.CANDIDATE_SCAN_LIMIT);
  assert.equal(out.pagesFetched, CANDIDATE_MAX_PAGES);
  assert.equal(out.batch.length, 0, '確定できていないのに対象を返してはいけない');
});

test('同一メールの重複レコードは 1 人ぶんだけ数える', async () => {
  const rows = [rec(1), { id: 'recDUP', fields: { ...okFields(1) } }, rec(2), rec(3)];
  const out = await selectCandidatesBounded({
    fetchPage: fakePager(rows).fetchPage, toRow, batchSize: 10, nowMs: NOW,
  });
  assert.equal(out.batch.length, 3);
});

// ── 関所 ────────────────────────────────────────────────────
/**
 * formula が**構文として壊れていない**こと。
 * 2026-08-12 に `'light-trial-autogrant'OR(...)`（カンマ落ち）を本番で 422 にして気づいた。
 * 正規表現の部分一致テストだけでは通ってしまうので、括弧と区切りを機械的に見る。
 */
function assertFormulaWellFormed(formula, label) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < formula.length; i += 1) {
    const ch = formula[i];
    if (ch === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    assert.ok(depth >= 0, `${label}: 閉じ括弧が多い`);
  }
  assert.equal(depth, 0, `${label}: 括弧が閉じていない`);
  assert.equal(inStr, false, `${label}: 文字列が閉じていない`);
  // 文字列リテラルを潰してから「値の直後にいきなり識別子」= 区切り落ち を見る
  const masked = formula.replace(/'[^']*'/g, '§');
  assert.equal(/§\s*[A-Za-z_(]/.test(masked), false, `${label}: 文字列の直後に区切りが無い`);
  assert.equal(/\)\s*[A-Za-z_]/.test(masked), false, `${label}: 閉じ括弧の直後に区切りが無い`);
  assert.equal(/\}\s*\{/.test(masked), false, `${label}: フィールド参照の間に区切りが無い`);
}

test('【本番で 422 にしない】formula が構文として壊れていない', () => {
  assertFormulaWellFormed(buildCandidateFormula(), '候補');
  assertFormulaWellFormed(buildBarrierFormula(), '関所');
  // 実際に本番へ投げて通った形（2026-08-12 検証済み）
  assert.equal(
    buildBarrierFormula(),
    "AND({ComebackGrantSource} = 'light-trial-autogrant', "
    + 'OR({LightGrantLifetime}, AND({LightGrantUntil} != BLANK(), IS_AFTER({LightGrantUntil}, NOW()))))',
  );
});

test('関所は自動付与で配って体験中の人だけを取る formula', () => {
  const f = buildBarrierFormula();
  assert.match(f, /ComebackGrantSource/);
  assert.match(f, /light-trial-autogrant/);
  assert.match(f, /IS_AFTER\(\{LightGrantUntil\}, NOW\(\)\)/);

  const active = { ComebackGrantSource: 'light-trial-autogrant', LightGrantUntil: day(10) };
  const ended = { ComebackGrantSource: 'light-trial-autogrant', LightGrantUntil: day(-1) };
  const manual = { ComebackGrantSource: 'manual-comeback', LightGrantUntil: day(10) };
  assert.equal(barrierFormulaAccepts(active, NOW), true);
  assert.equal(barrierFormulaAccepts(ended, NOW), false, '終わった体験は関所に要らない');
  assert.equal(barrierFormulaAccepts(manual, NOW), false, '手動付与は関所の対象外');
});

test('【silent truncation 禁止】関所も上限で fail closed', async () => {
  const rows = Array.from({ length: 100000 }, (_, i) => rec(i + 1));
  const out = await fetchBarrierRecords({ fetchPage: fakePager(rows).fetchPage, toRow });
  assert.equal(out.ok, false);
  assert.equal(out.abort, SELECTION_ABORT.BARRIER_SCAN_LIMIT);
  assert.equal(out.pagesFetched, BARRIER_MAX_PAGES);
  assert.equal(out.rows.length, 0, '数え切れていないのに件数を返してはいけない');
});

test('関所は小さい集合なら全部読む', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => rec(i + 1));
  const out = await fetchBarrierRecords({ fetchPage: fakePager(rows).fetchPage, toRow });
  assert.equal(out.ok, true);
  assert.equal(out.rows.length, 250);
  assert.equal(out.pagesFetched, 3);
});
