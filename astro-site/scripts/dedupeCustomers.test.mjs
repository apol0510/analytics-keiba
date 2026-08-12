/**
 * dedupeCustomers.test.mjs — 重複削除の安全条件
 *   node --test scripts/dedupeCustomers.test.mjs
 *
 * 重点: **消してよい条件から 1 つでも外れたら消さない**（skip する）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeletable, fingerprintTargets, BLOCKING_FIELDS, DEFAULT_POINTS } from './dedupe-customers.mjs';

const EMAIL = 'a@example.com';
const rec = (id, fields) => ({ id, fields: { Email: EMAIL, 'プラン': 'Free', 'ポイント': 1, ...fields } });

test('中身も参照も無い重複は削除してよい', () => {
  const r = checkDeletable({ target: rec('recTTTTTTTTTTTTTT'), keep: rec('recKKKKKKKKKKKKKK'), email: EMAIL });
  assert.equal(r.ok, true);
});

test('残す側が見つからなければ消さない', () => {
  assert.equal(checkDeletable({ target: rec('recT'), keep: null, email: EMAIL }).reason, 'keep_record_missing');
});

test('残す側のアドレスが違えば消さない（別人を消さない）', () => {
  const keep = rec('recK', { Email: 'other@example.com' });
  assert.equal(checkDeletable({ target: rec('recT'), keep, email: EMAIL }).reason, 'keep_email_mismatch');
});

test('削除側のアドレスが変わっていたら消さない（監査後の変更を検知）', () => {
  const target = rec('recT', { Email: 'changed@example.com' });
  assert.equal(checkDeletable({ target, keep: rec('recK'), email: EMAIL }).reason, 'target_email_changed');
});

test('【重要】権利・課金・意思表示の値が 1 つでもあれば消さない', () => {
  for (const field of BLOCKING_FIELDS) {
    const target = rec('recT', { [field]: field === 'PaymentConfirmed' ? true : '2026-01-01' });
    const r = checkDeletable({ target, keep: rec('recK'), email: EMAIL });
    assert.equal(r.ok, false, `${field} を見逃した`);
    assert.match(r.reason, /^has_values:/);
  }
});

test('ポイント残高があれば消さない（既定値 1 は残高ではない）', () => {
  assert.equal(checkDeletable({ target: rec('recT', { 'ポイント': DEFAULT_POINTS }), keep: rec('recK'), email: EMAIL }).ok, true);
  const r = checkDeletable({ target: rec('recT', { 'ポイント': 102 }), keep: rec('recK'), email: EMAIL });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^has_points:102/);
});

test('削除側のプランの方が強ければ消さない', () => {
  const target = rec('recT', { 'プラン': 'Premium' });
  const keep = rec('recK', { 'プラン': 'Free' });
  assert.equal(checkDeletable({ target, keep, email: EMAIL }).reason, 'target_plan_stronger');
  // 逆（弱い側を消す）は想定どおり
  assert.equal(checkDeletable({ target: rec('recT'), keep: rec('recK', { 'プラン': 'Premium Sanrenpuku' }), email: EMAIL }).ok, true);
});

test('対象一覧の指紋は順序に依存しない（取り違え検知に使える）', () => {
  const a = fingerprintTargets([{ id: 'recA' }, { id: 'recB' }]);
  const b = fingerprintTargets([{ id: 'recB' }, { id: 'recA' }]);
  assert.equal(a, b);
  assert.notEqual(a, fingerprintTargets([{ id: 'recA' }, { id: 'recC' }]));
});

test('既定は dry-run（--execute が無ければ削除経路へ入らない）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./dedupe-customers.mjs', import.meta.url), 'utf8');
  assert.match(src, /const execute = arg\('execute', false\) === true;/);
  assert.match(src, /if \(!execute\) \{[\s\S]{0,200}1 バイトも書いていません/);
  // export を書けなければ中止
  assert.match(src, /export を書けませんでした/);
  // 件数一致が必須
  assert.match(src, /件数が一致しません/);
  // 再実行安全（削除済みは失敗にしない）
  assert.match(src, /already_gone/);
});
