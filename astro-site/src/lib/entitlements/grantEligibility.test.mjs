/**
 * grantEligibility.test.mjs — 「今回の無料付与」＝ この操作を実行できるか
 *
 * 現在状態・履歴と**別項目**であること、理由が dry-run と同じ言葉であることを固定する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRANT_ELIGIBILITY, GRANT_ELIGIBILITY_LABEL, GRANT_ELIGIBILITY_NOTE, GRANT_REASON,
  resolveGrantEligibility, formatGrantEligibility, matchesGrantEligibility,
  GRANT_ELIGIBILITY_OPTIONS,
} from './grantEligibility.js';
import { CB_SKIP, CB_SKIP_LABEL } from '../comeback/comebackGrantPlan.js';
import { resolveCurrentFreeGrant, resolveFreeGrantHistory, FREE_GRANT_NOW } from './freeGrantStatus.js';

const NOW = Date.parse('2026-08-03T12:00:00+09:00');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ok = { Email: 'a@example.com', 'プラン': 'Free', Status: 'none' };
const el = (fields) => resolveGrantEligibility(fields, NOW);

test('選択肢は「今回付与できる / 現在の状態では付与できない / 要確認」', () => {
  assert.deepEqual(GRANT_ELIGIBILITY_OPTIONS.map((o) => o.label),
    ['今回付与できる', '現在の状態では付与できない', '要確認']);
  assert.equal(GRANT_ELIGIBILITY_LABEL[GRANT_ELIGIBILITY.GRANTABLE], '今回付与できる');
  assert.match(GRANT_ELIGIBILITY_NOTE, /この操作を実行できるかを示します/);
});

test('通常の顧客は今回付与できる', () => {
  const e = el(ok);
  assert.equal(e.canGrant, true);
  assert.equal(e.status, GRANT_ELIGIBILITY.GRANTABLE);
  assert.equal(formatGrantEligibility(e), '付与可能');
});

test('付与不可の理由が出る（停止・退会・データ不備）', () => {
  const cases = [
    [{ ...ok, Status: 'suspended' }, CB_SKIP.ACCOUNT_SUSPENDED, /アカウント停止/],
    [{ ...ok, WithdrawalRequested: true }, CB_SKIP.WITHDRAWAL_BLOCKED, /退会/],
    [{ ...ok, Email: '' }, CB_SKIP.DATA_INCOMPLETE, /メールアドレス/],
  ];
  for (const [fields, code, re] of cases) {
    const e = el(fields);
    assert.equal(e.status, GRANT_ELIGIBILITY.BLOCKED, JSON.stringify(fields));
    assert.equal(e.reasonCode, code, '理由コードが dry-run と違う');
    assert.match(e.reasonLabel, /^付与不可：/, '「付与不可」と理由を出していない');
    assert.match(e.reasonLabel, re);
    assert.equal(formatGrantEligibility(e), e.reasonLabel);
  }
});

test('理由コードは dry-run の除外理由（CB_SKIP）と同じものを使う', () => {
  const e = el({ ...ok, Status: 'banned' });
  assert.ok(Object.values(CB_SKIP).includes(e.reasonCode), '独自コードを増やしている');
  assert.ok(CB_SKIP_LABEL[e.reasonCode], 'dry-run 側のラベルが無いコード');
});

test('無料付与データの不整合は「要確認」（付与不可と混ぜない）', () => {
  const e = el({
    ...ok, LightGrantLifetime: true,
    LightGrantedAt: iso(NOW - 20 * DAY), LightGrantRevokedAt: iso(NOW - 5 * DAY),
  });
  assert.equal(e.status, GRANT_ELIGIBILITY.REVIEW);
  assert.equal(e.canGrant, false);
  assert.equal(e.reasonCode, GRANT_REASON.REVOKED_CONFLICT);
  assert.match(e.reasonLabel, /要確認：取消状態と期限が不整合/);
});

test('永久無料と期限の同時設定も「要確認」', () => {
  const e = el({ ...ok, PremiumGrantLifetime: true, PremiumGrantUntil: iso(NOW + DAY), PremiumGrantedAt: iso(NOW - DAY) });
  assert.equal(e.status, GRANT_ELIGIBILITY.REVIEW);
  assert.match(e.reasonLabel, /要確認：無料付与データ不整合/);
});

test('無料期間中でも付与はできる（内容が強ければ適用されるため）', () => {
  const e = el({ ...ok, LightGrantUntil: iso(NOW + 10 * DAY), LightGrantedAt: iso(NOW - DAY) });
  assert.equal(e.status, GRANT_ELIGIBILITY.GRANTABLE, '無料期間中を一律で不可にしている');
  assert.equal(e.notes[0].code, GRANT_REASON.ACTIVE_LIGHT_PERIOD);
  assert.match(formatGrantEligibility(e), /付与可能（現在 Light 無料期間中/);
});

test('片方が永久無料なら注意付きで付与できる（もう一方へは適用される）', () => {
  const e = el({ ...ok, LightGrantLifetime: true, LightGrantedAt: iso(NOW - DAY) });
  assert.equal(e.status, GRANT_ELIGIBILITY.GRANTABLE);
  assert.equal(e.notes[0].code, GRANT_REASON.ACTIVE_LIGHT_LIFETIME);
  assert.match(e.notes[0].label, /Light への付与は適用されません/);
});

test('Light も Premium も永久無料なら今回は付与できない', () => {
  const e = el({
    ...ok, LightGrantLifetime: true, LightGrantedAt: iso(NOW - DAY),
    PremiumGrantLifetime: true, PremiumGrantedAt: iso(NOW - DAY),
  });
  assert.equal(e.status, GRANT_ELIGIBILITY.BLOCKED);
  assert.equal(e.reasonCode, GRANT_REASON.ACTIVE_BOTH);
  assert.match(e.reasonLabel, /付与不可：Light・Premium とも永久無料が有効/);
});

test('顧客レコードが無ければ付与不可', () => {
  const e = el(null);
  assert.equal(e.status, GRANT_ELIGIBILITY.BLOCKED);
  assert.equal(e.reasonCode, CB_SKIP.UNKNOWN_CUSTOMER);
});

test('現在状態・履歴・今回の可否は別項目として並存する', () => {
  const fields = { ...ok, LightGrantUntil: iso(NOW - 5 * DAY), LightGrantedAt: iso(NOW - 35 * DAY) };
  const now = resolveCurrentFreeGrant(fields, NOW);
  const past = resolveFreeGrantHistory(fields, NOW);
  const e = el(fields);
  assert.deepEqual(now.codes, [FREE_GRANT_NOW.NONE], '現在状態');
  assert.ok(past.codes.includes('light'), '履歴');
  assert.equal(e.status, GRANT_ELIGIBILITY.GRANTABLE, '今回の可否');
});

test('絞り込みは複数選択 OR / 空は条件なし', () => {
  assert.equal(matchesGrantEligibility('grantable', ['grantable', 'review']), true);
  assert.equal(matchesGrantEligibility('blocked', ['grantable', 'review']), false);
  assert.equal(matchesGrantEligibility('blocked', []), true);
  assert.equal(matchesGrantEligibility('blocked', 'all'), true);
});

test('「付与できる」という単独の言い方を使わない', () => {
  for (const label of Object.values(GRANT_ELIGIBILITY_LABEL)) {
    assert.notEqual(label, '付与できる');
    assert.notEqual(label, '付与できない');
  }
});
