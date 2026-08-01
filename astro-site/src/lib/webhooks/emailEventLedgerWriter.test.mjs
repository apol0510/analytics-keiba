/**
 * emailEventLedgerWriter.test.mjs — 台帳書き込みの耐障害性（バッチ化・bounded retry・集計）
 *
 * 台帳は append-only で**後から復元できない**ため、
 * 「落ちたのに黙って捨てる」「一時障害で欠測する」「無限に叩き続ける」のどれも許さない。
 * 実ネットワークは使わず、`fetchFn` / `sleepFn` / `nowFn` を注入して決定的に検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeLedgerRows,
  chunkRows,
  dedupeRowsByEventKey,
  classifyWriteStatus,
  classifyWriteError,
  backoffMs,
  WRITE_FAILURE,
  LEDGER_BATCH_SIZE,
  LEDGER_MAX_ATTEMPTS,
  LEDGER_MAX_BACKOFF_MS,
} from './emailEventLedgerWriter.js';

/** テスト用の行（列は台帳の許可列のみ） */
const row = (key, extra = {}) => ({
  eventKey: key,
  fields: {
    EventKey: key,
    EventType: 'open',
    EventAt: '2026-08-02T00:00:00.000Z',
    ReceivedAt: '2026-08-02T00:00:01.000Z',
    Provider: 'sendgrid',
    VerificationStatus: 'verified',
    ResolutionStatus: 'unresolved',
    ResolutionReason: 'no_custom_args',
    CreatedBy: 'sendgrid-webhook',
    EmailHash: 'a'.repeat(32),
    ...extra,
  },
});

const rows = (n, prefix = 'k') => Array.from({ length: n }, (_, i) => row(`${prefix}${i + 1}`));

/** 応答スタブ */
const ok = () => ({ ok: true, status: 200, headers: { get: () => null } });
const err = (status, retryAfter = null) => ({
  ok: false, status, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? retryAfter : null) },
});

/** 呼び出しを記録する fetch スタブ。`plan` は呼び出し順の応答（関数なら実行） */
function stubFetch(plan) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = typeof plan === 'function' ? plan(calls.length) : plan[calls.length - 1];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next ?? ok();
  };
  return { fn, calls };
}

const noSleep = () => { let total = 0; return { fn: async (ms) => { total += ms; }, get total() { return total; } }; };

const baseArgs = () => ({
  apiKey: 'test-key',
  baseId: 'appTEST',
  table: 'EmailEvents',
  sleepFn: async () => {},
});

// ── 1. 0 件 ─────────────────────────────────────────────
test('0 件: リクエストを 1 回も出さない（空振りで叩かない）', async () => {
  const { fn, calls } = stubFetch([]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: [], fetchFn: fn });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    { attempted: r.attempted, written: r.written, failed: r.failed, batches: r.batches },
    { attempted: 0, written: 0, failed: 0, batches: 0 },
  );
});

// ── 2. 1 件 ─────────────────────────────────────────────
test('1 件: 1 リクエスト・upsert（EventKey マージ）で送る', async () => {
  const { fn, calls } = stubFetch([ok()]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(1), fetchFn: fn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].url, 'https://api.airtable.com/v0/appTEST/EmailEvents');
  assert.deepEqual(calls[0].body.performUpsert, { fieldsToMergeOn: ['EventKey'] });
  assert.equal(calls[0].body.records.length, 1);
  assert.equal(r.written, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.batches, 1);
});

// ── 3. 10 件 ────────────────────────────────────────────
test('10 件: 1 リクエストにまとめる（1 件ずつ叩かない）', async () => {
  const { fn, calls } = stubFetch([ok()]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(10), fetchFn: fn });
  assert.equal(calls.length, 1, '10 件は 1 リクエストに収まる');
  assert.equal(calls[0].body.records.length, 10);
  assert.equal(r.written, 10);
  assert.equal(r.batches, 1);
  assert.equal(LEDGER_BATCH_SIZE, 10);
});

// ── 4. 11 件で 2 バッチ ─────────────────────────────────
test('11 件: 10 + 1 の 2 バッチに分割する', async () => {
  const { fn, calls } = stubFetch([ok(), ok()]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(11), fetchFn: fn });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.body.records.length), [10, 1]);
  assert.equal(r.written, 11);
  assert.equal(r.batches, 2);
  assert.equal(r.failedBatches, 0);
});

// ── 5. 同一 EventKey 重複 ───────────────────────────────
test('同一 EventKey の重複は送信前に畳む（1 行の重複でバッチ全体を落とさない）', async () => {
  const { fn, calls } = stubFetch([ok()]);
  const dup = [row('same'), row('same'), row('other'), row('same')];
  const r = await writeLedgerRows({ ...baseArgs(), rows: dup, fetchFn: fn });
  assert.equal(calls[0].body.records.length, 2, '重複を送っていない');
  const keys = calls[0].body.records.map((x) => x.fields.EventKey);
  assert.deepEqual(keys, ['same', 'other']);
  assert.equal(r.deduped, 2);
  assert.equal(r.attempted, 2);
  assert.equal(r.written, 2);
});

