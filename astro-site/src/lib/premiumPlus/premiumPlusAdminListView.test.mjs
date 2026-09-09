/**
 * premiumPlusAdminListView.test.mjs — 一覧の主状態と運営サマリーを固定する
 *
 * ## 2026-09-09 MK 指摘
 *
 * > 「即時販売」「販売可」「購入可能」「販売中」が混在しており意味が分かれすぎています
 * > odamoto のように現在購入可能な会員が「購入可能な会員を探す操作」で漏れないこと
 *
 * 旧一覧は override を「即時販売」、PHASE 4 を「販売中」と別扱いし、停止を見ていなかった。
 * ここでは **4 分類だけ**にし、「購入可能」は `purchaseEnabled` だけで決めることを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIST_STATE, LIST_STATE_LABEL, LIST_STATE_ORDER, classifyListState, listStateLabel,
  summarizeListStates, listStateFilterOptions, matchesListState, findExactEmailMatch,
  describeAttention, describeLastChange, describeRowActions,
} from './premiumPlusAdminListView.js';

/** odamoto の実データ相当（override なしで PHASE 4 に到達＝旧実装で取り逃していた形） */
const ODAMOTO = {
  recordId: 'rec1zljY6Ozb23gd1', email: 'odamoto@gmail.com',
  eligibility: 'eligible', phase: 4, overrideApplied: false,
  purchaseEnabled: true, salePaused: false,
};
/** override を当てて購入可能にした会員 */
const OVERRIDDEN = {
  recordId: 'recOVR', email: 'ovr@example.com',
  eligibility: 'eligible', phase: 4, overrideApplied: true, purchaseEnabled: true, salePaused: false,
};
const STAGED = {
  recordId: 'recSTG', email: 'staged@example.com',
  eligibility: 'eligible', phase: 2, overrideApplied: false, purchaseEnabled: false, salePaused: false,
};
const PAUSED = {
  recordId: 'recPSE', email: 'paused@example.com',
  eligibility: 'eligible', phase: 4, overrideApplied: false, purchaseEnabled: false, salePaused: true,
};
const BLOCKED = { recordId: 'recBLK', email: 'blk@example.com', eligibility: 'blocked', purchaseEnabled: false };
const REVIEW = { recordId: 'recRVW', email: 'rvw@example.com', eligibility: 'review', purchaseEnabled: false };

test('主状態は 4 分類だけ', () => {
  assert.deepEqual(Object.values(LIST_STATE).sort(), ['out', 'paused', 'sale', 'staged']);
  assert.deepEqual(LIST_STATE_ORDER, ['sale', 'paused', 'staged', 'out']);
  assert.deepEqual(LIST_STATE_ORDER.map((k) => LIST_STATE_LABEL[k]),
    ['購入可能', '販売停止中', '段階表示中', '対象外']);
});

test('【本件】override が無くても購入可能な会員は「購入可能」（取り逃さない）', () => {
  assert.equal(classifyListState(ODAMOTO), LIST_STATE.SALE);
  assert.equal(listStateLabel(ODAMOTO), '購入可能');
});

test('【本件】override 有りも「購入可能」（同じ分類に入る）', () => {
  assert.equal(classifyListState(OVERRIDDEN), LIST_STATE.SALE);
  // 経路が違っても同じ状態。分類が分かれない
  assert.equal(classifyListState(OVERRIDDEN), classifyListState(ODAMOTO));
});

test('【本件】「購入可能」で絞ると、購入できる会員が経路を問わず全員入る', () => {
  const rows = [ODAMOTO, OVERRIDDEN, STAGED, PAUSED, BLOCKED, REVIEW];
  const hit = rows.filter((r) => matchesListState(r, LIST_STATE.SALE)).map((r) => r.email);
  assert.deepEqual(hit.sort(), ['odamoto@gmail.com', 'ovr@example.com'],
    '購入できる会員が漏れている / 買えない会員が混ざっている');
});

test('停止中は最優先（購入可能にも段階表示中にも混ぜない）', () => {
  assert.equal(classifyListState(PAUSED), LIST_STATE.PAUSED);
  // 停止中なのに purchaseEnabled が真という壊れた入力でも停止として扱う
  assert.equal(classifyListState({ ...PAUSED, purchaseEnabled: true }), LIST_STATE.PAUSED);
});

test('資格が無い会員は「対象外」にまとめる（保留と販売対象外を運営者に分けて見せない）', () => {
  assert.equal(classifyListState(BLOCKED), LIST_STATE.OUT);
  assert.equal(classifyListState(REVIEW), LIST_STATE.OUT);
});

