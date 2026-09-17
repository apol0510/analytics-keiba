/**
 * prospectPhase2EntryProbe.test.mjs — 入口判定の**軽量化で結論が変わらない**ことを固定
 *   node --test src/lib/marketing/prospectPhase2EntryProbe.test.mjs
 *
 * ## 何を守るか
 *
 * 2 段引き（①最後の step だけ → ②通過者だけ全 step）にしても、
 * **従来（全員 × 全 step を 1 回で引く）と入口の結論が 1 件も変わらない**こと。
 *
 * ⚠️ 速くなったかではなく、**同じ人が選ばれるか**をテストする。
 * ⚠️ `delivered` の累計で足切りしていないこと（集合は `claimDelivered` 由来で
 *    webhook の `delivered` とは別物。バウンスすれば両者はズレる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPhase2Probe, buildPhase2FullKeys, describePhase2Probe } from './prospectPhase2EntryProbe.js';
import { planPhase2Entry, PHASE2_ENTRY_SKIP } from './prospectPhase2Entry.js';
import { buildProspectDeliveryKeys } from './prospectSequenceHydration.js';
import { getCampaign } from './campaignCatalog.js';
import { getSequenceSteps } from './campaignSequence.js';
import { PROSPECT_STATE } from './prospectPolicy.js';

const BRAND = 'AK';
const FROM = 'noreply@keiba.link';
const PRIOR = getCampaign('campaign-discount-free', { includeDisabled: true });
const NEXT = getCampaign('campaign-prospect-phase2', { includeDisabled: true });
const PRIOR_STEPS = getSequenceSteps(PRIOR);

const person = (n, over = {}) => ({
  email: `p${n}@example.invalid`, state: PROSPECT_STATE.SENDING, delivered: 0, ...over,
});

/** その人の第 1 期の鍵を `upto` 通ぶんだけ「送信済み」にする */
function priorKeysFor(people, upto) {
  const map = buildProspectDeliveryKeys({ prospects: people, campaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const out = new Set();
  for (const [, byStep] of map) {
    for (const s of PRIOR_STEPS.slice(0, upto)) {
      const k = byStep.get(s.stepNumber);
      if (k) out.add(k);
    }
  }
  return out;
}

/** 従来のやり方（全員 × 全 step を 1 回で引く）で集合を作る */
function naiveDelivered(people, truth) {
  const map = buildProspectDeliveryKeys({ prospects: people, campaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const all = [];
  for (const [, byStep] of map) for (const [, k] of byStep) all.push(k);
  return new Set(all.filter((k) => truth.has(k)));
}

/** 2 段引きで集合を作る（`truth` が Redis の集合の代わり） */
function stagedDelivered(people, truth) {
  const probe = buildPhase2Probe({ prospects: people, priorCampaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const lastFound = probe.probeKeys.filter((k) => truth.has(k));
  const full = buildPhase2FullKeys({
    prospects: people, priorCampaign: PRIOR, brand: BRAND, fromEmail: FROM,
    lastStepDelivered: new Set(lastFound), probe,
  });
  return { set: new Set(full.keys.filter((k) => truth.has(k))), probe, full, lastFound };
}

const planWith = (people, delivered, over = {}) => planPhase2Entry({
  prospects: people, priorCampaign: PRIOR, nextCampaign: NEXT,
  priorDeliveredKeys: delivered, brand: BRAND, fromEmail: FROM, ...over,
});

// ══════════════════════════════════════════════════════════════════
//  ① 結論が変わらない（これが最重要）
// ══════════════════════════════════════════════════════════════════

test('【最重要】第 1 期 0〜3 通のどの状態でも、従来と同じ人が選ばれる', () => {
  for (const upto of [0, 1, 2, 3]) {
    const people = [person(1), person(2), person(3)];
    const truth = priorKeysFor(people, upto);
    const naive = planWith(people, naiveDelivered(people, truth));
    const staged = planWith(people, stagedDelivered(people, truth).set);
    assert.deepEqual(staged.emails, naive.emails, `第 1 期 ${upto} 通で選ばれる人が違う`);
    assert.equal(staged.ok, naive.ok);
  }
});

test('【最重要】完了者と未完了者が混ざっていても結論が同じ', () => {
  const done = [person(1), person(2)];
  const half = [person(3), person(4)];
  const none = [person(5)];
  const people = [...done, ...half, ...none];
  const truth = new Set([
    ...priorKeysFor(done, 3), ...priorKeysFor(half, 2), ...priorKeysFor(none, 0),
  ]);
  const naive = planWith(people, naiveDelivered(people, truth));
  const staged = planWith(people, stagedDelivered(people, truth).set);
  assert.deepEqual(staged.emails.sort(), naive.emails.sort());
  assert.deepEqual(staged.emails.sort(), ['p1@example.invalid', 'p2@example.invalid']);
  assert.equal(staged.skipped[PHASE2_ENTRY_SKIP.PRIOR_INCOMPLETE], 3);
});

/**
 * ⚠️ **順番どおりに配られていない**（最後だけ届いている）異常なケースでも、
 *    「全 step 揃っているか」で判定する契約は崩さない。
 */
test('【最重要】最後の step だけ有る人は入口に入らない（①を通っても②で落ちる）', () => {
  const people = [person(1)];
  const map = buildProspectDeliveryKeys({ prospects: people, campaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const last = PRIOR_STEPS[PRIOR_STEPS.length - 1].stepNumber;
  const truth = new Set([map.get('p1@example.invalid').get(last)]);   // 最後だけ
  const staged = stagedDelivered(people, truth);
  assert.equal(staged.lastFound.length, 1, '①を通過していない（前提が違う）');
  const naive = planWith(people, naiveDelivered(people, truth));
  const plan = planWith(people, staged.set);
  assert.deepEqual(plan.emails, [], '全 step 揃っていないのに入口へ入れている');
  assert.deepEqual(plan.emails, naive.emails);
});

test('【最重要】最後の step が無ければ全 step を引きに行かない（無駄な往復をしない）', () => {
  const people = [person(1), person(2)];
  const truth = priorKeysFor(people, 2);   // step3 は無い
  const staged = stagedDelivered(people, truth);
  assert.equal(staged.lastFound.length, 0);
  assert.equal(staged.full.keys.length, 0, '②で鍵を引こうとしている');
  assert.equal(staged.full.survivors, 0);
});

// ══════════════════════════════════════════════════════════════════
//  ② 足切りの誤りを作らない
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ 集合は `claimDelivered`（キュー登録時の予約）由来で、webhook の `delivered` とは別物。
 *    バウンスすれば「鍵は 3 つあるが delivered は 1」もあり得る。
 */
test('【最重要】delivered の累計で足切りしない（0 でも鍵が揃えば入口に入る）', () => {
  const people = [person(1, { delivered: 0 })];
  const truth = priorKeysFor(people, 3);
  const plan = planWith(people, stagedDelivered(people, truth).set);
  assert.deepEqual(plan.emails, ['p1@example.invalid'], 'delivered=0 を理由に落としている');
});

test('【重要】delivered が多くても、第 1 期未完なら入らない', () => {
  for (const d of [3, 4, 9, 20]) {
    const people = [person(1, { delivered: d })];
    const truth = priorKeysFor(people, 2);
    assert.deepEqual(planWith(people, stagedDelivered(people, truth).set).emails, [], `delivered=${d}`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ③ 他の安全条件は不変
// ══════════════════════════════════════════════════════════════════

test('【最重要】ENGAGED / SUPPRESSED / EXHAUSTED / PROMOTED は入らない', () => {
  for (const st of [PROSPECT_STATE.ENGAGED, PROSPECT_STATE.SUPPRESSED,
    PROSPECT_STATE.EXHAUSTED, PROSPECT_STATE.PROMOTED]) {
    const people = [person(1, { state: st })];
    const truth = priorKeysFor(people, 3);
    const plan = planWith(people, stagedDelivered(people, truth).set);
    assert.deepEqual(plan.emails, [], `${st} が入口に入っている`);
  }
});

test('【最重要】第 2 期が既に始まっている人は再入口しない（duplicate 防止）', () => {
  const people = [person(1)];
  const truth = priorKeysFor(people, 3);
  const nextKeys = buildProspectDeliveryKeys({ prospects: people, campaign: NEXT, brand: BRAND, fromEmail: FROM });
  const started = new Set([nextKeys.get('p1@example.invalid').get(1)]);
  const plan = planWith(people, stagedDelivered(people, truth).set, { nextDeliveredKeys: started });
  assert.deepEqual(plan.emails, []);
  assert.equal(plan.skipped[PHASE2_ENTRY_SKIP.ALREADY_STARTED], 1);
});

test('【重要】1 tick の上限を超えない（残りは次の tick へ）', () => {
  const people = Array.from({ length: 120 }, (_, i) => person(i));
  const truth = priorKeysFor(people, 3);
  const plan = planWith(people, stagedDelivered(people, truth).set, { maxPerTick: 50 });
  assert.equal(plan.emails.length, 50);
  assert.equal(plan.capped, true);
  assert.equal(plan.carriedOver, 70);
});

test('【重要】メールアドレスが無い人は数えるが引かない', () => {
  const people = [person(1), { email: '', state: PROSPECT_STATE.SENDING }];
  const probe = buildPhase2Probe({ prospects: people, priorCampaign: PRIOR, brand: BRAND, fromEmail: FROM });
  assert.equal(probe.probeKeys.length, 1, 'アドレス無しの鍵を作っている');
});

// ══════════════════════════════════════════════════════════════════
//  ④ 壊れた入力で開けない
// ══════════════════════════════════════════════════════════════════

test('【最重要】前 campaign が連続配信でなければ開けない', () => {
  const probe = buildPhase2Probe({ prospects: [person(1)], priorCampaign: { campaignId: 'x' }, brand: BRAND, fromEmail: FROM });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'prior_not_a_sequence');
  assert.deepEqual(probe.probeKeys, []);
});

test('【重要】①の結果が空なら②は何も引かない', () => {
  const people = [person(1)];
  const full = buildPhase2FullKeys({
    prospects: people, priorCampaign: PRIOR, brand: BRAND, fromEmail: FROM,
    lastStepDelivered: new Set(),
  });
  assert.deepEqual(full.keys, []);
  assert.equal(full.survivors, 0);
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 効果が数えられる（アドレス・鍵は出さない）
// ══════════════════════════════════════════════════════════════════

test('【重要】削減の数え方が正しく、鍵もアドレスも含まない', () => {
  const people = Array.from({ length: 100 }, (_, i) => person(i));
  const probe = buildPhase2Probe({ prospects: people, priorCampaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const stats = describePhase2Probe({ probe, survivors: 0, fullKeys: 0 });
  assert.equal(stats.鍵.従来, 100 * PRIOR_STEPS.length);
  assert.equal(stats.鍵.今回, 100);
  assert.ok(stats.鍵.削減率 > 0);
  const s = JSON.stringify(stats);
  assert.equal(/example\.invalid/.test(s), false, 'アドレスが混ざっている');
});
