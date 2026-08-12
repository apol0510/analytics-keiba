/**
 * engagementGuard.test.mjs — 「反応が無い相手を除外してよいか」の判定
 *   node --test src/lib/marketing/engagementGuard.test.mjs
 *
 * 重点（ここが崩れると開封している人を切る）:
 *   - 材料が 1 つでも欠けたら **誰も除外しない**（fail closed）
 *   - 「open=0 と確認できた」と「open データが無い」を混同しない
 *   - 数えるのは **記録を始めて以降の配信だけ**
 *   - 閾値は engagementPolicy.js の 5 / 10 / 20 をそのまま使う（複製しない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  resolveGuardMode, resolveCoverageSince, resolveEngagementCoverage,
  mapSignalsToEmails, buildEngagementView, engagementCountsView,
  GUARD_SKIP, GUARD_ACTIVE, DEFAULT_MAX_SIGNAL_AGE_MS,
} from './engagementGuard.js';
import { DEFAULT_THRESHOLDS, ENGAGEMENT } from './engagementPolicy.js';

const NOW = Date.UTC(2026, 7, 12, 0, 0);
const DAY = 86400000;
const START = NOW - 200 * DAY;     // 集計を始めた時刻
const hashOf = (e) => createHash('sha256').update(e, 'utf8').digest('hex').slice(0, 32);

const MEASURED = { open: 'enabled', click: 'disabled' };

/** 反応の集計（既定: 開封の記録が 1 件あり、直近にイベントを受けている） */
function signals(over = {}) {
  return {
    available: true,
    openByHash: over.openByHash || new Map([[hashOf('opener@example.com'), NOW - DAY]]),
    clickByHash: over.clickByHash || new Map(),
    meta: {
      startedAtMs: START, firstOpenAtMs: START + DAY, lastEventAtMs: NOW - 3600000,
      ...(over.meta || {}),
    },
    ...(over.available === undefined ? {} : { available: over.available }),
  };
}

const customer = (email, fields = {}) => ({ recordId: `rec${email}`, fields: { Email: email, ...fields } });

/** CampaignDeliveries の 1 行（既定は記録開始後） */
const delivery = (email, atMs = NOW - DAY, status = 'sent') => ({
  fields: {
    EmailType: 'campaign', RecipientEmail: email, Status: status,
    SentAt: new Date(atMs).toISOString(),
  },
});

const sends = (email, n, atMs = NOW - DAY) => Array.from({ length: n }, () => delivery(email, atMs));

// ── 適用可否（fail closed）──────────────────────────────────
test('材料が揃えば適用する', () => {
  const c = resolveEngagementCoverage({ signals: signals(), measurement: MEASURED, nowMs: NOW, env: {} });
  assert.equal(c.usable, true);
  assert.equal(c.reason, GUARD_ACTIVE);
  assert.equal(c.sinceMs, START);
});

test('【停止】MARKETING_ENGAGEMENT_GUARD=off なら誰も除外しない', () => {
  const env = { MARKETING_ENGAGEMENT_GUARD: 'off' };
  assert.equal(resolveGuardMode(env), 'off');
  const c = resolveEngagementCoverage({ signals: signals(), measurement: MEASURED, nowMs: NOW, env });
  assert.equal(c.usable, false);
  assert.equal(c.reason, GUARD_SKIP.OFF);
});

test('未設定・未知の値は停止扱いにしない（auto）', () => {
  assert.equal(resolveGuardMode({}), 'auto');
  assert.equal(resolveGuardMode({ MARKETING_ENGAGEMENT_GUARD: 'yes' }), 'auto');
});

test('【fail closed】集計を読めなければ適用しない', () => {
  const c = resolveEngagementCoverage({
    signals: { available: false, openByHash: new Map(), clickByHash: new Map(), meta: {} },
    measurement: MEASURED, nowMs: NOW, env: {},
  });
  assert.equal(c.usable, false);
  assert.equal(c.reason, GUARD_SKIP.STORE_UNAVAILABLE);
});

test('【fail closed】開封を計測していない / 状態が不明なら適用しない', () => {
  for (const m of [{ open: 'disabled' }, { open: 'unknown' }, null]) {
    const c = resolveEngagementCoverage({ signals: signals(), measurement: m, nowMs: NOW, env: {} });
    assert.equal(c.usable, false);
    assert.equal(c.reason, GUARD_SKIP.OPEN_NOT_MEASURED);
  }
});

