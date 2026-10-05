// AI ラボ（docs/AI_LAB.md・2026-10-05 MK 確定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseKapRaceId, sanitizeIngest, akTop5, attachAk, dayView, labStats, INGEST_SCHEMA } from './aiLab.js';
import { saveDay, loadRecentDays, dayKey } from './aiLabStore.js';
import { loadLabView, AILAB_POLL_PLANS } from './aiLabServer.js';
import { buildResultIndex } from '../acquisition/acquiredResults.js';
import { makeFakeRedis } from '../acquisition/fakeRedis.test-helper.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');

const payload = (extra = {}) => ({
  schema: INGEST_SCHEMA, market: 'jra', date: '2026-10-04', model_version: 'kap-v3',
  races: [{ race_id: '2026-10-04-05-11', odds_basis: 'decision', observed_at: '2026-10-04T06:34:21.110Z',
    // KAP の買い目・金額が混ざって来ても保存しない
    picked: ['11'], stake: 300, recommended_stake: 2100,
    field: [
      { selection: '11', horse_number: 11, p_calibrated: 0.0373, odds: 103.0, ev: 3.84, stake: 300, picked: true },
      { selection: '04', horse_number: 4, p_calibrated: 0.1555, odds: 1.7 },
      { selection: '07', horse_number: 7, p_calibrated: 0.0073, odds: null },
    ] }],
  ...extra,
});

test('race_id は JRA 場コードで読む（05=東京・08=京都）・範囲外は弾く', () => {
  assert.deepEqual(parseKapRaceId('2026-10-04-05-11'), { date: '2026-10-04', venueName: '東京', venueId: 'TOK', raceNumber: 11 });
  assert.equal(parseKapRaceId('2026-10-04-08-01').venueName, '京都');
  assert.equal(parseKapRaceId('2026-10-04-11-01'), null);
  assert.equal(parseKapRaceId('2026-10-04-05-13'), null);
  assert.equal(parseKapRaceId('x'), null);
});

test('取込: 保存するのは全頭の AI 勝率・オッズ・期待値だけ（KAP の買い目・金額は落とす）', () => {
  const s = sanitizeIngest(payload());
  assert.equal(s.ok, true);
  const r = s.day.races[0];
  assert.deepEqual(Object.keys(r).sort(), ['field', 'observedAt', 'oddsBasis', 'raceId', 'raceNumber', 'venueId', 'venueName'].sort());
  assert.deepEqual(r.field[0], { n: 11, p: 0.0373, odds: 103, ev: 3.8419 });
  assert.equal(r.field[2].ev, null, 'オッズが無ければ期待値も出さない');
  assert.doesNotMatch(JSON.stringify(s.day), /stake|picked/);
  for (const [bad, reason] of [[{ schema: 'x' }, 'schema'], [{ market: 'nankan' }, 'market'], [{ date: '2026/10/04' }, 'date'],
    [{ races: [] }, 'races'], [{ races: [{ race_id: '2026-10-05-05-11', field: [] }] }, 'race_id']]) {
    assert.equal(sanitizeIngest(payload(bad)).reason, reason, reason);
  }
});

test('AK 上位 5 頭 = 本命＋役割優先（対抗→単穴→連下最上位→連下・同役割は pt 降順）', () => {
  const horses = [
    { horseNumber: 6, role: '本命', pt: 190 }, { horseNumber: 3, role: '連下', pt: 157 }, { horseNumber: 18, role: '対抗', pt: 184 },
    { horseNumber: 14, role: '連下', pt: 160 }, { horseNumber: 2, role: '単穴', pt: 165 }, { horseNumber: 8, role: '連下', pt: 151 },
    { horseNumber: 11, role: '補欠', pt: 150 },
  ];
  assert.deepEqual(akTop5(horses).map((h) => [h.n, h.role]), [[6, '本命'], [18, '対抗'], [2, '単穴'], [14, '連下'], [3, '連下']]);
});

