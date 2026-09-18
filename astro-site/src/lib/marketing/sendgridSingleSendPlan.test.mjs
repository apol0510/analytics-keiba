/**
 * sendgridSingleSendPlan.test.mjs — Single Sends 27 通の契約を固定する
 *
 * - 27 通（10 + 9 + 8）で、**開始番号ごとに送る通し番号が違う**
 * - 同じ暦日には**同じ通し番号**が出る（1 人が 1 日に受け取るのは 1 通）
 * - 名前は一意（**二重作成の識別子**）
 * - id が 1 つでも欠ければ**何も作らない**
 * - 予約時刻は計画に含めず、別関数が与える
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSingleSendPlan, buildSchedule, estimateSendVolume, singleSendName,
  SINGLE_SEND_STARTS, PLAN_FAIL,
} from './sendgridSingleSendPlan.js';
import { buildMessagePlan, TOTAL_MESSAGES } from './sendgridMessagePlan.js';

const MESSAGES = buildMessagePlan().plan;
const LIST_IDS = { 1: 'list-1', 2: 'list-2', 3: 'list-3' };
const base = (over = {}) => buildSingleSendPlan({
  messages: MESSAGES, listIdByStart: LIST_IDS, senderId: 9739270, suppressionGroupId: 34108, ...over,
});

test('27 通（10 + 9 + 8）になる', () => {
  const r = base();
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.sends.length, 27);
  assert.deepEqual(r.totals['開始番号別'], { 1: 10, 2: 9, 3: 8 });
  assert.equal(r.totals['間隔日数'], 1);
  assert.equal(r.totals['最長日数'], 9);
  assert.match(r.totals.segment, /なし/);
});

test('開始番号ごとに送る通し番号が違う（start-2 は 02〜10）', () => {
  const r = base();
  const nums = (s) => r.sends.filter((x) => x.startMessage === s).map((x) => x.messageNumber);
  assert.deepEqual(nums(1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(nums(2), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(nums(3), [3, 4, 5, 6, 7, 8, 9, 10]);
});

test('同じ暦日には同じ通し番号が出る（1 人 1 日 1 通）', () => {
  const r = base();
  const day0 = r.sends.filter((s) => s.dayOffset === 0).map((s) => `${s.startMessage}:${s.messageNumber}`);
  assert.deepEqual(day0.sort(), ['1:1', '2:2', '3:3']);
  // 各 list の中で dayOffset は 0,1,2… と連番（同じ list に同日 2 通が無い）
  for (const start of SINGLE_SEND_STARTS) {
    const offsets = r.sends.filter((s) => s.startMessage === start).map((s) => s.dayOffset);
    assert.deepEqual(offsets, offsets.map((_, i) => i));
  }
});

test('名前は一意で、二重作成の識別子になる', () => {
  const r = base();
  const names = r.sends.map((s) => s.name);
  assert.equal(new Set(names).size, 27);
  assert.equal(names[0], singleSendName(1, 1));
  assert.equal(singleSendName(2, 10), 'AK Prospect Selection s2 m10');
});

test('宛先 list・sender・配信停止グループが全件に入る（segment は持たない）', () => {
  const r = base();
  for (const s of r.sends) {
    assert.equal(s.listId, LIST_IDS[s.startMessage]);
    assert.equal(s.senderId, 9739270);
    assert.equal(s.suppressionGroupId, 34108);
    assert.equal('segmentId' in s, false);
  }
});

test('id が 1 つでも欠ければ何も作らない', () => {
  assert.equal(base({ senderId: 0 }).reason, PLAN_FAIL.SENDER_MISSING);
  assert.equal(base({ suppressionGroupId: null }).reason, PLAN_FAIL.GROUP_MISSING);
  assert.equal(base({ listIdByStart: { 1: 'list-1' } }).reason, PLAN_FAIL.LIST_ID_MISSING);
  assert.equal(base({ messages: MESSAGES.slice(0, 5) }).reason, PLAN_FAIL.MESSAGES_INCOMPLETE);
  for (const r of [base({ senderId: 0 }), base({ listIdByStart: {} })]) {
    assert.equal(r.sends.length, 0, '失敗したのに計画を返している');
  }
});

test('予約時刻は計画に含めず、別関数が与える', () => {
  const r = base();
  assert.equal(r.sends.some((s) => 'send_at' in s), false, '計画に予約を持たせない');
  const sch = buildSchedule({ sends: r.sends, baseDateIso: '2026-10-01T00:00:00.000Z' });
  assert.equal(sch.ok, true);
  const byName = Object.fromEntries(sch.schedule.map((x) => [x.name, x.send_at]));
  assert.equal(byName[singleSendName(1, 1)], '2026-10-01T00:00:00.000Z');
  assert.equal(byName[singleSendName(1, 10)], '2026-10-10T00:00:00.000Z');
  assert.equal(byName[singleSendName(3, 10)], '2026-10-08T00:00:00.000Z');
  assert.equal(buildSchedule({ sends: r.sends, baseDateIso: 'x' }).ok, false);
});

test('総送信数は「人数 × 残りの通数」で出る（実測どおり 98,090 通）', () => {
  const v = estimateSendVolume({ countsByNextMessage: { 1: 328, 2: 3442, 3: 7979 } });
  assert.equal(v.contacts, 11749);
  assert.equal(v.emails, 328 * 10 + 3442 * 9 + 7979 * 8);
  assert.equal(v.emails, 98090);
  assert.equal(v.perStart[3].messagesEach, TOTAL_MESSAGES - 3 + 1);
});

test('期限つきの通を期限より後に置かない（違反を全部返す）', async () => {
  const { checkDeadlineFeasibility, findDeadlineMessages } = await import('./sendgridSingleSendPlan.js');
  const r = base();
  // 期限の文字列を含むのは 01 / 02 / 03 / 10（実際の文面と同じ構成）
  const contents = [1, 2, 3, 10].map((n) => ({ messageNumber: n, subject: 'x', html: '2026年9月23日まで', text: '' }))
    .concat([4, 5, 6, 7, 8, 9].map((n) => ({ messageNumber: n, subject: 'x', html: 'y', text: '' })));
  const dated = findDeadlineMessages({ contents, deadlineText: '2026年9月23日まで' });
  assert.deepEqual(dated, [1, 2, 3, 10]);

  // 9/18 開始 → 10 通目は start-1 で 9/27、start-2 で 9/26、start-3 で 9/25 ＝ すべて期限超過
  const late = checkDeadlineFeasibility({
    sends: r.sends, startDateIso: '2026-09-18T00:00:00+09:00',
    deadlineIso: '2026-09-23T00:00:00+09:00', datedMessageNumbers: dated,
  });
  assert.equal(late.ok, false);
  assert.deepEqual(late.violations.map((v) => v.messageNumber), [10, 10, 10]);
  assert.deepEqual(late.violations.map((v) => v['送信日']), ['2026-09-27', '2026-09-26', '2026-09-25']);

  // 最遅開始日は「10 通目の day offset」で決まる（start-1 は 9 日前、start-3 は 7 日前）
  assert.deepEqual(late.latestStartByStart, {
    1: '2026-09-14', 2: '2026-09-15', 3: '2026-09-16',
  });

  // 十分に早く始めれば全件成立する
  const ok = checkDeadlineFeasibility({
    sends: r.sends, startDateIso: '2026-09-14T00:00:00+09:00',
    deadlineIso: '2026-09-23T00:00:00+09:00', datedMessageNumbers: dated,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.violations.length, 0);
});

test('開始日が未確定でも「何日までに始めれば成立するか」は出る', async () => {
  const { checkDeadlineFeasibility } = await import('./sendgridSingleSendPlan.js');
  const r = base();
  const out = checkDeadlineFeasibility({
    sends: r.sends, startDateIso: '', deadlineIso: '2026-09-23T00:00:00+09:00',
    datedMessageNumbers: [1, 2, 3, 10],
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'start_date_undecided');
  assert.deepEqual(out.latestStartByStart, { 1: '2026-09-14', 2: '2026-09-15', 3: '2026-09-16' });
});

test('期限つきの通が無ければ、開始日を決めていなくても成立する', async () => {
  const { checkDeadlineFeasibility } = await import('./sendgridSingleSendPlan.js');
  const r = base();
  const out = checkDeadlineFeasibility({
    sends: r.sends, startDateIso: '', deadlineIso: '2026-09-23T00:00:00+09:00',
    datedMessageNumbers: [],
  });
  assert.equal(out.ok, true);
  assert.equal(out.reason, null);
  assert.deepEqual(out.violations, []);
});
