/**
 * engagementSuppressionCohort.test.mjs — 反応なし除外を「取り込みコホート」で運用する
 *   node --test src/lib/marketing/engagementSuppressionCohort.test.mjs
 *
 * 仕様の正本: docs/spec.md §反応なし除外は取り込みコホートで運用する ／
 *             docs/decisions.md 2026-08-26。
 *
 * 守る条件:
 *   1. **累計 10 通 delivered で開封 0** の相手はマーケティング配信から外れる
 *   2. **取り込み由来と既存顧客を区別**して数えられる
 *   3. **送信直前にも再判定**する（キュー登録後に閾値へ達した相手を送らない）
 *   4. 材料が欠けていれば **1 人も除外しない**（観測できていないだけの相手を切らない）
 *   5. 取引メール（決済・認証・サポート・期限通知）には影響しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveCohort, countByCohort, summarizeCohortExclusion, isImportSource, importBatchId, COHORT,
} from './importCohort.js';
import {
  createEngagementBlocklistStore, emptyBlocklist, BLOCKLIST_SKIP, DEFAULT_MAX_AGE_MS,
} from './engagementBlocklistStore.js';
import { classifyEngagement, isBlockedByEngagement, DEFAULT_THRESHOLDS, ENGAGEMENT } from './engagementPolicy.js';
import { buildEngagementView } from './engagementGuard.js';
import { hashEmailForSignal } from './engagementSignalStore.js';
import {
  readSequenceGates, readSequenceAutoState, resolveMaxRecipientsPerTick,
  MAX_RECIPIENTS_PER_TICK, SEQUENCE_ENV,
} from './sequenceAutomation.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const DISPATCH = read('../../../netlify/functions/marketing-campaign-dispatch.js');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');

// ── 1. 10 通・開封 0 で外れる ──────────────────────────────────
test('【要件】累計 10 通 delivered で開封 0 の相手は配信対象から外れる', () => {
  const t = DEFAULT_THRESHOLDS;
  assert.equal(t.inactiveDelivered, 10, '閾値が 10 から変わっている');

  const noOpen = { sent: 12, delivered: 10, open: 0, click: 0, purchases: 0, logins: 0 };
  const { state } = classifyEngagement(noOpen, { thresholds: t });
  assert.equal(state, ENGAGEMENT.INACTIVE);
  assert.equal(isBlockedByEngagement(state), true, '10 通・開封 0 が除外されない');
});

test('9 通までは外さない（材料が足りないうちに切らない）', () => {
  const nine = { sent: 9, delivered: 9, open: 0, click: 0, purchases: 0, logins: 0 };
  assert.equal(isBlockedByEngagement(classifyEngagement(nine, { thresholds: DEFAULT_THRESHOLDS }).state), false);
});

test('1 回でも開封していれば外さない（Apple MPP を考慮し open は「反応あり」へ倒すだけ）', () => {
  const opened = { sent: 30, delivered: 30, open: 1, click: 0, purchases: 0, logins: 0 };
  const { state } = classifyEngagement(opened, { thresholds: DEFAULT_THRESHOLDS });
  assert.equal(state, ENGAGEMENT.ACTIVE);
  assert.equal(isBlockedByEngagement(state), false);
});

test('購入・ログインは開封より強いシグナル（開封 0 でも外さない）', () => {
  for (const extra of [{ purchases: 1 }, { logins: 1 }]) {
    const s = { sent: 30, delivered: 30, open: 0, click: 0, purchases: 0, logins: 0, ...extra };
    assert.equal(isBlockedByEngagement(classifyEngagement(s, { thresholds: DEFAULT_THRESHOLDS }).state), false,
      JSON.stringify(extra));
  }
});

// ── 2. コホートの区別 ─────────────────────────────────────────
test('【要件】取り込み由来と既存顧客を区別する', () => {
  assert.equal(resolveCohort({ Source: 'customer-import:imp-2026-08-09-001' }), COHORT.IMPORTED);
  assert.equal(importBatchId('customer-import:imp-2026-08-09-001'), 'imp-2026-08-09-001');
  assert.equal(isImportSource('customer-import:x'), true);
  // 取り込み以外・不明は既存顧客（自動除外の対象を勝手に広げない）
  for (const src of ['admin', 'ak:marketing-automation:x', '', null, undefined]) {
    assert.equal(resolveCohort({ Source: src }), COHORT.EXISTING, String(src));
  }
  assert.equal(resolveCohort(null), COHORT.EXISTING);
});

test('【要件】除外人数をコホート別に数えられる（管理画面に出す材料）', () => {
  const list = [
    { fields: { Email: 'a@x.com', Source: 'customer-import:imp-1' } },
    { fields: { Email: 'b@x.com', Source: 'customer-import:imp-1' } },
    { fields: { Email: 'c@x.com', Source: 'admin' } },
    { fields: { Email: 'd@x.com' } },
  ];
  assert.deepEqual(countByCohort(list), { imported: 2, existing: 2, total: 4 });

  const s = summarizeCohortExclusion({ list, blockedEmails: new Set(['a@x.com', 'c@x.com']) });
  assert.deepEqual(s.audience, { imported: 2, existing: 2, total: 4 });
  assert.deepEqual(s.blocked, { imported: 1, existing: 1, total: 2 });
});

// ── 3. 送信直前の再判定 ───────────────────────────────────────
function memoryStore() {
  const mem = { set: new Set(), meta: null };
  const redisCmd = async ([op, key, ...rest]) => {
    if (op === 'DEL') { mem.set.clear(); return 1; }
    if (op === 'SADD') { rest.forEach((x) => mem.set.add(x)); return rest.length; }
    if (op === 'SET') { mem.meta = rest[0]; return 'OK'; }
    if (op === 'SMEMBERS') return [...mem.set];
    if (op === 'GET') return mem.meta;
    throw new Error('unexpected ' + op);
  };
  return { store: createEngagementBlocklistStore({ redisCmd }), mem };
}

test('【要件】送信直前に読む一覧へ書いて読める（アドレスは小文字で揃う）', async () => {
  const { store } = memoryStore();
  const now = Date.parse('2026-08-26T00:00:00Z');
  await store.write({ emails: new Set(['A@x.com', 'b@x.com']), computedAtMs: now });
  const r = await store.read({ nowMs: now });
  assert.equal(r.usable, true);
  assert.equal(r.count, 2);
  assert.deepEqual([...r.emails].sort(), ['a@x.com', 'b@x.com']);
});

test('【fail closed】古い一覧では 1 人も除外しない', async () => {
  const { store } = memoryStore();
  const now = Date.parse('2026-08-26T00:00:00Z');
  await store.write({ emails: new Set(['a@x.com']), computedAtMs: now });
  const stale = await store.read({ nowMs: now + DEFAULT_MAX_AGE_MS + 1 });
  assert.equal(stale.usable, false);
  assert.equal(stale.reason, BLOCKLIST_SKIP.STALE);
  assert.equal(stale.emails.size, 0);
});

test('【fail closed】読めない / 空 のときも 1 人も除外しない', async () => {
  const broken = createEngagementBlocklistStore({ redisCmd: async () => { throw new Error('down'); } });
  const r = await broken.read({ nowMs: Date.now() });
  assert.equal(r.usable, false);
  assert.equal(r.reason, BLOCKLIST_SKIP.UNAVAILABLE);
  assert.equal(r.emails.size, 0);

  const { store } = memoryStore();
  const empty = await store.read({ nowMs: Date.now() });
  assert.equal(empty.usable, false);
  assert.equal(empty.emails.size, 0);
  assert.equal(emptyBlocklist('x').emails.size, 0);
});

test('redis が無ければ store を作れない（黙って素通りしない）', () => {
  assert.throws(() => createEngagementBlocklistStore({}), /redis_not_configured/);
});

// ── 4. 配線されていること（実装が外れたら落とす）──────────────────
test('【配線】dispatcher が送信直前に一覧を読み、該当者を送らない', () => {
  assert.match(DISPATCH, /createEngagementBlocklistStore/, 'dispatcher が一覧を読んでいない');
  assert.match(DISPATCH, /engagementBlocked\s*&&\s*engagementBlocked\.has\(email\)/, '送信直前に照合していない');
  assert.match(DISPATCH, /engagement_blocked_imported/, 'コホート別の理由を記録していない');
  assert.match(DISPATCH, /engagement_blocked_existing/);
  // 読めないときは null ＝ 誰も除外しない
  assert.match(DISPATCH, /blocklist\.usable \? blocklist\.emails : null/, 'fail closed の向きが違う');
});

test('【配線】enqueue 側は判定できたときだけ一覧を書く', () => {
  assert.match(ADMIN, /createEngagementBlocklistStore/, 'enqueue 側が一覧を書いていない');
  assert.match(ADMIN, /view\.applied === true/, '材料が欠けた状態の結果を保存してしまう');
});

// ── 5. 取引メールに影響しない ─────────────────────────────────
test('【要件】取引メールの経路はこの一覧を参照しない', () => {
  for (const fn of ['confirm-bank-payment.js', 'send-magic-link.js', 'send-payment-confirmation-auto.js']) {
    const src = read(`../../../netlify/functions/${fn}`);
    assert.equal(src.includes('engagementBlocklistStore'), false, `${fn} が配信除外を参照している`);
    assert.equal(src.includes('engagementGuard'), false, `${fn} が反応なし判定を参照している`);
  }
});


// ── 6. 自動除外は取り込みコホートだけ（2026-08-26 MK 確定）──────────
const NOW6 = Date.parse('2026-08-26T00:00:00Z');
const DAY6 = 24 * 60 * 60 * 1000;

/** 開封の記録がある状態（guard が適用できる材料が揃っている） */
function signalsFixture() {
  return {
    available: true,
    // 「開封が 1 件も無い」だと guard は適用されない（記録が届いている証拠が無いため）
    openByHash: new Map([[hashEmailForSignal('opener@example.invalid'), NOW6 - DAY6]]),
    clickByHash: new Map(),
    meta: { startedAtMs: NOW6 - 90 * DAY6, firstOpenAtMs: NOW6 - 89 * DAY6, lastEventAtMs: NOW6 - 3600000 },
  };
}

