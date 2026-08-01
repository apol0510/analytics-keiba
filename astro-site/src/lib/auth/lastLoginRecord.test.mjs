/**
 * lastLoginRecord.test.mjs — ログイン時刻の記録（既存列 `最終ログイン` へ書く）
 *   node --test src/lib/auth/lastLoginRecord.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planLastLoginUpdate,
  assertOnlyLastLoginField,
  recordLastLogin,
  LAST_LOGIN_FIELD,
  MIN_UPDATE_INTERVAL_MS,
  LAST_LOGIN_SKIP,
} from './lastLoginRecord.js';
import { resolveMembership, MEMBER_TYPE } from './memberResolution.js';
import { decideFreeLogin, FREE_LOGIN_OUTCOME } from './authPolicies.js';

const NOW = Date.parse('2026-08-01T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** Airtable の update を模した記録係（呼ばれた fields を全部ためる） */
function spy(impl) {
  const calls = [];
  const fn = async (fields) => {
    calls.push(fields);
    if (typeof impl === 'function') return impl(fields);
    return { ok: true };
  };
  fn.calls = calls;
  return fn;
}

// =========================================================================
// 書き込み先は既存列 `最終ログイン`
// =========================================================================

test('書き込み先は既存列「最終ログイン」（LastLoginAt は新設しない）', () => {
  assert.equal(LAST_LOGIN_FIELD, '最終ログイン');
});

