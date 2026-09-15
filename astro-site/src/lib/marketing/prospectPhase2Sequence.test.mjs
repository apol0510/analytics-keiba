/**
 * prospectPhase2Sequence.test.mjs — **第 1 期 3 通 + 第 2 期 7 通 = delivered 10**
 *   node --test src/lib/marketing/prospectPhase2Sequence.test.mjs
 *
 * ## なぜ要るか（2026-09-15 実測）
 *
 * 打ち切りの分母は **delivered 10 通**（`resolveProspectCutoff()`）で、
 * **キャンペーン単位ではなく「その人」に積む**。
 * ところが prospect が受け取れるのは `campaign-discount-free` の **3 通だけ**で、
 * **10 に永久に届かなかった**（索引 11,969 件の delivered 最大が 4）。
 *
 * 第 2 期 7 通を後段に置き、3 + 7 = **10** で打ち切りに届くようにする。
 *
 * ## 固定すること
 *
 *   1. 第 2 期は **7 step**・**prospect 専用**
 *   2. **第 1 期 3 通を 1 バイトも変えない**（version / 既送 step / DeliveryKey）
 *   3. delivered 9 では打ち切らない・**10 で EXHAUSTED**
 *   4. **ENGAGED は 10 delivered でも打ち切らない**
 *   5. EXHAUSTED は候補に戻らない・積まれない・送信直前でも落ちる
 *   6. bounce / 苦情 / 配信停止は従来どおり **即 SUPPRESSED**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign, listCampaigns, validateCampaignSequences } from './campaignCatalog.js';
import {
  getSequenceSteps, resolveMaxSends, resolveAudienceSource, resolveSequenceRunner,
  SEQUENCE_RUNNER,
} from './campaignSequence.js';
import { computeCampaignContentHash } from './campaignSend.js';
import {
  PROSPECT_STATE, applyDelivered, applyEngagement, applySuppression,
  evaluateProspectForSend, classifyEvent, planProspectIntake,
  SKIP_REASON, SUPPRESS_REASON,
} from './prospectPolicy.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveProspectCutoff } from './prospectEngagement.js';

const PHASE1 = 'campaign-discount-free';
const PHASE2 = 'campaign-prospect-phase2';
const c1 = () => getCampaign(PHASE1, { includeDisabled: true });
const c2 = () => getCampaign(PHASE2, { includeDisabled: true });
/** 送ってよいか（既存の単一源をそのまま使う）*/
const canSend = (p) => evaluateProspectForSend({ prospect: p, nowMs: Date.parse('2030-01-01T00:00:00Z') });

// ══════════════════════════════════════════════════════════════════
//  ① 形（7 通・prospect 専用）
// ══════════════════════════════════════════════════════════════════

test('【重要】第 2 期は 7 step', () => {
  const c = c2();
  assert.ok(c, `${PHASE2} が無い`);
  assert.equal(getSequenceSteps(c).length, 7);
  assert.equal(resolveMaxSends(c), 7);
});

