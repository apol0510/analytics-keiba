/**
 * sendgridReconcileHandler.guard.test.mjs — reconcile の配線を**ソースで**固定する
 *
 * 実際の Function を import すると Redis / SendGrid を掴むので、ここは
 * 「危ない書き方が入っていないか」を本文で確かめる（既存の guard テストと同じやり方）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../../netlify/functions/admin-sendgrid-migration.js', import.meta.url), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf("if (action === 'reconcile')"), SRC.indexOf("if (action === 'import' || action === 'exit')"));

test('reconcile は既定で下見（apply が無ければ書き込まない）', () => {
  assert.match(BLOCK, /const apply = req\.apply === true;/);
  assert.match(BLOCK, /if \(!apply\) \{[\s\S]*dryRun: true[\s\S]*sideEffects: 'none'/);
});

test('書き込みは二重ゲート（env + 合言葉）を通る', () => {
  assert.match(BLOCK, /if \(!gateOpen\)[\s\S]*write_gate_closed/);
  assert.match(BLOCK, /req\.confirm[\s\S]*WRITE_CONFIRM[\s\S]*confirm_mismatch/);
});

test('旧 AK が prospect を送る設定のままなら貼り替えない', () => {
  assert.match(BLOCK, /assertSingleEngine\(/);
  assert.match(BLOCK, /akProspectSending: engine !== 'sendgrid'/);
});

test('変更が多すぎるときは実行しない', () => {
  assert.match(BLOCK, /if \(!safety\.ok\)[\s\S]*sideEffects: 'none'/);
});

test('【再送防止】remove が add より先に走る順序を、判定側の reconcileSteps に委ねている', () => {
  assert.match(BLOCK, /for \(const step of reconcileSteps\(plan\)\)/);
  assert.ok(BLOCK.indexOf("step.op === 'remove'") < BLOCK.indexOf('upsertContacts'), 'remove の分岐が add より前に無い');
});

test('受理されない宛先で良い宛先を巻き添えにせず、件数を必ず返す', () => {
  assert.match(BLOCK, /runWithSplit\(step\.entries/);
  assert.match(BLOCK, /applied\.providerRejected \+= r\.rejected\.length/);
});

test('contact の引き当ても分割つき（壊れた宛先で全部落とさない）', () => {
  assert.match(BLOCK, /const lookupSplit = await runWithSplit\(/);
  assert.match(BLOCK, /引けなかった宛先: lookupSplit\.rejected\.length/);
});

test('応答にアドレスを載せない（要約だけ返す）', () => {
  assert.match(BLOCK, /summary: summarizeReconcilePlan\(plan\)/);
  assert.equal(/emails:\s*step\.emails\s*,?\s*\n\s*(?!.*filter)/.test(BLOCK) && /return json\([\s\S]*emails/.test(BLOCK), false);
  // 応答オブジェクトに plan 本体（アドレスを持つ）をそのまま入れていない
  assert.equal(/json\(200, \{[\s\S]*?\bplan,/.test(BLOCK), false);
});

test('アドレスを持たない prospect レコードは触らず数えるだけ', () => {
  assert.match(BLOCK, /if \(!rec \|\| !rec\.email\) \{ withoutEmail \+= 1; continue; \}/);
});

test('AK の list 以外を消しに行かない（list id は SendGrid の名前解決から作る）', () => {
  assert.match(BLOCK, /const ids = listIdsByMessage\(await api\.getLists\(\)\);/);
});

test('状態を引けなかった人は計画から外す（fail closed）', () => {
  assert.match(BLOCK, /const unresolved = new Set\(lookupSplit\.rejected/);
  assert.match(BLOCK, /const targets = akEntries\.filter\(\(e\) => !unresolved\.has/);
  assert.match(BLOCK, /buildReconcilePlan\(\{ akEntries: targets/);
});
