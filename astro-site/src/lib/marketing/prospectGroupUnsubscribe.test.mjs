/**
 * 見込み客（prospect）の group 単位配信停止を AK Marketing に限る（2026-09-27 MK 確定）。
 *
 * SendGrid アカウントは KI と共用。Event Webhook で `group_unsubscribe` を ON にしたとき、
 * KI・テスト・不明 group の停止で AK の見込み客を止めない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEvent, SUPPRESS_REASON } from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { AK_MARKETING_GROUP } from '../unsubscribe/akMarketingGroup.js';

const AK = AK_MARKETING_GROUP.id;
const KI = 29174;
const TEST_GROUP = 28368;

const plan = (events) => planProspectEventUpdates({ events, classify: classifyEvent }).updates;

test('AK Marketing の group_unsubscribe → 見込み客を配信停止で抑止', () => {
  assert.deepEqual(classifyEvent('group_unsubscribe', { asm_group_id: AK }), { kind: 'suppress', reason: SUPPRESS_REASON.UNSUBSCRIBE });
  assert.deepEqual(classifyEvent('group_unsubscribe', { asm_group_id: String(AK) }).kind, 'suppress');
  const u = plan([{ email: 'p@example.test', event: 'group_unsubscribe', asm_group_id: AK }]);
  assert.deepEqual(u.map((x) => [x.action, x.reason]), [['suppress', SUPPRESS_REASON.UNSUBSCRIBE]]);
});

test('KI / テスト group の group_unsubscribe → 見込み客に影響なし', () => {
  for (const g of [KI, TEST_GROUP]) {
    assert.equal(classifyEvent('group_unsubscribe', { asm_group_id: g }).kind, 'ignore', String(g));
    assert.deepEqual(plan([{ email: 'p@example.test', event: 'group_unsubscribe', asm_group_id: g }]), [], String(g));
  }
});

test('group が不明・欠落の group_unsubscribe → 見込み客に影響なし（fail closed）', () => {
  for (const ev of [null, undefined, {}, { asm_group_id: null }, { asm_group_id: '' }, { asm_group_id: 'abc' }, { asm_group_id: 34108.5 }]) {
    assert.equal(classifyEvent('group_unsubscribe', ev).kind, 'ignore', JSON.stringify(ev));
  }
  assert.equal(classifyEvent('group_unsubscribe').kind, 'ignore', '種別だけでは止めない');
  assert.deepEqual(plan([{ email: 'p@example.test', event: 'group_unsubscribe' }]), []);
});

test('通常の unsubscribe・bounce・dropped・spamreport は従来どおり抑止（group を見ない）', () => {
  for (const [t, r] of [['unsubscribe', SUPPRESS_REASON.UNSUBSCRIBE], ['bounce', SUPPRESS_REASON.BOUNCE],
    ['blocked', SUPPRESS_REASON.BOUNCE], ['dropped', SUPPRESS_REASON.DROPPED], ['spamreport', SUPPRESS_REASON.COMPLAINT]]) {
    for (const ev of [null, { asm_group_id: KI }, { asm_group_id: AK }]) {
      assert.deepEqual(classifyEvent(t, ev), { kind: 'suppress', reason: r }, `${t} ${JSON.stringify(ev)}`);
    }
  }
});

test('group_resubscribe では見込み客を復活させない（抑止は不可逆）', () => {
  for (const g of [AK, KI, TEST_GROUP, undefined]) {
    assert.equal(classifyEvent('group_resubscribe', { asm_group_id: g }).kind, 'ignore', String(g));
  }
  // 同じバッチで停止 → 再開が来ても、停止が残る
  const u = plan([
    { email: 'p@example.test', event: 'group_unsubscribe', asm_group_id: AK },
    { email: 'p@example.test', event: 'group_resubscribe', asm_group_id: AK },
  ]);
  assert.deepEqual(u.map((x) => x.action), ['suppress']);
});
