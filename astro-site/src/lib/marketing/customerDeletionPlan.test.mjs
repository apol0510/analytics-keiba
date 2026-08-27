/**
 * customerDeletionPlan.test.mjs — **消してよい行だけを消す**
 *   node --test src/lib/marketing/customerDeletionPlan.test.mjs
 *
 * 守る条件:
 *   1. 5 条件すべてを満たしたときだけ消す
 *   2. native / converted / engaged / operator grant / suppressed / ambiguous を**絶対に巻き込まない**
 *   3. 材料（開封・プール・索引）が読めなければ **1 件も消さない**
 *   4. 2 回実行しても安全（already_deleted）／要求を鵜呑みにしない
 *   5. アドレスを持ち回らない（recordId と件数だけ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  planCustomerDeletion, canDeleteCustomers, reconcileDeletionTargets,
  DELETE_BLOCK, DELETE_ABORT, DELETE_GATE, DELETE_CONFIRM, DELETE_MAX_PER_CALL,
} from './customerDeletionPlan.js';
import { PROSPECT_STATE } from './prospectPolicy.js';

const hashOf = (email) => `h:${email}`;
const IMPORT = 'customer-import:imp-2026-08-09-001';

/** 移行対象になる素の行（＝消してよい候補）*/
const rec = (id, email, fields = {}) => ({
  id, fields: { Email: email, Source: IMPORT, ...fields },
});
/** プール側: 移り終わっていて送信候補 */
const pooled = (emails, over = {}) => new Map(
  emails.map((e) => [hashOf(e), { hash: hashOf(e), state: PROSPECT_STATE.SENDING, ...over }]),
);
const activeAll = (emails, val = true) => new Map(emails.map((e) => [hashOf(e), val]));

const run = (records, over = {}) => planCustomerDeletion({
  records,
  engagedEmails: new Set(),
  engagementApplied: true,
  prospectByHash: pooled(records.map((r) => r.fields.Email)),
  activeByHash: activeAll(records.map((r) => r.fields.Email)),
  hashOf,
  ...over,
});

/* ── 1. 消してよい行 ──────────────────────────────────────── */

test('【要件】移行済み・送信候補・索引に居る CSV 由来行だけを消す', () => {
  const records = [rec('rec1', 'a@x.com'), rec('rec2', 'b@x.com')];
  const p = run(records);
  assert.equal(p.ok, true);
  assert.equal(p.checked, 2);
  assert.deepEqual(p.deletableIds, ['rec1', 'rec2']);
  assert.deepEqual(p.blocked, {});
  assert.equal(p.decisions.migrate, 2);
});

test('⚠️ 応答に載るのは recordId だけ（アドレスを持ち回らない）', () => {
  const p = run([rec('rec1', 'secret@x.com')]);
  assert.equal(JSON.stringify(p).includes('secret@x.com'), false, '⚠️ アドレスが混ざっている');
});

/* ── 2. 絶対に巻き込まない相手 ───────────────────────────── */

test('⚠️【要件】取り込み由来でない（native）行は消さない', () => {
  const r = { id: 'recN', fields: { Email: 'n@x.com', Source: 'free-signup' } };
  const p = run([r]);
  assert.deepEqual(p.deletableIds, []);
  assert.equal(p.blocked[DELETE_BLOCK.NOT_MIGRATE], 1);
  assert.equal(p.decisions.keep_not_imported, 1);
});

test('⚠️【要件】本人が動いた（converted）行は消さない', () => {
  const p = run([rec('recC', 'c@x.com', { 'プラン': 'Premium' })]);
  assert.deepEqual(p.deletableIds, []);
  assert.equal(p.decisions.keep_converted, 1);
});

test('⚠️【要件】反応があった（engaged）行は消さない', () => {
  const records = [rec('recE', 'e@x.com')];
  const p = run(records, { engagedEmails: new Set(['e@x.com']) });
  assert.deepEqual(p.deletableIds, []);
  assert.equal(p.decisions.keep_engaged, 1);
});

test('⚠️【要件】配信停止・退会（suppressed）行は消さない', () => {
  for (const f of [
    { UnsubscribedAnalyticsKeiba: true }, { WithdrawalRequested: true },
    { Status: '退会' }, { Status: 'suspended' },
  ]) {
    const p = run([rec('recS', 's@x.com', f)]);
    assert.deepEqual(p.deletableIds, [], `${JSON.stringify(f)} を消そうとしている`);
    assert.equal(p.decisions.keep_suppressed, 1);
  }
});