function viewFor(list) {
  // 10 通 delivered / 開封 0 を作る
  const deliveries = [];
  for (const c of list) {
    for (let i = 0; i < 10; i += 1) {
      deliveries.push({ fields: {
        EmailType: 'campaign', RecipientEmail: c.fields.Email, Status: 'sent',
        SentAt: new Date(NOW6 - (i + 1) * DAY6).toISOString(),
      } });
    }
  }
  return buildEngagementView({
    list, deliveries, nowMs: NOW6, env: {},
    signals: signalsFixture(),
    measurement: { open: 'enabled' },
  });
}

test('【要件】自動除外は CSV 取り込み由来だけに効く（既存顧客には効かない）', () => {
  const imported = { recordId: 'r1', fields: { Email: 'imp@x.com', Source: 'customer-import:imp-1' } };
  const existing = { recordId: 'r2', fields: { Email: 'old@x.com', Source: 'admin' } };
  const unknown = { recordId: 'r3', fields: { Email: 'unk@x.com' } };

  const view = viewFor([imported, existing, unknown]);
  assert.equal(view.applied, true, '前提: 判定が適用できている');
  assert.equal(view.blockedEmails.has('imp@x.com'), true, '取り込み由来が除外されない');
  assert.equal(view.blockedEmails.has('old@x.com'), false, '既存顧客まで除外している');
  assert.equal(view.blockedEmails.has('unk@x.com'), false, '判断材料が無い会員まで除外している');
  assert.deepEqual(view.suppressionCohorts, [COHORT.IMPORTED]);
});

