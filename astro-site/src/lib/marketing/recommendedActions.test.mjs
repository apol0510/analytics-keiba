/**
 * recommendedActions.test.mjs — 推奨アクション（提案のみ・自動実行なし）
 *   node --test src/lib/marketing/recommendedActions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecommendations, REC } from './recommendedActions.js';
import { MARKETING_MIN_INTERVAL_MS } from './campaignSend.js';

const NOW = Date.parse('2026-08-01T06:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const base = {
  marketing: { contract: 'expired', plan: 'premium', sendable: true, suppressionReasons: [], premiumPlusEligibility: '' },
  entitlements: { promo: {} },
  membership: { memberType: 'free' },
  offers: [],
  engagement: { available: false, opened: null, clicked: null },
  daysSinceLogin: null,
  lastSentAtMs: null,
  nowMs: NOW,
};
const run = (over = {}) => buildRecommendations({ ...base, ...over });
const types = (r) => r.recommendations.map((x) => x.type);

test('すべての推奨に 理由 / 使用データ / 送信可否 が付く', () => {
  const r = run({ daysSinceLogin: 3 });
  for (const rec of r.recommendations) {
    assert.ok(rec.title, 'title が無い');
    assert.ok(rec.reason, `${rec.type} に理由が無い`);
    assert.ok(Array.isArray(rec.dataUsed) && rec.dataUsed.length > 0, `${rec.type} に使用データが無い`);
    assert.ok('sendable' in rec, `${rec.type} に送信可否が無い`);
    assert.ok('earliestAt' in rec, `${rec.type} に実行可能日時が無い`);
  }
});

test('送信禁止（suppression）は最優先で出し、送信可否を false にする', () => {
  const r = run({ marketing: { ...base.marketing, sendable: false, suppressionReasons: ['blacklist'] } });
  assert.equal(r.recommendations[0].type, REC.BLOCKED_SUPPRESSED, '送信禁止が先頭に出ていない');
  assert.equal(r.recommendations[0].sendable, false);
  assert.match(r.recommendations[0].reason, /blacklist/);
  assert.equal(r.sendableFrom, null, '送信禁止なのに送信可能時刻を出している');
});

test('24時間以内に送信済み → 次に送れる時刻を出す', () => {
  const lastSentAtMs = NOW - 2 * 60 * 60 * 1000;
  const r = run({ lastSentAtMs });
  const freq = r.recommendations.find((x) => x.type === REC.BLOCKED_FREQUENCY);
  assert.ok(freq, '頻度ガードの表示が無い');
  assert.equal(freq.earliestAt, iso(lastSentAtMs + MARKETING_MIN_INTERVAL_MS));
  assert.equal(freq.sendable, false);
  // 他の推奨も「その時刻以降」になる
  const other = r.recommendations.find((x) => x.type === REC.LIGHT_TRIAL || x.type === REC.COMEBACK_MAIL);
  if (other) assert.equal(other.earliestAt, iso(lastSentAtMs + MARKETING_MIN_INTERVAL_MS));
});

test('24時間を過ぎていれば送信可能として扱う', () => {
  const r = run({ lastSentAtMs: NOW - MARKETING_MIN_INTERVAL_MS - 1000, daysSinceLogin: 5 });
  assert.equal(types(r).includes(REC.BLOCKED_FREQUENCY), false);
  const rec = r.recommendations.find((x) => x.type === REC.COMEBACK_MAIL);
  assert.equal(rec.sendable, true);
});

test('期限切れ × 最近ログインあり → カムバック案内候補', () => {
  const r = run({ daysSinceLogin: 10 });
  const rec = r.recommendations.find((x) => x.type === REC.COMEBACK_MAIL);
  assert.ok(rec, 'カムバック案内が出ていない');
  assert.equal(rec.campaignId, 'expired-comeback');
  assert.match(rec.reason, /10 日前/);
});

test('期限切れ × 長期ログインなし → Light 無料体験候補', () => {
  for (const d of [31, 400, null]) {
    const r = run({ daysSinceLogin: d });
    const rec = r.recommendations.find((x) => x.type === REC.LIGHT_TRIAL);
    assert.ok(rec, `daysSinceLogin=${d} で無料体験が出ていない`);
    assert.equal(rec.offerId, 'light-30d-free');
  }
});

test('有効オファーあり・未申込 → 期限前リマインド（残り日数つき）', () => {
  const r = run({
    offers: [{ offerId: 'premium-annual-half', status: 'issued', live: true, expiresAt: iso(NOW + 5 * DAY), offerPrice: 24900 }],
  });
  const rec = r.recommendations.find((x) => x.type === REC.OFFER_REMINDER);
  assert.ok(rec);
  assert.equal(rec.campaignId, 'comeback-offer');
  assert.equal(rec.severity, 'warn', '期限が近いのに警告になっていない');
  assert.match(rec.reason, /残り約 5 日/);
  // オファーがあるならカムバック案内・無料体験は重ねて出さない
  assert.equal(types(r).includes(REC.COMEBACK_MAIL), false);
  assert.equal(types(r).includes(REC.LIGHT_TRIAL), false);
});

test('申込済みならリマインドしない', () => {
  const r = run({
    offers: [{ offerId: 'premium-annual-half', status: 'redeemed', live: false, expiresAt: iso(NOW + 5 * DAY), offerPrice: 24900 }],
  });
  assert.equal(types(r).includes(REC.OFFER_REMINDER), false);
});

test('無料特典の期間中 → 終了日と案内時期（7日前から）を出す', () => {
  const untilMs = NOW + 20 * DAY;
  const r = run({ entitlements: { promo: { lightActive: true, lightLifetime: false, lightUntilMs: untilMs } } });
  const rec = r.recommendations.find((x) => x.type === REC.GRANT_ENDING);
  assert.ok(rec);
  assert.match(rec.reason, /残り 20 日/);
  assert.equal(rec.earliestAt, iso(untilMs - 7 * DAY), '案内時期が終了 7 日前になっていない');
});

test('無期限特典は終了日を作らない（推測しない）', () => {
  const r = run({ entitlements: { promo: { lightActive: true, lightLifetime: true, lightUntilMs: null } } });
  const rec = r.recommendations.find((x) => x.type === REC.GRANT_ENDING);
  assert.ok(rec);
  assert.equal(rec.earliestAt, null);
  assert.match(rec.reason, /無期限/);
});

test('開封・クリックは取得できているときだけ推奨に使う', () => {
  // 取得できていない → 反応ベースの推奨を出さない
  const unknown = run({ engagement: { available: false, opened: null, clicked: null } });
  assert.equal(types(unknown).includes(REC.REWRITE_COPY), false, '取得不能を「未開封」と解釈している');
  assert.equal(types(unknown).includes(REC.PERSONAL_FOLLOW), false);

  const opened = run({ engagement: { available: true, opened: 2, clicked: 0 } });
  assert.ok(types(opened).includes(REC.REWRITE_COPY));

  const clicked = run({ engagement: { available: true, opened: 2, clicked: 1 } });
  assert.ok(types(clicked).includes(REC.PERSONAL_FOLLOW));
});

test('有効な有料契約 → カムバック対象外として明示', () => {
  const r = run({ marketing: { ...base.marketing, contract: 'active' } });
  const rec = r.recommendations.find((x) => x.type === REC.ACTIVE_PAID_SKIP);
  assert.ok(rec);
  assert.equal(types(r).includes(REC.COMEBACK_MAIL), false);
  assert.equal(types(r).includes(REC.LIGHT_TRIAL), false);
});

test('Premium Plus eligible / review を出し分ける', () => {
  const e = run({ marketing: { ...base.marketing, premiumPlusEligibility: 'eligible' } });
  const er = e.recommendations.find((x) => x.type === REC.PLUS_CANDIDATE);
  assert.equal(er.campaignId, 'premium-plus-offer');
  assert.equal(er.sendable, true);

  const rv = run({ marketing: { ...base.marketing, premiumPlusEligibility: 'review' } });
  const rr = rv.recommendations.find((x) => x.type === REC.PLUS_CANDIDATE);
  assert.equal(rr.campaignId, null, '保留なのに案内キャンペーンを勧めている');
  assert.equal(rr.sendable, false);
});

test('該当が無ければ「推奨なし」を返す（空配列にしない）', () => {
  const r = run({ marketing: { ...base.marketing, contract: 'none' } });
  assert.equal(r.recommendations.length, 1);
  assert.equal(r.recommendations[0].type, REC.NO_ACTION);
});

test('推奨は提案のみ（実行系のキーを持たない）', () => {
  const r = run({ daysSinceLogin: 3 });
  const dump = JSON.stringify(r);
  for (const forbidden of ['apply', 'execute', 'dryRun:false', 'operationId', 'token']) {
    assert.equal(dump.includes(forbidden), false, `推奨に実行系の値が入っている: ${forbidden}`);
  }
});
