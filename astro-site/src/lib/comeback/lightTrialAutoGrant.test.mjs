/**
 * lightTrialAutoGrant.test.mjs — Light 30日無料体験の自動付与（入口）
 *   node --test src/lib/comeback/lightTrialAutoGrant.test.mjs
 *
 * 重点:
 *   - **CSV 取り込みの会員だけ**が候補（従来からの無料会員は対象外）
 *   - 有料 / 期限なし付与 / 付与中 / 過去に付与済み / 配信不可 は除外
 *   - ゲートが 1 つでも欠ければ何も書かない
 *   - **付与に成功した人だけ**が Step1 の対象（順序保証）
 *   - コホートを観測できなければ誰にも付与しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readAutoGrantGates, checkAutoGrantCandidate, selectAutoGrantCandidates,
  planAutoGrantRun, recipientsAfterGrant, summarizeAutoGrantRun,
  resolveBatchSize, buildTrialGrantPlan, buildTrialOperationId,
  AUTOGRANT_ENV, AUTOGRANT_ABORT, AUTOGRANT_SKIP, TRIAL_OFFER_ID,
  DEFAULT_BATCH_SIZE, HARD_MAX_BATCH_SIZE,
} from './lightTrialAutoGrant.js';
import { buildComebackPlan } from './comebackGrantPlan.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { jstDateString } from '../marketing/campaignSend.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 20, 3, 0);
const TODAY = jstDateString(NOW);
const OFFER = resolveOffer(TRIAL_OFFER_ID).offer;

/** 付与に必要なゲートだけ（**配信系ゲートは要求しない**） */
const OPEN_ENV = {
  [AUTOGRANT_ENV.FIELDS_READY]: '1',
  [AUTOGRANT_ENV.GRANT_ENABLED]: 'true',
  [AUTOGRANT_ENV.ENABLED]: 'true',
  [AUTOGRANT_ENV.ARMED]: TODAY,
};

const row = (email, over = {}) => {
  const fields = { Email: email, Status: 'active', Source: 'customer-import:imp-A', ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
};

// ── ゲート ──────────────────────────────────────────────────
test('4 つ揃って初めて開く（既存の付与ゲートも要求する）', () => {
  assert.equal(readAutoGrantGates(OPEN_ENV, NOW).allOpen, true);
  for (const key of Object.keys(OPEN_ENV)) {
    const env = { ...OPEN_ENV };
    delete env[key];
    assert.equal(readAutoGrantGates(env, NOW).allOpen, false, `${key} が無くても開いてしまう`);
  }
  // 手動付与と同じゲートを再利用している（抜け道を作らない）
  assert.equal(AUTOGRANT_ENV.FIELDS_READY, 'COMEBACK_GRANT_FIELDS_READY');
  assert.equal(AUTOGRANT_ENV.GRANT_ENABLED, 'COMEBACK_GRANT_ENABLED');
});

test('【重要】配信系ゲートは要求しない（付与はメールを作らない）', () => {
  const g = readAutoGrantGates(OPEN_ENV, NOW);
  assert.equal(g.allOpen, true, '配信ゲートが無いと開かない構造になっている');
  assert.equal(JSON.stringify(AUTOGRANT_ENV).includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), false);
  assert.equal(JSON.stringify(AUTOGRANT_ENV).includes('MARKETING_CAMPAIGN_ENABLED'), false);
  // 配信ゲートが閉じていても付与の計画は作れる
  const p = buildTrialGrantPlan({
    records: [row('a@example.com')], env: { ...OPEN_ENV, MARKETING_CAMPAIGN_DISPATCH_ENABLED: undefined }, nowMs: NOW,
  });
  assert.equal(p.ok, true);
  assert.equal(p.targets, 1);
});

test('武装は当日の JST 日付のみ有効', () => {
  const stale = { ...OPEN_ENV, [AUTOGRANT_ENV.ARMED]: jstDateString(NOW - DAY) };
  assert.equal(readAutoGrantGates(stale, NOW).allOpen, false);
});

// ── 候補判定 ────────────────────────────────────────────────
test('【重要】CSV 取り込みの会員だけが候補', () => {
  const inCohort = checkAutoGrantCandidate({ ...row('a@example.com'), nowMs: NOW });
  assert.equal(inCohort.ok, true);

  const legacy = row('b@example.com');
  delete legacy.fields.Source;
  const outside = checkAutoGrantCandidate({ fields: legacy.fields, marketing: legacy.marketing, nowMs: NOW });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, AUTOGRANT_SKIP.NOT_IN_COHORT);
});

