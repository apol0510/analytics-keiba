import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  startAtMs, revealAtMs, preferredCircuit, buildFormation, planDelivery, buildMemberView,
  selectMemberOrders, selectThanksTargets, buildThanksEmail, normalizePredictionFile, jstDate,
  PP_FORMATION_POINTS,
} from './premiumPlusDelivery.js';

const T = (iso) => Date.parse(iso);

function race({ date = '2026-10-04', circuit = 'jra', venue = '東京', raceNumber = 11, startTime = '15:45', cis, field }) {
  const horses = cis.map((ci, i) => ({ n: i + 1, pt: 200 - i * 10, ci }));
  return { date, circuit, venue, raceNumber, raceName: 'テスト', startTime, fieldSize: field ?? horses.length, horses };
}

test('公開時刻は発走予定（JST）の10分前', () => {
  assert.equal(startAtMs('2026-10-04', '15:45'), T('2026-10-04T15:45:00+09:00'));
  assert.equal(revealAtMs('2026-10-04', '15:45'), T('2026-10-04T15:35:00+09:00'));
  assert.equal(revealAtMs('2026-10-04', ''), null);
  assert.equal(revealAtMs('2026-10-04', '25:00'), null);
});

test('土日は中央・平日は南関を優先', () => {
  assert.equal(preferredCircuit('2026-10-04'), 'jra'); // 日
  assert.equal(preferredCircuit('2026-10-03'), 'jra'); // 土
  assert.equal(preferredCircuit('2026-10-05'), 'nankan'); // 月
});

