/**
 * customerEmailLookup.test.mjs — CSV のアドレス突合が**取り落とさない**こと
 *   node --test src/lib/crm/customerEmailLookup.test.mjs
 *
 * ここで 1 人取り落とすと「AK に居ない」と判定され、取り込みで**レコードが二重に作られる**。
 * 二重になったアドレスは `auth/customerLookup` が CONFLICT で fail closed にするので、
 * その人は**ログインできなくなる**。取り落としは静かに起きるので、テストで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookupCustomersByEmails, buildEmailLookupFormula, chunkEmails, normalizeEmailList,
  EmailLookupError, EMAIL_CHUNK, MAX_EMAIL_CHUNKS,
} from './customerEmailLookup.js';

const mkEmails = (n, prefix = 'u') => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);

/** アドレス → レコードを返す偽 Airtable（formula から対象を読み取る） */
function fakeAirtable(existing, { pageSize = 100 } = {}) {
  const calls = [];
  const set = new Set(existing.map((e) => e.toLowerCase()));
  const fetchPage = async ({ formula, offset }) => {
    calls.push({ formula, offset });
    const asked = [...formula.matchAll(/= '([^']+)'/g)].map((m) => m[1]);
    const hits = asked.filter((e) => set.has(e)).map((e, i) => ({ id: `rec${i}`, fields: { Email: e } }));
    const start = offset ? Number(offset) : 0;
    const slice = hits.slice(start, start + pageSize);
    const next = start + pageSize < hits.length ? String(start + pageSize) : undefined;
    return { records: slice, offset: next };
  };
  return { fetchPage, calls };
}

// ── 正規化 ────────────────────────────────────────────────────
test('大文字小文字・前後空白・重複をまとめる', () => {
  assert.deepEqual(
    normalizeEmailList(['  A@Example.com ', 'a@example.com', '', null, 'b@example.com']),
    ['a@example.com', 'b@example.com'],
  );
});

test('空のときは formula を作らない（全件一致に化けさせない）', () => {
  assert.equal(buildEmailLookupFormula([]), null);
  assert.equal(buildEmailLookupFormula(['', '   ']), null);
});

test('【重要】アドレスで式を壊さない', () => {
  const f = buildEmailLookupFormula(["o'brien@example.com", 'a@example.com']);
  assert.ok(f.includes("o\\'brien@example.com"));
  const quotes = (f.replace(/\\'/g, '').match(/'/g) || []).length;
  assert.equal(quotes % 2, 0, `式が閉じていない: ${f}`);
});

test('空の Email 列に当たらないよう文字列化してから比較する', () => {
  assert.match(buildEmailLookupFormula(['a@example.com']), /\{Email\} & ''/);
});

// ── 分割 ──────────────────────────────────────────────────────
test('アドレスは chunk へ割る（1 リクエストを肥大させない）', () => {
  const chunks = chunkEmails(mkEmails(EMAIL_CHUNK * 2 + 5));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, EMAIL_CHUNK);
  assert.equal(chunks[2].length, 5);
});

test('【重要】多すぎるときは切り捨てずに例外', () => {
  assert.throws(
    () => chunkEmails(mkEmails(EMAIL_CHUNK * MAX_EMAIL_CHUNKS + 1)),
    (e) => e instanceof EmailLookupError && e.code === 'too_many_emails',
  );
});

// ── 突合（本題）───────────────────────────────────────────────
test('【重要】CSV の全アドレスを突合する（先頭だけで打ち切らない）', async () => {
  // AK には CSV の後ろの方の人も居る。旧実装（先頭 6,000 件走査）はここを落としていた
  const csv = mkEmails(1000);
  const existing = [csv[0], csv[500], csv[999]];
  const api = fakeAirtable(existing);

  const out = await lookupCustomersByEmails({ emails: csv, fetchPage: api.fetchPage });
  const found = out.records.map((r) => r.fields.Email).sort();
  assert.deepEqual(found, [...existing].sort(), 'CSV の後ろのアドレスを取り落としている');
  assert.equal(out.chunks, Math.ceil(1000 / EMAIL_CHUNK));
});

test('【重要】コストは顧客数ではなく CSV の行数で決まる', async () => {
  // AK に 15,962 人居ても、CSV が 10 行なら 1 リクエストで済む
  const api = fakeAirtable(mkEmails(15962, 'ak'));
  const out = await lookupCustomersByEmails({ emails: mkEmails(10), fetchPage: api.fetchPage });
  assert.equal(out.requests, 1);
  assert.equal(out.chunks, 1);
});

test('同じアドレスが複数レコードある（AK 側重複）ときは全部返す', async () => {
  const fetchPage = async () => ({
    records: [
      { id: 'rec1', fields: { Email: 'dup@example.com' } },
      { id: 'rec2', fields: { Email: 'dup@example.com' } },
    ],
  });
  const out = await lookupCustomersByEmails({ emails: ['dup@example.com'], fetchPage });
  assert.equal(out.records.length, 2, '重複検出に必要な 2 件目を落としている');
});

test('chunk 内のページングも最後まで読む', async () => {
  const csv = mkEmails(EMAIL_CHUNK);
  const api = fakeAirtable(csv, { pageSize: 30 }); // 全員 AK に居る → 7 ページ
  const out = await lookupCustomersByEmails({ emails: csv, fetchPage: api.fetchPage });
  assert.equal(out.records.length, EMAIL_CHUNK, '途中のページを取り落としている');
});

test('【重要】ページが終わらないときは黙って諦めずに例外', async () => {
  const fetchPage = async () => ({ records: [{ id: 'r', fields: { Email: 'a@example.com' } }], offset: 'more' });
  await assert.rejects(
    lookupCustomersByEmails({ emails: ['a@example.com'], fetchPage, maxPagesPerChunk: 3 }),
    (e) => e instanceof EmailLookupError && e.code === 'chunk_page_limit',
  );
});

test('取得側の失敗はそのまま伝える（握りつぶして少ない結果を返さない）', async () => {
  const fetchPage = async () => { throw new Error('HTTP 500'); };
  await assert.rejects(
    lookupCustomersByEmails({ emails: ['a@example.com'], fetchPage }),
    /HTTP 500/,
  );
});

test('fetchPage を渡し忘れたら落とす（黙って 0 件にしない）', async () => {
  await assert.rejects(
    lookupCustomersByEmails({ emails: ['a@example.com'] }),
    (e) => e instanceof EmailLookupError && e.code === 'fetch_page_required',
  );
});
