// AI ラボ（docs/AI_LAB.md・2026-10-07 MK 確定）: 中央・南関を同じ UI で・全頭のオッズ・期待値・カウントダウン
// 値はすべて合成（実オッズは使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRaceId, sanitizeIngest, countdown, followTarget, buildNav, raceDisplay,
  jstHm, jstHms, jstDate, INGEST_SCHEMA, STALE_MS, MARKETS, resultLine, startLine, nextUpcoming, RESULT_ETA,
} from './aiLab.js';
import { saveDay, loadDay, listDates, dayKey } from './aiLabStore.js';
import { attachAk, akTop5Marks } from './aiLabAk.js';
import { loadMarketView, pickInitialMarket, withResults, AILAB_POLL_PLANS } from './aiLabServer.js';

/** SET / GET / ZADD / ZREVRANGE だけの最小の Redis（保存の検証用） */
function makeFakeRedis() {
  const kv = new Map();
  const z = new Map();
  return async ([cmd, key, ...a]) => {
    if (cmd === 'SET') { kv.set(key, a[0]); return 'OK'; }
    if (cmd === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (cmd === 'ZADD') { const m = z.get(key) || new Map(); m.set(a[1], Number(a[0])); z.set(key, m); return 1; }
    if (cmd === 'ZREVRANGE') {
      const list = [...(z.get(key) || new Map()).entries()].sort((x, y) => y[1] - x[1]).map(([v]) => v);
      return list.slice(Number(a[0]), Number(a[1]) + 1);
    }
    throw new Error(`unsupported ${cmd}`);
  };
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');

const horse = (n, p, odds) => ({ horse_number: n, p_calibrated: p, odds, ev: odds == null || p == null ? null : Math.round(p * odds * 10000) / 10000 });
const race = (id, start, field, extra = {}) => ({
  race_id: id, race_start_at: start, status: 'ok', model_version: 'kap-ability-v3-rf.v1',
  odds_basis: 'latest', odds_observed_at: '2026-10-07T10:58:00.000Z', field, ...extra,
});
const nankan = (extra = {}) => ({
  schema: INGEST_SCHEMA, market: 'nankan', date: '2026-10-07', generated_at: '2026-10-07T10:59:00.000Z',
  races: [
    race('2026-10-07-OI-11', '2026-10-07T11:10:00.000Z', [horse(2, 0.1, 8.5), horse(1, 0.25, 5.0), horse(3, 0.05, null)]),
    race('2026-10-07-OI-12', '2026-10-07T11:45:00.000Z', [], { status: 'no_predictions', model_version: null }),
  ],
  ...extra,
});
const jra = () => ({
  schema: INGEST_SCHEMA, market: 'jra', date: '2026-10-04', generated_at: '2026-10-04T05:30:00.000Z',
  races: [
    race('2026-10-04-05-11', '2026-10-04T06:45:00.000Z', [horse(1, 0.3, 3.2), horse(2, 0.2, 6.0)]),
    race('2026-10-04-08-11', '2026-10-04T06:25:00.000Z', [horse(1, 0.15, 7.0)]),
  ],
});

test('race_id: 中央（場コード 2 桁）・南関（OI/KA/FU/UR）を読む・範囲外は弾く', () => {
  assert.deepEqual(parseRaceId('2026-10-04-05-11'), { market: 'jra', date: '2026-10-04', venueCode: '05', venueName: '東京', raceNumber: 11 });
  assert.deepEqual(parseRaceId('2026-10-07-OI-1'), { market: 'nankan', date: '2026-10-07', venueCode: 'OI', venueName: '大井', raceNumber: 1 });
  assert.equal(parseRaceId('2026-10-07-FU-12').venueName, '船橋');
  for (const bad of ['2026-10-04-11-01', '2026-10-04-05-13', '2026-10-07-XX-1', '2026-10-07-OI-0', '', null]) assert.equal(parseRaceId(bad), null, String(bad));
});

test('取込: 全頭の AI 勝率・オッズ・期待値を保存し、買い目・金額・判断は落とす', () => {
  const p = nankan();
  p.races[0].picked = ['02']; p.races[0].stake = 300;
  p.races[0].field[0].stake = 300; p.races[0].field[0].picked = true; p.races[0].field[0].decision = 'BUY';
  const s = sanitizeIngest(p);
  assert.equal(s.ok, true);
  const r = s.day.races.find((x) => x.raceId === '2026-10-07-OI-11');
  assert.deepEqual(r.field, [
    { n: 1, p: 0.25, odds: 5.0, ev: 1.25 },
    { n: 2, p: 0.1, odds: 8.5, ev: 0.85 },
    { n: 3, p: 0.05, odds: null, ev: null },
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.oddsBasis, 'latest');
  const text = JSON.stringify(s.day);
  for (const banned of ['picked', 'stake', 'BUY']) assert.equal(text.includes(banned), false, banned);
  // 評価前のレースも一覧には出す（値なし）
  const pending = s.day.races.find((x) => x.raceId === '2026-10-07-OI-12');
  assert.equal(pending.status, 'pending'); assert.deepEqual(pending.field, []);
});

test('取込: fail closed（不正なら保存しない／欠損・範囲外・食い違いは null）', () => {
  assert.equal(sanitizeIngest({ ...nankan(), schema: 'ak_ailab_ingest.v2' }).reason, 'schema');
  assert.equal(sanitizeIngest({ ...nankan(), market: 'kyoto' }).reason, 'market');
  assert.equal(sanitizeIngest({ ...nankan(), generated_at: 'x' }).reason, 'generated_at');
  const wrongMarket = nankan(); wrongMarket.races[0].race_id = '2026-10-07-05-11';
  assert.equal(sanitizeIngest(wrongMarket).reason, 'race_id');
  const wrongDate = nankan(); wrongDate.races[0].race_id = '2026-10-06-OI-11';
  assert.equal(sanitizeIngest(wrongDate).reason, 'race_id');
  const dupHorse = nankan(); dupHorse.races[0].field.push(horse(1, 0.1, 9));
  assert.equal(sanitizeIngest(dupHorse).reason, 'horse_number');
  const noStart = nankan(); noStart.races[0].race_start_at = null;
  assert.equal(sanitizeIngest(noStart).reason, 'race_start_at');
  // 値の不正は馬ごとに null（推測しない）
  const bad = nankan();
  bad.races[0].field = [
    { horse_number: 1, p_calibrated: 1.5, odds: 4.0, ev: 6.0 },          // 勝率が範囲外 → p null（期待値は検算できないがオッズと値は残す）
    { horse_number: 2, p_calibrated: 0.2, odds: 1.0, ev: 0.2 },          // オッズ 1.0 以下 → オッズ・期待値 null
    { horse_number: 3, p_calibrated: 0.2, odds: 5.0, ev: 3.0 },          // 期待値が 勝率×オッズ と食い違う → 期待値 null
    { horse_number: 4, p_calibrated: 0.2, odds: null, ev: 1.2 },         // オッズが無いのに期待値 → 期待値 null
  ];
  const f = sanitizeIngest(bad).day.races.find((x) => x.raceId === '2026-10-07-OI-11').field;
  assert.deepEqual(f, [
    { n: 1, p: null, odds: 4.0, ev: 6.0 },
    { n: 2, p: 0.2, odds: null, ev: null },
    { n: 3, p: 0.2, odds: 5.0, ev: null },
    { n: 4, p: 0.2, odds: null, ev: null },
  ]);
  // 市場由来（オッズから作った）勝率のレースは値を出さない
  const mi = nankan(); mi.races[0].model_version = 'market-implied.v1';
  assert.equal(sanitizeIngest(mi).day.races.find((x) => x.raceId === '2026-10-07-OI-11').status, 'pending');
});

test('馬名は AK の予想データから添える（無ければ馬番だけ）', () => {
  const day = sanitizeIngest(nankan()).day;
  const named = attachAk(day, [{ venueName: '大井', races: [{ raceInfo: { raceNumber: 11 }, horses: [{ horseNumber: 1, horseName: 'テストホースA' }] }] }]);
  const f = named.races.find((r) => r.raceId === '2026-10-07-OI-11').field;
  assert.equal(f[0].name, 'テストホースA');
  assert.equal(f[1].name, undefined);
});

test('JST 境界: 時刻表示はブラウザの TZ に依らず JST・日付をまたぐ', () => {
  assert.equal(jstHm('2026-10-07T14:59:59.000Z'), '23:59');
  assert.equal(jstHm('2026-10-07T15:00:00.000Z'), '00:00');
  assert.equal(jstHms('2026-10-07T10:58:07.000Z'), '19:58:07');
  assert.equal(jstDate(Date.parse('2026-10-07T14:59:59.999Z')), '2026-10-07');
  assert.equal(jstDate(Date.parse('2026-10-07T15:00:00.000Z')), '2026-10-08');
  assert.equal(jstHm('bad'), '-');
});

test('カウントダウン: 発走時刻ちょうどで「発走済み」・1 秒前は 0分01秒・時間表示', () => {
  const start = '2026-10-07T11:10:00.000Z';
  const t = Date.parse(start);
  assert.deepEqual(countdown(start, t), { started: true, seconds: 0, text: '発走済み' });
  assert.equal(countdown(start, t + 5000).text, '発走済み');
  assert.equal(countdown(start, t - 1000).text, '0分01秒');
  assert.equal(countdown(start, t - 999).text, '0分01秒');
  assert.equal(countdown(start, t - 61_000).text, '1分01秒');
  assert.equal(countdown(start, t - 3_725_000).text, '1時間2分05秒');
  assert.equal(countdown(null, t).text, '-');
});

test('自動追従: これから発走する一番早いレース（開催場をまたぐ）→ 発走したら次 → 全部発走済みなら最後', () => {
  const day = sanitizeIngest(jra()).day; // 京都 11R 15:25 JST・東京 11R 15:45 JST
  const kyoto = '2026-10-04-08-11';
  const tokyo = '2026-10-04-05-11';
  assert.equal(followTarget(day.races, Date.parse('2026-10-04T06:00:00Z')), kyoto);
  assert.equal(followTarget(day.races, Date.parse('2026-10-04T06:25:00Z')), tokyo, '発走時刻ちょうどで次へ');
  assert.equal(followTarget(day.races, Date.parse('2026-10-04T07:30:00Z')), tokyo, '全部発走済みなら最後');
  assert.equal(followTarget([], Date.now()), null);
});

test('前後レース・開催場は同じ開催場の R 番号順（dashboard と同じ）', () => {
  const p = nankan();
  p.races.push(race('2026-10-07-OI-10', '2026-10-07T10:35:00.000Z', [horse(1, 0.2, 4)]));
  const day = sanitizeIngest(p).day;
  const nav = buildNav(day.races, '2026-10-07-OI-11');
  assert.deepEqual(nav.venues.map((v) => [v.name, v.races]), [['大井', ['2026-10-07-OI-10', '2026-10-07-OI-11', '2026-10-07-OI-12']]]);
  assert.equal(nav.prev, '2026-10-07-OI-10');
  assert.equal(nav.next, '2026-10-07-OI-12');
  const j = buildNav(sanitizeIngest(jra()).day.races, '2026-10-04-05-11');
  assert.deepEqual(j.venues.map((v) => v.name), ['東京', '京都']);
  assert.equal(j.prev, null); assert.equal(j.next, null);
});

test('全頭表示: 馬番順・強調なし・オッズと期待値・AI 勝率（中央・南関とも同じ形）', () => {
  for (const [p, id] of [[nankan(), '2026-10-07-OI-11'], [jra(), '2026-10-04-05-11']]) {
    const day = sanitizeIngest(p).day;
    const r = day.races.find((x) => x.raceId === id);
    const now = Date.parse(r.startAt) - 5 * 60 * 1000;
    const d = raceDisplay(r, { nowMs: now, receivedAt: new Date(now - 60_000).toISOString() });
    // テストのため観測時刻を「今」の直前にする
    const d2 = raceDisplay({ ...r, oddsObservedAt: new Date(now - 60_000).toISOString() }, { nowMs: now, receivedAt: new Date(now - 60_000).toISOString() });
    assert.equal(d2.state, 'ok'); assert.equal(d2.valuesShown, true);
    assert.deepEqual(d2.rows.map((x) => x.n), r.field.map((x) => x.n).sort((a, b) => a - b), '全頭・馬番順');
    for (const row of d2.rows) assert.deepEqual(Object.keys(row).sort(), ['ev', 'mark', 'n', 'name', 'odds', 'p', 'rank'], '強調・買い目の項目が無い（印は AK の印だけ）');
    assert.ok(d2.oddsNote.includes('観測'));
    assert.ok(d.state === 'ok');
  }
  const r = sanitizeIngest(nankan()).day.races[0];
  const now = Date.parse('2026-10-07T11:00:00.000Z');
  const d = raceDisplay(r, { nowMs: now, receivedAt: '2026-10-07T10:59:30.000Z' });
  assert.deepEqual(d.rows.map((x) => [x.n, x.p, x.odds, x.ev]), [[1, '25.0%', '5.0', '1.25'], [2, '10.0%', '8.5', '0.85'], [3, '5.0%', '-', '-']]);
});

test('fail closed: 評価前・データ更新停止・オッズ観測が古い／無い は数値を出さない。発走後は判断時点の値を出す', () => {
  const r = sanitizeIngest(nankan()).day.races[0]; // 発走 20:10 JST・オッズ観測 19:58 JST
  const before = Date.parse('2026-10-07T11:00:00.000Z');
  // 評価前（予測なし）
  const pend = raceDisplay(sanitizeIngest(nankan()).day.races[1], { nowMs: before, receivedAt: '2026-10-07T10:59:00.000Z' });
  assert.equal(pend.state, 'pending'); assert.deepEqual(pend.rows, []); assert.match(pend.message, /10 分前/);
  // データの受信が古い（更新停止）
  const stale = raceDisplay(r, { nowMs: before, receivedAt: new Date(before - STALE_MS - 1).toISOString() });
  assert.equal(stale.valuesShown, false); assert.ok(stale.rows.every((x) => x.odds === '-' && x.ev === '-'));
  assert.ok(stale.rows.every((x) => x.p !== '-'), 'AI 勝率は出す');
  // オッズの観測が古い
  const oldObs = raceDisplay(r, { nowMs: Date.parse('2026-10-07T11:09:00.000Z'), receivedAt: '2026-10-07T11:08:30.000Z' });
  assert.equal(oldObs.valuesShown, false); assert.match(oldObs.message, /オッズの更新/);
  // 観測時刻が無い
  const noObs = raceDisplay({ ...r, oddsObservedAt: null }, { nowMs: before, receivedAt: '2026-10-07T10:59:30.000Z' });
  assert.equal(noObs.valuesShown, false);
  // 発走後: 判断時点（固定）の値なので古さで隠さない
  const after = raceDisplay({ ...r, oddsBasis: 'decision' }, { nowMs: Date.parse('2026-10-07T12:00:00.000Z'), receivedAt: '2026-10-07T10:00:00.000Z' });
  assert.equal(after.started, true); assert.equal(after.valuesShown, true); assert.match(after.oddsNote, /発走10分前（\d\d:\d\d 観測）の値です。発走後は更新しません/);
});

test('保存: market ごと・1 日 1 キー・受信時刻を添える／画面データは今日→直近／Redis 不可は null', async () => {
  const redis = makeFakeRedis();
  const now = Date.parse('2026-10-07T11:00:00.000Z');
  await saveDay(redis, sanitizeIngest(nankan()).day, { nowMs: now });
  await saveDay(redis, sanitizeIngest(jra()).day, { nowMs: now });
  assert.equal(dayKey('nankan', '2026-10-07'), 'ak:ailab:v2:nankan:day:2026-10-07');
  assert.throws(() => dayKey('kyoto', '2026-10-07'));
  assert.deepEqual(await listDates(redis, 'nankan'), ['2026-10-07']);
  const d = await loadDay(redis, 'nankan', '2026-10-07');
  assert.equal(d.receivedAt, '2026-10-07T11:00:00.000Z');
  assert.equal(await loadDay(redis, 'jra', '2026-10-07'), null, '他 market の日を混ぜない');
  const vn = await loadMarketView({ market: 'nankan', nowMs: now, deps: { redis } });
  assert.equal(vn.date, '2026-10-07'); assert.equal(vn.day.races.length, 2);
  const vj = await loadMarketView({ market: 'jra', nowMs: now, deps: { redis } });
  assert.equal(vj.date, '2026-10-04', '今日が無ければ直近');
  assert.equal(await loadMarketView({ market: 'kyoto', deps: { redis } }), null);
  assert.equal(await loadMarketView({ market: 'jra', deps: { redis: async () => { throw new Error('down'); } } }), null);
  // 最初に開く market: 今日これから発走がある market
  assert.equal(pickInitialMarket([vj, vn], { nowMs: now }), 'nankan');
  assert.equal(pickInitialMarket([vj, vn], { nowMs: now, requested: 'jra' }), 'jra');
  assert.equal(pickInitialMarket([vj, { ...vn, date: null, day: null }], { nowMs: now }), 'jra');
});

test('中央と南関は同じ処理・同じ画面（market で分岐しない）／片方の変更で他方を壊さない', async () => {
  assert.deepEqual(MARKETS, ['jra', 'nankan']);
  const redis = makeFakeRedis();
  await saveDay(redis, sanitizeIngest(jra()).day);
  await saveDay(redis, sanitizeIngest(nankan()).day);
  // 南関を上書きしても中央は変わらない
  const before = JSON.stringify(await loadDay(redis, 'jra', '2026-10-04'));
  const n2 = nankan(); n2.races = [n2.races[0]];
  await saveDay(redis, sanitizeIngest(n2).day);
  assert.equal(JSON.stringify(await loadDay(redis, 'jra', '2026-10-04')), before);
  const page = read('src/components/ailab/AiLabBoard.astro');
  assert.match(page, /data-market="jra"/); assert.match(page, /data-market="nankan"/);
  // 画面の描画は market で分岐しない（ラベルだけ MARKET_LABEL）
  const script = page.slice(page.indexOf('<script>'));
  assert.equal(/market\s*===\s*'(jra|nankan)'/.test(script), false);
});

test('画面: 全頭表・カウントダウン・自動追従・自動更新・データ鮮度。🛑 買い目・推奨・金額・的中の表示が無い', () => {
  const page = read('src/components/ailab/AiLabBoard.astro');
  const script = page.slice(page.indexOf('<script>'));
  assert.match(script, /\['馬番', '馬名', 'AI 勝率', 'オッズ', '期待値', '', \.\.\.\(hasRank \? \['着順'\] : \[\]\)\]/, '印の列は見出しなし・着順は結果があるときだけ（2026-10-07 MK）');
  assert.match(script, /raceDisplay\(r,/);
  assert.match(script, /id: 'ailab-countdown'/);
  assert.match(script, /followTarget\(list, now\(\)\)/);
  assert.match(script, /POLL_MS = 30000/);
  assert.match(script, /データ \$\{jstHms\(rec\)\} 更新/);
  assert.match(page, /id="ailab-prev"/); assert.match(page, /id="ailab-next"/); assert.match(page, /id="ailab-follow"/);
  const visible = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['買い目', '推奨', '的中', '購入金額', 'stake', 'picked']) {
    const allowed = banned === '買い目' ? visible.replace('買い目を出したりはしていません', '') : banned === '推奨' ? visible.replace('購入をすすめるものではありません', '') : visible;
    assert.equal(allowed.includes(banned), false, banned);
  }
  // 行の強調（色付け・印）をしない
  assert.equal(/ev-plus|ev-picked|is-next|highlight/.test(page), false);
});

test('API/ページ: 取込は秘密ヘッダ必須・env 無しは 503／自動更新は ak_session の署名だけ（Airtable を呼ばない）・無料は通さない', () => {
  const ingest = read('src/pages/api/ailab/ingest.js');
  assert.match(ingest, /x-ailab-secret/); assert.match(ingest, /timingSafeEqual/);
  assert.match(ingest, /sanitizeIngest\(payload\)/);
  const view = read('src/pages/api/ailab/view.js');
  const viewCode = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(viewCode, /verifyPlanAccess/); assert.equal(/airtable/i.test(viewCode), false);
  assert.match(view, /MARKETS\.includes\(market\)/);
  assert.equal(AILAB_POLL_PLANS.includes('free'), false);
  const page = read('src/pages/ai-lab/index.astro');
  assert.match(page, /gatePaidPage\(/);
  assert.match(page, /<AiLabBoard initial=\{initial\} market=\{market\} \/>/, '中央・南関で同じ部品');
  const board = read('src/components/ailab/AiLabBoard.astro');
  assert.match(board, /import \{[^}]*raceDisplay[^}]*\} from '..\/..\/lib\/ailab\/aiLab.js'/, 'ブラウザも同じ判定（単一源）を使う');
  // aiLab.js はブラウザに同梱する: Node 専用の import を持たない
  assert.equal(/from '(node:|\.\.\/)/.test(read('src/lib/ailab/aiLab.js')), false);
});

test('画面の要素 id は重複しない（レースの選択と見出しの取り違え防止）', () => {
  const ids = [...read('src/components/ailab/AiLabBoard.astro').matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
});

test('画面: 開発の目的と今後（夢）を伝える。ただし成果・時期の約束や誇張はしない', () => {
  const page = read('src/components/ailab/AiLabBoard.astro');
  assert.match(page, /AI ラボで目指していること/);
  assert.match(page, /<h3>これから<\/h3>/);
  for (const step of ['学ぶ', '確かめる', '届ける']) assert.match(page, new RegExp(`<b>${step}</b>`));
  const visible = page.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const ng of [/必ず/, /保証/, /絶対/, /儲か/, /回収率\s*\d/, /\d+\s*%\s*(以上|超)/, /年内|来月|\d{4}年\d{1,2}月/]) {
    assert.equal(ng.test(visible), false, `誇張・約束の表現: ${ng}`);
  }
});

test('AK の印（2026-10-07 MK 追記）: 上位 5 頭に ◎本命 ○対抗 ▲単穴 △連下最上位 △連下・取込時に添える・KAP からの印は受け取らない', () => {
  const horses = [
    { horseNumber: 1, role: '連下', pt: 50 }, { horseNumber: 2, role: '本命', pt: 90 }, { horseNumber: 3, role: '単穴', pt: 70 },
    { horseNumber: 4, role: '対抗', pt: 80 }, { horseNumber: 5, role: '連下最上位', pt: 60 }, { horseNumber: 6, role: '連下', pt: 55 },
    { horseNumber: 7, role: '抑え', pt: 40 }, { horseNumber: 8, role: '不要', pt: 10 },
  ];
  const m = akTop5Marks(horses);
  assert.deepEqual([...m.entries()].sort((a, b) => a[0] - b[0]), [[2, '◎'], [3, '▲'], [4, '○'], [5, '△'], [6, '△']], '上位 5 頭だけ（同役割は pt 降順）');
  // 取込時に名前と印を添える（AK の予想が無いレースは印なし）
  const p = nankan();
  p.races[0].field = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => horse(n, 0.1, 5.0));
  p.races[0].field[0].mark = '◎'; // KAP 側から来ても保存しない
  const day = sanitizeIngest(p).day;
  assert.equal(day.races[0].field[0].mark, undefined);
  const withAk = attachAk(day, [{ venueName: '大井', races: [{ raceInfo: { raceNumber: 11 }, horses }] }]);
  const r = withAk.races.find((x) => x.raceId === '2026-10-07-OI-11');
  assert.deepEqual(r.field.map((h) => h.mark || ''), ['', '◎', '▲', '○', '△', '△', '', '']);
  assert.ok(withAk.races.find((x) => x.raceId === '2026-10-07-OI-12').field.every((h) => !h.mark));
  // 画面の行に印（全頭表示のまま・印の無い馬は空欄）
  const now = Date.parse(r.startAt) - 5 * 60 * 1000;
  const d = raceDisplay({ ...r, oddsObservedAt: new Date(now - 60_000).toISOString() }, { nowMs: now, receivedAt: new Date(now - 60_000).toISOString() });
  assert.deepEqual(d.rows.map((x) => x.mark), ['', '◎', '▲', '○', '△', '△', '', '']);
  assert.equal(d.rows.length, 8, '全頭');
  const board = read('src/components/ailab/AiLabBoard.astro');
  assert.match(board, /'◎本命 ○対抗 ▲単穴 △連下'/);
  assert.equal(/AK 印/.test(board), false, '「AK 印」と書かない（2026-10-07 MK）');
  assert.equal(/ev-plus|ev-picked|highlight/.test(board), false, '印の馬の行を強調しない');
});

test('上部の見出しは「いまの AI 予想とは別に、次世代の AI も育てています」（今まで AI が無かったと誤解させない・2026-10-07 MK）', () => {
  const board = read('src/components/ailab/AiLabBoard.astro');
  assert.match(board, /いまの AI 予想とは別に、次世代の AI も育てています/);
  assert.equal(/>いま、AI を育てています</.test(board), false);
});

test('会員の皆さまへ将来お届けしたい想いを伝える（約束・時期は書かない・2026-10-07 MK）', () => {
  const board = read('src/components/ailab/AiLabBoard.astro');
  assert.match(board, /将来、ここまで一緒に歩んでくださった会員の皆さまへ/);
  assert.match(board, /支えてくださっている会員の皆さまに、いつかこの AI をお届けできる日を目指して/);
});

test('評価待ちの文言: 判断時刻（発走 10 分前）を過ぎたら「取り込んでいます（まもなく表示されます）」・境界は 10 分前ちょうど', () => {
  const r = sanitizeIngest(nankan()).day.races.find((x) => x.raceId === '2026-10-07-OI-12'); // 発走 11:45Z・評価前
  const start = Date.parse(r.startAt);
  assert.match(raceDisplay(r, { nowMs: start - 10 * 60 * 1000 - 1 }).message, /約 10 分前に出ます/);
  assert.match(raceDisplay(r, { nowMs: start - 10 * 60 * 1000 }).message, /取り込んでいます（まもなく表示されます）/);
  assert.match(raceDisplay(r, { nowMs: start - 1 }).message, /まもなく表示されます/);
  assert.match(raceDisplay(r, { nowMs: start }).message, /評価はありません/);
});

test('着順（結果アーカイブの 1〜3 着）: レースと全頭の行に添える・的中の判定はしない・結果前は待ちの案内', () => {
  const day = sanitizeIngest(nankan()).day;
  const index = new Map([['2026-10-07|大井|11', { first: 2, second: 3, third: 1, umatanPayout: 999, sanrenpukuPayout: 999 }]]);
  const withR = withResults(day, index);
  const r = withR.races.find((x) => x.raceId === '2026-10-07-OI-11');
  assert.deepEqual(r.result, { first: 2, second: 3, third: 1 }, '払戻は添えない');
  assert.equal(withR.races.find((x) => x.raceId === '2026-10-07-OI-12').result, undefined);
  const after = Date.parse(r.startAt) + 3600e3;
  assert.deepEqual(resultLine(r, { nowMs: after }), { state: 'result', order: [2, 3, 1] });
  const d = raceDisplay(r, { nowMs: after, receivedAt: '2026-10-07T10:59:00.000Z' });
  assert.deepEqual(d.rows.map((x) => [x.n, x.rank]), [[1, 3], [2, 1], [3, 2]]);
  // 結果前: 発走前は何も出さない・発走後は「全レース終了後に表示」
  const noRes = withR.races.find((x) => x.raceId === '2026-10-07-OI-12');
  assert.deepEqual(resultLine(noRes, { nowMs: Date.parse(noRes.startAt) - 1 }), { state: 'none' });
  assert.match(resultLine(noRes, { nowMs: Date.parse(noRes.startAt) + 1 }).text, /全レース終了後/);
  assert.equal(withResults(day, null), day, '索引が読めなければそのまま');
  const board = read('src/components/ailab/AiLabBoard.astro');
  assert.match(board, /resultLine\(r, \{ nowMs: now\(\), market: ST\.market \}\)/);
  assert.match(board, /\$\{row\.rank\}着/);
  const visible = board.replace(/<style[\s\S]*?<\/style>/g, '');
  assert.equal(/的中|不的中|ハズレ/.test(visible), false, '的中の判定を出さない');
});

test('発走後の表示: 「発走済み（HH:MM 発走）」・着順の目安時刻・オッズは発走 10 分前で固定と明示・次に発走するレースへの案内', () => {
  const start = '2026-10-10T01:47:00.000Z'; // 10:47 JST
  const t = Date.parse(start);
  assert.deepEqual(startLine(start, t - 61_000), { started: false, lead: '発走まで ', value: '1分01秒', tail: '（発走 10:47）' });
  assert.deepEqual(startLine(start, t), { started: true, lead: '', value: '発走済み', tail: '（10:47 発走）' }, '「発走まで 発走済み」と並べない');
  // 着順待ち: market ごとの目安（market 不明なら目安なし）
  const r = { raceId: '2026-10-10-08-03', startAt: start, venueName: '京都', raceNumber: 3 };
  assert.equal(resultLine(r, { nowMs: t + 1, market: 'jra' }).text, '着順は当日の全レース終了後（17 時台）に表示されます');
  assert.equal(resultLine(r, { nowMs: t + 1, market: 'nankan' }).text, '着順は当日の全レース終了後（21 時台）に表示されます');
  assert.equal(resultLine(r, { nowMs: t + 1 }).text, '着順は当日の全レース終了後に表示されます');
  assert.deepEqual(Object.keys(RESULT_ETA), MARKETS);
  // 次に発走するレース: 全開催場で一番早いもの。発走前のレースを見ているとき・全部終わったときは null
  const races = [
    r,
    { raceId: '2026-10-10-08-04', startAt: '2026-10-10T02:20:00.000Z', venueName: '京都', raceNumber: 4 },
    { raceId: '2026-10-10-05-04', startAt: '2026-10-10T02:05:00.000Z', venueName: '東京', raceNumber: 4 },
  ];
  assert.deepEqual(nextUpcoming(races, r.raceId, t + 60_000), { raceId: '2026-10-10-05-04', label: '東京 4R', startAt: '2026-10-10T02:05:00.000Z' });
  assert.equal(nextUpcoming(races, '2026-10-10-08-04', t + 60_000), null, '発走前のレースでは出さない');
  assert.equal(nextUpcoming(races, r.raceId, Date.parse('2026-10-10T03:00:00.000Z')), null, '全レース発走済みなら出さない');
  assert.equal(nextUpcoming(races, 'nope', t + 60_000), null);
  // 画面: 発走の行は startLine・跨いだら描き直す・次レースのボタンは自動追従 ON に戻す
  const board = read('src/components/ailab/AiLabBoard.astro');
  assert.match(board, /startLine\(r\.startAt, now\(\)\)/);
  assert.match(board, /nextUpcoming\(races\(\), r\.raceId, now\(\)\)/);
  assert.match(board, /b\.onclick = \(\) => \{ ST\.follow = true;/);
  assert.match(board, /el\.dataset\.started === '1'/);
  assert.equal(/発走まで ', h\('b', \{ id: 'ailab-countdown' \}, countdown/.test(board), false);
});