test('既存顧客まで広げたいときは明示的に渡さないと広がらない', () => {
  const list = [
    { recordId: 'r1', fields: { Email: 'imp@x.com', Source: 'customer-import:imp-1' } },
    { recordId: 'r2', fields: { Email: 'old@x.com', Source: 'admin' } },
  ];
  const deliveries = [];
  for (const c of list) {
    for (let i = 0; i < 10; i += 1) {
      deliveries.push({ fields: {
        EmailType: 'campaign', RecipientEmail: c.fields.Email, Status: 'sent',
        SentAt: new Date(NOW6 - (i + 1) * DAY6).toISOString(),
      } });
    }
  }
  const both = buildEngagementView({
    list, deliveries, nowMs: NOW6, env: {},
    signals: signalsFixture(),
    measurement: { open: 'enabled' },
    suppressionCohorts: [COHORT.IMPORTED, COHORT.EXISTING],
  });
  assert.equal(both.blockedEmails.has('old@x.com'), true);
});

// ── 7. 完全自動運用（MK の毎日の操作を要求しない）────────────────
const OPEN_ENV_7 = {
  [SEQUENCE_ENV.SCHEDULER]: 'true',
  [SEQUENCE_ENV.ENQUEUE]: 'true',
  [SEQUENCE_ENV.DISPATCH]: 'true',
};

