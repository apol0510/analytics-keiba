/**
 * sendgridCutover.test.mjs — **二重稼働 0** の契約を固定する
 *
 * 旧 AK 配信と SendGrid Automation が同時に live になると、同じ人へ同じ通が 2 回届く。
 * どちらの二重送信防止も相手を知らないので、防げるのは「1 つしか live にしない」ことだけ。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveProspectEngine, decideProspectSending, assertSingleEngine, canTransition,
  nextCutoverStep, PROSPECT_ENGINE, PROSPECT_ENGINE_ENV, CUTOVER_STATE,
  ENGINE_SKIP_REASON, CUTOVER_STEPS, ROLLBACK_STEPS,
} from './sendgridCutover.js';

const fnSource = (name) => readFileSync(
  fileURLToPath(new URL(`../../../netlify/functions/${name}`, import.meta.url)), 'utf8',
);

test('env 未設定・未知の値は従来どおり AK（勝手に新経路へ行かせない）', () => {
  assert.equal(resolveProspectEngine({}), PROSPECT_ENGINE.AK);
  assert.equal(resolveProspectEngine({ [PROSPECT_ENGINE_ENV]: '' }), PROSPECT_ENGINE.AK);
  assert.equal(resolveProspectEngine({ [PROSPECT_ENGINE_ENV]: 'SENDGRIDX' }), PROSPECT_ENGINE.AK);
  assert.equal(resolveProspectEngine({ [PROSPECT_ENGINE_ENV]: 'true' }), PROSPECT_ENGINE.AK);
  assert.equal(resolveProspectEngine({ [PROSPECT_ENGINE_ENV]: 'sendgrid' }), PROSPECT_ENGINE.SENDGRID);
  assert.equal(resolveProspectEngine({ [PROSPECT_ENGINE_ENV]: ' SendGrid ' }), PROSPECT_ENGINE.SENDGRID);
});

test('AK のままなら挙動は 1 バイトも変わらない', () => {
  for (const declaredSource of ['all', 'prospect', 'customer']) {
    const d = decideProspectSending({ engine: PROSPECT_ENGINE.AK, declaredSource });
    assert.deepEqual(d, { readProspects: true, skip: false, reason: null });
  }
});

test('SendGrid へ移したら prospect 専用 campaign は 1 件も積まない', () => {
  const d = decideProspectSending({ engine: PROSPECT_ENGINE.SENDGRID, declaredSource: 'prospect' });
  assert.equal(d.skip, true);
  assert.equal(d.readProspects, false);
  assert.equal(d.reason, ENGINE_SKIP_REASON);
});

test('SendGrid へ移しても Customers 向けは止めない（prospect だけ読まない）', () => {
  for (const declaredSource of ['all', 'customer']) {
    const d = decideProspectSending({ engine: PROSPECT_ENGINE.SENDGRID, declaredSource });
    assert.equal(d.skip, false, declaredSource);
    assert.equal(d.readProspects, false, declaredSource);
  }
});

test('live が 2 つある状態を検知する', () => {
  assert.equal(assertSingleEngine({ akProspectSending: true, sendgridAutomationLive: true }).ok, false);
  assert.equal(
    assertSingleEngine({ akProspectSending: true, sendgridAutomationLive: true }).violation,
    'both_engines_live',
  );
  assert.equal(
    assertSingleEngine({ akProspectSending: false, sendgridAutomationLive: false }).state,
    CUTOVER_STATE.FROZEN,
  );
  assert.equal(
    assertSingleEngine({ akProspectSending: false, sendgridAutomationLive: true }).state,
    CUTOVER_STATE.SENDGRID_LIVE,
  );
});

test('ak_live から sendgrid_live へ直接は進めない（必ず frozen を挟む）', () => {
  assert.equal(canTransition(CUTOVER_STATE.AK_LIVE, CUTOVER_STATE.SENDGRID_LIVE).ok, false);
  assert.equal(canTransition(CUTOVER_STATE.AK_LIVE, CUTOVER_STATE.FROZEN).ok, true);
  assert.equal(canTransition(CUTOVER_STATE.FROZEN, CUTOVER_STATE.SENDGRID_LIVE).ok, true);
  // rollback も frozen 経由
  assert.equal(canTransition(CUTOVER_STATE.SENDGRID_LIVE, CUTOVER_STATE.AK_LIVE).ok, false);
  assert.equal(canTransition(CUTOVER_STATE.SENDGRID_LIVE, CUTOVER_STATE.FROZEN).ok, true);
});

test('承認が要る段の手前で止まる', () => {
  const first = nextCutoverStep([]);
  assert.equal(first.step.id, 'stop_ak_prospect');
  assert.equal(first.stop, true, '旧配信の停止は MK 承認が要る');

  const afterStop = nextCutoverStep(['stop_ak_prospect']);
  assert.equal(afterStop.step.id, 'verify_stopped');
  assert.equal(afterStop.stop, false, '確認は承認不要');

  const beforeImport = nextCutoverStep(['stop_ak_prospect', 'verify_stopped', 'snapshot']);
  assert.equal(beforeImport.step.id, 'import_contacts');
  assert.equal(beforeImport.stop, true);

  const done = nextCutoverStep(CUTOVER_STEPS.map((s) => s.id));
  assert.equal(done.done, true);
});

test('rollback は「同じメールをもう一度送る」経路を持たない', () => {
  const ids = ROLLBACK_STEPS.map((s) => s.id);
  assert.deepEqual(ids, ['disable_automations', 'reconcile', 'resume_ak']);
  // 再開は最後で、その前に必ず突き合わせが入る
  assert.ok(ids.indexOf('reconcile') < ids.indexOf('resume_ak'));
});

test('cron-campaign-sequence が切替を実際に読んでいる（配線の guard）', () => {
  const src = fnSource('cron-campaign-sequence.js');
  assert.ok(src.includes("from '../../src/lib/marketing/sendgridCutover.js'"), 'import が無い');
  assert.ok(src.includes('resolveProspectEngine(env)'), 'engine を解決していない');
  assert.ok(src.includes('decideProspectSending('), '判定を呼んでいない');
  assert.ok(src.includes('engineDecision.skip'), 'prospect 専用 campaign を止めていない');
  assert.ok(src.includes('!engineDecision.readProspects'), 'prospect を読まない分岐が無い');
});

test('管理 API はメール送信 API を持たない', () => {
  const src = fnSource('admin-sendgrid-migration.js');
  assert.equal(src.includes('/v3/mail/send'), false);
  assert.equal(src.includes('@sendgrid/mail'), false);
});
