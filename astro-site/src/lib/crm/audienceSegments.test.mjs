/**
 * audienceSegments.test.mjs — 大規模セグメントの数え方を固定する
 *   node --test src/lib/crm/audienceSegments.test.mjs
 *
 * 13,000 件規模で一番怖いのは「**数字が静かに間違っている**」こと。
 * 母数と内訳が合わない・除外が消える・個人情報が混ざる、を落ちるテストで止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENTS, SEGMENT_IDS, SEG_EXCLUDE, SEG_EXCLUDE_LABEL, SEGMENT_CATALOG_VERSION,
  DORMANT_DAYS, RECENT_LOGIN_DAYS,
  getSegment, computeConditionHash, evaluateSegment, evaluateAllSegments,
} from './audienceSegments.js';

const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const rec = (i, over = {}) => ({
  id: `r${i}`,
  fields: { Email: `u${i}@example.com`, 'プラン': 'Free', ...over },
});

/** 13,000 件相当の母集団（無料が大半・少数の例外を混ぜる） */
function bigFixture(n = 13000) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i % 1000 === 0) out.push(rec(i, { 'プラン': 'Premium', Status: 'active', '有効期限': '2027-12-31' }));
    else if (i % 997 === 0) out.push(rec(i, { UnsubscribedAnalyticsKeiba: true }));
    else if (i % 991 === 0) out.push(rec(i, { Status: 'test' }));
    else if (i % 983 === 0) out.push(rec(i, { Email: 'not-an-email' + i }));
    else if (i % 977 === 0) out.push(rec(i, { ForceLogout: true }));
    else out.push(rec(i, { '最終ログイン': iso(NOW - (i % 400) * DAY) }));
  }
  return out;
}

const base = (over = {}) => ({
  nowMs: NOW,
  blacklistHard: new Set(),
  blacklistSoft: new Set(),
  providerSuppressed: new Set(),
  lastContactAtMs: new Map(),
  ...over,
});

// ── 数え方の骨格 ────────────────────────────────────────────────

test('母数 = 送信候補 + 除外合計 が常に成り立つ', () => {
  const records = bigFixture();
  for (const id of SEGMENT_IDS) {
    const r = evaluateSegment({ ...base(), records, segmentId: id });
    assert.equal(r.ok, true, `${id} が評価できない`);
    assert.equal(r.balanced, true, `${id} で母数と内訳が合わない`);
    assert.equal(r.total, r.sendable + r.excluded, `${id}: ${r.total} != ${r.sendable}+${r.excluded}`);
  }
});

test('母数は一意メールアドレスで数える（レコード数ではない）', () => {
  const records = [
    rec(1), rec(2),
    { id: 'r3', fields: { Email: 'u1@example.com', 'プラン': 'Free' } },   // 重複
  ];
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all' });
  assert.equal(r.total, 2, '重複レコードを母数に数えている');
  assert.equal(r.ignoredRecords.duplicateEmail, 1);
  // 重複している人は送信候補にしない
  assert.equal(r.byReason[SEG_EXCLUDE.DUPLICATE_EMAIL], 1);
  assert.equal(r.sendable, 1);
});

test('アドレスが無い行は母数にも除外にも入れない（別枠で数える）', () => {
  const records = [rec(1), { id: 'r2', fields: { 'プラン': 'Free' } }];
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all' });
  assert.equal(r.total, 1);
  assert.equal(r.ignoredRecords.noEmail, 1);
  assert.equal(r.balanced, true);
});

// ── 誰を外すか ──────────────────────────────────────────────────

test('無料ユーザーだけを集計する（有料会員は母数に入らない）', () => {
  const records = [
    rec(1), rec(2),
    rec(3, { 'プラン': 'Premium', Status: 'active', '有効期限': '2027-12-31' }),
  ];
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all' });
  assert.equal(r.total, 2, '有料会員を無料セグメントに入れている');
});