test('画面: 期待値ランキング・AK 上位 5 頭は発走後だけ・答え合わせ（1着が上位 5 頭か／勝ち馬の期待値順位）', () => {
  const day = attachAk(sanitizeIngest(payload()).day, [{ venueId: 'TOK', races: [{ raceInfo: { raceNumber: 11, startTime: '15:45' },
    horses: [{ horseNumber: 4, role: '本命', pt: 1 }, { horseNumber: 11, role: '対抗', pt: 1 }] }] }]);
  const before = dayView(day, { results: new Map(), nowMs: Date.parse('2026-10-04T15:00:00+09:00') });
  assert.equal(before.races[0].akTop5, null, '発走前は AK の予想を出さない（有料予想の価値を守る）');
  assert.deepEqual(before.races[0].ranking.map((h) => [h.n, h.rank]), [[11, 1], [4, 2], [7, null]]);
  const results = buildResultIndex({ umatan: [{ date: '2026-10-04', races: [{ raceNumber: 11, venue: '東京', result: { first: { number: 4 }, second: { number: 11 }, third: { number: 7 } } }] }] });
  const after = dayView(day, { results, nowMs: Date.parse('2026-10-04T16:00:00+09:00') });
  assert.deepEqual(after.races[0].akTop5.map((h) => h.n), [4, 11]);
  assert.deepEqual(after.races[0].result, { order: [4, 11, 7], winnerInAkTop5: true, winnerEvRank: 2 });
  assert.deepEqual(labStats([after]), { settled: 1, top5Hit: 1, evRanked: 1, evTop5: 1 });
  assert.deepEqual(labStats([before]), { settled: 0, top5Hit: 0, evRanked: 0, evTop5: 0 }, '結果の無いレースは数えない');
});

test('保存: 1 日 1 キー・日付索引・AK 上位 5 頭は消えたら前の値を保つ／画面データ', async () => {
  const redis = makeFakeRedis();
  const calls = [];
  const r2 = async (args) => { calls.push(args[0]); if (args[0] === 'ZADD') { (r2.z ||= new Map()).set(args[3], Number(args[2])); return 1; }
    if (args[0] === 'ZREVRANGE') return [...(r2.z || new Map()).entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    return redis(args.slice(0, 3)); };
  const day = attachAk(sanitizeIngest(payload()).day, [{ venueId: 'TOK', races: [{ raceInfo: { raceNumber: 11, startTime: '15:45' }, horses: [{ horseNumber: 4, role: '本命', pt: 1 }] }] }]);
  await saveDay(r2, day);
  const again = await saveDay(r2, attachAk(sanitizeIngest(payload()).day, []));
  assert.deepEqual(again.races[0].akTop5, [{ n: 4, role: '本命' }], 'AK 側の予想が消えても保存済みを保つ');
  assert.equal(again.races[0].startTime, '15:45');
  assert.equal(dayKey('2026-10-04'), 'ak:ailab:v1:jra:day:2026-10-04');
  const days = await loadRecentDays(r2);
  assert.equal(days.length, 1);
  const view = await loadLabView({ deps: { redis: r2, index: new Map() }, nowMs: Date.parse('2026-10-04T16:00:00+09:00') });
  assert.equal(view.days[0].races[0].akTop5[0].n, 4);
  assert.ok(view.serverNow);
});

test('API/ページ: 取込は秘密ヘッダ必須・env 無しは 503／自動更新は ak_session の署名だけ（Airtable を呼ばない）・無料は通さない', () => {
  const ing = read('src/pages/api/ailab/ingest.js');
  assert.match(ing, /if \(!secret \|\| secret\.length < 32\) return json\(503/);
  assert.match(ing, /timingSafeEqual\(digest\(request\.headers\.get\('x-ailab-secret'\)/);
  assert.match(ing, /sanitizeIngest\(payload\)/);
  const view = read('src/pages/api/ailab/view.js');
  assert.match(view, /verifyPlanAccess\(/);
  assert.doesNotMatch(view.replace(/\/\*\*[\s\S]*?\*\//, ''), /gatePaidPage|airtable/i);
  assert.ok(!AILAB_POLL_PLANS.includes('free') && AILAB_POLL_PLANS.includes('premium') && AILAB_POLL_PLANS.includes('light'));
  const page = read('src/pages/ai-lab/index.astro');
  assert.match(page, /gatePaidPage\(\{ request: Astro\.request, requiredPlan: \['standard', 'premium', 'Premium Sanrenpuku'\]/);
  assert.match(page, /var POLL_MS = 30000;/, '30 秒ごとに自動更新');
  assert.match(page, /setInterval\(tick, 1000\)/, '発走までのカウントダウン');
  assert.match(page, /自動追従/);
  assert.match(page, /<style is:global>/, 'JS で描く要素にも当たる');
  assert.match(page, /\.lab-page \[hidden\] \{ display: none !important; \}/, 'hidden を display 指定で潰さない');
  assert.doesNotMatch(page, /実際の購入は行っていません|実購入なし|仮想注文/, '実購入なしを訴求しない（MK）');
  assert.doesNotMatch(page, /stake|推奨金額/, '金額は出さない');
  assert.match(read('src/pages/dashboard.astro'), /href="\/ai-lab\/"/);
});