test('運営サマリーは「購入可能 N 名」の形で 4 分類ぶん出る', () => {
  const s = summarizeListStates([ODAMOTO, OVERRIDDEN, STAGED, PAUSED, BLOCKED, REVIEW]);
  assert.equal(s.total, 6);
  assert.deepEqual(s.counts, { sale: 2, paused: 1, staged: 1, out: 2 });
  assert.deepEqual(s.items.map((i) => `${i.label} ${i.count}名`),
    ['購入可能 2名', '販売停止中 1名', '段階表示中 1名', '対象外 2名']);
});

test('状態フィルタの選択肢に内部用語を出さない', () => {
  const labels = listStateFilterOptions().map((o) => o.label).join(' ');
  assert.match(labels, /購入可能/);
  for (const w of ['即時販売', 'override', 'PHASE', '販売可', '保留']) {
    assert.ok(!labels.includes(w), `内部用語が選択肢に出ている: ${w}`);
  }
});

test('メール完全一致で 1 件だけなら、その会員を返す', () => {
  const rows = [ODAMOTO, STAGED];
  assert.equal(findExactEmailMatch(rows, 'odamoto@gmail.com').recordId, ODAMOTO.recordId);
  assert.equal(findExactEmailMatch(rows, ' ODAMOTO@Gmail.com ').recordId, ODAMOTO.recordId);
  // 部分一致・0 件・複数一致では飛ばさない
  assert.equal(findExactEmailMatch(rows, 'odamoto'), null);
  assert.equal(findExactEmailMatch(rows, 'nobody@example.com'), null);
  assert.equal(findExactEmailMatch([ODAMOTO, { ...ODAMOTO, recordId: 'dup' }], 'odamoto@gmail.com'), null);
});

test('【重要】次の操作はボタン名だけで結果が分かる（1 個だけ）', () => {
  const selling = describeRowActions(ODAMOTO, { salePauseWritable: true });
  assert.equal(selling.length, 1);
  assert.equal(selling[0].label, '販売を停止');
  assert.equal(selling[0].danger, true, '止める操作が危険扱いになっていない');
  const paused = describeRowActions(PAUSED, { salePauseWritable: true });
  assert.equal(paused[0].label, '販売を再開');
  assert.equal(paused[0].danger, false, '再開に確認を増やしている');
  for (const a of selling.concat(paused)) assert.ok(a.hint, '押すとどうなるかが無い');
});

test('書込 gate が無ければ押させない（fail closed）', () => {
  const a = describeRowActions(ODAMOTO, { salePauseWritable: false })[0];
  assert.equal(a.enabled, false);
  assert.ok(a.reason);
  // 行側の値が false でも押させない
  const b = describeRowActions({ ...ODAMOTO, salePauseWritable: false }, { salePauseWritable: true })[0];
  assert.equal(b.enabled, false);
});

test('【重要】正常な会員に警告を出さない（異常だけ出す）', () => {
  for (const r of [ODAMOTO, OVERRIDDEN, STAGED, PAUSED, BLOCKED, REVIEW]) {
    assert.deepEqual(describeAttention(r), [], `正常な会員に警告が出ている: ${r.email}`);
  }
  assert.equal(describeAttention({ ...ODAMOTO, reopenLaunch: { state: 'incomplete' } }).length, 1);
  assert.equal(describeAttention({ ...ODAMOTO, reopenLaunch: { state: 'unknown' } }).length, 1);
  assert.match(describeAttention({ ...PAUSED, purchaseEnabled: true })[0], /要調査/);
});

test('「最後に何をしたか / いつ」を新しい順に 1 件返す', () => {
  assert.equal(describeLastChange({}), null);
  const r = {
    updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'MK',
    salePausedAt: '2026-09-05T00:00:00.000Z', salePausedBy: 'MK',
    reopenCouponClaimedAt: '2026-09-03T00:00:00.000Z',
  };
  assert.equal(describeLastChange(r).label, '販売の停止/再開');
  assert.equal(describeLastChange({ updatedAt: r.updatedAt }).label, '販売資格の変更');
});

test('【重要】主状態のラベル・分類に内部用語が混ざらない', () => {
  const all = Object.values(LIST_STATE_LABEL).join(' ');
  for (const w of ['即時販売', 'override', 'PHASE', 'eligibility']) {
    assert.ok(!all.includes(w), `主状態に内部用語が出ている: ${w}`);
  }
});