test('有料会員・期限なし付与・付与中・過去付与・配信不可は候補外', () => {
  const cases = [
    [{ 'プラン': 'Premium', '有効期限': '2027-01-01' }, AUTOGRANT_SKIP.PAID_MEMBER],
    [{ LightGrantLifetime: true }, AUTOGRANT_SKIP.GRANT_LIFETIME],
    [{ LightGrantUntil: new Date(NOW + 10 * DAY).toISOString() }, AUTOGRANT_SKIP.GRANT_ACTIVE],
    [{ LightGrantUntil: new Date(NOW - 10 * DAY).toISOString() }, AUTOGRANT_SKIP.GRANTED_BEFORE],
    [{ UnsubscribedAnalyticsKeiba: true }, AUTOGRANT_SKIP.NOT_SENDABLE],
  ];
  for (const [over, reason] of cases) {
    const r = row('c@example.com', over);
    const got = checkAutoGrantCandidate({ fields: r.fields, marketing: r.marketing, nowMs: NOW });
    assert.equal(got.ok, false, `候補にしてしまった: ${JSON.stringify(over)}`);
    assert.equal(got.reason, reason, JSON.stringify(over));
  }
});

test('【重要】過去に無料付与を受けた人へは再付与しない', () => {
  const past = row('d@example.com', { LightGrantedAt: new Date(NOW - 200 * DAY).toISOString() });
  const got = checkAutoGrantCandidate({ fields: past.fields, marketing: past.marketing, nowMs: NOW });
  assert.equal(got.ok, false);
  assert.equal(got.reason, AUTOGRANT_SKIP.GRANTED_BEFORE);
});

test('dry-run の内訳（コホート総数 / 候補 / 理由別）が出る', () => {
  const legacy = row('old@example.com');
  delete legacy.fields.Source;
  const sel = selectAutoGrantCandidates({
    records: [row('a@example.com'), legacy, row('paid@example.com', { 'プラン': 'Light', '有効期限': '2027-01-01' })],
    nowMs: NOW,
  });
  assert.equal(sel.counts.cohortTotal, 2, 'コホート総数');
  assert.equal(sel.counts.candidates, 1, '付与候補');
  assert.equal(sel.counts.byReason[AUTOGRANT_SKIP.NOT_IN_COHORT], 1);
  assert.equal(sel.counts.byReason[AUTOGRANT_SKIP.PAID_MEMBER], 1);
});

test('同一アドレスの重複レコードは 1 人ぶん', () => {
  const a = row('dup@example.com');
  const b = { ...row('dup@example.com'), recordId: 'rec-dup2' };
  const sel = selectAutoGrantCandidates({ records: [a, b], nowMs: NOW });
  assert.equal(sel.counts.candidates, 1);
});

// ── 実行計画 ────────────────────────────────────────────────
const selOf = (records) => selectAutoGrantCandidates({ records, nowMs: NOW });