test('dedupeRowsByEventKey: EventKey が空の行は送らない', () => {
  const r = dedupeRowsByEventKey([row('a'), { fields: {} }, row('a')]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.deduped, 2);
});

// ── 6. 429 後に成功 ─────────────────────────────────────
test('429 の後に成功する（レート制限は再試行する）', async () => {
  const sleep = noSleep();
  const { fn, calls } = stubFetch([err(429, '1'), ok()]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(3), fetchFn: fn, sleepFn: sleep.fn });
  assert.equal(calls.length, 2);
  assert.equal(r.written, 3);
  assert.equal(r.failed, 0);
  assert.equal(r.retryCount, 1);
  assert.deepEqual(r.failureReasons, {}, '最終的に成功した再試行は失敗として数えない');
  assert.ok(sleep.total > 0 && sleep.total <= LEDGER_MAX_BACKOFF_MS, 'backoff が上限内で入る');
});

// ── 7. 5xx 後に成功 ─────────────────────────────────────
test('5xx の後に成功する（一時障害は再試行する）', async () => {
  const { fn, calls } = stubFetch([err(500), err(503), ok()]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(2), fetchFn: fn });
  assert.equal(calls.length, 3);
  assert.equal(r.written, 2);
  assert.equal(r.retryCount, 2);
  assert.equal(r.failedBatches, 0);
});

// ── 8. timeout で上限到達 ───────────────────────────────
test('timeout が続く: 試行上限で必ず止まり、理由 timeout で失敗として数える', async () => {
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const { fn, calls } = stubFetch(() => timeout);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(4), fetchFn: fn });
  assert.equal(calls.length, LEDGER_MAX_ATTEMPTS, '無限に再試行しない');
  assert.equal(r.written, 0);
  assert.equal(r.failed, 4);
  assert.equal(r.failedBatches, 1);
  assert.equal(r.retryCount, LEDGER_MAX_ATTEMPTS - 1);
  assert.deepEqual(r.failureReasons, { [WRITE_FAILURE.TIMEOUT]: 4 });
});

test('transport error（ネットワーク断）も再試行し、上限で止まる', async () => {
  const { fn, calls } = stubFetch(() => new TypeError('fetch failed'));
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(1), fetchFn: fn });
  assert.equal(calls.length, LEDGER_MAX_ATTEMPTS);
  assert.deepEqual(r.failureReasons, { [WRITE_FAILURE.TRANSPORT_ERROR]: 1 });
});

// ── 9. 403 / 404 / 422 は再試行しない ───────────────────
for (const [status, reason] of [[403, WRITE_FAILURE.FORBIDDEN], [404, WRITE_FAILURE.NOT_FOUND], [422, WRITE_FAILURE.UNPROCESSABLE]]) {
  test(`${status} は恒久エラー: 再試行せず 1 回で諦める（叩き続けない）`, async () => {
    const { fn, calls } = stubFetch(() => err(status));
    const r = await writeLedgerRows({ ...baseArgs(), rows: rows(2), fetchFn: fn });
    assert.equal(calls.length, 1, `${status} で再試行している`);
    assert.equal(r.retryCount, 0);
    assert.equal(r.written, 0);
    assert.equal(r.failed, 2);
    assert.deepEqual(r.failureReasons, { [reason]: 2 });
  });
}

test('classifyWriteStatus: 再試行可否の分類が固定されている', () => {
  assert.deepEqual(classifyWriteStatus(429), { reason: WRITE_FAILURE.RATE_LIMITED, retryable: true });
  assert.deepEqual(classifyWriteStatus(502), { reason: WRITE_FAILURE.SERVER_ERROR, retryable: true });
  assert.equal(classifyWriteStatus(403).retryable, false);
  assert.equal(classifyWriteStatus(404).retryable, false);
  assert.equal(classifyWriteStatus(422).retryable, false);
  assert.equal(classifyWriteStatus(400).retryable, false);
  assert.equal(classifyWriteError({ name: 'AbortError' }).reason, WRITE_FAILURE.TIMEOUT);
});

test('backoff は上限で頭打ちになる（Retry-After が大きくても超えない）', () => {
  assert.ok(backoffMs(1) <= LEDGER_MAX_BACKOFF_MS);
  assert.ok(backoffMs(10) <= LEDGER_MAX_BACKOFF_MS);
  assert.equal(backoffMs(1, '3600'), LEDGER_MAX_BACKOFF_MS, 'Retry-After でも上限を超えない');
  assert.ok(backoffMs(2) > backoffMs(1), '指数的に伸びる');
});

// ── 10. 一部バッチ成功・一部失敗 ────────────────────────
test('2 バッチのうち片方だけ失敗: 成功分は書かれ、失敗分だけ数える', async () => {
  // batch1 = 成功 / batch2 = 422（恒久）
  const { fn, calls } = stubFetch([ok(), err(422)]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(11), fetchFn: fn });
  assert.equal(calls.length, 2);
  assert.equal(r.written, 10);
  assert.equal(r.failed, 1);
  assert.equal(r.batches, 2);
  assert.equal(r.failedBatches, 1);
  assert.deepEqual(r.failureReasons, { [WRITE_FAILURE.UNPROCESSABLE]: 1 });
});

