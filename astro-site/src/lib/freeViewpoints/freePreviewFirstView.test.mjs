/**
 * freePreviewFirstView.test.mjs — ファーストビュー（2026-09-27）の振る舞い。
 *
 * 守ること:
 *   - 注目馬は公開 DTO の ◎ だけ。理由は公開事実（前走着順・近走 3 着以内回数）だけ
 *   - 戻り値に pt / AI総合指数 / 役割 / 特徴量 / 買い目 / 生データ参照が入らない
 *   - メインレースは getMainRaceNumber と同じ判定
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMainRace, buildReasons, buildFirstViewPick } from '../freePreviewFirstView.js';

const horse = (n, role, extra = {}) => ({
  number: n, name: `ウマ${n}`, jockey: `騎手${n}`, role,
  pt: 777 + n, computerIndex: 91, sourceComputerIndex: 92, rawScore: 555, displayScore: 444,
  importance: [{ label: 'x', value: 0.9 }], evalPoints: ['秘密'], ...extra,
});
const HORSES = [
  horse(1, '連下'), horse(2, '対抗'), horse(3, '本命', { recent: [{ rank: 1 }, { rank: 2 }, { rank: 7 }] }),
  horse(4, '単穴'), horse(5, '連下最上位'), horse(6, '補欠'), horse(7, '無'),
];

test('メインレースは開催レース数から決める（12R→11R / 10R→9R / 8R→7R）', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ raceNumber: `${i + 1}R` }));
  assert.equal(pickMainRace(mk(12), (r) => r.raceNumber).raceNumber, '11R');
  assert.equal(pickMainRace(mk(10), (r) => r.raceNumber).raceNumber, '9R');
  assert.equal(pickMainRace(mk(8), (r) => r.raceNumber).raceNumber, '7R');
  assert.equal(pickMainRace(mk(9), (r) => r.raceNumber).raceNumber, '9R');
  assert.equal(pickMainRace([], (r) => r.raceNumber), null);
});

test('isMainRace フラグがあればそれを優先する', () => {
  const races = [{ raceNumber: 1 }, { raceNumber: 2, isMainRace: true }, { raceNumber: 3 }];
  assert.equal(pickMainRace(races, (r) => r.raceNumber).raceNumber, 2);
});

test('理由は良い公開事実だけ（前走 1〜3 着 / 近走で 3 着以内 2 回以上）', () => {
  assert.deepEqual(buildReasons([{ rank: 1 }, { rank: 2 }, { rank: 7 }]), ['前走1着', '近3走で3着以内2回']);
  assert.deepEqual(buildReasons([{ rank: 8 }, { rank: 2 }]), []);
  assert.deepEqual(buildReasons([{ finish: '3' }]), ['前走3着']);
  // 取消・中止は着順として数えない
  assert.deepEqual(buildReasons([{ rank: 1, finishStatus: '取消' }, { rank: 2 }, { rank: 3 }]), ['近2走で3着以内2回']);
  assert.deepEqual(buildReasons(undefined), []);
});

test('注目馬は ◎、相手は ○▲△ の上位 4 頭の印だけ', () => {
  const pick = buildFirstViewPick({ venue: '大井', raceNumber: '11R', raceName: '重賞', horses: HORSES, resolveRecent: (h) => h.recent || [] });
  assert.equal(pick.raceNumber, 11);
  assert.deepEqual(pick.honmei, { number: 3, name: 'ウマ3', jockey: '騎手3' });
  assert.deepEqual(pick.reasons, ['前走1着', '近3走で3着以内2回']);
  assert.deepEqual(pick.others.map((o) => `${o.mark}${o.number}`), ['○2', '▲4', '△5']);
  assert.equal(pick.headcount, 7);
});

test('過去走が古い順なら新しい順に直してから理由を作る', () => {
  const horses = [horse(3, '本命', { recent: [{ rank: 9 }, { rank: 8 }, { rank: 1 }] })];
  const pick = buildFirstViewPick({ horses, resolveRecent: (h) => h.recent, recentOrder: 'oldest-first' });
  assert.deepEqual(pick.reasons, ['前走1着']);
});

test('良い材料が無ければ事実だけの既定文にする（盛らない）', () => {
  const horses = [horse(3, '本命', { recent: [{ rank: 9 }] }), horse(4, '対抗')];
  const pick = buildFirstViewPick({ horses, resolveRecent: (h) => h.recent || [] });
  assert.deepEqual(pick.reasons, ['出走2頭からAIが本命に選んだ馬']);
});

test('競走名の仮名（第11レース）はレース番号と重複するので出さない', () => {
  const horses = [horse(3, '本命')];
  assert.equal(buildFirstViewPick({ raceNumber: 11, raceName: '第11レース', horses }).raceName, '');
  assert.equal(buildFirstViewPick({ raceNumber: 11, raceName: 'スプリンターズＳ', horses }).raceName, 'スプリンターズＳ');
});

test('◎ が無いレースは出さない', () => {
  assert.equal(buildFirstViewPick({ horses: [horse(1, '対抗')] }), null);
  assert.equal(buildFirstViewPick({ horses: [] }), null);
});

test('戻り値に有料情報・生データ参照が入らない', () => {
  const pick = buildFirstViewPick({ venue: '大井', raceNumber: 11, horses: HORSES, resolveRecent: (h) => h.recent || [] });
  const json = JSON.stringify(pick);
  for (const bad of ['pt', 'computerIndex', 'sourceComputerIndex', 'rawScore', 'displayScore', 'importance', 'evalPoints', 'role', '_horse', 'bettingLines']) {
    assert.equal(json.includes(`"${bad}"`), false, `キー ${bad} が漏れている`);
  }
  for (const bad of ['777', '780', '91', '92', '555', '444', '秘密', '本命', '対抗', '単穴', '補欠']) {
    assert.equal(json.includes(bad), false, `値 ${bad} が漏れている`);
  }
});
