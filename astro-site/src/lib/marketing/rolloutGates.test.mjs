/**
 * rolloutGates.test.mjs — 工程ごとの env（どれが閉じていて、何が止まるか）
 *   node --test src/lib/marketing/rolloutGates.test.mjs
 *
 * 守る性質:
 *   - **既定は全部閉**（env を置かなければ副作用ゼロ）
 *   - 工程ごとに必要な env が違うことを表として固定する（説明と実装のズレを防ぐ）
 *   - 閉じている env の**名前をそのまま**返す（運用者が開けられるように）
 *   - 既存ゲートを緩めない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readStageGates, canRunStage, describeBlocked,
  ROLLOUT_STAGE_GATE, STAGE_ENV,
} from './rolloutGates.js';

const OPEN = Object.freeze({
  MARKETING_ROLLOUT_ENABLED: 'true',
  COMEBACK_GRANT_FIELDS_READY: '1',
  COMEBACK_GRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
});

test('【重要】env が空なら全工程が閉じている', () => {
  const g = readStageGates({});
  assert.equal(g.allOpen, false);
  for (const stage of Object.values(ROLLOUT_STAGE_GATE)) {
    assert.equal(g.stages[stage].open, false, `${stage} が既定で開いている`);
    assert.equal(g.stages[stage].effective, false);
  }
});

test('全部開ければ全工程が開く', () => {
  const g = readStageGates(OPEN);
  assert.equal(g.allOpen, true);
  assert.equal(g.blocked.length, 0);
  for (const stage of Object.values(ROLLOUT_STAGE_GATE)) {
    assert.equal(g.stages[stage].effective, true, `${stage} が開いていない`);
  }
});

test('【重要】キュー登録には MARKETING_CAMPAIGN_ENABLED が要る', () => {
  assert.ok(STAGE_ENV[ROLLOUT_STAGE_GATE.QUEUE].includes('MARKETING_CAMPAIGN_ENABLED'));
  const g = readStageGates({ ...OPEN, MARKETING_CAMPAIGN_ENABLED: '' });
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.QUEUE].open, false);
  // 他の工程は巻き添えにしない
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.GRANT].open, true);
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.DISPATCH].open, true);
});

test('【重要】実送信には MARKETING_CAMPAIGN_DISPATCH_ENABLED が要る', () => {
  assert.ok(STAGE_ENV[ROLLOUT_STAGE_GATE.DISPATCH].includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'));
  const g = readStageGates({ ...OPEN, MARKETING_CAMPAIGN_DISPATCH_ENABLED: '' });
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.DISPATCH].open, false);
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.QUEUE].open, true);
});

test('【重要】付与には既存の 3 つが要る（自動化用の抜け道を作らない）', () => {
  assert.deepEqual(STAGE_ENV[ROLLOUT_STAGE_GATE.GRANT], [
    'COMEBACK_GRANT_FIELDS_READY', 'COMEBACK_GRANT_ENABLED', 'LIGHT_TRIAL_AUTOGRANT_ENABLED',
  ]);
  for (const name of STAGE_ENV[ROLLOUT_STAGE_GATE.GRANT]) {
    const g = readStageGates({ ...OPEN, [name]: '' });
    assert.equal(g.stages[ROLLOUT_STAGE_GATE.GRANT].open, false, `${name} が無くても付与が開いている`);
  }
});

test('【重要】FIELDS_READY は "1"（既存の付与ゲートに合わせる）', () => {
  assert.equal(readStageGates({ ...OPEN, COMEBACK_GRANT_FIELDS_READY: 'true' })
    .stages[ROLLOUT_STAGE_GATE.GRANT].open, false, '"true" を受け入れている（既存と食い違う）');
  assert.equal(readStageGates({ ...OPEN, COMEBACK_GRANT_FIELDS_READY: '1' })
    .stages[ROLLOUT_STAGE_GATE.GRANT].open, true);
});

test('【重要】自動運転そのものが閉じていれば、他が開いていても実際には動かない', () => {
  const g = readStageGates({ ...OPEN, MARKETING_ROLLOUT_ENABLED: '' });
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.QUEUE].open, true, '個別の判定まで壊している');
  assert.equal(g.stages[ROLLOUT_STAGE_GATE.QUEUE].effective, false, '自動運転が閉じているのに動く扱い');
  assert.equal(canRunStage({ ...OPEN, MARKETING_ROLLOUT_ENABLED: '' }, ROLLOUT_STAGE_GATE.QUEUE), false);
});

test('【重要】閉じている env の名前をそのまま返す', () => {
  const g = readStageGates({ ...OPEN, MARKETING_CAMPAIGN_ENABLED: '', MARKETING_CAMPAIGN_DISPATCH_ENABLED: '' });
  const names = g.blocked.flatMap((b) => b.missing);
  assert.ok(names.includes('MARKETING_CAMPAIGN_ENABLED'));
  assert.ok(names.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'));
});

test('【重要】何が止まるかを日本語で言える（運用者向け）', () => {
  const msg = describeBlocked({ ...OPEN, MARKETING_CAMPAIGN_DISPATCH_ENABLED: '' });
  assert.ok(msg.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), msg);
  assert.ok(msg.includes('メールが 1 通も出ません'), msg);
  assert.equal(describeBlocked(OPEN), null, '全部開いているのに警告を出している');
});

test('true 以外の値は開いていない扱い（1 / yes / TRUE を勝手に認めない）', () => {
  for (const v of ['1', 'yes', 'TRUE', 'True', ' true ']) {
    const g = readStageGates({ ...OPEN, MARKETING_CAMPAIGN_DISPATCH_ENABLED: v });
    const expected = v.trim() === 'true';
    assert.equal(g.stages[ROLLOUT_STAGE_GATE.DISPATCH].open, expected, `"${v}" の扱いが違う`);
  }
});

test('canRunStage は既定で false（不明な工程も false）', () => {
  assert.equal(canRunStage({}, ROLLOUT_STAGE_GATE.DISPATCH), false);
  assert.equal(canRunStage(OPEN, 'unknown-stage'), false);
});

test('応答に secret や値そのものを含めない（名前だけ）', () => {
  const dump = JSON.stringify(readStageGates({ ...OPEN, MARKETING_CAMPAIGN_ENABLED: 'super-secret-value' }));
  assert.equal(dump.includes('super-secret-value'), false, 'env の値を出している');
});