test('⚠️【要件】運営付与だけ（operator grant）の行は消さない', () => {
  const p = run([rec('recO', 'o@x.com', { PremiumPlusEligibility: 'eligible' })]);
  assert.deepEqual(p.deletableIds, []);
  assert.equal(p.decisions.review_operator_grant, 1);
});

/* ── 3. 移り終わっていない相手 ───────────────────────────── */

test('⚠️【要件】prospect レコードが無ければ消さない（移り終わっていない）', () => {
  const records = [rec('rec1', 'a@x.com')];
  const p = run(records, { prospectByHash: new Map() });
  assert.deepEqual(p.deletableIds, []);
  assert.equal(p.blocked[DELETE_BLOCK.NOT_IN_POOL], 1);
});

test('⚠️【要件】送信できない state なら消さない', () => {
  const records = [rec('rec1', 'a@x.com')];
  for (const state of [PROSPECT_STATE.EXHAUSTED, PROSPECT_STATE.SUPPRESSED, PROSPECT_STATE.PROMOTED]) {
    const p = run(records, { prospectByHash: pooled(['a@x.com'], { state }) });
    assert.deepEqual(p.deletableIds, [], `${state} を消そうとしている`);
    assert.equal(p.blocked[DELETE_BLOCK.NOT_SENDABLE], 1);
  }
});

test('⚠️【要件】索引に居なければ消さない（2026-08-27 の事故と同じ形）', () => {
  const records = [rec('rec1', 'a@x.com')];
  const p = run(records, { activeByHash: activeAll(['a@x.com'], false) });
  assert.deepEqual(p.deletableIds, []);
  assert.equal(p.blocked[DELETE_BLOCK.NOT_IN_ACTIVE_INDEX], 1);
});

test('アドレスが空なら消さない', () => {
  const p = run([{ id: 'recX', fields: { Email: '', Source: IMPORT } }]);
  assert.deepEqual(p.deletableIds, []);
});

/* ── 4. 材料が読めなければ 1 件も消さない ────────────────── */

test('⚠️【要件】開封が読めなければ 1 件も消さない', () => {
  const records = [rec('rec1', 'a@x.com')];
  const p = run(records, { engagementApplied: false });
  assert.equal(p.ok, false);
  assert.equal(p.abort, DELETE_ABORT.ENGAGEMENT_UNAVAILABLE);
  assert.deepEqual(p.deletableIds, []);
});

test('⚠️【要件】プール・索引が読めなければ 1 件も消さない', () => {
  const records = [rec('rec1', 'a@x.com')];
  assert.equal(run(records, { prospectByHash: null }).abort, DELETE_ABORT.POOL_UNAVAILABLE);
  assert.equal(run(records, { activeByHash: null }).abort, DELETE_ABORT.INDEX_UNAVAILABLE);
  assert.deepEqual(run(records, { activeByHash: null }).deletableIds, []);
});

test('⚠️ 引数が無くても例外にせず中止', () => {
  const p = planCustomerDeletion();
  assert.equal(p.ok, false);
  assert.deepEqual(p.deletableIds, []);
});

/* ── 5. 実行のゲート ─────────────────────────────────────── */

test('⚠️【要件】確認文字列・控えの申告が無ければ実行させない', () => {
  const ids = ['rec1'];
  assert.equal(canDeleteCustomers({ confirmed: true, ids, exportProven: true }).allowed, true);
  assert.deepEqual(
    canDeleteCustomers({ confirmed: false, ids, exportProven: true }).reasons,
    [DELETE_GATE.NOT_CONFIRMED],
  );
  assert.deepEqual(
    canDeleteCustomers({ confirmed: true, ids, exportProven: false }).reasons,
    [DELETE_GATE.EXPORT_NOT_PROVEN],
  );
  assert.deepEqual(canDeleteCustomers({ confirmed: true, ids: [], exportProven: true }).reasons,
    [DELETE_GATE.NO_IDS]);
  assert.equal(canDeleteCustomers().allowed, false);
});

test('⚠️ 上限を超えたら実行させない', () => {
  const ids = Array.from({ length: DELETE_MAX_PER_CALL + 1 }, (_, i) => `r${i}`);
  assert.ok(canDeleteCustomers({ confirmed: true, ids, exportProven: true })
    .reasons.includes(DELETE_GATE.TOO_MANY));
});

test('確認文字列は画面から流し込めない値', () => {
  assert.equal(DELETE_CONFIRM, 'DELETE MIGRATED CUSTOMERS');
});

/* ── 6. 冪等性・要求を鵜呑みにしない ─────────────────────── */