test('記録が無ければ書く（サーバー時刻を ISO dateTime で）', () => {
  const r = planLastLoginUpdate({ fields: {}, nowMs: NOW });
  assert.equal(r.update, true);
  assert.deepEqual(Object.keys(r.fields), [LAST_LOGIN_FIELD]);
  assert.equal(r.fields[LAST_LOGIN_FIELD], iso(NOW));
  assert.match(r.fields[LAST_LOGIN_FIELD], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('#10 既存値が新しければ上書きしない（throttle 6 時間）', () => {
  const recent = planLastLoginUpdate({ fields: { [LAST_LOGIN_FIELD]: iso(NOW - 60 * 1000) }, nowMs: NOW });
  assert.equal(recent.update, false);
  assert.equal(recent.reason, LAST_LOGIN_SKIP.RECENTLY_UPDATED);

  const old = planLastLoginUpdate({
    fields: { [LAST_LOGIN_FIELD]: iso(NOW - MIN_UPDATE_INTERVAL_MS - 1000) }, nowMs: NOW,
  });
  assert.equal(old.update, true);
});

test('未来日時（不正データ）は上書きして正常化する', () => {
  const r = planLastLoginUpdate({ fields: { [LAST_LOGIN_FIELD]: iso(NOW + 365 * DAY) }, nowMs: NOW });
  assert.equal(r.update, true, '未来日時が残ると永久に更新されない');
  assert.equal(r.fields[LAST_LOGIN_FIELD], iso(NOW));
});

test('壊れた値・空値は無視して書く', () => {
  for (const bad of ['', '   ', 'not-a-date', null, undefined]) {
    assert.equal(planLastLoginUpdate({ fields: { [LAST_LOGIN_FIELD]: bad }, nowMs: NOW }).update, true);
  }
});

test('now が不正なら書かない（fail closed）', () => {
  assert.equal(planLastLoginUpdate({ fields: {}, nowMs: NaN }).update, false);
  assert.equal(planLastLoginUpdate({ fields: {} }).update, false);
});

test('#9 書き込み対象は「最終ログイン」1 列だけ', () => {
  assert.equal(assertOnlyLastLoginField({ [LAST_LOGIN_FIELD]: iso(NOW) }), true);
  // 契約・課金・特典の列が混ざったら弾く
  for (const bad of [
    { [LAST_LOGIN_FIELD]: iso(NOW), 'プラン': 'Premium' },
    { [LAST_LOGIN_FIELD]: iso(NOW), PaymentConfirmed: true },
    { [LAST_LOGIN_FIELD]: iso(NOW), LightGrantUntil: iso(NOW) },
    { '有効期限': '2027-01-01' },
    { '最終ポイント付与日': '2026-08-01' },
    {},
  ]) {
    assert.equal(assertOnlyLastLoginField(bad), false, `${JSON.stringify(bad)} を通している`);
  }
});

// =========================================================================
// recordLastLogin（I/O 注入）
// =========================================================================

test('#1 記録は「最終ログイン」だけを渡す（他フィールドを検知したら fail）', async () => {
  const update = spy();
  const r = await recordLastLogin({ update, fields: {}, nowMs: NOW });
  assert.equal(r.written, true);
  assert.equal(update.calls.length, 1);
  assert.deepEqual(Object.keys(update.calls[0]), [LAST_LOGIN_FIELD]);
  const forbidden = ['プラン', 'PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
    'PaymentEmailSent', 'LightGrantUntil', 'PremiumGrantUntil', 'LifetimeSanrenpuku', '最終ポイント付与日'];
  for (const k of forbidden) assert.equal(k in update.calls[0], false, `${k} を書いている`);
});

test('#8 書き込み失敗でも例外を投げない（ログインは成立させる）', async () => {
  const update = spy(() => { throw new Error('UNKNOWN_FIELD_NAME: 最終ログイン'); });
  const r = await recordLastLogin({ update, fields: {}, nowMs: NOW });
  assert.equal(r.written, false);
  assert.equal(r.reason, LAST_LOGIN_SKIP.WRITE_FAILED);
  assert.match(r.error, /UNKNOWN_FIELD_NAME/);
});

test('#12 列が無い環境でも認証は失敗しない（例外が外へ出ない）', async () => {
  const update = spy(() => Promise.reject(new Error('422 Unprocessable Entity')));
  await assert.doesNotReject(() => recordLastLogin({ update, fields: {}, nowMs: NOW }));
});

test('throttle 中は update を呼ばない（Airtable への書き込み自体が起きない）', async () => {
  const update = spy();
  const r = await recordLastLogin({ update, fields: { [LAST_LOGIN_FIELD]: iso(NOW - 60 * 1000) }, nowMs: NOW });
  assert.equal(r.written, false);
  assert.equal(r.reason, LAST_LOGIN_SKIP.RECENTLY_UPDATED);
  assert.equal(update.calls.length, 0);
});

test('update が渡されなければ何もしない', async () => {
  const r = await recordLastLogin({ fields: {}, nowMs: NOW });
  assert.equal(r.written, false);
  assert.equal(r.reason, LAST_LOGIN_SKIP.NO_TARGET);
});

// =========================================================================
// 記録してよいログイン結果か（呼び出し側の分岐と突き合わせる）
// =========================================================================

const member = (fields) => resolveMembership({ fields, recordId: 'recX', now: NOW });

test('#2 期限切れの無料ログインは記録対象', () => {
  const m = member({ 'プラン': 'Premium', Status: 'active', '有効期限': '2026-04-19' });
  assert.equal(decideFreeLogin(m).outcome, FREE_LOGIN_OUTCOME.FREE, '無料ログインが成立しない');
});

test('#3 退会申請の無料ログインは記録対象', () => {
  const m = member({ 'プラン': 'Premium', Status: 'active', WithdrawalRequested: true });
  assert.equal(decideFreeLogin(m).outcome, FREE_LOGIN_OUTCOME.FREE);
});

test('#4 有料会員は無料経路では記録しない（マジックリンク検証成功時に記録する）', () => {
  const m = member({ 'プラン': 'Premium', Status: 'active', '有効期限': '2099-01-01' });
  assert.equal(m.memberType, MEMBER_TYPE.PAID);
  assert.equal(decideFreeLogin(m).outcome, FREE_LOGIN_OUTCOME.REQUIRES_MAGIC_LINK,
    '有料が無料経路で即ログインになっている');
});

test('#5 認証できない状態（停止・強制ログアウト・判定不能）は記録対象にならない', () => {
  for (const bad of [
    { 'プラン': 'Premium', Status: 'suspended' },
    { 'プラン': 'Premium', ForceLogout: true },
    { 'プラン': 'Test', Status: 'active' },
  ]) {
    assert.equal(decideFreeLogin(member(bad)).outcome, FREE_LOGIN_OUTCOME.DENIED);
  }
});
