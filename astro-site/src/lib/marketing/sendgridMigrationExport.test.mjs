/**
 * sendgridMigrationExport.test.mjs — 変換層（contact / Automation / 文面）の契約
 *
 * - `ready` 以外を SendGrid へ出さない
 * - 通し番号ごとに宛先リストを分ける（**4 通目の人を 1 通目始まりへ入れない**）
 * - custom field / list が解決できなければ**何も作らない**
 * - 文面は既存 catalog のまま（配信停止だけ SendGrid のタグへ）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContactUpserts, buildContactCsv, resolveFieldIds, summarizeContactExport,
  CONTACT_FIELD_NAMES, EXPORT_REFUSE, EXPORT_FAIL,
} from './sendgridContactExport.js';
import {
  buildAutomationPlan, buildExitPlan, listNameFor, automationNameFor, INTERVAL_DAYS,
} from './sendgridAutomationPlan.js';
import { buildMessageContents, SENDGRID_UNSUBSCRIBE_TAG } from './sendgridContentExport.js';
import { buildMessagePlan, TOTAL_MESSAGES } from './sendgridMessagePlan.js';
import { MIGRATION_STATUS, containsEmailLike } from './sendgridNextMessage.js';

const FIELD_DEFS = {
  custom_fields: CONTACT_FIELD_NAMES.map((name, i) => ({ id: `f${i + 1}`, name })),
};
const LIST_IDS = Object.fromEntries(
  Array.from({ length: TOTAL_MESSAGES }, (_, i) => [i + 1, `list-${i + 1}`]),
);
const ready = (email, n, over = {}) => ({
  email, hash: `h-${email}`, status: MIGRATION_STATUS.READY,
  nextMessageNumber: n, highestSent: n - 1, delivered: n - 1, ...over,
});

test('custom field が 1 つでも欠ければ何も作らない', () => {
  const partial = resolveFieldIds({ custom_fields: [{ id: 'f1', name: CONTACT_FIELD_NAMES[0] }] });
  assert.equal(partial.ok, false);
  assert.equal(partial.reason, EXPORT_FAIL.FIELD_IDS_MISSING);

  const built = buildContactUpserts({
    entries: [ready('a@example.test', 1)],
    fieldIds: { [CONTACT_FIELD_NAMES[0]]: 'f1' },
    listIdByMessage: LIST_IDS,
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(built.ok, false);
  assert.equal(built.reason, EXPORT_FAIL.FIELD_IDS_MISSING);
  assert.equal(built.batches.length, 0);
});

test('通し番号ごとに別の list へ入る（4 通目の人は 4 通目始まりへ）', () => {
  const fields = resolveFieldIds(FIELD_DEFS);
  const built = buildContactUpserts({
    entries: [ready('a@example.test', 1), ready('b@example.test', 4), ready('c@example.test', 4)],
    fieldIds: fields.ids,
    listIdByMessage: LIST_IDS,
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(built.ok, true);
  const byStart = Object.fromEntries(built.batches.map((b) => [b.startMessage, b]));
  assert.deepEqual(byStart[1].list_ids, ['list-1']);
  assert.equal(byStart[1].contacts.length, 1);
  assert.deepEqual(byStart[4].list_ids, ['list-4']);
  assert.equal(byStart[4].contacts.length, 2);
  // custom field は id をキーにして入る
  const cf = byStart[4].contacts[0].custom_fields;
  assert.equal(cf[fields.ids.ak_next_message], 4);
  assert.equal(cf[fields.ids.ak_migrated_at], '2026-09-18T00:00:00.000Z');
});

test('ready 以外・重複・list 未解決・再送の疑いは 1 件も出さない', () => {
  const fields = resolveFieldIds(FIELD_DEFS);
  const built = buildContactUpserts({
    entries: [
      ready('dup@example.test', 2),
      ready('dup@example.test', 2),
      { ...ready('excluded@example.test', 2), status: MIGRATION_STATUS.EXCLUDED },
      { ...ready('unresolved@example.test', 2), status: MIGRATION_STATUS.UNRESOLVED },
      ready('nolist@example.test', 9),
      { ...ready('resend@example.test', 2), highestSent: 5 },
      { ...ready('bad@example.test', 99) },
    ],
    fieldIds: fields.ids,
    listIdByMessage: { 2: 'list-2' },
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(built.ok, true);
  assert.equal(built.counts['受理'], 1);
  assert.equal(built.refused[EXPORT_REFUSE.DUPLICATE], 1);
  assert.equal(built.refused[EXPORT_REFUSE.NOT_READY], 2);
  assert.equal(built.refused[EXPORT_REFUSE.NO_LIST], 1);
  assert.equal(built.refused[EXPORT_REFUSE.RESEND_RISK], 1);
  assert.equal(built.refused[EXPORT_REFUSE.BAD_MESSAGE_NUMBER], 1);
});

test('1 リクエストの件数で分割する', () => {
  const fields = resolveFieldIds(FIELD_DEFS);
  const entries = Array.from({ length: 5 }, (_, i) => ready(`u${i}@example.test`, 1));
  const built = buildContactUpserts({
    entries, fieldIds: fields.ids, listIdByMessage: LIST_IDS, perRequest: 2,
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.deepEqual(built.batches.map((b) => b.contacts.length), [2, 2, 1]);
});

test('集計にアドレスを含めない', () => {
  const fields = resolveFieldIds(FIELD_DEFS);
  const built = buildContactUpserts({
    entries: [ready('a@example.test', 1)], fieldIds: fields.ids, listIdByMessage: LIST_IDS,
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  const s = summarizeContactExport(built);
  assert.equal(containsEmailLike(s), false);
  assert.equal(s['通し番号別']['1'], 1);
});

test('CSV も ready 以外を出さない', () => {
  const csv = buildContactCsv({
    entries: [ready('a@example.test', 3), { ...ready('b@example.test', 3), status: MIGRATION_STATUS.EXCLUDED }],
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.deepEqual(csv.header, ['email', ...CONTACT_FIELD_NAMES]);
  assert.equal(csv.rows.length, 1);
  assert.equal(csv.rows[0][0], 'a@example.test');
  assert.equal(csv.rows[0][1], '3');
});

test('Automation は 1 日 1 通で、開始番号から 10 通目までを持つ', () => {
  const plan = buildMessagePlan();
  const built = buildAutomationPlan({
    countsByNextMessage: { 1: 100, 4: 50, 10: 5 }, plan: plan.plan,
  });
  assert.equal(built.ok, true);
  assert.equal(built.automations.length, TOTAL_MESSAGES);

  const start4 = built.automations.find((a) => a.startMessage === 4);
  assert.equal(start4.listName, listNameFor(4));
  assert.equal(start4.automationName, automationNameFor(4));
  assert.equal(start4.messageCount, 7);
  assert.deepEqual(start4.messages.map((m) => m.messageNumber), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(start4.messages.map((m) => m.dayOffset), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(INTERVAL_DAYS, 1);

  // 0 人の入口は作らない
  assert.equal(built.automations.find((a) => a.startMessage === 2).needed, false);
  assert.equal(built.totals['作るAutomation数'], 3);
  // 残送信 = 100×10 + 50×7 + 5×1
  assert.equal(built.totals['残送信総数'], 1000 + 350 + 5);
  assert.equal(built.totals['対象contact数'], 155);
});

test('退出は全 list から外す（どこに居るか分からなくても残さない）', () => {
  const exit = buildExitPlan({
    changes: [{ email: 'A@Example.test', state: 'ENGAGED' }, { email: 'b@example.test', state: 'SUPPRESSED' }],
    listIdByMessage: { 1: 'list-1', 4: 'list-4' },
  });
  assert.equal(exit.removals.length, 2);
  assert.equal(exit.removals[0].email, 'a@example.test');
  assert.deepEqual(exit.removals[0].listIds, ['list-1', 'list-4']);
});

test('文面は 10 通ぶん作れ、配信停止だけ SendGrid のタグへ置き換わる', () => {
  const plan = buildMessagePlan();
  const built = buildMessageContents({ plan: plan.plan });
  assert.equal(built.ok, true, built.reason || '');
  assert.equal(built.messages.length, TOTAL_MESSAGES);
  for (const m of built.messages) {
    assert.ok(m.subject.length > 0);
    assert.ok(m.html.includes(SENDGRID_UNSUBSCRIBE_TAG), `${m.messageNumber} 通目に配信停止タグが無い`);
    assert.equal(/\{\{|\}\}/.test(m.text), false, '未解決の差し込みが残っている');
  }
  // 件名は 10 通すべて違う
  assert.equal(new Set(built.messages.map((m) => m.subject)).size, TOTAL_MESSAGES);
});
