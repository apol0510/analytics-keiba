/**
 * deliveryRewirePlan.test.mjs — **他人の行を触らずに、自分の行だけ張り直す**
 *   node --test src/lib/marketing/deliveryRewirePlan.test.mjs
 *
 * 守る条件:
 *   1. 対応表に載っている行だけ書き換える（**他 Customer を絶対に変更しない**）
 *   2. `RecipientEmail` でも一致を確かめる（取り違えを弾く）
 *   3. 2 回実行しても安全（already_rewired）
 *   4. 「更新できた」ではなく「**古い参照 0 / 新しい参照が期待どおり**」で完了と判定する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildRewireMapping, planDeliveryRewire, canRewireDeliveries, verifyRewire,
  REWIRE_REFUSE, REWIRE_GATE, REWIRE_CONFIRM, REWIRE_MAX_ENTRIES,
} from './deliveryRewirePlan.js';

const OLD = 'recOLD00000000001';
const NEW = 'recNEW00000000001';
const OTHER = 'recOTHER000000001';
const row = (id, customerId, email) => ({
  id, fields: { CustomerRecordId: customerId, RecipientEmail: email },
});
const mapOne = buildRewireMapping([{ oldId: OLD, newId: NEW, email: 'a@example.com' }]);

/* ── 1. 自分の行だけ張り直す ─────────────────────────────── */

test('【要件】対応表の行を 旧 → 新 recordId へ張り替える', () => {
  const p = planDeliveryRewire({
    rows: [row('recD1', OLD, 'a@example.com'), row('recD2', OLD, 'A@Example.com')],
    mapping: mapOne,
  });
  assert.equal(p.counts.updates, 2, '大文字小文字の違いで落ちている');
  assert.deepEqual(p.updates[0], { id: 'recD1', fields: { CustomerRecordId: NEW } });
  assert.equal(p.counts.refused, 0);
});

test('⚠️【要件】対応表に無い行は 1 文字も触らない（他 Customer を変更しない）', () => {
  const p = planDeliveryRewire({
    rows: [row('recX', OTHER, 'other@example.com'), row('recD1', OLD, 'a@example.com')],
    mapping: mapOne,
  });
  assert.deepEqual(p.updates.map((u) => u.id), ['recD1']);
  assert.deepEqual(p.refused, [{ id: 'recX', reason: REWIRE_REFUSE.NOT_IN_MAPPING }]);
  assert.equal(p.updates.some((u) => u.id === 'recX'), false, '⚠️ 他人の行を書き換えようとしている');
});

test('⚠️【要件】アドレスが一致しない行は書き換えない（取り違え）', () => {
  const p = planDeliveryRewire({
    rows: [row('recD1', OLD, 'someone-else@example.com')], mapping: mapOne,
  });
  assert.equal(p.counts.updates, 0, '⚠️ 別人の履歴を書き換えようとしている');
  assert.deepEqual(p.refused, [{ id: 'recD1', reason: REWIRE_REFUSE.EMAIL_MISMATCH }]);
});

test('⚠️ 行にアドレスが無ければ書き換えない（突き合わせられない）', () => {
  const p = planDeliveryRewire({ rows: [row('recD1', OLD, '')], mapping: mapOne });
  assert.equal(p.counts.updates, 0);
  assert.deepEqual(p.refused, [{ id: 'recD1', reason: REWIRE_REFUSE.NO_EMAIL_ON_ROW }]);
});

/* ── 2. 冪等性 ───────────────────────────────────────────── */

test('⚠️【要件】既に新しい id を指している行は触らない（2 回実行しても安全）', () => {
  const p = planDeliveryRewire({
    rows: [row('recD1', NEW, 'a@example.com')], mapping: mapOne,
  });
  assert.equal(p.counts.updates, 0);
  assert.deepEqual(p.alreadyRewired, ['recD1']);
  assert.equal(p.counts.refused, 0, '⚠️ 済んだ行を「触れない行」として騒いでいる');
});

test('⚠️ 1 回目と 2 回目を続けて流しても、2 回目は 0 件', () => {
  const rows = [row('recD1', OLD, 'a@example.com')];
  const first = planDeliveryRewire({ rows, mapping: mapOne });
  assert.equal(first.counts.updates, 1);
  // 1 回目を適用した状態を作る
  const after = [row('recD1', NEW, 'a@example.com')];
  const second = planDeliveryRewire({ rows: after, mapping: mapOne });
  assert.equal(second.counts.updates, 0);
  assert.equal(second.counts.already, 1);
});

/* ── 3. 対応表の作り方 ───────────────────────────────────── */

test('⚠️ 壊れた対応表は通さない（recordId の形・アドレス必須）', () => {
  const m = buildRewireMapping([
    { oldId: 'bad', newId: NEW, email: 'a@example.com' },
    { oldId: OLD, newId: 'bad', email: 'a@example.com' },
    { oldId: OLD, newId: NEW, email: '' },
    { oldId: OLD, newId: OLD, email: 'a@example.com' },   // 変わっていない
    null, undefined, {},
  ]);
  assert.equal(m.size, 0);
});

