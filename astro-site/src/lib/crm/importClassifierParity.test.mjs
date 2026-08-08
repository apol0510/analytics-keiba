/**
 * importClassifierParity.test.mjs — 新旧分類器の判定差が 0 件であることを固定する
 *   node --test src/lib/crm/importClassifierParity.test.mjs
 *
 * 経緯（2026-08-09）:
 *   本実行に使う新分類器 `classifyCreateRow` に **role_address 除外が無く**、
 *   旧経路 `customerImport.js` なら人が見るはずの共用アドレス（info@ 等）を
 *   そのまま CREATE していた。本番 plan で CREATE が旧より **+7** 多く出て発覚。
 *
 *   ここでは「同じ入力を新旧に流して **CREATE 集合が完全一致**すること」を固定する。
 *   個別アドレスを場当たりで除外するのではなく、判定関数と順序を揃えることで一致させる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCreateRow, summarizeImportPlan, SKIP_REASON } from './importEligibility.js';
import { buildImportPreview, isRoleAddress } from './customerImport.js';

/** 旧経路へ 1 行だけ流し、CREATE（新規追加）と判定されたかを返す */
function oldIsCreate(email, ak = {}) {
  const p = buildImportPreview({
    rows: [{ email, name: 'N' }],
    batchId: 'imp-parity',
    existingEmails: new Set(ak.existing || []),
    duplicateInAk: new Set(ak.duplicateInAk || []),
    paidEmails: new Set(ak.paid || []),
    unsubscribedEmails: new Set(ak.unsubscribed || []),
    blacklistEmails: new Set([]),
    hardBounceEmails: new Set(ak.hardBounce || []),
    softBounceEmails: new Set(ak.softBounce || []),
    spamEmails: new Set([]),
    testEmails: new Set(ak.testAccounts || []),
    suspendedEmails: new Set(ak.suspended || []),
    ambiguousEmails: new Set([]),
    providerSuppressed: new Set(ak.provider || []),
  });
  return p['新規追加'] === 1;
}

/** 旧経路の理由コード（1 行入力なので 1 件だけ返る） */
function oldReason(email, ak = {}) {
  const p = buildImportPreview({
    rows: [{ email, name: 'N' }], batchId: 'imp-parity',
    existingEmails: new Set(ak.existing || []), duplicateInAk: new Set(ak.duplicateInAk || []),
    paidEmails: new Set(ak.paid || []), unsubscribedEmails: new Set(ak.unsubscribed || []),
    blacklistEmails: new Set([]), hardBounceEmails: new Set(ak.hardBounce || []),
    softBounceEmails: new Set(ak.softBounce || []), spamEmails: new Set([]),
    testEmails: new Set(ak.testAccounts || []), suspendedEmails: new Set(ak.suspended || []),
    ambiguousEmails: new Set([]), providerSuppressed: new Set(ak.provider || []),
  });
  return Object.keys(p['理由別'] || {})[0] || null;
}

const facts = (o = {}) => ({
  existing: new Set(o.existing || []),
  unsubscribed: new Set(o.unsubscribed || []),
  hardBounce: new Set(o.hardBounce || []),
  softBounce: new Set(o.softBounce || []),
  suspended: new Set(o.suspended || []),
  testAccounts: new Set(o.testAccounts || []),
  paid: new Set(o.paid || []),
  duplicateInAk: new Set(o.duplicateInAk || []),
});

// ── 1. role アドレスは単一源を共有する ────────────────────────
test('role アドレス判定は旧経路の isRoleAddress をそのまま使う（再実装しない）', () => {
  for (const local of ['info', 'support', 'contact', 'admin', 'sales', 'help', 'office',
    'noreply', 'no-reply', 'postmaster', 'webmaster', 'abuse']) {
    const e = `${local}@example.com`;
    assert.equal(isRoleAddress(e), true, `${e} が role 判定されない`);
    const v = classifyCreateRow({ entry: { email: e }, facts: facts(), providerEmails: new Set() });
    assert.equal(v.ok, false, `${e} を CREATE 対象にしている`);
    assert.equal(v.reason, SKIP_REASON.ROLE_ADDRESS);
  }
});

test('個人アドレスは role 扱いしない（過剰除外しない）', () => {
  for (const e of ['taro@example.com', 'info.taro@example.com', 'admin2@example.com']) {
    const v = classifyCreateRow({ entry: { email: e }, facts: facts(), providerEmails: new Set() });
    assert.equal(v.ok, true, `${e} を誤って除外している`);
  }
});