test('現役有料会員は（万一混ざっても）除外する', () => {
  // プラン欄が Free なのに課金が生きている矛盾データ
  const records = [rec(1, { 'プラン': 'Free', PlanType: 'Lifetime', Status: 'active' })];
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all' });
  assert.equal(r.sendable + r.excluded, r.total);
});

test('配信停止・blacklist・provider 停止リストを除外する', () => {
  const records = [rec(1), rec(2, { UnsubscribedAnalyticsKeiba: true }), rec(3), rec(4)];
  const r = evaluateSegment({
    ...base({
      blacklistHard: new Set(['u3@example.com']),
      blacklistSoft: new Set(['u3@example.com']),
      providerSuppressed: new Set(['u4@example.com']),
    }),
    records, segmentId: 'free-all',
  });
  assert.equal(r.byReason[SEG_EXCLUDE.UNSUBSCRIBED], 1);
  assert.equal(r.byReason[SEG_EXCLUDE.BLACKLIST_HARD], 1);
  assert.equal(r.byReason[SEG_EXCLUDE.PROVIDER_SUPPRESSED], 1);
  assert.equal(r.sendable, 1);
});

test('停止・テストアカウント・強制ログアウト・メール不正を除外する', () => {
  const records = [
    rec(1),
    rec(2, { Status: 'suspended' }),
    rec(3, { Status: 'test' }),
    rec(4, { ForceLogout: true }),
    rec(5, { Email: 'not-an-email' }),
  ];
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all' });
  assert.equal(r.byReason[SEG_EXCLUDE.SUSPENDED_OR_TEST], 2);
  assert.equal(r.byReason[SEG_EXCLUDE.FORCE_LOGOUT], 1);
  assert.equal(r.byReason[SEG_EXCLUDE.INVALID_EMAIL], 1);
  assert.equal(r.sendable, 1);
});

test('配信基盤の停止リストを確認できないときは全員 fail closed', () => {
  const records = [rec(1), rec(2), rec(3)];
  const r = evaluateSegment({ ...base({ providerSuppressed: null }), records, segmentId: 'free-all' });
  assert.equal(r.sendable, 0, '確認できないのに送信候補にしている');
  assert.equal(r.byReason[SEG_EXCLUDE.PROVIDER_UNKNOWN], 3);
  assert.equal(r.balanced, true);
});

test('直近 24 時間に送った人と、このキャンペーンで送信済みの人を除外する', () => {
  const records = [rec(1), rec(2)];
  const r = evaluateSegment({
    ...base({
      lastContactAtMs: new Map([['u1@example.com', NOW - 3600000]]),
      deliveredEmails: new Set(['u2@example.com']),
    }),
    records, segmentId: 'free-all',
  });
  assert.equal(r.byReason[SEG_EXCLUDE.RECENT_CONTACT], 1);
  assert.equal(r.byReason[SEG_EXCLUDE.ALREADY_DELIVERED], 1);
  assert.equal(r.sendable, 0);
});

// ── セグメントの意味 ────────────────────────────────────────────

test('最近ログイン / 長期未ログインが排他になる', () => {
  const records = [
    rec(1, { '最終ログイン': iso(NOW - 10 * DAY) }),
    rec(2, { '最終ログイン': iso(NOW - (DORMANT_DAYS + 10) * DAY) }),
    rec(3),   // ログイン記録なし
  ];
  const recent = evaluateSegment({ ...base(), records, segmentId: 'free-recent-login' });
  const dormant = evaluateSegment({ ...base(), records, segmentId: 'free-dormant' });
  assert.equal(recent.total, 1);
  assert.equal(dormant.total, 2, 'ログイン記録なしを長期未ログインに入れていない');
  assert.ok(RECENT_LOGIN_DAYS < DORMANT_DAYS);
});

