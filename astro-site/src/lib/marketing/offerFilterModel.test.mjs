/**
 * offerFilterModel.test.mjs — オファーの「状態」と「残り期間」を混ぜない
 *
 * 旧 UI は「申込可能なオファーあり」と「期限が7日以内」を同じチェックリストに並べていたが、
 * 後者は前者の**部分集合**で、並列の選択肢ではなかった。ここで関係を固定する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFER_STATE, OFFER_WINDOW, OFFER_STATE_LABEL, OFFER_WINDOW_LABEL, OFFER_RELATION_NOTE,
  resolveOfferState, matchesOfferState, matchesOfferWindow, detectOfferConflict, formatOfferCell,
  OFFER_STATE_VALUES,
} from './offerFilterModel.js';

const NOW = Date.parse('2026-08-03T12:00:00+09:00');
const DAY = 86400000;

test('状態は排他（1 顧客に 1 つだけ）', () => {
  const cases = [
    [{ live: 1, redeemed: 2, expired: 3 }, OFFER_STATE.LIVE],
    [{ live: 0, redeemed: 1, expired: 2 }, OFFER_STATE.REDEEMED],
    [{ live: 0, redeemed: 0, revoked: 1, expired: 2 }, OFFER_STATE.REVOKED],
    [{ live: 0, expired: 1 }, OFFER_STATE.EXPIRED],
    [{}, OFFER_STATE.NONE],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveOfferState({ ...input, nowMs: NOW }).state, expected, JSON.stringify(input));
  }
});

test('台帳を読めなければ「発行なし」と断定しない', () => {
  const v = resolveOfferState({ available: false, nowMs: NOW });
  assert.equal(v.state, OFFER_STATE.UNKNOWN);
  assert.notEqual(v.state, OFFER_STATE.NONE);
});

test('残り期間は「使えるオファーあり」のときだけ決まる', () => {
  const live7 = resolveOfferState({ live: 1, soonestExpiresAtMs: NOW + 3 * DAY, nowMs: NOW });
  assert.equal(live7.window, OFFER_WINDOW.D7);
  assert.equal(live7.daysLeft, 3);
  const live30 = resolveOfferState({ live: 1, soonestExpiresAtMs: NOW + 30 * DAY, nowMs: NOW });
  assert.equal(live30.window, OFFER_WINDOW.D8PLUS);
  const expired = resolveOfferState({ expired: 1, nowMs: NOW });
  assert.equal(expired.window, OFFER_WINDOW.UNKNOWN, '使えないオファーに残り期間を与えている');
  const noExpiry = resolveOfferState({ live: 1, soonestExpiresAtMs: null, nowMs: NOW });
  assert.equal(noExpiry.window, OFFER_WINDOW.NO_LIMIT);
});

test('「7日以内」は「使えるオファーあり」の部分集合として判定される', () => {
  const v = resolveOfferState({ live: 1, soonestExpiresAtMs: NOW + 2 * DAY, nowMs: NOW });
  assert.equal(matchesOfferState(v.state, ['live']), true);
  assert.equal(matchesOfferWindow(v, ['within7']), true);
  // 使えるオファーが無い人は、残り期間を指定した時点で必ず外れる
  const none = resolveOfferState({ nowMs: NOW });
  assert.equal(matchesOfferWindow(none, ['within7']), false);
  assert.equal(matchesOfferWindow(none, []), true, '未選択で絞ってしまっている');
});

test('矛盾する組合せを取得前に検出する', () => {
  const c = detectOfferConflict({ state: ['none'], window: ['within7'] });
  assert.ok(c, '矛盾を見逃している');
  assert.match(c.message, /この条件の組合せでは対象が存在しません/);
  assert.equal(detectOfferConflict({ state: ['live'], window: ['within7'] }), null);
  assert.equal(detectOfferConflict({ state: [], window: ['within7'] }), null, '状態未指定は矛盾ではない');
  assert.equal(detectOfferConflict({ state: ['none'], window: [] }), null);
});

test('関係を説明する 1 文がある（並列ではないと伝える）', () => {
  assert.match(OFFER_RELATION_NOTE, /現在利用できるオファーがある顧客を、残り期間でさらに絞り込めます。/);
});

test('一覧の表示は状態 + 残り期間', () => {
  const v = resolveOfferState({ live: 1, soonestExpiresAtMs: NOW + 5 * DAY, nowMs: NOW });
  assert.equal(formatOfferCell(v), '現在申込みに使えるオファーあり（残り 5 日）');
  assert.equal(formatOfferCell(resolveOfferState({ expired: 1, nowMs: NOW })), '期限切れのオファーのみ');
});

test('表示名に内部コードを出さない', () => {
  for (const v of OFFER_STATE_VALUES) {
    assert.ok(OFFER_STATE_LABEL[v], `${v} のラベルが無い`);
    assert.notEqual(OFFER_STATE_LABEL[v], v);
  }
  assert.equal(OFFER_WINDOW_LABEL.within7, '利用期限まで7日以内');
});