test('フォーメーションは 1着1頭(pt1位)→2着3頭→3着7頭 = 18点', () => {
  const f = buildFormation(race({ cis: [70, 68, 66, 64, 62, 60, 58, 56, 54, 52] }));
  assert.deepEqual(f.first, [1]);
  assert.deepEqual(f.second, [2, 3, 4]);
  assert.deepEqual(f.third, [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(f.points, PP_FORMATION_POINTS);
  // 実際の組み合わせ数も 18
  let n = 0;
  for (const a of f.first) for (const b of f.second) for (const c of f.third) if (new Set([a, b, c]).size === 3) n += 1;
  assert.equal(n, 18);
});

test('8頭未満では作らない', () => {
  assert.equal(buildFormation(race({ cis: [70, 68, 66, 64, 62, 60, 58] })), null);
});

test('混戦のレースを選ぶ・公開まで30分未満のレースは選ばない', () => {
  const nowMs = T('2026-10-04T08:00:00+09:00');
  const solid = race({ raceNumber: 11, startTime: '15:45', cis: [90, 70, 66, 64, 62, 60, 58, 56, 54] });
  const chaos = race({ raceNumber: 9, startTime: '14:35', cis: [72, 71, 70, 69, 66, 64, 62, 60, 58, 56, 54, 52, 50, 48] });
  const out = planDelivery({ saleDate: '2026-10-04', racesByCircuit: { jra: [solid, chaos] }, nowMs });
  assert.equal(out.ok, true);
  assert.equal(out.delivery.races.length, 1);
  assert.equal(out.delivery.races[0].raceNumber, 9);
  assert.equal(out.delivery.races[0].revealAtMs, T('2026-10-04T14:25:00+09:00'));

  const late = planDelivery({ saleDate: '2026-10-04', racesByCircuit: { jra: [chaos] }, nowMs: T('2026-10-04T14:00:00+09:00') });
  assert.deepEqual(late, { ok: false, reason: 'no_eligible_race' });
});

test('優先開催が無ければもう一方の開催から選ぶ', () => {
  const nk = race({ circuit: 'nankan', venue: '大井', cis: [72, 71, 70, 69, 66, 64, 62, 60, 58] });
  const out = planDelivery({ saleDate: '2026-10-04', racesByCircuit: { jra: [], nankan: [nk] }, nowMs: T('2026-10-04T08:00:00+09:00') });
  assert.equal(out.delivery.circuit, 'nankan');
});

test('⚠️ 公開時刻前の応答には買い目が含まれない', () => {
  const delivery = planDelivery({
    saleDate: '2026-10-04',
    racesByCircuit: { jra: [race({ cis: [72, 71, 70, 69, 66, 64, 62, 60, 58] })] },
    nowMs: T('2026-10-04T08:00:00+09:00'),
  }).delivery;
  const orders = [{ saleDate: '2026-10-04' }];
  const before = buildMemberView({ orders, deliveries: { '2026-10-04': delivery }, nowMs: T('2026-10-04T15:34:59+09:00') });
  const r0 = before.days[0].races[0];
  assert.equal(r0.revealed, false);
  for (const k of ['first', 'second', 'third', 'points', 'betType']) assert.equal(k in r0, false, k);
  assert.equal(JSON.stringify(before).includes('"first"'), false);
  assert.equal(before.days[0].status, 'scheduled');

  const after = buildMemberView({ orders, deliveries: { '2026-10-04': delivery }, nowMs: T('2026-10-04T15:35:00+09:00') });
  assert.equal(after.days[0].races[0].revealed, true);
  assert.equal(after.days[0].races[0].points, 18);
  assert.equal(after.days[0].status, 'revealed');
});

test('未生成の日は準備中（レース数は 1）', () => {
  const v = buildMemberView({ orders: [{ saleDate: '2026-10-05' }], deliveries: {}, nowMs: T('2026-10-04T08:00:00+09:00') });
  assert.equal(v.days[0].status, 'preparing');
  assert.equal(v.days[0].raceCount, 1);
});

test('マイページに出す注文は本人・確認済み・本番・今日以降だけ', () => {
  const nowMs = T('2026-10-04T08:00:00+09:00');
  const me = 'recAAAAAAAAAAAAAA';
  const orders = [
    { recordId: me, saleDate: '2026-10-04', status: 'confirmed' },
    { recordId: me, saleDate: '2026-10-03', status: 'confirmed' },
    { recordId: me, saleDate: '2026-10-05', status: 'awaiting_payment' },
    { recordId: me, saleDate: '2026-10-06', status: 'confirmed', canary: true },
    { recordId: 'recBBBBBBBBBBBBBB', saleDate: '2026-10-04', status: 'confirmed' },
  ];
  assert.deepEqual(selectMemberOrders(orders, { recordId: me, nowMs }).map((o) => o.saleDate), ['2026-10-04']);
  assert.equal(selectThanksTargets(orders, { nowMs }).length, 2);
});

test('サンクスメールに買い目・点数を書かない／レース数と公開時刻を書く', () => {
  const m = buildThanksEmail({ fullName: '山田 太郎', saleDate: '2026-10-04', raceCount: 1 });
  for (const body of [m.text, m.html]) {
    assert.match(body, /1レース/);
    assert.match(body, /10分前/);
    assert.match(body, /\/dashboard\//);
    assert.doesNotMatch(body, /18点|点数|1着|2着|3着/);
  }
  assert.match(m.text, /2026年10月4日（日）/);
  assert.doesNotMatch(buildThanksEmail({ fullName: '<b>x</b>', saleDate: '2026-10-04' }).html, /<b>x<\/b>/);
});

test('JST 日付', () => {
  assert.equal(jstDate(T('2026-10-03T15:00:00Z')), '2026-10-04');
  assert.equal(jstDate(T('2026-10-03T14:59:59Z')), '2026-10-03');
});

test('予想 JSON（南関・中央）を読める／取消・名前なしは除外', () => {
  const nk = normalizePredictionFile({ predictions: [{ raceInfo: { venue: '大井', raceNumber: 1, startTime: '16:25' },
    horses: [{ horseNumber: 1, horseName: 'A', pt: 10, computerIndex: 80, role: '本命' },
      { horseNumber: 2, horseName: '', pt: 9, role: '対抗' }, { horseNumber: 3, horseName: 'C', pt: 0, role: '無' }] }] },
  { date: '2026-10-04', circuit: 'nankan' });
  assert.equal(nk.length, 1);
  assert.deepEqual(nk[0].horses.map((h) => h.n), [1]);
  assert.equal(nk[0].fieldSize, 3);
  const jra = normalizePredictionFile({ venues: [{ venue: '東京', predictions: [{ raceInfo: { raceNumber: 11, startTime: '15:45' }, horses: [] }] }] },
    { date: '2026-10-04', circuit: 'jra' });
  assert.equal(jra[0].venue, '東京');
});

test('guard: 生成ジョブ・API は買い目をログへ出さず、API はセッションの recordId だけを使う', () => {
  const cron = readFileSync(new URL('../../../netlify/functions/cron-premium-plus-delivery.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cron, /console\.log\([^)]*(first|second|third|Email)/);
  const api = readFileSync(new URL('../../pages/api/premium-plus-delivery.json.js', import.meta.url), 'utf8');
  assert.match(api, /verified\.payload\?\.sub/);
  assert.doesNotMatch(api, /searchParams|request\.json\(\)/);
  assert.match(api, /no-store/);
  const toml = readFileSync(new URL('../../../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[functions\."cron-premium-plus-delivery"\]\s*\n\s*schedule = "\*\/5 \* \* \* \*"/);
  assert.match(cron, /schedule: '\*\/5 \* \* \* \*'/);
});