test('【fail closed】開封の記録が 1 件も無いうちは適用しない（届いている証拠が無い）', () => {
  const c = resolveEngagementCoverage({
    signals: signals({ openByHash: new Map() }), measurement: MEASURED, nowMs: NOW, env: {},
  });
  assert.equal(c.usable, false);
  assert.equal(c.reason, GUARD_SKIP.NO_OPEN_RECORDED);
});

test('【fail closed】イベントの受信が途絶えていたら適用しない（Webhook 停止の疑い）', () => {
  const stale = signals({ meta: { lastEventAtMs: NOW - DEFAULT_MAX_SIGNAL_AGE_MS - 1000 } });
  const c = resolveEngagementCoverage({ signals: stale, measurement: MEASURED, nowMs: NOW, env: {} });
  assert.equal(c.usable, false);
  assert.equal(c.reason, GUARD_SKIP.SIGNAL_STALE);

  const never = signals({ meta: { lastEventAtMs: null } });
  assert.equal(
    resolveEngagementCoverage({ signals: never, measurement: MEASURED, nowMs: NOW, env: {} }).reason,
    GUARD_SKIP.SIGNAL_STALE,
  );
});

test('【fail closed】記録開始時刻が無ければ適用しない', () => {
  const c = resolveEngagementCoverage({
    signals: signals({ meta: { startedAtMs: null } }), measurement: MEASURED, nowMs: NOW, env: {},
  });
  assert.equal(c.usable, false);
  assert.equal(c.reason, GUARD_SKIP.NO_COVERAGE_START);
});

// ── 数える期間 ──────────────────────────────────────────────
test('期間は env で後ろへずらせるが、記録開始より前へは戻せない', () => {
  const meta = { startedAtMs: START };
  assert.equal(resolveCoverageSince({ meta, env: {} }), START);
  assert.equal(
    resolveCoverageSince({ meta, env: { MARKETING_ENGAGEMENT_COVERAGE_SINCE: String(START + DAY) } }),
    START + DAY, '後ろへはずらせる',
  );
  assert.equal(
    resolveCoverageSince({ meta, env: { MARKETING_ENGAGEMENT_COVERAGE_SINCE: String(START - 50 * DAY) } }),
    START, '記録していない期間まで遡らない',
  );
  assert.equal(
    resolveCoverageSince({ meta, env: { MARKETING_ENGAGEMENT_COVERAGE_SINCE: 'こわれた値' } }),
    START, '壊れた値で緩めない',
  );
  assert.equal(
    resolveCoverageSince({ meta, env: { MARKETING_ENGAGEMENT_COVERAGE_SINCE: '2026-08-01T00:00:00Z' } }),
    Date.parse('2026-08-01T00:00:00Z'), 'ISO も受ける',
  );
});

// ── hash → アドレス ─────────────────────────────────────────
test('EmailHash の集計をアドレスへ引き直す', () => {
  const s = signals({
    openByHash: new Map([[hashOf('opener@example.com'), NOW - DAY]]),
    clickByHash: new Map([[hashOf('clicker@example.com'), NOW - DAY]]),
  });
  const m = mapSignalsToEmails({ emails: ['Opener@Example.com', 'clicker@example.com', 'silent@example.com'], signals: s });
  assert.equal(m.openByEmail.get('opener@example.com'), 1);
  assert.equal(m.openedAtMs.get('opener@example.com'), NOW - DAY);
  assert.equal(m.clickByEmail.get('clicker@example.com'), 1);
  assert.equal(m.openByEmail.has('silent@example.com'), false);
});

// ── 境界（4/5/9/10/19/20）────────────────────────────────────
const view = (list, deliveries, over = {}) => buildEngagementView({
  list, deliveries, signals: signals(), measurement: MEASURED, nowMs: NOW, env: {}, ...over,
});

test('閾値は engagementPolicy の 5 / 10 / 20 をそのまま使う', () => {
  const v = view([customer('a@example.com')], []);
  assert.deepEqual(v.thresholds, DEFAULT_THRESHOLDS);
  assert.equal(v.thresholds.lowEngagementSends, 5);
  assert.equal(v.thresholds.inactiveDelivered, 10);
  assert.equal(v.thresholds.hardInactiveDelivered, 20);
});

test('境界: 4 通=判断材料なし / 5 通=観察のみ（どちらも除外しない）', () => {
  const v4 = view([customer('a@example.com')], sends('a@example.com', 4));
  assert.equal(v4.counts[ENGAGEMENT.UNKNOWN], 1);
  assert.equal(v4.blockedEmails.size, 0);

  const v5 = view([customer('a@example.com')], sends('a@example.com', 5));
  assert.equal(v5.counts[ENGAGEMENT.LOW_ENGAGEMENT], 1);
  assert.equal(v5.blockedEmails.size, 0, 'LOW_ENGAGEMENT は観察段階。止めない');
});