// ── 2. 判定順序が旧と一致する ─────────────────────────────────
test('role かつ test のアドレスは role_address が勝つ（旧と同じ順序）', () => {
  const e = 'info@example.com';
  const v = classifyCreateRow({
    entry: { email: e }, facts: facts({ testAccounts: [e] }), providerEmails: new Set(),
  });
  assert.equal(v.reason, SKIP_REASON.ROLE_ADDRESS,
    '順序が旧と違う（test_account が先に立っている）');
  // 旧経路も同じ理由コードを返すこと
  assert.equal(oldReason(e, { testAccounts: [e] }), 'role_address',
    '旧経路の理由と一致しない');
});

test('理由コードが新旧で一致する（主要 7 種）', () => {
  const cases = [
    ['unsub@example.com', { unsubscribed: ['unsub@example.com'] }, 'unsubscribed'],
    ['hard@example.com', { hardBounce: ['hard@example.com'] }, 'hard_bounce'],
    ['soft@example.com', { softBounce: ['soft@example.com'] }, 'soft_bounce'],
    ['susp@example.com', { suspended: ['susp@example.com'] }, 'suspended'],
    ['test@example.com', { testAccounts: ['test@example.com'] }, 'test_account'],
    ['dupak@example.com', { duplicateInAk: ['dupak@example.com'] }, 'duplicate_in_ak'],
    ['info@example.com', {}, 'role_address'],
  ];
  for (const [email, ak, expected] of cases) {
    const nv = classifyCreateRow({ entry: { email }, facts: facts(ak), providerEmails: new Set() });
    assert.equal(nv.reason, expected, `新: ${email} の理由が ${nv.reason}`);
    assert.equal(oldReason(email, ak), expected, `旧: ${email} の理由が違う`);
  }
});

// ── 3. CREATE 集合の全件一致 ─────────────────────────────────
test('同じ入力で新旧の CREATE 集合が完全一致する', () => {
  const ak = {
    existing: ['exist@example.com'],
    unsubscribed: ['unsub@example.com'],
    hardBounce: ['hard@example.com'],
    softBounce: ['soft@example.com'],
    suspended: ['susp@example.com'],
    testAccounts: ['test@example.com', 'info@example.com'],
    paid: ['paid@example.com'],
    duplicateInAk: ['dupak@example.com'],
    provider: ['sup@example.com'],
  };
  const emails = [
    'new1@example.com', 'new2@example.com',
    'exist@example.com', 'unsub@example.com', 'hard@example.com', 'soft@example.com',
    'susp@example.com', 'test@example.com', 'paid@example.com', 'dupak@example.com',
    'sup@example.com',
    'info@example.com', 'support@example.com', 'noreply@example.com',
  ];

  const f = facts(ak);
  const provider = new Set(ak.provider);

  const newCreate = new Set(
    emails.filter((e) => classifyCreateRow({ entry: { email: e }, facts: f, providerEmails: provider }).ok),
  );

  const oldCreate = new Set(emails.filter((e) => oldIsCreate(e, ak)));

  const onlyNew = [...newCreate].filter((e) => !oldCreate.has(e));
  const onlyOld = [...oldCreate].filter((e) => !newCreate.has(e));
  assert.deepEqual(onlyNew, [], `新だけが CREATE にしている: ${onlyNew.join(', ')}`);
  assert.deepEqual(onlyOld, [], `旧だけが CREATE にしている: ${onlyOld.join(', ')}`);
});

// ── 4. 集計の verdict 割り当てが旧と一致する ──────────────────
test('REVIEW_REQUIRED は flagged / role_address / duplicate_in_ak（旧と同じ）', () => {
  const entries = [
    { email: 'a@example.com', flags: ['要確認'] },
    { email: 'info@example.com' },
    { email: 'dupak@example.com' },
    { email: 'paid@example.com' },
    { email: 'ok@example.com' },
  ];
  const s = summarizeImportPlan({
    entries, facts: facts({ duplicateInAk: ['dupak@example.com'], paid: ['paid@example.com'] }),
    providerEmails: new Set(),
  });
  assert.equal(s.reviewRequired, 3, 'REVIEW の割り当てが旧と違う');
  assert.equal(s.excluded, 1, 'EXCLUDED の割り当てが旧と違う');
  assert.equal(s.create, 1);
  assert.equal(s.create + s.existing + s.excluded + s.reviewRequired, s.total);
});

test('role_address を追加しても内訳の合計は崩れない', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ email: `u${i}@example.com` }))
    .concat([{ email: 'info@example.com' }, { email: 'admin@example.com' }]);
  const s = summarizeImportPlan({ entries, facts: facts(), providerEmails: new Set() });
  assert.equal(s.total, 52);
  assert.equal(s.create, 50);
  assert.equal(s.reviewRequired, 2);
  assert.equal(s.create + s.existing + s.excluded + s.reviewRequired, s.total);
});