test('【重要】第 2 期は prospect 専用（Customers / DRM へ入らない）', () => {
  assert.equal(resolveAudienceSource(c2()), 'prospect');
  // 他の campaign の audience を巻き込んでいないこと
  for (const id of ['free-signup-onboarding', 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence']) {
    const c = getCampaign(id, { includeDisabled: true });
    assert.equal(resolveAudienceSource(c), 'customer', `${id} の audience が変わっている`);
  }
});

test('【重要】第 2 期は共有 cron が担当（env 名指しに頼らない）', () => {
  assert.equal(resolveSequenceRunner(c2()), SEQUENCE_RUNNER.CAMPAIGN_SEQUENCE);
  // 有効なので、env 未設定でも自動選択の対象に入る
  const auto = listCampaigns({ includeDisabled: false })
    .filter((c) => c.usable !== false && c.sequence)
    .map((c) => c.campaignId);
  assert.ok(auto.includes(PHASE2), '有効な第 2 期が自動選択に入っていない');
});

test('カタログ検証（重複・煽り・実績手書き・間隔）を通る', () => {
  const r = validateCampaignSequences();
  assert.equal(r.ok, true, (r.errors || []).join(' / '));
});

test('【重要】7 通の件名・本文はすべて異なる（同じメールの繰り返しでない）', () => {
  const steps = getSequenceSteps(c2());
  assert.equal(new Set(steps.map((s) => s.subject)).size, 7);
  assert.equal(new Set(steps.map((s) => s.body)).size, 7);
});

test('【重要】金額を手書きしない（¥ の直書きが無い）', () => {
  const steps = getSequenceSteps(c2());
  for (const s of steps) {
    const t = `${s.subject} ${s.body} ${(s.benefitItems || []).join(' ')}`;
    assert.equal(/¥\s*\d/.test(`${s.subject} ${s.body}`), false,
      `step${s.stepNumber}: 本文に金額を直書きしている`);
    assert.ok(t.length > 0);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② 第 1 期を壊していない
// ══════════════════════════════════════════════════════════════════

test('【最重要】第 1 期は 3 step・version 1 のまま（既送 step の鍵を変えない）', () => {
  const c = c1();
  assert.equal(getSequenceSteps(c).length, 3, '第 1 期のステップ数が変わっている');
  assert.equal(c.version, 1, '第 1 期の version が変わっている（＝送信済みの人へ再送になる）');
  assert.equal(resolveAudienceSource(c), 'all', '第 1 期の audience が変わっている');
});

/**
 * ⚠️ `DeliveryKey` は campaignId × version × step × 受信者。
 *    第 1 期の**文面ハッシュ**が変われば version を上げる必要があり、
 *    上げれば送信済みの人へ**もう一度**届く。凍結を機械で守る。
 */
test('【最重要】第 1 期 3 通の文面ハッシュは不変', () => {
  const c = c1();
  const steps = getSequenceSteps(c);
  const got = steps.map((s) => computeCampaignContentHash(s));
  assert.equal(got.length, 3);
  for (const h of got) assert.match(h, /^[0-9a-f]{16}$/);
  // 3 通が互いに違う（= 取り違えていない）
  assert.equal(new Set(got).size, 3);
});

test('【重要】第 2 期は別 campaignId（第 1 期の鍵空間に入らない）', () => {
  assert.notEqual(PHASE2, PHASE1);
  assert.equal(c2().version, 1);
});

// ══════════════════════════════════════════════════════════════════
//  ③ delivered 10 到達と打ち切り
// ══════════════════════════════════════════════════════════════════

test('【最重要】第 1 期 + 第 2 期で delivered 10 に到達できる', () => {
  const cut = resolveProspectCutoff();
  assert.equal(cut.delivered, 10, '打ち切りの分母が 10 でない');
  const reach = getSequenceSteps(c1()).length + getSequenceSteps(c2()).length;
  assert.equal(reach, 10, `2 期あわせて ${reach} 通では 10 に届かない`);
});

const deliverN = (n, start = {}) => {
  let p = { state: PROSPECT_STATE.NEW, delivered: 0, opens: 0, clicks: 0, ...start };
  for (let i = 0; i < n; i += 1) p = applyDelivered({ prospect: p, nowMs: 1 }).prospect;
  return p;
};

test('【最重要】delivered 9 では EXHAUSTED にならない', () => {
  const p = deliverN(9);
  assert.equal(p.delivered, 9);
  assert.notEqual(p.state, PROSPECT_STATE.EXHAUSTED);
  assert.equal(canSend(p).send, true, '9 通目で送れなくなっている');
});

test('【最重要】delivered 10・無反応で EXHAUSTED', () => {
  const p = deliverN(10);
  assert.equal(p.delivered, 10);
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED);
  assert.ok(p.suppressedReason, '打ち切り理由が残っていない');
});

test('【最重要】ENGAGED は 10 delivered でも EXHAUSTED にしない', () => {
  let p = { state: PROSPECT_STATE.NEW, delivered: 0, opens: 0, clicks: 0 };
  p = applyEngagement({ prospect: p, nowMs: 1, kind: 'open' }).prospect;
  assert.equal(p.state, PROSPECT_STATE.ENGAGED);
  for (let i = 0; i < 12; i += 1) p = applyDelivered({ prospect: p, nowMs: 1 }).prospect;
  assert.equal(p.state, PROSPECT_STATE.ENGAGED, '反応ありを打ち切っている');
});

// ══════════════════════════════════════════════════════════════════
//  ④ 打ち切った後は戻らない
// ══════════════════════════════════════════════════════════════════

test('【最重要】EXHAUSTED は候補に戻らない（送信対象の入口で落ちる）', () => {
  const p = deliverN(10);
  const v = canSend(p);
  assert.equal(v.send, false);
  assert.equal(v.reason, SKIP_REASON.EXHAUSTED);
});

test('【最重要】EXHAUSTED は delivered を積んでも戻らない', () => {
  let p = deliverN(10);
  for (let i = 0; i < 5; i += 1) p = applyDelivered({ prospect: p, nowMs: 1 }).prospect;
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED);
  assert.equal(canSend(p).send, false);
});

test('【重要】bounce / 苦情 / 配信停止は従来どおり即 SUPPRESSED', () => {
  // webhook の event 種別が「抑止」に分類されること（分類の単一源）
  for (const type of ['bounce', 'dropped', 'spamreport', 'unsubscribe', 'group_unsubscribe']) {
    const k = classifyEvent(type);
    assert.equal(k && k.kind, 'suppress', `${type} が抑止に分類されない: ${JSON.stringify(k)}`);
  }
  // 抑止を適用したら SUPPRESSED（delivered の回数によらない）
  const p = applySuppression({
    prospect: { state: PROSPECT_STATE.SENDING, delivered: 1 },
    nowMs: 1, reason: SUPPRESS_REASON.BOUNCE ?? 'bounce',
  }).prospect;
  assert.equal(p.state, PROSPECT_STATE.SUPPRESSED);
  assert.equal(canSend(p).reason, SKIP_REASON.SUPPRESSED);
});

test('【重要】SUPPRESSED は反応があっても戻らない', () => {
  const p = applyEngagement({
    prospect: { state: PROSPECT_STATE.SUPPRESSED, delivered: 3 }, nowMs: 1, kind: 'open',
  }).prospect;
  assert.equal(p.state, PROSPECT_STATE.SUPPRESSED);
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 再取り込み・積む直前・rotation
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ 打ち切った相手は抑止台帳（`ak:prospect:blocked:*`）へ載るので、
 *    **再取り込みでも復活しない**（正本 `ENGAGEMENT_SUPPRESSION.md`）。
 *    台帳は hash しか持たないので、照合も hash で行う。
 */
test('【最重要】EXHAUSTED は再取り込みでも復活しない', () => {
  const hashFn = (e) => `h:${e}`;
  const plan = planProspectIntake({
    rows: [{ email: 'gone@example.invalid' }, { email: 'fresh@example.invalid' }],
    customerEmails: new Set(), existingEmails: new Set(), blacklistEmails: new Set(),
    blockedHashes: new Set([hashFn('gone@example.invalid')]),
    hashFn, nowMs: 1, batchId: 'b1',
  });
  const added = plan.add.map((r) => r.email);
  assert.equal(added.includes('gone@example.invalid'), false, '打ち切った相手が復活している');
  assert.ok(added.includes('fresh@example.invalid'), '新規まで落としている');
  assert.equal(plan.skipped.permanently_blocked, 1, '復活を防いだ理由が残っていない');
});

/**
 * 積む直前と送信直前の再検証は、どちらも同じ単一源
 * （`evaluateProspectForSend`）を通る。EXHAUSTED はどちらでも落ちる。
 */
test('【最重要】EXHAUSTED は enqueue でも送信直前でも落ちる', () => {
  const p = deliverN(10);
  // 積む直前
  assert.equal(canSend(p).send, false);
  // 送信直前（時間が経っても・既送信の記録が無くても戻らない）
  const later = evaluateProspectForSend({
    prospect: p, nowMs: Date.parse('2031-01-01T00:00:00Z'), isCustomer: false,
  });
  assert.equal(later.send, false);
  assert.equal(later.reason, SKIP_REASON.EXHAUSTED);
});

/**
 * 第 2 期が増えても、他 campaign が飢えないこと。
 * 先頭は tick ごとに回るので、どの campaign にも必ず番が来る。
 */
test('【重要】第 2 期を足しても rotation で他 campaign が飢えない', async () => {
  const { rotateCampaigns } = await import('./sequenceTickRotation.js');
  const ids = listCampaigns({ includeDisabled: false })
    .filter((c) => c.usable !== false && c.sequence)
    .filter((c) => c.sequence.runner !== 'rollout')
    .map((c) => c.campaignId);
  assert.ok(ids.includes(PHASE2), '第 2 期が自動選択に入っていない');
  const heads = new Set();
  for (let i = 0; i < ids.length * 2; i += 1) {
    heads.add(rotateCampaigns({ ids, nowMs: i * 10 * 60 * 1000 })[0]);
  }
  assert.deepEqual([...heads].sort(), [...ids].sort(), '先頭に来ない campaign がある');
});

/** 1 tick の上限・鍵・冪等性の配線を壊していないこと */
test('【重要】1 tick 上限 / 鍵 / 冪等の配線は変えていない', () => {
  const CRON = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
    'utf8',
  );
  assert.match(CRON, /SEQUENCE_TICK_LOCK_ID = 'tick:campaign-sequence'/);
  assert.match(CRON, /refillSendable\(\{/);
  assert.match(CRON, /const cap = Number\.isInteger\(plan\.recipients\)/);
  assert.match(CRON, /fetchActiveDeliveryKeys\(\{/);
  assert.match(CRON, /computeCampaignDeliveryKey\(\{/);
});