test('⚠️【要件】要求された id でも、いま消せない判定なら消さない', () => {
  const t = reconcileDeletionTargets({
    requestedIds: ['a', 'b', 'c'],
    deletableIds: ['a'],
    presentIds: ['a', 'b', 'c'],
  });
  assert.deepEqual(t.toDelete, ['a']);
  assert.deepEqual(t.refused, ['b', 'c'], '⚠️ 状態が変わった行を消そうとしている');
  assert.deepEqual(t.alreadyDeleted, []);
});

test('⚠️【要件】もう存在しない id は already_deleted（2 回実行しても安全）', () => {
  const t = reconcileDeletionTargets({
    requestedIds: ['a', 'gone'], deletableIds: ['a'], presentIds: ['a'],
  });
  assert.deepEqual(t.toDelete, ['a']);
  assert.deepEqual(t.alreadyDeleted, ['gone']);
  assert.deepEqual(t.refused, []);
});

test('2 回目は消すものが無い（全部 already_deleted）', () => {
  const t = reconcileDeletionTargets({
    requestedIds: ['a', 'b'], deletableIds: [], presentIds: [],
  });
  assert.deepEqual(t.toDelete, []);
  assert.deepEqual(t.alreadyDeleted, ['a', 'b']);
});

test('重複した id は 1 回だけ扱う', () => {
  const t = reconcileDeletionTargets({
    requestedIds: ['a', 'a'], deletableIds: ['a'], presentIds: ['a'],
  });
  assert.deepEqual(t.toDelete, ['a']);
});

/* ── 7. guard: Function 側 ───────────────────────────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');
const applySrc = adminSrc.slice(
  adminSrc.indexOf('async function handleCustomerDeletionApply'),
  adminSrc.indexOf('async function handleProspectIndexRepair'),
);

test('⚠️ guard: 削除は単一源の判定を通し、要求を作り直してから消す', () => {
  assert.ok(applySrc.length > 200, 'handler が見つからない');
  assert.match(applySrc, /planCustomerDeletion\(/, '⚠️ 判定を作り直していない');
  assert.match(applySrc, /reconcileDeletionTargets\(/, '⚠️ 要求された id をそのまま消している');
  assert.match(applySrc, /canDeleteCustomers\(/);
  assert.match(applySrc, /const dryRun = !apply;/, '⚠️ 既定が下見になっていない');
});

test('⚠️ guard: 削除ハンドラは prospect / 送信を触らない', () => {
  for (const banned of [
    'addIfAbsent', 'addManyIfAbsent', 'recordSend', 'recordDelivered', 'markDelivered',
    'purge', 'sendgrid', 'enqueue', 'reindexByHash',
  ]) {
    assert.equal(applySrc.includes(banned), false, `⚠️ 削除が別経路を触っている: ${banned}`);
  }
});

test('⚠️ guard: 判定の分類は単一源（decideForRecord）を使い、自前で書き直していない', () => {
  const planSrc = readFileSync(fileURLToPath(
    new URL('./customerDeletionPlan.js', import.meta.url),
  ), 'utf8');
  assert.match(planSrc, /import \{[\s\S]*decideForRecord[\s\S]*\} from '\.\/prospectMigrationPlan\.js'/);
  for (const banned = 'hasSelfConversion(', x = [banned]; x.length; x.pop()) {
    assert.equal(planSrc.includes(banned), false, '⚠️ 除外判定を自前で書き直している');
  }
});

/* ── 8. PII / secret を持ち込んでいない ─────────────────── */

test('⚠️ 追加したコードに実在アドレス・secret を書いていない', () => {
  const files = [
    './customerDeletionPlan.js',
    '../../../scripts/delete-migrated-customers.mjs',
    '../../../scripts/restore-customers-from-export.mjs',
    '../../../scripts/verify-after-customer-deletion.mjs',
  ];
  const allowed = /@(example\.com|x\.com|keiba\.link)/;
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    for (const m of src.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []) {
      assert.match(m, allowed, `⚠️ 実在しそうなアドレスが埋まっている: ${m}`);
    }
    assert.equal(/(pat[A-Za-z0-9]{14,}|SG\.[A-Za-z0-9_-]{20,}|key[A-Za-z0-9]{14,})/.test(src), false,
      `⚠️ secret らしき文字列がある: ${f}`);
  }
});

test('⚠️ 控えはリポジトリの外へ保存する（PII を git に置かない）', () => {
  const src = readFileSync(fileURLToPath(
    new URL('../../../scripts/delete-migrated-customers.mjs', import.meta.url),
  ), 'utf8');
  assert.match(src, /homedir\(\)/, '⚠️ 控えの保存先がリポジトリ内になっている');
  assert.match(src, /mode: 0o600/, '⚠️ 控えファイルの権限を絞っていない');
});
