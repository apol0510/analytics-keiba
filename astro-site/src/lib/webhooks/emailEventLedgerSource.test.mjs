/**
 * emailEventLedgerSource.test.mjs — 台帳を Airtable 経由で読めるかの判定
 *   node --test src/lib/webhooks/emailEventLedgerSource.test.mjs
 *
 * ここで固定するのは **2026-08-28 の誤読**そのもの:
 * `MARKETING_EVENT_SINK=blob` では Airtable は常に 0 行なのに、
 * 「取得成功・0 件」を返していたため画面が「反応が無い」と読めていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveLedgerReadability, describeLedgerSource, LEDGER_SOURCE_REASON,
} from './emailEventLedgerSource.js';

test('blob モードでは Airtable 経由では読めない', () => {
  const r = resolveLedgerReadability({ MARKETING_EVENT_SINK: 'blob' });
  assert.equal(r.readable, false);
  assert.equal(r.reason, LEDGER_SOURCE_REASON.SINK_BLOB);
  assert.equal(r.sinkMode, 'blob');
});

test('airtable / dual / 未設定では読める', () => {
  for (const v of ['airtable', 'dual', undefined, '', 'なにか変な値']) {
    const r = resolveLedgerReadability({ MARKETING_EVENT_SINK: v });
    assert.equal(r.readable, true, `mode=${v}`);
  }
});

test('blob モードでは 0 件を「反応なし」として出さない（available:false / rows:null）', () => {
  const d = describeLedgerSource({
    readable: false, sinkMode: 'blob',
    fetchAvailable: true, rows: 0,           // 取得は成功していても採用しない
    unresolvedTotal: 0, conflictTotal: 0, unattributedAvailable: true,
  });
  assert.equal(d.available, false);
  assert.equal(d.rows, null);
  assert.equal(d.unresolvedTotal, null);
  assert.equal(d.conflictTotal, null);
  assert.equal(d.reason, LEDGER_SOURCE_REASON.SINK_BLOB);
  assert.match(d.note, /Blob/);
  assert.match(d.note, /反応が無かったという意味ではありません/);
  // 「運用開始前だから記録が無い」と読める説明を **blob では出さない**
  assert.equal(/運用開始前/.test(d.note), false);
});

test('airtable モードの 0 件は従来どおり「0 件」として出す', () => {
  const d = describeLedgerSource({
    readable: true, sinkMode: 'airtable',
    fetchAvailable: true, rows: 0,
    unresolvedTotal: 3, conflictTotal: 1, unattributedAvailable: true,
  });
  assert.equal(d.available, true);
  assert.equal(d.rows, 0);
  assert.equal(d.unresolvedTotal, 3);
  assert.equal(d.reason, LEDGER_SOURCE_REASON.OK);
});

test('取得失敗は 0 件ではなく取得不能', () => {
  const d = describeLedgerSource({
    readable: true, sinkMode: 'airtable', fetchAvailable: false, rows: 0,
  });
  assert.equal(d.available, false);
  assert.equal(d.rows, null);
  assert.equal(d.reason, LEDGER_SOURCE_REASON.FETCH_FAILED);
});

test('未確定件数は「引けたときだけ」数値（引けなければ null）', () => {
  const d = describeLedgerSource({
    readable: true, sinkMode: 'airtable', fetchAvailable: true, rows: 2,
    unresolvedTotal: 9, conflictTotal: 4, unattributedAvailable: false,
  });
  assert.equal(d.unresolvedTotal, null);
  assert.equal(d.conflictTotal, null);
});

// ── guard: 呼び出し側が分岐を再実装していないこと ──────────────────
const ADMIN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');

test('guard: カルテは describeLedgerSource / resolveLedgerReadability を使う', () => {
  assert.match(ADMIN, /describeLedgerSource\(\{/);
  assert.match(ADMIN, /const ledgerReadability = resolveLedgerReadability\(process\.env\)/);
});

test('guard: 読めないときは Airtable を引かない（0 行を掴まない）', () => {
  assert.match(ADMIN, /ledgerReadability\.readable\s*\n?\s*\?\s*fetchCustomerLedgerEvents/);
  assert.match(ADMIN, /ledgerReadability\.readable\s*\n?\s*\?\s*fetchLedgerUnattributed/);
});

test('guard: 旧「運用開始前のメールは記録がありません」を無条件に返さない', () => {
  const i = ADMIN.indexOf('ledgerSource:');
  assert.ok(i > 0);
  const around = ADMIN.slice(i, i + 400);
  assert.equal(/運用開始前/.test(around), false);
});