test('先頭バッチが落ちても後続バッチを止めない（1 件の失敗で全部を捨てない）', async () => {
  const { fn } = stubFetch([err(403), ok()]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: rows(11), fetchFn: fn });
  assert.equal(r.written, 1);
  assert.equal(r.failed, 10);
  assert.equal(r.failedBatches, 1);
});

// ── 11. attempted / written / failed の整合 ─────────────
test('集計の整合: attempted = written + failed / accepted = attempted + skipped + deduped', async () => {
  const { fn } = stubFetch([ok(), err(500), err(500), err(500)]);
  const input = [...rows(10, 'a'), ...rows(5, 'b'), row('a1')]; // 16 行（1 行は重複）
  const r = await writeLedgerRows({ ...baseArgs(), rows: input, fetchFn: fn });
  assert.equal(r.attempted, 15, '重複を除いた 15 行を送った');
  assert.equal(r.attempted, r.written + r.failed, 'attempted が written + failed と一致しない');
  assert.equal(input.length, r.attempted + r.skipped + r.deduped);
  assert.equal(r.written, 10);
  assert.equal(r.failed, 5);
  assert.equal(r.failedBatches, 1);
  assert.deepEqual(r.failureReasons, { [WRITE_FAILURE.SERVER_ERROR]: 5 });
});

test('許可列以外を含む行は送らず skipped と理由コードに出す（沈黙させない）', async () => {
  const { fn, calls } = stubFetch([ok()]);
  const bad = row('bad');
  bad.fields.Email = 'someone@example.com'; // 禁止列
  const isAllowed = (f) => !Object.keys(f).includes('Email');
  const r = await writeLedgerRows({ ...baseArgs(), rows: [row('good'), bad], fetchFn: fn, isAllowedFields: isAllowed });
  assert.equal(calls[0].body.records.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.attempted, 1);
  assert.deepEqual(r.failureReasons, { [WRITE_FAILURE.FIELD_NOT_ALLOWED]: 1 });
});

test('全体の締切を超えたら残りバッチを送らず deadline_exceeded として数える', async () => {
  let t = 0;
  const { fn, calls } = stubFetch(() => ok());
  const r = await writeLedgerRows({
    ...baseArgs(), rows: rows(21), fetchFn: fn,
    nowFn: () => (t += 5000), // 呼ぶたびに 5 秒進む（2 バッチ目で締切超過）
    totalDeadlineMs: 8000,
  });
  assert.ok(calls.length < 3, '締切超過後も送り続けている');
  assert.ok((r.failureReasons[WRITE_FAILURE.DEADLINE_EXCEEDED] || 0) > 0);
  assert.equal(r.attempted, r.written + r.failed);
});

// ── 12. env OFF は write 0（Function 側の gate 契約）──────
test('gate OFF 相当: 行が来なければ 1 バイトも書かない', async () => {
  const { fn, calls } = stubFetch([]);
  const r = await writeLedgerRows({ ...baseArgs(), rows: [], fetchFn: fn });
  assert.equal(calls.length, 0);
  assert.equal(r.written, 0);
});

// ── 13. PII 非保存 ──────────────────────────────────────
test('送信ペイロードに生アドレス・IP・User-Agent・生 URL・token を含めない', async () => {
  const { fn, calls } = stubFetch([ok()]);
  const r = row('pii');
  r.fields.UrlCategory = 'offer';
  r.fields.UrlPath = '/offer';
  await writeLedgerRows({ ...baseArgs(), rows: [r], fetchFn: fn });
  const body = JSON.stringify(calls[0].body);
  for (const needle of ['@', 'useragent', 'User-Agent', '?t=', 'http://', 'https://analytics']) {
    assert.equal(body.includes(needle), false, `送信ペイロードに ${needle} が含まれている`);
  }
  const keys = Object.keys(calls[0].body.records[0].fields);
  for (const banned of ['Email', 'IP', 'IpAddress', 'UserAgent', 'Url', 'RawUrl', 'RawPayload', 'Token']) {
    assert.equal(keys.includes(banned), false, `禁止列 ${banned} を送っている`);
  }
});

test('URL には baseId とテーブル名だけを載せ、API キーは Authorization ヘッダのみ', async () => {
  const { fn, calls } = stubFetch([ok()]);
  await writeLedgerRows({ ...baseArgs(), rows: rows(1), fetchFn: fn });
  assert.equal(calls[0].url.includes('test-key'), false, 'URL に API キーを載せている');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
});

test('chunkRows: 上限を超えるサイズ指定でも 10 件を超えない', () => {
  assert.equal(chunkRows(rows(25), 100).every((c) => c.length <= LEDGER_BATCH_SIZE), true);
  assert.deepEqual(chunkRows(rows(25)).map((c) => c.length), [10, 10, 5]);
  assert.deepEqual(chunkRows([]), []);
});
