/**
 * prospectSelectionSteps.test.mjs — 差し替え文面（01 / 02 / 03 / 10）の契約
 *
 * **守るべきこと**
 *   1. 固定の期限・日付を 1 つも含まない（差し替えた目的そのもの）
 *   2. 差し替えるのは 01 / 02 / 03 / 10 **だけ**。04〜09 は 1 バイトも変わらない
 *   3. **通し番号 ↔ (campaignId, step) と `DeliveryKey` は変わらない**
 *      → next_message が動かない ＝ **既送信の号を送り直さない**
 *   4. 期限切れの割引を前提にした CTA を持たない／金額を書き写さない
 *   5. 行き先は許可された本番 URL
 *   6. コピー品質基準（本文の厚み・特典欄・CTA ラベル）を満たす
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROSPECT_SELECTION_OVERRIDES, OVERRIDDEN_MESSAGE_NUMBERS, SELECTION_LINKS, hasFixedDate,
} from './prospectSelectionSteps.js';
import { buildMessageContents } from './sendgridContentExport.js';
import { buildMessagePlan, buildMessageKeys, TOTAL_MESSAGES } from './sendgridMessagePlan.js';
import { buildSingleSendPlan, findDeadlineMessages, checkDeadlineFeasibility } from './sendgridSingleSendPlan.js';
import { resolveNextMessage } from './sendgridNextMessage.js';
import { PROSPECT_STATE } from './prospectPolicy.js';
import { evaluateCopyStandard } from './emailCopyStandard.js';
import { FORBIDDEN_PHRASES } from './campaignSequence.js';
import { ALLOWED_LINK_ORIGINS } from './marketingEmailShell.js';

const PLAN = buildMessagePlan().plan;
const rendered = (overrides) => buildMessageContents({ plan: PLAN, ...(overrides === undefined ? {} : { overrides }) });

test('差し替えるのは 01 / 02 / 03 / 10 だけ', () => {
  assert.deepEqual(OVERRIDDEN_MESSAGE_NUMBERS, [1, 2, 3, 10]);
  const r = rendered();
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.messages.length, TOTAL_MESSAGES);
  assert.deepEqual(r.messages.filter((m) => m['差し替え']).map((m) => m.messageNumber), [1, 2, 3, 10]);
});

test('04〜09 は 1 バイトも変わらない', () => {
  const withSwap = rendered();
  const withoutSwap = rendered({});          // 差し替え無し（catalog そのまま）
  const byNumber = (list) => Object.fromEntries(list.messages.map((m) => [m.messageNumber, m]));
  const a = byNumber(withSwap); const b = byNumber(withoutSwap);
  for (const n of [4, 5, 6, 7, 8, 9]) {
    assert.equal(a[n].subject, b[n].subject, `${n} の件名が変わっている`);
    assert.equal(a[n].html, b[n].html, `${n} の HTML が変わっている`);
    assert.equal(a[n].text, b[n].text, `${n} の text が変わっている`);
  }
  // 差し替えた 4 通は確かに変わっている
  for (const n of [1, 2, 3, 10]) assert.notEqual(a[n].subject, b[n].subject, `${n} が差し替わっていない`);
});

test('10 通すべてに固定の期限・日付が無い（任意の開始日で成立する）', () => {
  const r = rendered();
  for (const m of r.messages) {
    assert.equal(
      hasFixedDate({ subject: m.subject, body: m.text }), false,
      `${m.messageNumber} 通目に固定の日付が残っている`,
    );
  }
  // 期限つき判定でも 0 件になる（＝ どの開始日でも違反が出ない）
  const dated = findDeadlineMessages({
    contents: r.messages.map((m) => ({ messageNumber: m.messageNumber, subject: m.subject, html: m.html, text: m.text })),
    deadlineText: '2026年9月23日まで',
  });
  assert.deepEqual(dated, []);
});

test('どの開始日でも 27 通が成立する', () => {
  const r = rendered();
  const plan = buildSingleSendPlan({
    messages: PLAN, listIdByStart: { 1: 'l1', 2: 'l2', 3: 'l3' }, senderId: 1, suppressionGroupId: 2,
  });
  const dated = findDeadlineMessages({
    contents: r.messages.map((m) => ({ messageNumber: m.messageNumber, subject: m.subject, html: m.html, text: m.text })),
    deadlineText: '2026年9月23日まで',
  });
  for (const start of ['2026-09-19', '2026-10-01', '2027-01-05']) {
    const f = checkDeadlineFeasibility({
      sends: plan.sends, startDateIso: `${start}T00:00:00+09:00`,
      deadlineIso: '2026-09-23T00:00:00+09:00', datedMessageNumbers: dated,
    });
    assert.equal(f.ok, true, `${start} 開始で違反が出る`);
    assert.equal(f.violations.length, 0);
  }
});

test('差し替えても DeliveryKey は変わらない（next_message が動かない）', () => {
  // 鍵は campaignId × version × step × 受信者 で決まり、**本文に依存しない**
  const email = 'seed-rewrite@example.test';
  const keys = buildMessageKeys({
    plan: PLAN, email, brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link',
  });
  assert.equal(keys.size, TOTAL_MESSAGES);
  const again = buildMessageKeys({
    plan: PLAN, email, brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link',
  });
  for (const [n, k] of keys) assert.equal(again.get(n), k, `${n} 通目の鍵が変わった`);
  // 通し番号 ↔ (campaignId, step) の対応も不変
  assert.deepEqual(PLAN.slice(0, 3).map((p) => [p.campaignId, p.stepNumber]),
    [['campaign-discount-free', 1], ['campaign-discount-free', 2], ['campaign-discount-free', 3]]);
});

test('【機械保証】既に受け取った通し番号は二度と送られない', () => {
  const plan = buildSingleSendPlan({
    messages: PLAN, listIdByStart: { 1: 'l1', 2: 'l2', 3: 'l3' }, senderId: 1, suppressionGroupId: 2,
  });
  const receivedBy = (start) => plan.sends.filter((s) => s.startMessage === start).map((s) => s.messageNumber);

  // highestSent = h の人は next = h+1 → list start-(h+1) に入る → 受け取るのは h+1 以上だけ
  for (const highestSent of [0, 1, 2]) {
    const sent = new Set(Array.from({ length: highestSent }, (_, i) => i + 1));
    const r = resolveNextMessage({
      prospect: { email: 'x@example.test', state: PROSPECT_STATE.SENDING },
      deliveredMessageNumbers: sent,
    });
    assert.equal(r.nextMessageNumber, highestSent + 1);
    const willReceive = receivedBy(r.nextMessageNumber);
    for (const n of willReceive) {
      assert.ok(n >= r.nextMessageNumber, `既送信の ${n} を送ろうとしている`);
      assert.equal(sent.has(n), false, `${n} は既に受け取っている`);
    }
    assert.equal(willReceive[0], highestSent + 1);
    assert.equal(willReceive.length, TOTAL_MESSAGES - highestSent);
  }
});

test('期限切れの割引を前提にした CTA を持たない / 金額を書き写さない', () => {
  for (const n of OVERRIDDEN_MESSAGE_NUMBERS) {
    const s = PROSPECT_SELECTION_OVERRIDES[n];
    const all = [s.subject, s.preheader, s.headline, s.body, s.ctaLabel, s.ctaNote, ...s.benefitItems].join('\n');
    assert.equal(/割引|OFF|キャンペーン|特別価格/.test(all), false, `${n}: 割引前提の表現が残っている`);
    assert.equal(/[¥￥]\s?\d|\d+\s*円/.test(all), false, `${n}: 金額を書き写している`);
    for (const bad of FORBIDDEN_PHRASES) assert.equal(all.includes(bad), false, `${n}: 禁止表現「${bad}」`);
    assert.equal(/(的中率|回収率|勝率)\s*[:：]?\s*\d/.test(all), false, `${n}: 実績数値の手書き`);
  }
});

test('行き先は許可された本番 URL だけ', () => {
  const allowed = new Set(Object.values(SELECTION_LINKS));
  for (const n of OVERRIDDEN_MESSAGE_NUMBERS) {
    const url = PROSPECT_SELECTION_OVERRIDES[n].ctaUrl;
    assert.ok(allowed.has(url), `${n}: 未知の URL ${url}`);
    assert.ok(ALLOWED_LINK_ORIGINS.some((o) => url.startsWith(`${o}/`)), `${n}: 許可外のドメイン`);
  }
});

test('コピー品質基準（本文の厚み・特典欄・CTA ラベル）を満たす', () => {
  for (const n of OVERRIDDEN_MESSAGE_NUMBERS) {
    const r = evaluateCopyStandard(PROSPECT_SELECTION_OVERRIDES[n]);
    assert.equal(r.ok, true, `${n}: ${JSON.stringify(r.violations || r)}`);
  }
});

test('件名は 10 通すべて違う（同じ文面を繰り返さない）', () => {
  const r = rendered();
  assert.equal(new Set(r.messages.map((m) => m.subject)).size, TOTAL_MESSAGES);
});
