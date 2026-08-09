/**
 * importTargetedSelect.test.mjs — 名指し取得でも全件取得と同じ選定になることを固定する
 *   node --test src/lib/crm/importTargetedSelect.test.mjs
 *
 * 2026-08-09 の本実行: Customers 15,967 件で **1 回の全件取得に約 170 秒**かかり、
 * Function タイムアウト（最大 26 秒）を超えて毎 step 504 になった。
 * 実測で「対象 100 件の名指しクエリは 1 コール 1.7 秒」だったため、
 * **候補メールだけを窓単位で引く**方式へ変える。判定結果は変えない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCreateRowsTargeted, planWindows, chunkEmails, SCAN_WINDOW, LOOKUP_CHUNK, MAX_WINDOWS,
} from './importTargetedSelect.js';
import { selectCreateRows } from './importEligibility.js';
import { buildAkFacts } from './importAkFacts.js';

/** 疑似 Customers（全件） */
function makeCustomers(existingEmails) {
  return existingEmails.map((e, i) => ({ id: `rec${i}`, fields: { Email: e } }));
}
/** 名指しクエリの模擬: 与えたメールに一致するレコードだけ返す */
function makeLoader(allRecords, counter) {
  return async (emails) => {
    counter.calls += 1; counter.emails += emails.length;
    const set = new Set(emails);
    const hit = allRecords.filter((r) => set.has(String(r.fields.Email).toLowerCase()));
    return buildAkFacts({ records: hit, nowMs: Date.now(), blacklistHard: new Set(), blacklistSoft: new Set(), testRecipients: [] });
  };
}

const entriesOf = (n, prefix = 'u') =>
  Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com`, name: 'N' }));

test('全件 facts と名指し facts で CREATE 集合が完全一致する', async () => {
  const entries = entriesOf(500);
  // 既存を散らす（前半に多め）
  const existing = entries.filter((_, i) => i % 3 === 0).map((e) => e.email);
  const all = makeCustomers(existing);
  const fullFacts = buildAkFacts({ records: all, nowMs: Date.now(), blacklistHard: new Set(), blacklistSoft: new Set(), testRecipients: [] });

  const full = selectCreateRows({ entries, facts: fullFacts, providerEmails: new Set(), cursor: 0, limit: 100 });
  const counter = { calls: 0, emails: 0 };
  const targeted = await selectCreateRowsTargeted({
    entries, cursor: 0, limit: 100, providerEmails: new Set(),
    loadFacts: makeLoader(all, counter), selectFn: selectCreateRows,
  });

  assert.deepEqual(targeted.rows.map((r) => r.email), full.rows.map((r) => r.email), 'CREATE 集合が違う');
  assert.equal(targeted.scannedTo, full.scannedTo, 'scannedTo が違う（cursor がずれる）');
  assert.deepEqual(targeted.skipped, full.skipped, 'skip の内訳が違う');
});

test('既存が連続していても窓を進めて必要数を集める', async () => {
  const entries = entriesOf(1000);
  // 先頭 400 件をすべて既存にする
  const existing = entries.slice(0, 400).map((e) => e.email);
  const all = makeCustomers(existing);
  const counter = { calls: 0, emails: 0 };
  const t = await selectCreateRowsTargeted({
    entries, cursor: 0, limit: 100, providerEmails: new Set(),
    loadFacts: makeLoader(all, counter), selectFn: selectCreateRows,
  });
  assert.equal(t.rows.length, 100);
  assert.ok(t.windowsUsed >= 2, `窓が ${t.windowsUsed} しか開いていない`);
  assert.equal(t.skipped.existing, 400);
});

test('全件取得より圧倒的に少ないメールしか引かない', async () => {
  const entries = entriesOf(14279);
  const all = makeCustomers([]);
  const counter = { calls: 0, emails: 0 };
  await selectCreateRowsTargeted({
    entries, cursor: 0, limit: 100, providerEmails: new Set(),
    loadFacts: makeLoader(all, counter), selectFn: selectCreateRows,
  });
  assert.ok(counter.emails <= SCAN_WINDOW, `${counter.emails} 件も引いている`);
  assert.equal(counter.calls, 1, '窓を開きすぎている');
});

test('cursor の位置から再開する', async () => {
  const entries = entriesOf(1000);
  const all = makeCustomers([]);
  const counter = { calls: 0, emails: 0 };
  const t = await selectCreateRowsTargeted({
    entries, cursor: 500, limit: 100, providerEmails: new Set(),
    loadFacts: makeLoader(all, counter), selectFn: selectCreateRows,
  });
  assert.equal(t.rows[0].email, 'u500@example.com');
  assert.equal(t.scannedTo, 600);
});

test('末尾まで走査したら exhausted を立てる', async () => {
  const entries = entriesOf(50);
  const all = makeCustomers([]);
  const t = await selectCreateRowsTargeted({
    entries, cursor: 0, limit: 100, providerEmails: new Set(),
    loadFacts: makeLoader(all, { calls: 0, emails: 0 }), selectFn: selectCreateRows,
  });
  assert.equal(t.rows.length, 50);
  assert.equal(t.exhausted, true);
});

test('facts が引けなければ例外にする（空集合で続けない = fail open 禁止）', async () => {
  const entries = entriesOf(100);
  await assert.rejects(
    () => selectCreateRowsTargeted({
      entries, cursor: 0, limit: 10, providerEmails: new Set(),
      loadFacts: async () => null, selectFn: selectCreateRows,
    }),
    /targeted facts unavailable/,
  );
});

test('重複している既存アドレスも名指しで検出できる', async () => {
  const entries = entriesOf(10);
  // 同じメールのレコードが 2 件ある（AK 側重複）
  const all = [
    { id: 'a', fields: { Email: 'u3@example.com' } },
    { id: 'b', fields: { Email: 'u3@example.com' } },
  ];
  const t = await selectCreateRowsTargeted({
    entries, cursor: 0, limit: 10, providerEmails: new Set(),
    loadFacts: makeLoader(all, { calls: 0, emails: 0 }), selectFn: selectCreateRows,
  });
  assert.ok(!t.rows.some((r) => r.email === 'u3@example.com'), '重複アドレスを CREATE 対象にしている');
});

// ── 補助関数 ────────────────────────────────────────────────
test('窓の分割が cursor 以降を隙間なく覆う', () => {
  const w = planWindows({ entries: entriesOf(1000), cursor: 250, windowSize: 300, maxWindows: 12 });
  assert.equal(w[0].from, 250);
  for (let i = 1; i < w.length; i += 1) assert.equal(w[i].from, w[i - 1].to, '窓に隙間がある');
});

test('窓の数に上限がある（暴走防止）', () => {
  const w = planWindows({ entries: entriesOf(100000), cursor: 0, windowSize: 300, maxWindows: MAX_WINDOWS });
  assert.equal(w.length, MAX_WINDOWS);
});

test('メールの chunk は重複を除いて上限内に割る', () => {
  const c = chunkEmails(['A@x.com', 'a@x.com', ...Array.from({ length: 120 }, (_, i) => `u${i}@x.com`)], LOOKUP_CHUNK);
  assert.equal(c.flat().length, 121, '重複を除けていない');
  for (const g of c) assert.ok(g.length <= LOOKUP_CHUNK);
});