test('【要件】日付 ARM を毎日書き換えなくても自動で動く', () => {
  const g = readSequenceGates(OPEN_ENV_7, NOW6);
  assert.equal(g.allOpen, true, 'まだ日付 ARM を要求している');
  assert.equal(g.armMode, 'always');
  assert.deepEqual(g.missing, []);
  assert.equal(readSequenceAutoState(OPEN_ENV_7, NOW6).enabled, true);
});

test('【要件】止める手段は残っている（kill switch）', () => {
  for (const key of [SEQUENCE_ENV.SCHEDULER, SEQUENCE_ENV.DISPATCH, SEQUENCE_ENV.ENQUEUE]) {
    const env = { ...OPEN_ENV_7 };
    delete env[key];
    assert.equal(readSequenceGates(env, NOW6).allOpen, false, `${key} を外しても止まらない`);
  }
});

test('【要件】1 tick の上限が 15,000 名を同じ日に配り切れる大きさ', () => {
  assert.equal(MAX_RECIPIENTS_PER_TICK, 500);
  // 10 分間隔 = 1 日 144 tick。500 × 144 = 72,000 通/日 ＞ 15,000
  const perDay = MAX_RECIPIENTS_PER_TICK * 144;
  assert.ok(perDay >= 15000, `1 日 ${perDay} 通では 15,000 名を配り切れない`);
  // 15,000 名なら 30 tick = 5 時間で完走する
  assert.ok(Math.ceil(15000 / MAX_RECIPIENTS_PER_TICK) * 10 <= 24 * 60, '同じ日に終わらない');
});

test('1 tick の上限は env で下げられる（壊れた値は既定へ）', () => {
  assert.equal(resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: '100' }), 100);
  for (const bad of ['0', '-1', 'abc', '', undefined, '99999']) {
    assert.equal(resolveMaxRecipientsPerTick({ MARKETING_SEQUENCE_MAX_PER_TICK: bad }),
      MAX_RECIPIENTS_PER_TICK, String(bad));
  }
});

test('【配線】cron が 10 分間隔で動く（1 日 1 回では配り切れない）', () => {
  const cron = read('../../../netlify/functions/cron-campaign-sequence.js');
  assert.match(cron, /schedule: '\*\/10 \* \* \* \*'/, 'cron が 10 分間隔になっていない');
  assert.match(cron, /resolveMaxRecipientsPerTick/, '1 tick の上限を env から読んでいない');
});

// ── 8. 3 区分とも自動で回る（1 本だけ進める実装では足りない）──────────
test('【要件】env 指定が無ければ有効な連続配信をすべて自動で進める', async () => {
  const { resolveTickCampaignIds } = await import('../../../netlify/functions/cron-campaign-sequence.js');
  const ids = resolveTickCampaignIds({});
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    assert.ok(ids.includes(id), `${id} が自動対象に入っていない（手動送信が必要なままになる）`);
  }
});

test('env で対象を絞れる（障害時・段階運用のため）', async () => {
  const { resolveTickCampaignIds } = await import('../../../netlify/functions/cron-campaign-sequence.js');
  assert.deepEqual(
    resolveTickCampaignIds({ MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free, campaign-discount-light' }),
    ['campaign-discount-free', 'campaign-discount-light'],
  );
  assert.deepEqual(resolveTickCampaignIds({ MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free' }),
    ['campaign-discount-free']);
});

test('停止中のキャンペーンは自動対象に入らない（期間外は送らない）', async () => {
  const { resolveTickCampaignIds } = await import('../../../netlify/functions/cron-campaign-sequence.js');
  const ids = resolveTickCampaignIds({});
  assert.equal(ids.includes('general-announcement'), false, '停止中まで自動で進めている');
  assert.equal(ids.includes('sanrenpuku-offer'), false);
});
