/**
 * unsubscribeBackfill.test.mjs — 旧 mailto 残件の一括精算を固定する。
 *   node --test src/lib/unsubscribe/unsubscribeBackfill.test.mjs
 *
 * 守りたいこと:
 *   - 同じ入力を 2 回実行しても二重副作用なし（既停止者は変更なし）
 *   - Customers / prospect の双方に対応。片方にしかいない人も正しく停止
 *   - 判定不能は書かない（fail closed）
 *   - 承認した人数と実行時の人数が違えば実行しない
 *   - 生アドレスを戻り値へ出さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  normalizeBackfillInput, classifyBackfillTarget, summarizeBackfillPlan,
  decideBackfillExecution, TARGET_STATUS, INPUT_REJECT, MAX_BACKFILL_TARGETS,
  LEGACY_CUTOFF_ISO,
} from './unsubscribeBackfill.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FN = readFileSync(join(ROOT, 'netlify/functions/admin-unsubscribe-backfill.js'), 'utf8');

const classify = (o) => classifyBackfillTarget(o);

// ── cutoff ──────────────────────────────────────────────────────

test('cutoff は #558 が production へ published された実測時刻（merge 時刻ではない）', () => {
  assert.equal(LEGACY_CUTOFF_ISO, '2026-09-16T14:56:15.220Z');
  assert.notEqual(LEGACY_CUTOFF_ISO, '2026-09-16T14:54:44Z', 'merge 時刻を cutoff にしている');
});

// ── 入力の正規化 ────────────────────────────────────────────────

test('同一アドレスの複数依頼は 1 人に畳む（旧方式の常態）', () => {
  const r = normalizeBackfillInput(['A@Example.test', 'a@example.test', ' a@example.test ']);
  assert.deepEqual(r.emails, ['a@example.test']);
  assert.equal(r.rejected[INPUT_REJECT.DUPLICATE], 2);
  assert.equal(r.received, 3);
});

test('メールでないものは弾く（問い合わせ・迷惑メールの混入を通さない）', () => {
  const r = normalizeBackfillInput(['not-an-email', '', null, undefined, 'a@b', 'ok@example.test']);
  assert.deepEqual(r.emails, ['ok@example.test']);
  assert.equal(r.rejected[INPUT_REJECT.INVALID], 5);
});

test('1 回の上限を超える分は弾く（暴走防止）', () => {
  const many = Array.from({ length: MAX_BACKFILL_TARGETS + 5 }, (_, i) => `u${i}@example.test`);
  const r = normalizeBackfillInput(many);
  assert.equal(r.emails.length, MAX_BACKFILL_TARGETS);
  assert.equal(r.rejected[INPUT_REJECT.OVER_LIMIT], 5);
});

test('戻り値にアドレスを含めない区分がある（rejected は件数だけ）', () => {
  const r = normalizeBackfillInput(['bad']);
  assert.deepEqual(Object.values(r.rejected), [1]);
  assert.ok(!JSON.stringify(r.rejected).includes('bad'));
});

// ── 照合の区分 ──────────────────────────────────────────────────

test('Customers に居て未反映 → 書く', () => {
  const r = classify({ customer: 'found', customerUnsubscribed: false, prospect: 'missing' });
  assert.deepEqual(r.statuses, [TARGET_STATUS.CUSTOMER_PENDING]);
  assert.deepEqual(r.needsWrite, { customer: true, prospect: false });
});

test('【冪等】Customers で既に停止済み → 書かない', () => {
  const r = classify({ customer: 'found', customerUnsubscribed: true, prospect: 'missing' });
  assert.deepEqual(r.statuses, [TARGET_STATUS.CUSTOMER_ALREADY]);
  assert.deepEqual(r.needsWrite, { customer: false, prospect: false });
});

test('見込み客にしか居ない人も正しく停止対象になる', () => {
  const r = classify({ customer: 'missing', prospect: 'found', prospectSuppressed: false });
  assert.deepEqual(r.statuses, [TARGET_STATUS.PROSPECT_PENDING]);
  assert.deepEqual(r.needsWrite, { customer: false, prospect: true });
});

test('【冪等】見込み客で既に抑止済み → 書かない', () => {
  const r = classify({ customer: 'missing', prospect: 'found', prospectSuppressed: true });
  assert.deepEqual(r.needsWrite, { customer: false, prospect: false });
});

test('両方に居る人は、未反映の側だけ書く', () => {
  const r = classify({
    customer: 'found', customerUnsubscribed: true,
    prospect: 'found', prospectSuppressed: false,
  });
  assert.deepEqual(r.statuses.sort(), [TARGET_STATUS.CUSTOMER_ALREADY, TARGET_STATUS.PROSPECT_PENDING].sort());
  assert.deepEqual(r.needsWrite, { customer: false, prospect: true });
});

test('どちらにも居ない → not-found（書かない）', () => {
  const r = classify({ customer: 'missing', prospect: 'missing' });
  assert.deepEqual(r.statuses, [TARGET_STATUS.NOT_FOUND]);
  assert.deepEqual(r.needsWrite, { customer: false, prospect: false });
});

test('【fail closed】片方でも読めなければ書かない', () => {
  for (const o of [
    { customer: 'unknown', prospect: 'found', prospectSuppressed: false },
    { customer: 'found', customerUnsubscribed: false, prospect: 'unknown' },
    { customer: 'unknown', prospect: 'unknown' },
  ]) {
    const r = classify(o);
    assert.ok(r.statuses.includes(TARGET_STATUS.UNKNOWN), '判定不能を unknown にしていない');
    assert.deepEqual(r.needsWrite, { customer: false, prospect: false }, '読めていないのに書こうとしている');
  }
});

// ── 集計 ────────────────────────────────────────────────────────

test('集計が各区分を正しく数える', () => {
  const rows = [
    classify({ customer: 'found', customerUnsubscribed: false, prospect: 'missing' }),   // 顧客のみ・未反映
    classify({ customer: 'found', customerUnsubscribed: true, prospect: 'missing' }),    // 顧客のみ・停止済み
    classify({ customer: 'missing', prospect: 'found', prospectSuppressed: false }),      // 見込みのみ・未反映
    classify({ customer: 'found', customerUnsubscribed: true, prospect: 'found', prospectSuppressed: true }), // 両方・停止済み
    classify({ customer: 'missing', prospect: 'missing' }),                              // どちらにも居ない
    classify({ customer: 'unknown', prospect: 'unknown' }),                              // 判定不能
  ];
  const s = summarizeBackfillPlan(rows);
  assert.equal(s.unique, 6);
  assert.equal(s.needsWrite, 2);
  assert.equal(s.alreadyStopped, 2);
  assert.equal(s.customerOnly, 2);
  assert.equal(s.prospectOnly, 1);
  assert.equal(s.both, 1);
  assert.equal(s.notFound, 1);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.writes, { customer: 1, prospect: 1 });
});

// ── 実行ゲート ──────────────────────────────────────────────────

test('dry-run はいつでも通る（先に件数を確定させる）', () => {
  assert.deepEqual(decideBackfillExecution({ dryRun: true, needsWrite: 3 }), { ok: true, reason: null });
});

test('【重要】承認した人数と実行時の人数が違えば実行しない', () => {
  assert.equal(decideBackfillExecution({ dryRun: false, needsWrite: 5, expectedCount: 4 }).reason,
    'expected-count-mismatch');
  assert.equal(decideBackfillExecution({ dryRun: false, needsWrite: 5 }).reason,
    'expected-count-required');
});

test('書く相手が 0 人なら実行しない', () => {
  assert.equal(decideBackfillExecution({ dryRun: false, needsWrite: 0, expectedCount: 0 }).reason,
    'nothing-to-do');
});

test('人数が一致したときだけ実行できる', () => {
  assert.deepEqual(decideBackfillExecution({ dryRun: false, needsWrite: 5, expectedCount: 5 }),
    { ok: true, reason: null });
});

// ── Function の構造ガード ───────────────────────────────────────

test('停止の書き込みは #558 の正本を再利用する（2 つ目のロジックを作らない）', () => {
  assert.match(FN, /updateUnsubscribeStatus/, 'Customers 側の正本を使っていない');
  assert.match(FN, /suppressProspect/, '見込み客側の正本を使っていない');
  assert.ok(!/UnsubscribedAnalyticsKeiba['"]?\s*:/.test(FN), 'フィールドを自前で書いている');
});

test('専用 secret のみ（他の管理 secret へ fallback しない）', () => {
  assert.match(FN, /process\.env\.UNSUBSCRIBE_BACKFILL_SECRET/);
  for (const other of ['PAYMENT_ADMIN_SECRET', 'PREMIUM_PLUS_ADMIN_SECRET',
    'MARKETING_ADMIN_SECRET', 'PROXY_NOTICE_ADMIN_SECRET']) {
    assert.ok(!new RegExp(`process\\.env\\.${other}`).test(FN), `${other} へ fallback している`);
  }
  const line = FN.split('\n').find((l) => l.includes('const adminSecret'));
  assert.ok(line && !line.includes('||'), 'fallback が残っている');
});

test('既定は dry-run（明示的に false にしたときだけ書く）', () => {
  assert.match(FN, /const dryRun = body\.dryRun !== false/);
});

test('契約・権限・決済フィールドに触れない', () => {
  for (const f of ['プラン', 'PlanType', '有効期限', 'PaidAt', 'PaymentConfirmed',
    'Status', 'LifetimeSanrenpuku', 'WithdrawalRequested']) {
    assert.ok(!new RegExp(`['"\`]${f}['"\`]\\s*:`).test(FN), `${f} を書いている`);
  }
});

test('メールを 1 通も送らない', () => {
  assert.ok(!/sendgrid|SENDGRID|api\.sendgrid\.com|mail\/send/i.test(FN));
});

test('受信箱を読まない（宛先リストは呼び出し側が渡す）', () => {
  assert.ok(!/imap|gmail|googleapis|mailbox/i.test(FN), 'Function が受信箱を読もうとしている');
  assert.match(FN, /normalizeBackfillInput\(body\.emails\)/);
});

test('戻り値に生アドレスを載せない（trace のみ）', () => {
  assert.match(FN, /trace: emailTraceId\(email\)/);
  assert.ok(!/applied\.push\(\{[^}]*email\b/.test(FN), '適用結果に生アドレスを入れている');
  const logs = FN.split('\n').filter((l) => /console\.(log|warn|error)/.test(l));
  for (const l of logs) {
    assert.ok(!/\$\{?\s*(email|r\.email)\b/.test(l), `ログに生アドレス: ${l.trim().slice(0, 80)}`);
  }
});

test('認可より前に Airtable / Redis へ触れない', () => {
  const authAt = FN.indexOf('decideAdminWrite');
  for (const marker of ['readCustomer(', 'readProspect(', 'createProspectStore(']) {
    const at = FN.indexOf(`  const [c, p] = await Promise.all([${marker}`) >= 0
      ? FN.indexOf(`  const [c, p] = await Promise.all([${marker}`)
      : FN.indexOf(`= await ${marker}`);
    if (at === -1) continue;
    assert.ok(at > authAt, `${marker} が認可より前にある`);
  }
});
