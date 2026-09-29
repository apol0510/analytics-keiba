/**
 * finalSelectionAudit.guard.test.mjs — 最終監査（2026-09-30・GitHub Actions）が**読むだけ**であることの契約
 *   node --test src/lib/marketing/finalSelectionAudit.guard.test.mjs
 *
 * 守ること:
 *   - 本番 write・list 変更・env 変更・メール送信・再送・予約変更の経路を**持たない**
 *   - 管理 API は許可した read-only action だけ。reconcile に apply / confirm を付けない
 *   - 出力にアドレスを出さない
 *   - ワークフローは read 権限だけ・既存の secret 2 つだけ・2026-09-30（JST）以外は何もしない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  READ_ONLY_ADMIN, SENDGRID_POST_ALLOW, makeClients, assertNoAddress, reconstructWatch0927, judge,
  KNOWN_BASELINE, EXPECTED_SENDS,
} from '../../../scripts/final-selection-audit.mjs';

const SCRIPT = readFileSync(fileURLToPath(new URL('../../../scripts/final-selection-audit.mjs', import.meta.url)), 'utf8');
const WORKFLOW = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/final-selection-audit.yml', import.meta.url)), 'utf8');
const CODE = SCRIPT.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── スクリプト: 書き込み経路を持たない ─────────────────────────────
test('SendGrid の書き込み・送信・予約の経路を持たない', () => {
  for (const bad of ["method: 'PUT'", "method: 'DELETE'", "method: 'PATCH'", '/v3/mail/send', '/schedule', '/suppression',
    '/v3/marketing/singlesends/', "'/v3/marketing/contacts'", '/v3/marketing/lists/']) {
    assert.equal(CODE.includes(bad), false, `${bad} を持っている`);
  }
  assert.deepEqual([...SENDGRID_POST_ALLOW], ['/v3/marketing/contacts/exports']);
});

test('管理 API は read-only の action だけ・apply / confirm を送らない', () => {
  assert.deepEqual(READ_ONLY_ADMIN, {
    'admin-marketing': ['mailOverview', 'prospectSequenceCheck', 'prospectIndexAudit'],
    'admin-sendgrid-migration': ['reconcile'],
  });
  assert.equal(/apply\s*:\s*true/.test(CODE), false);
  assert.equal(/confirm\s*:/.test(CODE), false);
  // env を書き換える・再デプロイする経路を持たない
  for (const bad of ['env:set', 'env:unset', 'build_hooks', 'execSync', 'spawn(']) assert.equal(CODE.includes(bad), false, bad);
});

test('クライアントは許可外の呼び出しを送る前に止める', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => { calls.push([init.method || 'GET', String(url)]); return { ok: true, status: 200, json: async () => ({ sideEffects: 'none', result: [] }) }; };
  const c = makeClients({ SENDGRID_API_KEY: 'k', PREMIUM_PLUS_ADMIN_SECRET: 's' }, fakeFetch);
  await assert.rejects(c.sgGet('/v3/mail/send'), /read_only_violation/);
  await assert.rejects(c.sgPostExport('/v3/marketing/contacts', {}), /read_only_violation/);
  await assert.rejects(c.admin('admin-marketing', { action: 'send' }), /read_only_violation/);
  await assert.rejects(c.admin('admin-sendgrid-migration', { action: 'reconcile', apply: true }), /read_only_violation/);
  await assert.rejects(c.admin('admin-sendgrid-migration', { action: 'import' }), /read_only_violation/);
  assert.equal(calls.length, 0, '止める前に送っている');
  await c.admin('admin-marketing', { action: 'mailOverview' });
  assert.equal(calls.length, 1);
});

test('管理 API が「副作用あり」と答えたら使わずに止める', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ sideEffects: 'sendgrid_lists_only' }) });
  const c = makeClients({ SENDGRID_API_KEY: 'k', PREMIUM_PLUS_ADMIN_SECRET: 's' }, fakeFetch);
  await assert.rejects(c.admin('admin-sendgrid-migration', { action: 'reconcile', scope: 'excluded' }), /not_read_only_response/);
});

test('出力にアドレスが混ざったら止める', () => {
  assert.throws(() => assertNoAddress({ a: 'x@example.com' }), /address_in_output/);
  assert.doesNotThrow(() => assertNoAddress({ a: 1, b: 'ak-prospect-select-start-3' }));
});

// ── ⑦ 2026-09-27 の通知の再構成 ────────────────────────────────
test('⑦ 09-27 の通知は、手動除去後の start-3 m10 で RECIPIENT_GAP が出たと再構成できる', () => {
  // 09-27 19:00 JST の実送信数（本番 read-only 実測）
  const rows = [
    { name: 'AK Prospect Selection s3 m10', sendAt: '2026-09-27T10:00:00Z', requests: 2450, delivered: 2449, bounces: 1, spamReports: 0 },
    { name: 'AK Prospect Selection s2 m09', sendAt: '2026-09-27T10:00:00Z', requests: 2399, delivered: 2398, bounces: 1, spamReports: 0 },
    { name: 'AK Prospect Selection s1 m08', sendAt: '2026-09-27T10:00:00Z', requests: 11, delivered: 11, bounces: 0, spamReports: 0 },
    { name: 'AK Prospect Selection s3 m09', sendAt: '2026-09-26T10:00:00Z', requests: 8361, delivered: 8361, bounces: 0, spamReports: 0 },
    { name: 'AK Prospect Selection s2 m10', sendAt: '2026-09-28T10:00:00Z', requests: 800, delivered: 800, bounces: 0, spamReports: 0 },
  ];
  const r = reconstructWatch0927(rows);
  assert.equal(r.recipientGap.length, 1);
  assert.equal(r.recipientGap[0].name, 'AK Prospect Selection s3 m10');
  assert.equal(r.recipientGap[0].expected, 7252);
  assert.match(r.conclusion, /手動除去/);
});

// ── 異常の判定 ─────────────────────────────────────────────
const okResult = () => ({
  sends: { count: EXPECTED_SENDS, scheduled: 0 },
  excluded: { residue: KNOWN_BASELINE.excludedResidue, unresolved: 0 },
  listMembership: { a: { nowhere: 0 }, b: { nowhere: 0 } },
  activeIndex: { activeNotSendable: KNOWN_BASELINE.activeNotSendable, missing: 0 },
  env: { migrationWriteGate: 'unset' },
  overview: { ok: true },
});

test('既知の値のままなら異常なし・増えたら異常（直さずに記録）', () => {
  assert.deepEqual(judge(okResult()), []);
  const r = okResult(); r.excluded.residue = 5; r.listMembership.a.nowhere = 1; r.activeIndex.activeNotSendable = 3;
  r.sends.scheduled = 1; r.env.migrationWriteGate = 'set';
  const a = judge(r);
  for (const k of ['excluded_residue_5', 'list_members_in_no_index_1', 'active_not_sendable_3', 'sends_not_triggered_1', 'migration_write_gate_set']) {
    assert.ok(a.includes(k), k);
  }
});

// ── ワークフロー ─────────────────────────────────────────────
test('ワークフローは read 権限だけ・既存の secret 2 つだけを使う', () => {
  assert.match(WORKFLOW, /permissions:\n\s+contents: read\n/);
  const secrets = [...WORKFLOW.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID']);
  for (const bad of ['env:set', 'env:unset', 'build_hooks', 'git push', 'gh pr', 'contents: write', 'apply']) {
    assert.equal(WORKFLOW.includes(bad), false, `${bad} を含む`);
  }
});

test('ワークフローは 2026-09-30（JST）以外は何もしない', () => {
  assert.match(WORKFLOW, /cron: '7 23 29 9 \*'/);
  assert.match(WORKFLOW, /today="\$\(TZ=Asia\/Tokyo date \+%F\)"/);
  assert.match(WORKFLOW, /\[ "\$today" = "2026-09-30" \]/);
  // 実行系の step はすべて日付ガードの結果を条件にしている
  const steps = WORKFLOW.split(/\n\s+- (?:name|uses):/).slice(2);
  for (const s of steps) assert.match(s, /if: steps\.guard\.outputs\.run == 'true'/, `ガードなしの step: ${s.slice(0, 40)}`);
});

test('ワークフローはアドレスを含む行を表示しない', () => {
  assert.match(WORKFLOW, /grep -v '@' audit\.stderr/);
  assert.match(WORKFLOW, /grep -q '@' final-selection-audit\.md/);
});
