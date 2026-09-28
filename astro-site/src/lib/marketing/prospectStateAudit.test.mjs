/**
 * prospectStateAudit.test.mjs — 全レコード監査（state × 索引 × 抑止台帳）の判定と、読み取り専用であることを固定する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyProspectConsistency, FINDING, FINDING_SEVERITY, SEVERITY, isAnomaly,
  createStateAuditReader, auditStateWindow, createStateAuditAccumulator, AUDIT_SOURCE, READ_ONLY_OPS,
} from './prospectStateAudit.js';
import {
  ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX, prospectKey, blockedKey,
} from './prospectStore.js';

const H = (c) => c.repeat(64);
const rec = (o) => JSON.stringify({ email: 'x@example.com', sends: 1, delivered: 1, opens: 0, ...o });
const led = (kind) => JSON.stringify({ hash: 'h', kind, reason: 'r', at: '2026-09-27T00:00:00Z' });
const ok = (input) => classifyProspectConsistency(input, { env: {} });

test('正常形はどれも異常 0', () => {
  assert.deepEqual(ok({ recordRaw: rec({ state: 'SENDING' }), inActive: true }).codes, []);
  assert.deepEqual(ok({ recordRaw: rec({ state: 'NEW', delivered: 0 }), inActive: true }).codes, []);
  assert.deepEqual(ok({ recordRaw: rec({ state: 'ENGAGED', opens: 1 }), inEngaged: true }).codes, []);
  assert.deepEqual(ok({ recordRaw: rec({ state: 'PROMOTED', opens: 1 }) }).codes, []);
  assert.deepEqual(ok({ recordRaw: rec({ state: 'EXHAUSTED', delivered: 10 }), ledgerRaw: led('exhausted'), inBlocked: true }).codes, []);
  assert.deepEqual(ok({ recordRaw: rec({ state: 'SUPPRESSED' }), ledgerRaw: led('suppressed'), inBlocked: true }).codes, []);
  // purge 済み（台帳だけ残る）
  assert.deepEqual(ok({ recordRaw: null, ledgerRaw: led('exhausted'), inBlocked: true }).codes, []);
});

test('死角の本体: EXHAUSTED なのに台帳が無い（どの索引にも居ない）を critical で拾う', () => {
  const r = ok({ recordRaw: rec({ state: 'EXHAUSTED', delivered: 10 }) });
  assert.ok(r.codes.includes(FINDING.BLOCK_STATE_WITHOUT_LEDGER));
  assert.ok(r.codes.includes(FINDING.BLOCK_STATE_NOT_IN_BLOCKED_INDEX));
  assert.equal(FINDING_SEVERITY[FINDING.BLOCK_STATE_WITHOUT_LEDGER], SEVERITY.CRITICAL);
});

test('送信候補の state のまま delivered 10・開封 0 → 打ち切り漏れ（critical）', () => {
  const r = ok({ recordRaw: rec({ state: 'SENDING', delivered: 10, opens: 0, clicks: 0 }), inActive: true });
  assert.deepEqual(r.codes, [FINDING.CUTOFF_REACHED_BUT_SENDABLE]);
  // 9 通なら正常
  assert.deepEqual(ok({ recordRaw: rec({ state: 'SENDING', delivered: 9 }), inActive: true }).codes, []);
});

test('送信候補の state なのに台帳がある / 送信候補索引に居ない', () => {
  assert.ok(ok({ recordRaw: rec({ state: 'SENDING' }), ledgerRaw: led('suppressed'), inActive: true, inBlocked: true })
    .codes.includes(FINDING.SENDABLE_WITH_LEDGER));
  assert.deepEqual(ok({ recordRaw: rec({ state: 'SENDING' }) }).codes, [FINDING.SENDABLE_NOT_IN_ACTIVE]);
});

test('索引の食い違い', () => {
  assert.ok(ok({ recordRaw: rec({ state: 'EXHAUSTED', delivered: 10 }), ledgerRaw: led('exhausted'), inBlocked: true, inActive: true })
    .codes.includes(FINDING.NOT_SENDABLE_IN_ACTIVE));
  assert.deepEqual(ok({ recordRaw: rec({ state: 'ENGAGED', opens: 1 }) }).codes, [FINDING.ENGAGED_NOT_IN_ENGAGED_INDEX]);
  assert.ok(ok({ recordRaw: rec({ state: 'PROMOTED' }), inEngaged: true }).codes.includes(FINDING.NOT_ENGAGED_IN_ENGAGED_INDEX));
  assert.deepEqual(ok({ recordRaw: null, ledgerRaw: led('exhausted') }).codes, [FINDING.LEDGER_NOT_IN_BLOCKED_INDEX]);
  assert.deepEqual(ok({ recordRaw: null, inBlocked: true }).codes, [FINDING.BLOCKED_INDEX_WITHOUT_LEDGER]);
  assert.deepEqual(ok({ recordRaw: null, inActive: true }).codes, [FINDING.NO_RECORD_IN_ACTIVE]);
  assert.deepEqual(ok({ recordRaw: null, inEngaged: true }).codes, [FINDING.NO_RECORD_IN_ENGAGED]);
});

test('台帳 kind の食い違い / 遅れた反応は info / 苦情後の反応は critical', () => {
  assert.deepEqual(
    ok({ recordRaw: rec({ state: 'SUPPRESSED' }), ledgerRaw: led('exhausted'), inBlocked: true }).codes,
    [FINDING.LEDGER_KIND_MISMATCH],
  );
  const late = ok({ recordRaw: rec({ state: 'ENGAGED', opens: 1, delivered: 10 }), ledgerRaw: led('exhausted'), inEngaged: true, inBlocked: true });
  assert.deepEqual(late.codes, [FINDING.LATE_REACTION]);
  assert.equal(isAnomaly(late.codes), false);
  assert.deepEqual(
    ok({ recordRaw: rec({ state: 'PROMOTED' }), ledgerRaw: led('suppressed'), inBlocked: true }).codes,
    [FINDING.REACTED_AFTER_SUPPRESSION],
  );
});

test('壊れた値・不明な state', () => {
  assert.ok(ok({ recordRaw: '{oops' }).codes.includes(FINDING.RECORD_CORRUPT));
  assert.ok(ok({ recordRaw: null, ledgerRaw: 'x', inBlocked: true }).codes.includes(FINDING.LEDGER_CORRUPT));
  assert.deepEqual(ok({ recordRaw: rec({ state: 'WEIRD' }) }).codes, [FINDING.UNKNOWN_STATE]);
});

test('返す record に email を含めない', () => {
  const r = ok({ recordRaw: rec({ state: 'EXHAUSTED', delivered: 10 }) });
  assert.equal(JSON.stringify(r).includes('@'), false);
});

// ── 偽 Redis（読み取りコマンドだけ実装。書き込みが来たら落とす）
function fakeRedis({ strings = {}, sets = {} } = {}, { pageSize = 2 } = {}) {
  const S = new Map(Object.entries(strings));
  const T = new Map(Object.entries(sets).map(([k, v]) => [k, new Set(v)]));
  const log = [];
  const cmd = async (a) => {
    log.push(a);
    const op = a[0];
    if (op === 'SCAN') {
      const pat = a[a.indexOf('MATCH') + 1].replace(/\*$/, '');
      const all = [...S.keys(), ...T.keys()].filter((k) => k.startsWith(pat)).sort();
      const at = Number(a[1]);
      const next = at + pageSize >= all.length ? '0' : String(at + pageSize);
      return [next, all.slice(at, at + pageSize)];
    }
    if (op === 'SSCAN') {
      const all = [...(T.get(a[1]) || [])].sort();
      const at = Number(a[2]);
      const next = at + pageSize >= all.length ? '0' : String(at + pageSize);
      return [next, all.slice(at, at + pageSize)];
    }
    if (op === 'MGET') return a.slice(1).map((k) => (S.has(k) ? S.get(k) : null));
    if (op === 'SMISMEMBER') return a.slice(2).map((m) => ((T.get(a[1]) || new Set()).has(m) ? 1 : 0));
    throw new Error(`write_or_unknown:${op}`);
  };
  const pipeline = async (list) => Promise.all(list.map(cmd));
  return { cmd, pipeline, log, S, T };
}

test('読み取り専用: 書き込み系・名前空間外は送る前に弾く', async () => {
  const r = fakeRedis();
  const reader = createStateAuditReader(r);
  assert.deepEqual([...READ_ONLY_OPS].sort(), ['MGET', 'SCAN', 'SMISMEMBER', 'SSCAN']);
  await assert.rejects(() => reader.window({ source: 'bogus' }), /unknown_source/);
  // 内部の check を経由させるため、名前空間外の MGET を inspect 経由では作れないことも確認
  const src = readFileSync(fileURLToPath(new URL('./prospectStateAudit.js', import.meta.url)), 'utf8');
  for (const w of ["'SET'", "'SADD'", "'SREM'", "'DEL'", "'EVAL'", "'EXPIRE'"]) {
    assert.equal(src.includes(w), false, `${w} が source にある`);
  }
  assert.equal(r.log.length, 0);
});

test('全窓を回すと、list にも送信候補索引にも居ないレコードを数えられる', async () => {
  const a = H('a'); const b = H('b'); const c = H('c'); const d = H('d'); const e = H('e');
  const r = fakeRedis({
    strings: {
      [prospectKey(a)]: rec({ state: 'SENDING' }),                     // 正常
      [prospectKey(b)]: rec({ state: 'EXHAUSTED', delivered: 10 }),    // ⚠️ 台帳なし・どこにも居ない
      [prospectKey(c)]: rec({ state: 'SUPPRESSED' }),                  // 正常
      [blockedKey(c)]: led('suppressed'),
      [blockedKey(d)]: led('exhausted'),                               // purge 済み・正常
      'ak:prospect:stats': '{}',
    },
    sets: {
      [ACTIVE_INDEX]: [a, e],                                           // e: レコード無しで送信候補索引にだけ居る
      [ENGAGED_INDEX]: [],
      [BLOCKED_INDEX]: [c, d],
    },
  });
  const reader = createStateAuditReader(r);
  const acc = createStateAuditAccumulator();
  for (const source of Object.values(AUDIT_SOURCE)) {
    let cursor = '0';
    do {
      // eslint-disable-next-line no-await-in-loop
      const w = await auditStateWindow(reader, { source, cursor, env: {} });
      acc.add(source, w);
      cursor = w.cursor;
    } while (cursor !== '0');
  }
  const s = acc.summary();
  assert.equal(s.universe, 5);
  assert.equal(s.records, 3);
  assert.equal(s.ledgers, 2);
  assert.equal(s.ledgerOnly, 1);
  assert.deepEqual(s.stateCounts, { SENDING: 1, EXHAUSTED: 1, SUPPRESSED: 1 });
  const byHash = new Map(s.findings.map((f) => [f.hash, f]));
  assert.deepEqual(byHash.get(b).codes.sort(),
    [FINDING.BLOCK_STATE_NOT_IN_BLOCKED_INDEX, FINDING.BLOCK_STATE_WITHOUT_LEDGER].sort());
  assert.equal(byHash.get(b).severity, SEVERITY.CRITICAL);
  assert.deepEqual(byHash.get(e).codes, [FINDING.NO_RECORD_IN_ACTIVE]);
  assert.equal(s.findings.length, 2);
  assert.equal(s.bySeverity.critical, 1);
  assert.equal(s.bySeverity.integrity, 1);
  // 書き込みコマンドは 1 つも出ていない
  assert.ok(r.log.every((x) => READ_ONLY_OPS.includes(x[0])));
  assert.equal(JSON.stringify(s).includes('@'), false);
});

test('読み直しで消えたズレ（書き込み途中を読んだ）は異常に数えない', async () => {
  const b = H('b');
  const r = fakeRedis({ strings: { [prospectKey(b)]: rec({ state: 'EXHAUSTED', delivered: 10 }) } });
  let inspects = 0;
  const reader = createStateAuditReader(r);
  const orig = reader.inspect;
  reader.inspect = async (hs) => {
    inspects += 1;
    if (inspects === 2) { // 2 回目の読みの前に webhook が台帳まで書き終えた
      r.S.set(blockedKey(b), led('exhausted'));
      r.T.set(BLOCKED_INDEX, new Set([b]));
    }
    return orig(hs);
  };
  const w = await auditStateWindow(reader, { source: 'keys', cursor: '0', env: {} });
  assert.equal(w.findings.length, 0);
  assert.equal(w.transient, 1);
});

test('SCAN が同じ鍵を 2 回返しても 2 人に数えない', () => {
  const acc = createStateAuditAccumulator();
  const h = H('f');
  const win = {
    seen: { records: [h], ledgers: [], members: [] }, states: [[h, 'SENDING']], findings: [], transient: 0,
  };
  acc.add('keys', win); acc.add('keys', win);
  assert.equal(acc.summary().records, 1);
});

test('管理 API に配線され、スクリプトは read-only の action しか叩かない', () => {
  const fn = readFileSync(fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');
  assert.match(fn, /action === 'prospectStateAudit'\) return await handleProspectStateAudit/);
  const body = fn.slice(fn.indexOf('async function handleProspectStateAudit'), fn.indexOf('async function handleProspectSequenceCheck'));
  assert.match(body, /createStateAuditReader/);
  assert.equal(/createProspectStore|casMany|\.purge\(|reindexByHash/.test(body), false, '書き込み可能な store を使っていない');
  const script = readFileSync(fileURLToPath(new URL('../../../scripts/audit-prospect-state.mjs', import.meta.url)), 'utf8');
  const m = script.match(/READ_ONLY_ADMIN_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  assert.deepEqual(m[1].split(',').map((x) => x.replace(/['"\s]/g, '')).filter(Boolean), ['prospectStateAudit']);
  assert.match(script, /process\.exit\(3\)/);
  assert.match(script, /読み切れなかった/);
});