test('正しい対応表だけ通る', () => {
  const m = buildRewireMapping([{ oldId: OLD, newId: NEW, email: 'A@Example.com' }]);
  assert.equal(m.size, 1);
  assert.deepEqual(m.get(OLD), { newId: NEW, email: 'a@example.com' });
});

/* ── 4. 実行のゲート ─────────────────────────────────────── */

test('⚠️ 確認文字列が無ければ実行させない', () => {
  const entries = [{ oldId: OLD, newId: NEW, email: 'a@example.com' }];
  assert.equal(canRewireDeliveries({ confirmed: true, entries }).allowed, true);
  assert.deepEqual(canRewireDeliveries({ confirmed: false, entries }).reasons,
    [REWIRE_GATE.NOT_CONFIRMED]);
  assert.deepEqual(canRewireDeliveries({ confirmed: true, entries: [] }).reasons,
    [REWIRE_GATE.NO_ENTRIES]);
  assert.equal(canRewireDeliveries().allowed, false);
});

test('⚠️ 上限を超えたら実行させない', () => {
  const entries = Array.from({ length: REWIRE_MAX_ENTRIES + 1 },
    (_, i) => ({ oldId: OLD, newId: NEW, email: `a${i}@example.com` }));
  assert.ok(canRewireDeliveries({ confirmed: true, entries }).reasons.includes(REWIRE_GATE.TOO_MANY));
  assert.equal(REWIRE_CONFIRM, 'REWIRE CAMPAIGN DELIVERIES');
});

/* ── 5. 完了判定（前後の件数）───────────────────────────── */

test('⚠️【要件】古い参照 0 かつ 新しい参照が期待どおりのときだけ完了', () => {
  assert.equal(verifyRewire({ oldRefsAfter: 0, newRefsAfter: 23452, expectedRefs: 23452 }).ok, true);
});

test('⚠️ 古い参照が 1 件でも残っていたら未完了', () => {
  const v = verifyRewire({ oldRefsAfter: 1, newRefsAfter: 23451, expectedRefs: 23452 });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('old_refs_remain'));
});

test('⚠️ 新しい参照が期待件数と違えば未完了（行が消えている / 増えている）', () => {
  assert.equal(verifyRewire({ oldRefsAfter: 0, newRefsAfter: 23000, expectedRefs: 23452 }).ok, false);
  assert.equal(verifyRewire({ oldRefsAfter: 0, newRefsAfter: 23999, expectedRefs: 23452 }).ok, false);
});

test('⚠️ 数えられなければ未完了（「分からない」を「完了」に倒さない）', () => {
  assert.equal(verifyRewire().ok, false);
  assert.equal(verifyRewire({ oldRefsAfter: NaN, newRefsAfter: 1, expectedRefs: 1 }).ok, false);
});

/* ── 6. guard: Function 側 ───────────────────────────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');
const src = adminSrc.slice(
  adminSrc.indexOf('async function handleCampaignDeliveryRewire'),
  adminSrc.indexOf('async function fetchDeliveriesByCustomerIds'),
);

test('⚠️ guard: 再配線は下見が既定で、単一源の判定と検算を通す', () => {
  assert.ok(src.length > 200, 'handler が見つからない');
  assert.match(adminSrc, /action === 'campaignDeliveryRewire'/);
  assert.match(src, /const dryRun = !apply;/, '⚠️ 既定が下見になっていない');
  assert.match(src, /planDeliveryRewire\(/);
  assert.match(src, /verifyRewire\(/, '⚠️ 書いたあとの検算が無い');
  assert.match(src, /canRewireDeliveries\(/);
});

test('⚠️ guard: 再配線は Customers / Redis / 送信を触らない', () => {
  for (const banned of [
    'CUSTOMERS_TABLE', 'createProspectStore', 'deleteCustomerRecord', 'sendgrid',
    'addManyIfAbsent', 'markDelivered', 'enqueue',
  ]) {
    assert.equal(src.includes(banned), false, `⚠️ 再配線が別経路を触っている: ${banned}`);
  }
});

test('⚠️ guard: 書き換えるのは CustomerRecordId だけ', () => {
  const planSrc = readFileSync(fileURLToPath(new URL('./deliveryRewirePlan.js', import.meta.url)), 'utf8');
  const fieldWrites = planSrc.match(/fields: \{[^}]*\}/g) || [];
  for (const f of fieldWrites) {
    assert.match(f, /CustomerRecordId/, `⚠️ 別の field を書こうとしている: ${f}`);
    assert.equal(/RecipientEmail:/.test(f), false, '⚠️ アドレスを書き換えようとしている');
  }
});

test('⚠️ 追加コードに実在アドレス・secret を書いていない', () => {
  for (const f of ['./deliveryRewirePlan.js', '../../../scripts/rewire-campaign-deliveries.mjs']) {
    const s = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    for (const m of s.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []) {
      assert.match(m, /@(example\.com|keiba\.link)/, `⚠️ 実在しそうなアドレス: ${m}`);
    }
    assert.equal(/(pat[A-Za-z0-9]{14,}|SG\.[A-Za-z0-9_-]{20,})/.test(s), false, `⚠️ secret: ${f}`);
  }
});
