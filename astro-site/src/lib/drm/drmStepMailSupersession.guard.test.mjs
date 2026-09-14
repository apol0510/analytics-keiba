/**
 * drmStepMailSupersession.guard.test.mjs — **同じ 6 通が二度届かない**
 *   node --test src/lib/drm/drmStepMailSupersession.guard.test.mjs
 *
 * ── 何を守るか ────────────────────────────────────────────────
 * 無料登録オンボーディングの 6 通は 2 か所に存在する:
 *
 *   旧: `newsletter/step-sequences.js`（`StepEnrollments` 系統・鍵は `step:{seqId}:{n}`）
 *   新: `marketing/freeSignupOnboardingSteps.js`（campaign `free-signup-onboarding`・
 *       鍵は `DeliveryKey` = campaign × version × step × 受信者）
 *
 * **鍵の体系が違うので、互いの送信を検知できない。** 両方を live にすると
 * 同じ人へ同じ 6 通が二度届く。env を 1 つ開けただけで事故にならないよう、
 * コード側で fail closed にしてある。ここはそれが外れていないことを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getCampaign } from '../marketing/campaignCatalog.js';
import { getSequenceSteps } from '../marketing/campaignSequence.js';
import {
  getSequence, listSteps, isSequenceSuperseded, supersededBy,
} from '../newsletter/step-sequences.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ENQUEUE = read('../../../netlify/functions/enqueue-step-emails.js');
const OLD_ID = 'analytics-keiba:signup-onboarding';
const NEW_ID = 'free-signup-onboarding';

test('【重要】旧ステップメールは「移行済み」と印が付いている', () => {
  assert.equal(isSequenceSuperseded(OLD_ID), true, '移行済みの印が消えている');
  assert.equal(supersededBy(OLD_ID), `campaign:${NEW_ID}`);
  assert.ok(getSequence(OLD_ID).supersededAt, '移行日が無い');
});

test('【最重要】移行済みシーケンスの live 送信はコードで止まる（env 頼みにしない）', () => {
  assert.match(ENQUEUE, /isSequenceSuperseded\(sequenceId\)/, 'live パスが移行済みを見ていない');
  assert.match(ENQUEUE, /reason: 'sequence superseded'/);
  // 判定は **env より前**（env を開けただけで通り抜けない）
  const superseded = ENQUEUE.indexOf('isSequenceSuperseded(sequenceId)');
  const envGate = ENQUEUE.indexOf("process.env.STEP_EMAIL_AUTOMATION_ENABLED !== 'true'");
  assert.ok(superseded > 0 && envGate > superseded,
    '移行済みの判定が env ゲートより後ろにある');
});

test('【安全】止めるのは live だけ（計画の確認 = dryRun は通す）', () => {
  const block = ENQUEUE.slice(ENQUEUE.indexOf('isSequenceSuperseded(sequenceId)') - 200);
  assert.match(block.slice(0, 400), /if \(live && isSequenceSuperseded/,
    'dryRun まで止めている（計画すら見られなくなる）');
});

test('【重要】後継の campaign が実在し、同じ通数を持つ', () => {
  const c = getCampaign(NEW_ID, { includeDisabled: true });
  assert.ok(c, '後継 campaign が消えている');
  assert.equal(getSequenceSteps(c).length, listSteps(OLD_ID).length,
    '移送元と通数が違う（移送が欠けているか増えている）');
});

test('【重要】後継は現行仕様の文面（旧の古い記述を持ち込んでいない）', () => {
  const c = getCampaign(NEW_ID, { includeDisabled: true });
  const all = getSequenceSteps(c).map((s) => `${s.subject} ${s.body}`).join('\n');
  for (const stale of ['10点', '双方向馬単']) {
    assert.equal(all.includes(stale), false, `後継に古い記述「${stale}」が残っている`);
  }
  assert.match(all, /最大5点/, '現行仕様（最大5点）の記述が無い');
});

test('【安全】旧定義の本文を書き換えていない（正本は移送先）', () => {
  // 旧は送らないので直さない。**直すなら移送先**。ここでは古いままであることを確認し、
  // 「古い本文が live で出ない」ことは上のガードが保証する。
  const old = listSteps(OLD_ID).map((s) => `${s.subjectTemplate} ${s.bodyTemplate}`).join('\n');
  assert.ok(old.includes('10点'), '旧定義を書き換えている（移送先を直すこと）');
});
