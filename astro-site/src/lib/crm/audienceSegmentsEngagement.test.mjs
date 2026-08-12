/**
 * audienceSegmentsEngagement.test.mjs — セグメント下見に反応なし除外を足したときの数え方
 *   node --test src/lib/crm/audienceSegmentsEngagement.test.mjs
 *
 * 重点:
 *   - 「送信できる人数」から反応なしの人が引かれる（送信前に本当の人数が見える）
 *   - 母数 = 送信候補 + 除外合計 が崩れない
 *   - Set を渡さなければ従来どおり（既存の下見を壊さない）
 *   - 既存の除外理由を奪わない（配信停止・バウンス等が先）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSegment, SEG_EXCLUDE, SEG_EXCLUDE_LABEL } from './audienceSegments.js';

const NOW = Date.UTC(2026, 7, 12, 0, 0);

const rec = (email, fields = {}) => ({
  id: `rec-${email}`,
  fields: { Email: email, Status: 'active', ...fields },
});

/** 無料ユーザー 3 名（free-all に入る最小構成） */
const records = [rec('a@example.com'), rec('b@example.com'), rec('c@example.com')];

const run = (over = {}) => evaluateSegment({
  records, segmentId: 'free-all', nowMs: NOW,
  blacklistHard: new Set(), blacklistSoft: new Set(),
  providerSuppressed: new Set(),   // 確認できている（fail closed に落ちない）
  lastContactAtMs: new Map(),
  ...over,
});

test('Set を渡さなければ従来どおり（1 人も除外されない）', () => {
  const r = run();
  assert.equal(r.total, 3);
  assert.equal(r.sendable, 3);
  assert.equal(r.byReason.engagement_blocked, undefined);
});

test('反応なしの人は「送信できる人数」から引かれる', () => {
  const r = run({ engagementBlockedEmails: new Set(['b@example.com']) });
  assert.equal(r.total, 3);
  assert.equal(r.sendable, 2);
  assert.equal(r.byReason[SEG_EXCLUDE.ENGAGEMENT_BLOCKED], 1);
  assert.equal(r.balanced, true, '母数 = 送信候補 + 除外合計');
});

test('全員が反応なしでも数え方が崩れない', () => {
  const r = run({ engagementBlockedEmails: new Set(records.map((x) => x.fields.Email)) });
  assert.equal(r.sendable, 0);
  assert.equal(r.excluded, 3);
  assert.equal(r.balanced, true);
});

test('配信停止・バウンスの理由を奪わない（強い理由が先）', () => {
  const r = evaluateSegment({
    records: [rec('a@example.com', { UnsubscribedAnalyticsKeiba: true }), rec('b@example.com')],
    segmentId: 'free-all', nowMs: NOW,
    blacklistHard: new Set(), blacklistSoft: new Set(['b@example.com']),
    providerSuppressed: new Set(), lastContactAtMs: new Map(),
    engagementBlockedEmails: new Set(['a@example.com', 'b@example.com']),
  });
  assert.equal(r.byReason.unsubscribed, 1);
  assert.equal(r.byReason.blacklist_soft, 1);
  assert.equal(r.byReason.engagement_blocked, undefined);
});

test('理由コードに日本語ラベルがある（画面に生コードを出さない）', () => {
  assert.ok(SEG_EXCLUDE_LABEL[SEG_EXCLUDE.ENGAGEMENT_BLOCKED]);
});

test('顧客の一覧・アドレスは返さない（件数だけ）', () => {
  const r = run({ engagementBlockedEmails: new Set(['b@example.com']), sampleSize: 3 });
  const json = JSON.stringify(r);
  assert.equal(/@example\.com/.test(json), false);
  assert.equal(/rec-/.test(json), false);
});
