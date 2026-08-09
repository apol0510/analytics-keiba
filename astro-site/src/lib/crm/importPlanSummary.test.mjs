/**
 * importPlanSummary.test.mjs — 本実行前の内訳集計を固定する
 *   node --test src/lib/crm/importPlanSummary.test.mjs
 *
 * ⚠️ 内訳は `countCreateCandidates` と**同じ `classifyCreateRow`** を通す。
 *    別ロジックで数え直すと「CREATE の数」と「内訳の合計」がズレるため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeImportPlan, countCreateCandidates, SKIP_REASON, orderEntriesDeterministically,
} from './importEligibility.js';

const E = (email, extra = {}) => ({ email, name: 'N', ...extra });

// ⚠️ facts の各項目は **Set でなければならない**。`asSet` は Set 以外を空集合にするため、
//    配列を渡すと**除外が全て無効化**され、落とすべき行が CREATE されてしまう。
//    実装 (`buildAkFacts`) が Set を返すことは下のテストで固定する。
const facts = {
  existing: new Set(['exist1@example.com', 'exist2@example.com']),
  unsubscribed: new Set(['unsub@example.com']),
  hardBounce: new Set(['hard@example.com']),
  softBounce: new Set(['soft@example.com']),
  suspended: new Set(['susp@example.com']),
  testAccounts: new Set(['test@example.com']),
  paid: new Set(['paid@example.com']),
  duplicateInAk: new Set(['dupak@example.com']),
};
const providerEmails = new Set(['sup@example.com']);

const entries = [
  E('new1@example.com'), E('new2@example.com'), E('new3@example.com'),
  E('exist1@example.com'), E('exist2@example.com'),
  E('unsub@example.com'), E('hard@example.com'), E('soft@example.com'),
  E('susp@example.com'), E('test@example.com'), E('paid@example.com'),
  E('dupak@example.com'), E('sup@example.com'),
  E(''),                                    // no_email
  E('flag@example.com', { flags: ['要確認'] }),
  E('NEW1@example.com'),                    // CSV 内の重複（大文字）
];

test('CREATE の数は countCreateCandidates と一致する', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  assert.equal(s.create, countCreateCandidates({ entries, facts, providerEmails }));
});

test('内訳の合計が CSV 行数と一致する（取りこぼしが無い）', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  assert.equal(s.total, entries.length);
  assert.equal(s.create + s.existing + s.excluded + s.reviewRequired, s.total,
    `内訳が合わない: ${JSON.stringify(s)}`);
});

test('EXISTING は既存 Customers の数だけ（更新しない対象）', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  assert.equal(s.existing, 2);
});

test('REVIEW_REQUIRED は flagged / role_address / duplicate_in_ak（旧経路と同じ割り当て）', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  // flagged 1 + duplicate_in_ak 1（この fixture に role アドレスは無い）
  assert.equal(s.reviewRequired, 2);
  assert.equal(s.skippedByReason[SKIP_REASON.FLAGGED], 1);
  assert.equal(s.skippedByReason[SKIP_REASON.DUPLICATE_IN_AK], 1);
});

test('EXCLUDED は機械的に落とす 8 種の合計（duplicate_in_ak は REVIEW へ）', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  // no_email / unsubscribed / hard / soft / suspended / test / paid / provider
  // ⚠️ duplicate_in_ak は旧経路で REVIEW なので EXCLUDED に入れない
  assert.equal(s.excluded, 8);
});

test('CSV 内の正規化メール重複を数える（大文字小文字を同一視）', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  assert.equal(s.duplicateInCsv, 1, 'NEW1@ と new1@ を重複として数えていない');
});

test('空 entries でも壊れない', () => {
  const s = summarizeImportPlan({});
  assert.equal(s.total, 0);
  assert.equal(s.create, 0);
  assert.equal(s.create + s.existing + s.excluded + s.reviewRequired, 0);
});

test('並び順を変えても集計は変わらない（決定的）', () => {
  const a = summarizeImportPlan({ entries, facts, providerEmails });
  const b = summarizeImportPlan({
    entries: orderEntriesDeterministically([...entries].reverse()), facts, providerEmails,
  });
  assert.equal(a.create, b.create);
  assert.equal(a.existing, b.existing);
  assert.equal(a.excluded, b.excluded);
  assert.equal(a.reviewRequired, b.reviewRequired);
});

test('buildAkFacts は除外判定に使う項目を必ず Set で返す（silent failure 防止）', async () => {
  const { buildAkFacts } = await import('./importAkFacts.js');
  const f = buildAkFacts({
    records: [{ fields: { Email: 'a@example.com' } }],
    nowMs: Date.now(), blacklistHard: [], blacklistSoft: [], testRecipients: [],
  });
  // asSet() は Set 以外を空集合にするため、Array になった瞬間に除外が効かなくなる
  for (const k of ['existing', 'duplicateInAk', 'paid', 'unsubscribed', 'suspended',
    'testAccounts', 'hardBounce', 'softBounce']) {
    assert.ok(f[k] instanceof Set, `facts.${k} が Set でない（除外が無効化される）`);
  }
});

test('facts に配列を渡すと除外が効かなくなることを明示的に記録する', () => {
  // これは仕様の確認であって推奨ではない。呼び出し側は必ず Set を渡すこと。
  const arrayFacts = { existing: ['exist1@example.com'] };
  const s = summarizeImportPlan({ entries: [E('exist1@example.com')], facts: arrayFacts, providerEmails: new Set() });
  assert.equal(s.existing, 0, '配列でも除外できてしまうなら asSet の仕様が変わっている');
  assert.equal(s.create, 1, '既存のはずの行が CREATE 側に来る（だから Set 必須）');
});

test('返り値にアドレス・氏名を含めない（PII を出さない）', () => {
  const s = summarizeImportPlan({ entries, facts, providerEmails });
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /@/, `PII が混ざっている: ${json}`);
});