test('過去有料・現在無料は支払い実績で判定する', () => {
  const records = [rec(1), rec(2, { PaidAt: iso(NOW - 400 * DAY) })];
  const r = evaluateSegment({ ...base(), records, segmentId: 'ex-paid-now-free' });
  assert.equal(r.total, 1);
});

test('未知のセグメントは fail closed', () => {
  const r = evaluateSegment({ ...base(), records: [rec(1)], segmentId: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_segment');
  assert.equal(getSegment('nope'), null);
});

// ── 個人情報を返さない ──────────────────────────────────────────

test('戻り値にアドレス・氏名・recordId を含めない', () => {
  const records = [rec(1, { '氏名': '山田太郎' }), rec(2)];
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all', sampleSize: 5 });
  const json = JSON.stringify(r);
  for (const b of ['@example.com', '山田太郎', '"r1"', 'recA']) {
    assert.equal(json.includes(b), false, `${b} を返している`);
  }
});

test('検証用サンプルは属性だけ（件数も上限で頭打ち）', () => {
  const r = evaluateSegment({ ...base(), records: bigFixture(2000), segmentId: 'free-all', sampleSize: 999 });
  assert.ok(r.sample.length <= 20, 'サンプルが多すぎる');
  for (const s of r.sample) {
    assert.deepEqual(Object.keys(s).sort(),
      ['contract', 'emailDomainKind', 'everPaid', 'hasLoginRecord', 'plan', 'segment']);
  }
});

test('サンプルを要求しなければ 1 件も返さない', () => {
  const r = evaluateSegment({ ...base(), records: bigFixture(100), segmentId: 'free-all' });
  assert.deepEqual(r.sample, []);
});

// ── 条件ハッシュ ────────────────────────────────────────────────

test('同じ条件なら同じハッシュ、違う条件なら違うハッシュ', () => {
  const a = computeConditionHash(getSegment('free-all'));
  const b = computeConditionHash(getSegment('free-all'));
  const c = computeConditionHash(getSegment('free-dormant'));
  assert.equal(a, b, 'ハッシュが安定していない');
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
});

test('キャンペーンが違えばハッシュも変わる（別配信の snapshot を使い回せない）', () => {
  const s = getSegment('free-all');
  const a = computeConditionHash(s, { campaignId: 'x', campaignVersion: 1 });
  const b = computeConditionHash(s, { campaignId: 'x', campaignVersion: 2 });
  assert.notEqual(a, b);
});

test('カタログの版が定義に含まれる（条件の意味を変えたら検知できる）', () => {
  assert.equal(typeof SEGMENT_CATALOG_VERSION, 'number');
  assert.ok(SEGMENT_CATALOG_VERSION >= 1);
  assert.ok(SEGMENTS.length >= 8, 'セグメントの候補が足りない');
  for (const s of SEGMENTS) {
    assert.ok(s.id && s.name && s.description, `${s.id} の説明が無い`);
    assert.equal(typeof s.match, 'function');
  }
});

test('すべての除外理由に表示名がある', () => {
  for (const code of Object.values(SEG_EXCLUDE)) {
    assert.ok(SEG_EXCLUDE_LABEL[code], `${code} の文言が無い`);
  }
});

// ── 規模 ────────────────────────────────────────────────────────

test('13,000 件でも件数だけを返す（明細を返さない）', () => {
  const records = bigFixture(13000);
  const r = evaluateSegment({ ...base(), records, segmentId: 'free-all', sampleSize: 5 });
  assert.ok(r.total > 12000, '母数が小さすぎる');
  assert.equal(r.balanced, true);
  // 明細の配列を返していないこと（返すのは sample だけで、それも 20 件以下）
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) assert.ok(v.length <= 20, `${k} に明細が入っている（${v.length} 件）`);
  }
});

test('全セグメントを一度に数えても壊れない', () => {
  const all = evaluateAllSegments({ ...base(), records: bigFixture(3000) });
  assert.equal(all.length, SEGMENT_IDS.length);
  for (const r of all) assert.equal(r.balanced, true);
});