test('【重要】ゲートが閉じていれば計画を作らない', () => {
  const plan = planAutoGrantRun({
    selection: selOf([row('a@example.com')]), gates: readAutoGrantGates({}, NOW), offer: OFFER,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.GATES_CLOSED);
});

test('【重要】コホートを観測できなければ誰にも付与しない', () => {
  const legacy = row('old@example.com');
  delete legacy.fields.Source;
  const plan = planAutoGrantRun({
    selection: selOf([legacy]), gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.COHORT_UNVERIFIABLE);
});

test('【重要】候補が多くても全体を中止しない（先頭 N 件だけ処理する）', () => {
  const many = Array.from({ length: 5 }, (_, i) => row(`u${i}@example.com`));
  const sel = selectAutoGrantCandidates({ records: many, nowMs: NOW, maxGrants: 2 });
  const plan = planAutoGrantRun({ selection: sel, gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER, batchSize: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.recipients, 2);
  assert.equal(plan.remaining, 3);
  assert.equal(DEFAULT_BATCH_SIZE, 100);
});

test('別の特典では実行しない（30日無料のみ）', () => {
  const plan = planAutoGrantRun({
    selection: selOf([row('a@example.com')]), gates: readAutoGrantGates(OPEN_ENV, NOW),
    offer: resolveOffer('light-lifetime-free').offer,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.OFFER_UNAVAILABLE);
});

// ── 既存 planner の再利用と順序保証 ─────────────────────────
test('付与の形は既存 planner が作る（このモジュールは複製しない）', () => {
  const sel = selOf([row('a@example.com')]);
  const plan = planAutoGrantRun({ selection: sel, gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER });
  assert.equal(plan.ok, true);

  const grantPlan = buildComebackPlan({
    grantOffers: [OFFER], purchaseOffer: null, selected: plan.candidates,
    nowMs: NOW, operationId: `light-trial-${TODAY}`, actor: 'cron-light-trial', source: 'light-trial-autogrant',
  });
  assert.equal(grantPlan.ok, true);
  assert.equal(grantPlan.targets.length, 1);
  const f = grantPlan.targets[0].grantFields;
  assert.ok(f.LightGrantUntil, '期限付きで付与される');
  assert.equal(f.LightGrantLifetime, false);
  assert.ok(String(f.LightGrantOp).includes('light-trial'), 'operationId が刻まれる（冪等性の要）');
});

test('【重要】付与しても Step1 は 1 件も queue しない（付与と送信は分離）', () => {
  const sel = selectAutoGrantCandidates({ records: [row('a@example.com')], nowMs: NOW });
  const plan = planAutoGrantRun({ selection: sel, gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER });
  const s = summarizeAutoGrantRun({ plan, granted: 1, failed: 0 });
  assert.equal(s['キュー登録'], 0);
  assert.equal(s['送信'], 0);
});

test('【重要】付与に成功した人だけが Step1 の対象になる', () => {
  const targets = [{ recordId: 'rec-1' }, { recordId: 'rec-2' }, { recordId: 'rec-3' }];
  // rec-2 だけ書き込みに失敗した状況
  const ok = recipientsAfterGrant({ targets, writtenRecordIds: ['rec-1', 'rec-3'] });
  assert.deepEqual(ok, ['rec-1', 'rec-3']);
  // 1 件も成功しなければ誰にも送らない
  assert.deepEqual(recipientsAfterGrant({ targets, writtenRecordIds: [] }), []);
});

test('同じ operationId で 2 回計画しても付与内容は同じ（冪等）', () => {
  const sel = selOf([row('a@example.com')]);
  const mk = () => buildComebackPlan({
    grantOffers: [OFFER], purchaseOffer: null, selected: sel.candidates,
    nowMs: NOW, operationId: 'light-trial-2026-08-20', actor: 'cron-light-trial', source: 'x',
  });
  assert.deepEqual(mk().targets[0].grantFields, mk().targets[0].grantFields);
  assert.equal(mk().planFingerprint, mk().planFingerprint);
});

test('要約にアドレスも recordId も含めない', () => {
  const sel = selOf([row('a@example.com')]);
  const plan = planAutoGrantRun({ selection: sel, gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER });
  const json = JSON.stringify(summarizeAutoGrantRun({ plan, granted: 1, queued: 1 }));
  assert.equal(/@example\.com/.test(json), false);
  assert.equal(/rec-/.test(json), false);
});

// ── 段階実行（14,000 件規模で全体 abort しない）──────────────
const bulk = (n) => Array.from({ length: n }, (_, i) => row(`b${String(i).padStart(6, '0')}@example.com`));

test('【重要】14,487 候補でも中止せず、先頭 100 件だけを計画する', () => {
  const p = buildTrialGrantPlan({ records: bulk(14487), env: OPEN_ENV, nowMs: NOW });
  assert.equal(p.ok, true);
  assert.equal(p.counts.candidates, 14487);
  assert.equal(p.counts.batchSize, 100, '1 回の処理件数');
  assert.equal(p.counts.remaining, 14387, 'remaining');
  assert.equal(p.targets, 100, '実際に付与する件数');
});

test('【重要】2 回目は次の 100 件へ進む（付与済みは候補から消える・offset を持たない）', () => {
  const all = bulk(250);
  const first = buildTrialGrantPlan({ records: all, env: OPEN_ENV, nowMs: NOW });
  const firstIds = first.plan.targets.map((t) => t.recordId);
  assert.equal(firstIds.length, 100);

  // 1 回目で付与された 100 名に LightGrant を立てる（= 本番で付与が成功した状態）
  const granted = new Set(firstIds);
  const after = all.map((r) => (granted.has(r.recordId)
    ? row(r.fields.Email, { LightGrantUntil: new Date(NOW + 30 * DAY).toISOString() })
    : r));
  // recordId を元のまま保つ（row() は email から作るため合わせる）
  after.forEach((r, i) => { r.recordId = all[i].recordId; });

  const second = buildTrialGrantPlan({ records: after, env: OPEN_ENV, nowMs: NOW });
  const secondIds = second.plan.targets.map((t) => t.recordId);
  assert.equal(second.counts.candidates, 150, '付与済みは候補から外れる');
  assert.equal(secondIds.length, 100);
  assert.equal(secondIds.some((id) => granted.has(id)), false, '**二重付与している**');
  assert.equal(second.counts.remaining, 50);
});

test('【重要】並び順は決定的（同じ入力なら毎回同じ 100 件・同じ指紋）', () => {
  const shuffled = bulk(300).sort(() => 0.5 - Math.random());
  const a = buildTrialGrantPlan({ records: shuffled, env: OPEN_ENV, nowMs: NOW });
  const b = buildTrialGrantPlan({ records: [...shuffled].reverse(), env: OPEN_ENV, nowMs: NOW });
  assert.deepEqual(a.plan.targets.map((t) => t.recordId), b.plan.targets.map((t) => t.recordId));
  assert.equal(a.planFingerprint, b.planFingerprint);
});

test('【重要】下見と実計画が一致する（同じ関数を通る）', () => {
  const records = bulk(300);
  const preview = buildTrialGrantPlan({ records, env: {}, nowMs: NOW });          // ゲート閉（下見）
  const run = buildTrialGrantPlan({ records, env: OPEN_ENV, nowMs: NOW });        // ゲート開（実行）
  assert.equal(preview.ok, false, '下見はゲート閉で ok:false');
  assert.equal(preview.abort, AUTOGRANT_ABORT.GATES_CLOSED);
  assert.equal(preview.counts.batchSize, run.counts.batchSize, '件数が一致しない');
  assert.equal(preview.counts.remaining, run.counts.remaining);
  assert.equal(preview.planFingerprint, run.planFingerprint, '**下見と実計画がズレている**');
});

// ── 1 回の件数（既定 / 設定可 / hard max / 異常値）────────────
test('件数は既定 100・env で変更でき、hard max を超えたら実行しない', () => {
  assert.deepEqual(resolveBatchSize({}), { ok: true, size: DEFAULT_BATCH_SIZE, source: 'default' });
  assert.equal(resolveBatchSize({ [AUTOGRANT_ENV.BATCH_SIZE]: '250' }).size, 250);
  assert.equal(resolveBatchSize({ [AUTOGRANT_ENV.BATCH_SIZE]: String(HARD_MAX_BATCH_SIZE) }).ok, true);

  const over = resolveBatchSize({ [AUTOGRANT_ENV.BATCH_SIZE]: String(HARD_MAX_BATCH_SIZE + 1) });
  assert.equal(over.ok, false);
  assert.match(over.reason, /^over_hard_max/);
});

test('【fail closed】壊れた件数指定では実行しない', () => {
  for (const bad of ['abc', '0', '-5', '10.5', '1e3']) {
    const r = resolveBatchSize({ [AUTOGRANT_ENV.BATCH_SIZE]: bad });
    assert.equal(r.ok, false, `受け入れてしまった: ${JSON.stringify(bad)}`);
  }
  // 空文字・空白だけは「未設定」として既定へ（env を消したのと同じ扱い）
  assert.equal(resolveBatchSize({ [AUTOGRANT_ENV.BATCH_SIZE]: ' ' }).size, DEFAULT_BATCH_SIZE);
  // 計画そのものが作られない
  const p = buildTrialGrantPlan({
    records: bulk(10), env: { ...OPEN_ENV, [AUTOGRANT_ENV.BATCH_SIZE]: '9999' }, nowMs: NOW,
  });
  assert.equal(p.ok, false);
  assert.equal(p.abort, AUTOGRANT_ABORT.BATCH_SIZE_REJECTED);
  assert.equal(p.hardMax, HARD_MAX_BATCH_SIZE);
});

test('失敗した人は候補に残る（次回そのまま再評価される）', () => {
  const all = bulk(150);
  const first = buildTrialGrantPlan({ records: all, env: OPEN_ENV, nowMs: NOW });
  const failedId = first.plan.targets[0].recordId;
  // 付与に失敗した = LightGrant が立たない → 次回も候補のまま
  const second = buildTrialGrantPlan({ records: all, env: OPEN_ENV, nowMs: NOW });
  assert.ok(second.plan.targets.some((t) => t.recordId === failedId), '失敗者が候補から消えている');
});

test('operationId は JST 日付で決まる（同日再実行は同じ = 冪等）', () => {
  assert.equal(buildTrialOperationId(NOW), buildTrialOperationId(NOW + 60 * 1000));
  assert.match(buildTrialOperationId(NOW), /^light-trial-\d{4}-\d{2}-\d{2}$/);
});