test('境界: 9 通=止めない / 10 通=除外 / 19 通=除外 / 20 通=強い除外', () => {
  const v9 = view([customer('a@example.com')], sends('a@example.com', 9));
  assert.equal(v9.blockedEmails.size, 0);

  const v10 = view([customer('a@example.com')], sends('a@example.com', 10));
  assert.equal(v10.counts[ENGAGEMENT.INACTIVE], 1);
  assert.ok(v10.blockedEmails.has('a@example.com'));

  const v19 = view([customer('a@example.com')], sends('a@example.com', 19));
  assert.equal(v19.counts[ENGAGEMENT.INACTIVE], 1);

  const v20 = view([customer('a@example.com')], sends('a@example.com', 20));
  assert.equal(v20.counts[ENGAGEMENT.HARD_INACTIVE], 1);
  assert.ok(v20.blockedEmails.has('a@example.com'));
});

// ── 反応があれば除外しない ───────────────────────────────────
test('開封が 1 回でもあれば ACTIVE（何通送っていても除外しない）', () => {
  const v = view([customer('opener@example.com')], sends('opener@example.com', 30));
  assert.equal(v.counts[ENGAGEMENT.ACTIVE], 1);
  assert.equal(v.blockedEmails.size, 0);
});

test('購入・ログインがあれば ACTIVE へ復帰する（開封が無くても）', () => {
  const paid = view([customer('a@example.com', { PaidAt: '2026-01-01' })], sends('a@example.com', 30));
  assert.equal(paid.blockedEmails.size, 0);
  assert.equal(paid.counts[ENGAGEMENT.ACTIVE], 1);

  const logged = view([customer('b@example.com', { LastLoginAt: '2026-06-01' })], sends('b@example.com', 30));
  assert.equal(logged.blockedEmails.size, 0);
});

// ── 期間の絞り込み ──────────────────────────────────────────
test('【重要】記録開始より前の配信は数えない（無反応と見なさない）', () => {
  const before = sends('a@example.com', 30, START - 10 * DAY);
  const v = view([customer('a@example.com')], before);
  assert.equal(v.blockedEmails.size, 0, '観測できていない期間の送信で切ってはいけない');
  assert.equal(v.counts[ENGAGEMENT.UNKNOWN], 1);
});

test('送信時刻が読めない配信行は数えない（期間内だと証明できない）', () => {
  const noTime = Array.from({ length: 30 }, () => ({
    fields: { EmailType: 'campaign', RecipientEmail: 'a@example.com', Status: 'sent' },
  }));
  const v = view([customer('a@example.com')], noTime);
  assert.equal(v.blockedEmails.size, 0);
});

test('適用できないときは engagementByEmail が null（送信計画は素通り）', () => {
  const v = buildEngagementView({
    list: [customer('a@example.com')], deliveries: sends('a@example.com', 30),
    signals: signals(), measurement: { open: 'disabled' }, nowMs: NOW, env: {},
  });
  assert.equal(v.applied, false);
  assert.equal(v.engagementByEmail, null);
  assert.equal(v.blockedEmails.size, 0, '適用できないなら 1 人も除外しない');
  assert.ok(v.reasonLabel, '理由は必ず日本語で返す（画面で「0 名」と誤読させない）');
  // 参考値としての内訳は出す（期間で絞らない素の数字）
  assert.equal(v.counts[ENGAGEMENT.HARD_INACTIVE], 1);
});

test('適用中は Map を返し、除外対象が数えられる', () => {
  const v = view(
    [customer('a@example.com'), customer('opener@example.com')],
    [...sends('a@example.com', 12), ...sends('opener@example.com', 12)],
  );
  assert.equal(v.applied, true);
  assert.ok(v.engagementByEmail instanceof Map);
  assert.deepEqual([...v.blockedEmails], ['a@example.com']);
  assert.equal(v.coverage.sinceMs, START);
});

test('画面向けの内訳は 5 区分すべてを 0 込みで返す', () => {
  const v = view([customer('a@example.com')], []);
  const c = engagementCountsView(v.counts);
  assert.deepEqual(Object.keys(c).sort(),
    ['active', 'hardInactive', 'inactive', 'lowEngagement', 'unknown']);
  assert.equal(c.inactive, 0);
});
