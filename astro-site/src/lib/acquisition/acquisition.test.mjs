/**
 * 有料予想の取得方式（2026-10-03 MK 確定・docs/PREDICTION_ACQUISITION.md）の固定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePredictionKey, buildPredictionKey } from './predictionKey.js';
import { canAcquire } from './acquisitionPolicy.js';
import { buildPredictionContent, buildRaceListing, narrowUmatan } from './predictionContent.js';
import { evaluateSanrenpukuRace, rankDay, GRADE } from './sanrenpukuSelection.js';
import { summarizeUsage } from './usageStats.js';
import { recentRacesFor, historyRecordFor } from './pastRaces.js';
import { acquirePrediction, listAcquisitions, readAcquired, userKey } from './acquisitionStore.js';
import { handleAcquire, loadAcquiredView, isSameOriginPost } from './acquisitionServer.js';
import { makeFakeRedis } from './fakeRedis.test-helper.mjs';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');

// ── 合成データ（12 頭・本命 3）──
const H = (n, role, pt, ci) => ({ horseNumber: n, horseName: `馬${n}`, jockey: `騎手${n}`, role, pt, computerIndex: ci });
const horses = [
  H(1, '連下', 60, 60), H(2, '単穴', 80, 74), H(3, '本命', 160, 90), H(4, '対抗', 110, 80),
  H(5, '連下最上位', 70, 66), H(6, '連下', 55, 58), H(7, '補欠', 30, 50), H(8, '無', 10, 40),
  H(9, '単穴', 75, 70), H(10, '連下', 50, 55), H(11, '補欠', 20, 47), H(12, '無', 5, 30),
];
const race = (raceNumber, extra = {}) => ({
  raceInfo: { date: '2026-10-03', venue: '船橋', raceNumber, raceName: `テスト${raceNumber}R`, startTime: '15:00', distance: 1600, horseCount: 12 },
  horses, bettingLines: { umatan: ['3↔2.4.5.9.10(抑え7.11)', '4↔2.3.5.9.10(抑え7.11)'] }, ...extra,
});
const venue = { venueName: '船橋', venueId: 'funabashi', totalRaces: 12, races: [race(1), race(11)] };
const findRace = (cat, date, venueId, n) => (venueId === 'funabashi' && date === '2026-10-03'
  ? { venue, race: venue.races.find((r) => r.raceInfo.raceNumber === n) || null } : null);
const findRaceStrict = (...a) => { const f = findRace(...a); return f && f.race ? f : null; };

const PREMIUM = { canViewPremium: true, canViewSanrenpuku: false };
const SRP_ONLY = { canViewPremium: false, canViewSanrenpuku: true };
const NONE = { canViewPremium: false, canViewSanrenpuku: false, canViewLight: true };
const REC_A = 'recAAAAAAAAAAAAAA';
const REC_B = 'recBBBBBBBBBBBBBB';
const gateFor = (ent, subject = REC_A) => async () => ({ ok: true, response: null, entitlements: ent, subject });
const req = (origin = 'https://analytics.keiba.link') => new Request('https://analytics.keiba.link/api/predictions/acquire', { method: 'POST', headers: origin ? { origin } : {} });
const KEY = 'premium:nankan:2026-10-03:funabashi:11';
const SRP_KEY = 'srp:nankan:2026-10-03:funabashi:11';

async function acquire(redis, ent, key = KEY, subject = REC_A, now = new Date('2026-10-03T03:00:00Z')) {
  return handleAcquire({ request: req(), rawKey: key, env: {}, now, deps: { gate: gateFor(ent, subject), redis, findRace: findRaceStrict } });
}
const view = (redis, ent, key = KEY, subject = REC_A) => loadAcquiredView({ gate: { ok: true, entitlements: ent, subject }, rawKey: key, env: {}, deps: { redis } });

// ── キー ──
test('予想キー: 形式外・未知の会場・不正な日付・レース番号は拒否', () => {
  assert.equal(parsePredictionKey(KEY).venueName, '船橋');
  assert.equal(parsePredictionKey('premium:jra:2026-10-04:TOK:11').venueName, '東京');
  for (const bad of ['', 'premium:nankan:2026-10-03:funabashi:13', 'premium:nankan:2026-02-30:funabashi:1',
    'premium:nankan:2026-10-03:tokyo:1', 'free:nankan:2026-10-03:funabashi:1', `${KEY} `, 'premium:jra:2026-10-04:funabashi:1']) {
    assert.equal(parsePredictionKey(bad), null, bad);
  }
  assert.equal(buildPredictionKey({ product: 'srp', cat: 'nankan', date: '2026-10-03', venue: 'funabashi', raceNumber: 11 }), SRP_KEY);
});

// ── 取得前は本文を出さない ──
test('取得前: 一覧のモデルは出走情報だけ（買い目・印・指数を含まない）', () => {
  const listing = buildRaceListing({ race: race(11), venueTotalRaces: 12 });
  assert.deepEqual(Object.keys(listing).sort(), ['distance', 'horseCount', 'isMainRace', 'raceName', 'raceNumber', 'startTime']);
  const src = read('src/components/acquisition/AcquisitionRaceList.astro');
  for (const w of ['umatan', 'sanrenpuku.', 'horses', 'aiIndex', 'bettingLines', 'AcquiredPredictionBody']) {
    assert.equal(src.includes(w), false, `一覧部品が本文（${w}）に触れている`);
  }
});

test('本文部品を使うのは取得済み確認後の閲覧ページだけ', async () => {
  const { readdirSync } = await import('node:fs');
  const out = readdirSync(`${ROOT}src/pages`, { recursive: true })
    .filter((f) => /\.(astro|js|ts)$/.test(f) && read(`src/pages/${f}`).includes('AcquiredPredictionBody'));
  // 本番の閲覧（取得済み確認後）と、Preview 詳細（buildPreviewContent＝公開範囲だけ）
  assert.deepEqual(out.sort(), ['free-prediction/view.astro', 'predictions/view.astro']);
  const pv = read('src/pages/free-prediction/view.astro');
  assert.match(pv, /content=\{c\}/);
  assert.ok(pv.indexOf('buildPreviewContent(') > -1 && !pv.includes('buildPredictionContent'), 'Preview 詳細が有料本文を組み立てている');
  const v = read('src/pages/predictions/view.astro');
  assert.ok(v.indexOf('gatePaidPage(') < v.indexOf('loadAcquiredView('), '認可の前に本文を読んでいる');
  assert.match(v, /v\.status === 'ok' \? v\.content : null/);
});

test('有料 4 ページの本文表示（全レース一括）を撤去し、取得一覧だけを出す', () => {
  for (const [p, product] of [['src/pages/premium-prediction/jra.astro', 'premium'], ['src/pages/premium-prediction/nankan.astro', 'premium'],
    ['src/pages/premium-sanrenpuku.astro', 'srp'], ['src/pages/premium-sanrenpuku-jra.astro', 'srp']]) {
    const s = read(p);
    // テンプレート（マークアップ）だけを見る。旧 CSS / スクリプトのセレクタは本文ではない
    const body = s.slice(s.indexOf('---', 3) + 3).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    assert.match(body, product === 'premium' ? /<PremiumRaceBoard mode="premium"/ : new RegExp(`<AcquisitionRaceList product="${product}"`), p);
    for (const w of ['race-accordion-content', 'bet-horses', 'premium-select-reveal', 'premium-select-highlight', 'RaceHorseSection raceHorses', 'JraRaceHorseSection']) {
      assert.equal(body.includes(w), false, `${p}: 旧本文表示（${w}）が残っている`);
    }
    assert.ok(s.indexOf('gatePaidPage(') < s.indexOf('loadMemberAcquisitions('), `${p}: 認可の前に取得記録を読んでいる`);
  }
});

// ── 取得後のみ本文 ──
test('取得後のみ本文を返す・URL 直打ち（未取得キー）では本文なし', async () => {
  const redis = makeFakeRedis();
  const before = await view(redis, PREMIUM);
  assert.equal(before.status, 'not_acquired');
  assert.equal(before.content, undefined);
  assert.equal(before.canAcquire, true);
  const r = await acquire(redis, PREMIUM);
  assert.deepEqual([r.status, r.created], ['ok', true]);
  const after = await view(redis, PREMIUM);
  assert.equal(after.status, 'ok');
  assert.equal(after.content.raceNumber, 11);
  assert.equal((await view(redis, PREMIUM, 'premium:nankan:2026-10-03:funabashi:1')).status, 'not_acquired');
  assert.equal((await view(redis, PREMIUM, '../etc')).status, 'invalid');
});

test('同一予想の二重取得は冪等（記録 1 件・最初の取得日時を保持・本文 1 つ）', async () => {
  const redis = makeFakeRedis();
  const a = await acquire(redis, PREMIUM, KEY, REC_A, new Date('2026-10-03T03:00:00Z'));
  const b = await acquire(redis, PREMIUM, KEY, REC_A, new Date('2026-10-03T05:00:00Z'));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(redis.hashes.get(userKey(REC_A)).size, 1);
  assert.equal((await listAcquisitions({ redis, recordId: REC_A }))[0].at, '2026-10-03T03:00:00.000Z');
  assert.equal([...redis.strings.keys()].filter((k) => k.startsWith('ak:acq:v1:c:')).length, 1);
});

test('他会員の取得状態に影響しない（A の取得で B は未取得のまま・本文は共有でも記録は本人だけ）', async () => {
  const redis = makeFakeRedis();
  await acquire(redis, PREMIUM, KEY, REC_A);
  assert.equal((await view(redis, PREMIUM, KEY, REC_B)).status, 'not_acquired');
  assert.deepEqual(await listAcquisitions({ redis, recordId: REC_B }), []);
  await acquire(redis, PREMIUM, KEY, REC_B);
  assert.equal(redis.hashes.get(userKey(REC_A)).size, 1);
  assert.equal(redis.hashes.get(userKey(REC_B)).size, 1);
});

test('権限外は取得できない（書き込み 0）／商品ごとの権利', async () => {
  const redis = makeFakeRedis();
  assert.equal((await acquire(redis, NONE)).status, 'forbidden');
  assert.equal((await acquire(redis, PREMIUM, SRP_KEY)).status, 'forbidden', 'Premium だけでは三連複の選別は取れない');
  assert.equal((await acquire(redis, SRP_ONLY, KEY)).status, 'forbidden', '三連複だけでは Premium 予想は取れない');
  assert.equal(redis.calls.length, 0);
  assert.equal((await acquire(redis, SRP_ONLY, SRP_KEY)).status, 'ok');
  // 会場別の権利（中央版・南関版）
  assert.equal(canAcquire({ canViewPremium: false, canViewPremiumJra: true, canViewPremiumNankan: false }, { product: 'premium', cat: 'jra' }), true);
  assert.equal(canAcquire({ canViewPremium: false, canViewPremiumJra: true, canViewPremiumNankan: false }, { product: 'premium', cat: 'nankan' }), false);
  assert.equal(canAcquire(null, { product: 'premium', cat: 'jra' }), false);
  assert.equal(canAcquire(PREMIUM, { product: 'premium', cat: 'other' }), false);
});

test('同一オリジン以外の送信・Redis 障害・データ無しは本文を作らない（fail closed）', async () => {
  assert.equal(isSameOriginPost(req('https://evil.example')), false);
  assert.equal(isSameOriginPost(req(null)), false);
  assert.equal(isSameOriginPost(req()), true);
  const broken = makeFakeRedis({ failOn: () => true });
  assert.equal((await acquire(broken, PREMIUM)).status, 'unavailable');
  assert.equal((await view(broken, PREMIUM)).status, 'unavailable');
  assert.equal((await acquire(makeFakeRedis(), PREMIUM, 'premium:nankan:2026-10-03:funabashi:5')).status, 'not_found');
  const noRedis = await handleAcquire({ request: req(), rawKey: KEY, env: {}, deps: { gate: gateFor(PREMIUM), findRace: findRaceStrict } });
  assert.equal(noRedis.status, 'unavailable');
  // 本文の無い参照は「取得済み」として本文を出さない
  const redis = makeFakeRedis();
  await acquire(redis, PREMIUM);
  for (const k of [...redis.strings.keys()]) redis.strings.delete(k);
  assert.equal((await view(redis, PREMIUM)).status, 'unavailable');
});

test('取得記録の保存は recordId 形式と予想キー・本文の一致を確かめる', async () => {
  const redis = makeFakeRedis();
  const content = buildPredictionContent({ product: 'premium', cat: 'nankan', venueName: '船橋', race: race(11), venueTotalRaces: 12 });
  await assert.rejects(acquirePrediction({ redis, recordId: 'bad', key: KEY, content }), /invalid_record_id/);
  await assert.rejects(acquirePrediction({ redis, recordId: REC_A, key: 'premium:nankan:2026-10-03:funabashi:1', content }), /content_mismatch/);
  assert.equal(await readAcquired({ redis, recordId: REC_A, key: KEY }), null);
});

// ── 商品ごとの本文 ──
test('Premium 馬単は通常の買い目＋点数を絞った買い目（本命軸・上位 3 頭・向きは通常と同じ）', () => {
  const c = buildPredictionContent({ product: 'premium', cat: 'nankan', venueName: '船橋', race: race(1), venueTotalRaces: 12 });
  assert.deepEqual(c.umatan.normal.map((l) => l.line), ['3↔2.4.5.9.10', '4↔2.3.5.9.10']);
  assert.deepEqual(c.umatan.normal.map((l) => l.points), [10, 10]);
  assert.deepEqual(c.umatan.narrowed, { line: '3↔2.4.9', points: 6 }, '対抗4・単穴2/9（pt 降順で 2→9）');
  const main = narrowUmatan(horses, ['3→2.4.5.9.10']);
  assert.deepEqual(main, { line: '3→2.4.9', points: 3 }, 'メインレースは一方向');
  assert.equal(c.selection, undefined);
  assert.equal(c.sanrenpuku, undefined, 'Premium に三連複を出さない');
});

test('Premium は馬単専用: 三連複の買い目を本文に入れない（2026-10-03 MK 確定）', () => {
  const c = buildPredictionContent({ product: 'premium', cat: 'nankan', venueName: '船橋', race: race(1), venueTotalRaces: 12 });
  assert.equal(c.sanrenpuku, undefined);
  assert.equal(c.v, 2);
  assert.equal(JSON.stringify(c).includes(' - '), false, '三連複の表記（a - b - c）が入っていない');
  // 描画部品: Premium の分岐に三連複は無い（v1 の保存データに残っていても出さない）
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  const premiumBranch = body.slice(body.indexOf('{!isSrp ? ('), body.indexOf(') : (', body.indexOf('{!isSrp ? (')));
  assert.equal(/三連複|sanrenpuku/.test(premiumBranch), false, 'Premium の分岐で三連複を描画している');
});

test('過去走: 全馬ぶん保存（無料ページと同じ取り出し方）・中央は新しい順 5 走、南関は古い順保存の末尾 5 走を新しい順へ', () => {
  const jraHorse = { ...H(3, '本命', 160, 90), recentRacesFromHistories: [1, 2, 3, 4, 5, 6].map((i) => ({ venue: `京都${i}`, rank: i, distance: '芝1600' })), recentRaces: [{ venue: 'x', rank: 9 }] };
  const nkHorse = { ...H(3, '本命', 160, 90), recentRacesFromEntriesNankan: [1, 2, 3, 4, 5, 6].map((i) => ({ venue: `川崎${i}`, rank: i, date: `2026-0${i}-01` })) };
  const jr = recentRacesFor(jraHorse, 'jra');
  assert.deepEqual(jr.map((r) => r.venue), ['京都1', '京都2', '京都3', '京都4', '京都5']);
  const nk = recentRacesFor(nkHorse, 'nankan');
  assert.deepEqual(nk.map((r) => r.venue), ['川崎6', '川崎5', '川崎4', '川崎3', '川崎2']);
  assert.deepEqual(recentRacesFor({ recentRaces: [{ venue: '大井', rank: 2 }] }, 'nankan').map((r) => r.rank), ['2']);
  // 本文の全馬に recent がある（空配列でも項目は持つ）。pt・指数は入れない
  const c = buildPredictionContent({ product: 'premium', cat: 'nankan', venueName: '船橋', race: { ...race(1), horses: horses.map((h) => (h.horseNumber === 3 ? nkHorse : h)) }, venueTotalRaces: 12 });
  assert.ok(c.horses.every((h) => Array.isArray(h.recent)));
  assert.equal(c.horses.find((h) => h.number === 3).recent.length, 5);
  assert.equal(JSON.stringify(c.horses.map((h) => h.recent)).includes('"pt"'), false);
});

test('中央の過去走データ（通算・勝率・連対率・3着内率・条件別・競走成績 10 走）を無料ページと同じ集計で持つ', () => {
  const hist = [1, 2, 3, 5, 1, 4, 2, 8, 1, 3, 6, 7].map((rank, i) => ({ rank, surface: i % 2 ? '芝' : 'ダ', distanceMeters: 1600, venue: '東京', _dateStr: `26/0${(i % 9) + 1}/01`, raceName: `R${i}` }));
  const rec = historyRecordFor({ historyForDetails: hist }, { distance: 'ダート1600㍍', venue: '東京' });
  assert.equal(rec.record, '3-2-2-5');
  assert.deepEqual([rec.winPct, rec.placePct, rec.showPct], ['25%', '42%', '58%']);
  assert.ok(rec.conds.some((x) => x.label === '芝') && rec.conds.some((x) => x.label.startsWith('同距離±200m')) && rec.conds.some((x) => x.label === '同会場(東京)'));
  assert.equal(rec.rows.length, 10);
  assert.equal(rec.more, 2);
  assert.equal(historyRecordFor({}, {}), null);
});

test('Premium 詳細の構成: レース情報・取得済み・馬単 通常・馬単 絞り・印とAI総合指数・連下/抑え/評価外・過去走・取得済み予想への導線', () => {
  const view = read('src/pages/predictions/view.astro');
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  for (const w of ['acq-hero', '✓ 取得済み', '取得日時', '取得済みの予想を見る']) assert.ok(view.includes(w), w);
  for (const w of ['馬単 通常の買い目', '馬単 点数を絞った買い目', '印とAI総合指数', 'minor-group-renka', 'minor-group-osae', 'ineligible-section', 'id="past-races"', '過去走']) assert.ok(body.includes(w), w);
  const glass = read('src/styles/acquisitionGlass.css');
  assert.match(glass, /backdrop-filter: var\(--ag-blur\)/, 'ガラスモーフィズム（ぼかし）');
  assert.match(glass, /@supports not/, 'ぼかし非対応ブラウザでも可読');
  assert.match(glass, /radial-gradient\([^)]*rgba\(96, 165, 250/, '背景に青の光源');
  assert.match(glass, /rgba\(196, 181, 253/, 'ラベンダーの光源');
  assert.match(glass, /rgba\(255, 255, 255, 0\.10\), transparent/, '柔らかい白の光');
  assert.match(glass, /rgba\(103, 232, 249/, 'シアンの光源');
});

test('Premium Sanrenpuku は推奨度/見送り・通常・中心・理由を持ち、馬単は持たない', () => {
  const c = buildPredictionContent({ product: 'srp', cat: 'nankan', venueName: '船橋', race: race(11), venueTotalRaces: 12 });
  assert.ok([GRADE.A, GRADE.B, GRADE.SKIP].includes(c.selection.grade));
  assert.equal(typeof c.selection.skip, 'boolean');
  assert.ok(c.selection.reasons.length >= 1);
  assert.ok(c.sanrenpuku.normal.length >= 1);
  assert.ok(c.sanrenpuku.center && c.sanrenpuku.center.points > 0);
  assert.equal(c.umatan, undefined);
  for (const r of c.selection.reasons) assert.equal(/\d/.test(r), false, '理由に指数の数値を書かない');
});

test('レース選別: 本命が抜けた多頭数=A／拮抗=見送り／少頭数=見送り／軸なし=見送り', () => {
  assert.equal(evaluateSanrenpukuRace(horses, { horseCount: 12, cat: 'nankan' }).grade, GRADE.A);
  const close = horses.map((h) => (h.role === '本命' ? { ...h, pt: 112 } : h));
  const r1 = evaluateSanrenpukuRace(close, { horseCount: 12, cat: 'nankan' });
  assert.equal(r1.grade, GRADE.SKIP);
  assert.match(r1.reasons.join(), /混戦/);
  assert.equal(evaluateSanrenpukuRace(horses, { horseCount: 6, cat: 'nankan' }).grade, GRADE.SKIP);
  assert.equal(evaluateSanrenpukuRace(horses.filter((h) => h.role !== '本命'), { horseCount: 11 }).grade, GRADE.SKIP);
  const day = rankDay([
    { key: 'a', selection: { skip: false, score: 120 } }, { key: 'b', selection: { skip: true, score: 0 } },
    { key: 'c', selection: { skip: false, score: 190 } }, { key: 'd', selection: { skip: false, score: 150 } }, { key: 'e', selection: { skip: false, score: 100 } },
  ]);
  assert.deepEqual(day.top3.map((x) => x.key), ['c', 'd', 'a']);
  assert.equal(day.skipped.length, 1);
});

test('表示指数は raw−1（getHorseAiIndex）だけを保存する', () => {
  const c = buildPredictionContent({ product: 'premium', cat: 'nankan', venueName: '船橋', race: race(1), venueTotalRaces: 12 });
  const honmei = c.horses.find((h) => h.number === 3);
  assert.equal(honmei.aiIndex, 89);
  assert.equal(JSON.stringify(c).includes('computerIndex'), false);
});

// ── 利用状況 ──
test('利用状況: 今月の取得数・利用日数（JST）・中央/南関別・最近 5 件', () => {
  const e = (at, cat, key) => ({ at, cat, key, product: 'premium' });
  const u = summarizeUsage([
    e('2026-10-01T15:30:00Z', 'jra', 'k1'), // JST 10/2
    e('2026-10-02T01:00:00Z', 'nankan', 'k2'), // JST 10/2
    e('2026-10-03T03:00:00Z', 'nankan', 'k3'),
    e('2026-09-30T14:59:00Z', 'jra', 'k0'), // JST 9/30 → 先月
  ], { nowMs: Date.parse('2026-10-03T05:00:00Z'), recent: 5 });
  assert.equal(u.month, '2026-10');
  assert.equal(u.monthCount, 3);
  assert.equal(u.activeDays, 2);
  assert.deepEqual(u.byCategory, { jra: 1, nankan: 2 });
  assert.deepEqual(u.recent.map((x) => x.key), ['k3', 'k2', 'k1', 'k0']);
});

// ── 既存権利・Premium Plus ──
test('既存の三連複購入者（買い切り）は Premium が切れても三連複の選別を取得できる（権利を縮小しない）', () => {
  const now = Date.parse('2026-10-03T03:00:00Z');
  const lifetime = resolveEntitlements(fromAirtableFields({ 'プラン': 'Premium', Status: 'active', '有効期限': '2026-01-01', LifetimeSanrenpuku: true }), now);
  assert.equal(canAcquire(lifetime, { product: 'srp', cat: 'jra' }), true);
  assert.equal(canAcquire(lifetime, { product: 'srp', cat: 'nankan' }), true);
  assert.equal(canAcquire(lifetime, { product: 'premium', cat: 'jra' }), false, 'Premium 期限切れなら Premium 予想は取れない');
  for (const p of ['src/pages/premium-sanrenpuku.astro', 'src/pages/premium-sanrenpuku-jra.astro']) {
    assert.match(read(p), /requiredPlan: 'Premium Sanrenpuku'/, `${p}: 入口の権利判定を変えていない`);
  }
});

test('Premium Plus の導線は既存のまま（段階公開の予告枠・三連複の段階表示を残す）', () => {
  for (const p of ['src/pages/premium-sanrenpuku.astro', 'src/pages/premium-sanrenpuku-jra.astro', 'src/pages/premium-prediction/jra.astro', 'src/pages/premium-prediction/nankan.astro']) {
    assert.match(read(p), /<PremiumPlusStageTeaser \/>/, p);
  }
  for (const p of ['src/pages/premium-prediction/jra.astro', 'src/pages/premium-prediction/nankan.astro']) {
    const s = read(p);
    for (const w of ['planSanrenpukuDisplay', 'isFunnelTarget', 'canShowSanrenpukuUpsell', 'upsell/upsellClient.js']) assert.ok(s.includes(w), `${p}: ${w}`);
  }
});

test('マイページ: 取得できる会員にだけ、本人（viewer.recordId）の利用状況を出す', () => {
  const s = read('src/pages/dashboard.astro');
  assert.match(s, /loadMemberAcquisitions\(\{ recordId: viewer\.recordId/);
  assert.match(s, /const showAcquisition = viewer\.isMember && !!viewer\.recordId/);
  assert.match(s, /\{showAcquisition && \(/);
  assert.match(s, /<AcquisitionUsagePanel usage=\{acquisitionUsage\} \/>/);
});

test('一覧・本文のページは本人以外の recordId を受け取らない（クエリ・フォームに会員指定が無い）', () => {
  for (const p of ['src/pages/api/predictions/acquire.js', 'src/pages/predictions/view.astro', 'src/pages/predictions/history.astro']) {
    const s = read(p);
    assert.equal(/searchParams\.get\('(recordId|sub|email)'\)|params\.get\('(recordId|sub|email)'\)/.test(s), false, p);
  }
  assert.match(read('src/pages/api/predictions/acquire.js'), /isSameOriginPost\(request\)/);
});


test('mobile-first・全画面ガラス統一（2026-10-03 MK 追加確定）', () => {
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  const list = read('src/components/acquisition/AcquisitionRaceList.astro');
  const usage = read('src/components/acquisition/AcquisitionUsagePanel.astro');
  // 連下・抑え・評価外は 1 頭ずつ独立したチップ（「/」区切りの文字列は禁止）
  assert.equal(/join\(['"] \/ ['"]\)/.test(body), false, '「/」区切りで馬を並べている');
  assert.match(body, /<ul class="ag-chips">/);
  assert.match(body, /<li class=\{`ag-chip \$\{ROLE_CLASS\[h\.role\]\}`\}>/);
  for (const r of ['ag-role-honmei', 'ag-role-taikou', 'ag-role-tana', 'ag-role-renka', 'ag-role-osae', 'ag-role-out']) {
    assert.match(read('src/styles/acquisitionGlass.css'), new RegExp(`\\.${r}`), r);
  }
  // 過去走: PC は表、mobile は走ごとのカード（同じ情報を両方に出す）
  assert.match(body, /class="acq-table-wrap acq-only-wide"/);
  assert.match(body, /class="acq-race-cards acq-only-narrow"/);
  // 全要素がガラス（共通 CSS を使う）
  for (const [name, src] of [['body', body], ['list', list], ['usage', usage], ['srp', read('src/components/acquisition/SrpRecommendedRaces.astro')], ['view', read('src/pages/predictions/view.astro')]]) {
    assert.match(src, /acquisitionGlass\.css/, name);
  }
  assert.match(list, /class=\{`ag-glass acq-race/);
  assert.match(list, /class="ag-cta acq-btn"/);
  assert.match(list, /class="ag-done"/);
  // スマホ: 本日の活用状況を一覧の最上部、今月の活用状況は一覧の下（PC は右カラム）
  for (const p of ['src/components/acquisition/PremiumRaceBoard.astro', 'src/pages/premium-sanrenpuku.astro', 'src/pages/premium-sanrenpuku-jra.astro']) {
    const s = read(p);
    assert.ok(s.indexOf('variant="today"') < s.indexOf('<AcquisitionRaceList'), `${p}: 本日の活用状況が一覧より上にない`);
    assert.ok(s.indexOf('variant="side"') > s.indexOf('<AcquisitionRaceList'), `${p}: 今月の活用状況が一覧より下にない`);
  }
});

test('一覧モデルは日付（新しい順）・会場・レース・（三連複は）選別結果を返す', async () => {
  const { buildListModel } = await import('./listModel.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'acq-'));
  mkdirSync(join(root, 'src', 'data', 'predictions'), { recursive: true });
  for (const d of ['2026-10-01', '2026-10-03']) {
    writeFileSync(join(root, 'src', 'data', 'predictions', `${d}-funabashi.json`), JSON.stringify({ eventInfo: { date: d, venue: '船橋', totalRaces: 12 }, predictions: [{ ...race(11), raceInfo: { ...race(11).raceInfo, date: d } }] }));
  }
  const m = buildListModel({ cat: 'nankan', product: 'srp', requestedDate: '2026-10-03', acquisitions: [], root, now: Date.parse('2026-10-03T00:00:00Z') });
  assert.deepEqual(m.dates, ['2026-10-03', '2026-10-01']);
  assert.equal(m.date, '2026-10-03');
  assert.equal(m.venues.length, 1);
  assert.equal(m.venues[0].races[0].key, 'srp:nankan:2026-10-03:funabashi:11');
  assert.ok(m.venues[0].races[0].selection);
  assert.ok(m.day && Array.isArray(m.day.top3));
});

test('会場別 Premium（中央版・南関版）も取得の入口を通り、取得できるのは契約した会場だけ', async () => {
  const { ACQUISITION_DOOR_PLANS } = await import('./acquisitionServer.js');
  for (const p of ['premium', 'premium-jra', 'premium-nankan', 'Premium Sanrenpuku']) assert.ok(ACQUISITION_DOOR_PLANS.includes(p), p);
  const now = Date.parse('2026-10-03T03:00:00Z');
  const jraOnly = resolveEntitlements(fromAirtableFields({ 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-04', PaidAt: 'x', VenueAccess: 'jra' }), now);
  assert.equal(canAcquire(jraOnly, { product: 'premium', cat: 'jra' }), true);
  assert.equal(canAcquire(jraOnly, { product: 'premium', cat: 'nankan' }), false);
  assert.equal(canAcquire(jraOnly, { product: 'srp', cat: 'jra' }), false);
});

// ── 2026-10-03/04 MK 追加確定: 活用状況・会場タブ・着順の色 ──
test('本日の活用状況: 分母はその契約で本日取得できる実レース数（中央のみ・南関のみ・両方）・% は取得率', async () => {
  const { buildValueSummary } = await import('./valueSummary.js');
  const now = Date.parse('2026-10-04T03:00:00Z'); // JST 10/4
  const count = (cat, d) => (d === '2026-10-04' ? (cat === 'jra' ? 36 : 12) : (d === '2026-10-05' ? (cat === 'jra' ? 24 : 0) : 0));
  const dates = () => ['2026-10-05', '2026-10-04'];
  const acq = (cat, n, date = '2026-10-04') => Array.from({ length: n }, (_, i) => ({ key: `premium:${cat}:${date}:X:${i + 1}`, product: 'premium', cat, date, at: '2026-10-04T02:00:00Z' }));
  const both = buildValueSummary({ acquisitions: [...acq('jra', 12)], ent: { canViewPremium: true }, contract: { tier: 'Premium', planType: 'Annual' }, nowMs: now, count, dates });
  assert.deepEqual([both.today.acquired, both.today.available, both.today.pct], [12, 48, 25]);
  const jraOnly = buildValueSummary({ acquisitions: acq('jra', 12), ent: { canViewPremium: false, canViewPremiumJra: true, canViewPremiumNankan: false }, contract: { tier: 'Premium', stripe: true, venueAccess: 'jra' }, nowMs: now, count, dates });
  assert.deepEqual([jraOnly.today.acquired, jraOnly.today.available, jraOnly.today.pct], [12, 36, 33]);
  const nkOnly = buildValueSummary({ acquisitions: acq('jra', 3), ent: { canViewPremium: false, canViewPremiumJra: false, canViewPremiumNankan: true }, contract: {}, nowMs: now, count, dates });
  assert.deepEqual([nkOnly.today.acquired, nkOnly.today.available], [0, 12], '契約外の区分は分子にも分母にも入れない');
  // 次に取得できる予想: 本日に未取得があれば本日、全部取得済みなら次の開催
  assert.equal(both.next.isToday, true);
  const done = buildValueSummary({ acquisitions: acq('jra', 36), ent: { canViewPremiumJra: true, canViewPremiumNankan: false }, contract: {}, nowMs: now, count, dates });
  assert.deepEqual([done.next.isToday, done.next.date, done.next.available], [false, '2026-10-05', 24]);
  // 読めないときは取得数を作らない（0 と区別）
  const unknown = buildValueSummary({ acquisitions: null, ent: { canViewPremium: true }, contract: {}, nowMs: now, count, dates });
  assert.equal(unknown.today.acquired, null);
  assert.equal(unknown.month, null);
});

test('今月の活用状況: 取得レース数・利用日数・内訳・1 レースあたりの実質額（月額 ÷ 取得数・定価）', async () => {
  const { buildValueSummary, monthlyPriceFor, MONTHLY_PRICE } = await import('./valueSummary.js');
  const now = Date.parse('2026-10-04T03:00:00Z');
  const acqs = [
    { key: 'a', product: 'premium', cat: 'jra', date: '2026-10-04', at: '2026-10-04T01:00:00Z' },
    { key: 'b', product: 'premium', cat: 'nankan', date: '2026-10-02', at: '2026-10-02T09:00:00Z' },
    { key: 'c', product: 'srp', cat: 'nankan', date: '2026-10-02', at: '2026-10-02T09:00:00Z' },
  ];
  const v = buildValueSummary({ acquisitions: acqs, ent: { canViewPremium: true }, contract: { tier: 'Premium', stripe: true }, nowMs: now, count: () => 0, dates: () => [] });
  assert.equal(v.month.count, 2, 'Premium の取得だけを数える');
  assert.equal(v.month.activeDays, 2);
  assert.deepEqual(v.month.byCategory, { jra: 1, nankan: 1 });
  assert.equal(v.month.unitCost, Math.round(4980 / 2));
  assert.equal(monthlyPriceFor({ tier: 'Premium', stripe: true, venueAccess: 'nankan' }).yen, 2980);
  assert.equal(monthlyPriceFor({ tier: 'Premium', planType: 'Monthly' }).yen, 18000);
  assert.equal(monthlyPriceFor({ tier: 'Premium', planType: 'Annual' }).yen, MONTHLY_PRICE.annual);
  assert.equal(monthlyPriceFor({ tier: 'Premium', planType: 'Lifetime' }), null, '買い切りは実質額を出さない');
  assert.equal(monthlyPriceFor({ tier: 'Free' }), null);
  const zero = buildValueSummary({ acquisitions: [], ent: { canViewPremium: true }, contract: { tier: 'Premium', planType: 'Annual' }, nowMs: now, count: () => 0, dates: () => [] });
  assert.equal(zero.month.unitCost, null, '0 件で割らない');
  const srp = buildValueSummary({ acquisitions: acqs, ent: { canViewSanrenpuku: true }, contract: { tier: 'Premium', stripe: true }, product: 'srp', nowMs: now, count: () => 0, dates: () => [] });
  assert.equal(srp.month.price, null, '三連複の選別には月額の実質額を出さない');
});

test('活用状況の表示: 「残り○回」と書かない・主役は次に取得できる予想・見返しは控えめ', () => {
  const panel = read('src/components/acquisition/AcquisitionValuePanel.astro');
  const tpl = panel.slice(panel.indexOf('---', 3));
  assert.equal(/残り|あと\s*\d|回まで|上限/.test(tpl.replace(/<style[\s\S]*<\/style>/, '')), false, 'クレジット制に見える表現');
  assert.match(tpl, /本日の使用状況/);
  assert.match(tpl, /今月の活用状況/);
  assert.match(tpl, /1レースあたりの実質額/);
  assert.match(tpl, /次のレースの予想を取得する/);
  assert.match(tpl, /class="ag-cta acq-today-cta"/);
  assert.match(tpl, /class="acq-month-history"/, '見返しは控えめなリンク');
});

test('会場タブ（すべて / 中央競馬 / 南関東競馬）と「すべて」一覧', async () => {
  const tabs = read('src/components/acquisition/AcquisitionVenueTabs.astro');
  for (const label of ['すべて', '中央競馬', '南関東競馬']) assert.ok(tabs.includes(`label: '${label}'`), label);
  // Premium（本利用）と Preview（体験）で同じタブ。リンク先だけが違う
  assert.match(tabs, /premium: \{ all: '\/predictions\/', jra: '\/premium-prediction\/jra\/', nankan: '\/premium-prediction\/nankan\/' \}/);
  assert.match(tabs, /preview: \{ all: '\/free-prediction\/all\/', jra: '\/free-prediction\/jra\/', nankan: '\/free-prediction\/nankan\/' \}/);
  assert.match(read('src/pages/premium-prediction/jra.astro'), /<PremiumRaceBoard mode="premium" venue="jra"/);
  assert.match(read('src/pages/premium-prediction/nankan.astro'), /<PremiumRaceBoard mode="premium" venue="nankan"/);
  const all = read('src/pages/predictions/index.astro');
  assert.match(all, /<PremiumRaceBoard mode="premium" venue="all"/);
  assert.match(read('src/components/acquisition/PremiumRaceBoard.astro'), /<AcquisitionVenueTabs active=\{venue\} mode=\{mode\} \/>/);
  assert.ok(all.indexOf('gatePaidPage(') < all.indexOf('buildListModel('), '認可の前に一覧を組み立てている');
  assert.match(all, /requiredPlan: \['premium', 'premium-jra', 'premium-nankan'\]/, '会場別 Premium も「すべて」に入れる');
  // 「すべて」のモデル: 中央・南関を合わせ、区分ごとの取得可否をレースに付ける
  const { buildListModel } = await import('./listModel.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'acq-all-'));
  mkdirSync(join(root, 'src', 'data', 'predictions', 'jra', '2026', '10'), { recursive: true });
  writeFileSync(join(root, 'src', 'data', 'predictions', '2026-10-03-funabashi.json'), JSON.stringify({ eventInfo: { date: '2026-10-03', venue: '船橋', totalRaces: 12 }, predictions: [race(11)] }));
  writeFileSync(join(root, 'src', 'data', 'predictions', 'jra', '2026', '10', '2026-10-03.json'), JSON.stringify({ date: '2026-10-03', venues: [{ venue: '東京', eventInfo: { totalRaces: 12 }, predictions: [{ ...race(11), raceInfo: { ...race(11).raceInfo, venue: '東京' } }] }] }));
  const m = buildListModel({ cat: 'all', product: 'premium', requestedDate: '2026-10-03', acquisitions: [], root, canAcquireFor: (c) => c === 'jra' });
  assert.deepEqual(m.venues.map((v) => [v.venueName, v.cat]), [['中央 東京', 'jra'], ['南関 船橋', 'nankan']]);
  assert.deepEqual(m.venues.map((v) => v.races[0].canAcquire), [true, false]);
  assert.deepEqual(m.venues.map((v) => v.races[0].key), ['premium:jra:2026-10-03:TOK:11', 'premium:nankan:2026-10-03:funabashi:11']);
});

test('着順の色: 1着ゴールド / 2着アイスシルバー（灰色にしない）/ 3着ブロンズ', () => {
  const css = read('src/styles/acquisitionGlass.css');
  assert.match(css, /\.rk-1 \{[^}]*rgba\(252, 211, 77/);
  assert.match(css, /\.rk-2 \{[^}]*color: #ffffff[^}]*rgba\(224, 242, 254[^}]*box-shadow: 0 0 12px/);
  assert.match(css, /\.rk-3 \{[^}]*rgba\(234, 147, 84/);
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  assert.equal(/\.rk-2 \{/.test(body), false, '部品側に古い 2 着色が残っている');
});

// ── 2026-10-04 MK 確定: Preview（/free-prediction/）と Premium は同じ部品・違いは権限と CTA だけ ──
test('Preview の詳細内容は公開範囲だけ（買い目・指数・pt・▲△以外の役割を入れない）', async () => {
  const { buildPreviewContent } = await import('./previewContent.js');
  const c = buildPreviewContent({ cat: 'nankan', venueName: '船橋', race: race(11), venueTotalRaces: 12 });
  assert.equal(c.preview, true);
  const json = JSON.stringify(c);
  for (const w of ['umatan', 'sanrenpuku', 'aiIndex', 'computerIndex', '"pt"', 'bettingLines', '抑え', '補欠', '"無"', '連下"']) assert.equal(json.includes(w), false, w);
  assert.deepEqual(c.horses.filter((h) => h.mark).map((h) => [h.number, h.mark]), [[3, '◎'], [4, '○'], [2, '▲'], [9, '▲'], [5, '△']], '公開の印（◎○▲△）だけ・無料公開 DTO と同じ');
  assert.ok(c.horses.every((h) => Array.isArray(h.recent)), '過去走は全馬');
  assert.equal(c.horses.length, 12, '全出走馬（分類は付けない）');
  // 本文部品: プレビューでは買い目・指数の実値を参照しない（ダミーのモザイクだけ）
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  assert.match(body, /const umatanTotal = \(isSrp \|\| isPreview\) \? 0/, 'プレビューで買い目を参照している');
  const pv = body.slice(body.indexOf('{isPreview ? ('), body.indexOf(') : !isSrp ? ('));
  assert.equal(/c\.umatan|l\.line|h\.aiIndex/.test(pv), false);
});

test('Preview と Premium の画面は同じ部品（違いは mode・CTA・権限だけ）', () => {
  const board = read('src/components/acquisition/PremiumRaceBoard.astro');
  const list = read('src/components/acquisition/AcquisitionRaceList.astro');
  assert.match(board, /mode: 'premium' \| 'preview'/);
  assert.match(list, /mode\?: 'premium' \| 'preview'/);
  // CTA は同じ位置（同じ acq-race-cta の中）・同じボタン部品（ag-cta acq-btn）
  const cta = list.slice(list.indexOf('<div class="acq-race-cta">'), list.indexOf('</article>'));
  assert.match(cta, /isPreview \? \([\s\S]*class="ag-cta ag-cta-premium acq-btn" href="\/pricing\/"[\s\S]*\) : r\.acquired \? \([\s\S]*class="ag-cta acq-btn"/);
  // Preview は公開ページ（会員判定・Cookie を使わない）。Premium は認可あり
  for (const p of ['src/pages/free-prediction/jra.astro', 'src/pages/free-prediction/nankan.astro', 'src/pages/free-prediction/all.astro', 'src/pages/free-prediction/view.astro']) {
    const s = read(p);
    assert.match(s, /setPublicCdnCache\(Astro\)/, p);
    for (const w of ['gatePaidPage', 'ak_session', 'Astro.cookies', 'loadMemberAcquisitions']) assert.equal(s.includes(w), false, `${p}: ${w}`);
  }
  assert.match(read('src/pages/predictions/index.astro'), /gatePaidPage\(/);
  // /free/ は Premium 系 UI へ寄せない
  for (const p of ['src/pages/free/jra.astro', 'src/pages/free/nankan.astro']) {
    const s = read(p);
    for (const w of ['PremiumRaceBoard', 'AcquisitionRaceList', 'acquisitionGlass']) assert.equal(s.includes(w), false, `${p}: ${w}`);
  }
});

test('サイトマップ: 会員限定の取得画面とプレビュー詳細は載せない・プレビュー一覧は載せる', async () => {
  const { isSitemapExcluded } = await import('../seo/sitemapPolicy.mjs');
  for (const p of ['/predictions/', '/predictions/view/', '/predictions/history/', '/free-prediction/view/']) assert.equal(isSitemapExcluded(`https://analytics.keiba.link${p}`), true, p);
  for (const p of ['/free-prediction/jra/', '/free-prediction/nankan/', '/free-prediction/all/', '/free/jra/']) assert.equal(isSitemapExcluded(`https://analytics.keiba.link${p}`), false, p);
});

test('Premium 導線 CTA は同じスタイル（明るい紫）・通常の取得 CTA（青）・取得済み（緑）と分ける', () => {
  const css = read('src/styles/acquisitionGlass.css');
  // 色体系
  assert.match(css, /--ag-cta: linear-gradient\(135deg, #3b82f6 0%, #2563eb 45%, #0284c7 100%\)/, '通常の操作は青');
  assert.match(css, /--ag-cta-premium: linear-gradient\(135deg, rgba\(180, 108, 249, 0\.1\d\)/, 'Premium 導線はメインバッジと同じ薄い紫のガラス（塗りつぶしにしない）');
  assert.doesNotMatch(css.match(/--ag-cta-premium: [^;]*;/)[0], /rgba\(255, 255, 255/, '白の光沢を重ねない（乳白色に見える）');
  const rule = (sel) => (css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`)) || [])[0] || '';
  const base = rule('.ag-cta.ag-cta-premium');
  assert.match(base, /backdrop-filter: blur\(14px\) saturate\(170%\)/, '色付きガラス: 背景ぼかし（2026-10-05 MK）');
  assert.match(base, /color: #c084fc/, '文字は紫（2026-10-05 MK・淡いラベンダーは乳白色に見える）');
  assert.match(base, /border: 1px solid rgba\(180, 108, 249/, '枠は紫（メインバッジと同じ作り）');
  assert.match(base, /box-shadow: 0 0 22px rgba\(168, 85, 247/, '柔らかい紫の発光');
  assert.match(rule('.ag-cta.ag-cta-premium:hover'), /--ag-cta-premium-hover/, 'hover で明るく');
  assert.match(rule('.ag-cta.ag-cta-premium:active'), /translateY\(1px\)/, 'active で沈む');
  assert.match(rule('.ag-cta.ag-cta-premium:focus-visible'), /outline: 3px solid/, 'キーボードのフォーカスが見える');
  assert.match(css, /@media \(max-width: 759px\) \{ \.ag-cta\.ag-cta-premium \{ min-height: 52px/);
  // /pricing/ への Premium 導線はすべて同じクラス（Preview・Premium 部品・関連導線）
  const files = ['src/components/acquisition/AcquisitionRaceList.astro', 'src/components/acquisition/PremiumRaceBoard.astro', 'src/components/acquisition/AcquiredPredictionBody.astro', 'src/pages/free-prediction/view.astro', 'src/pages/free-prediction/jra.astro', 'src/pages/free-prediction/nankan.astro', 'src/pages/free-prediction/all.astro'];
  for (const f of files) {
    const tags = [...read(f).matchAll(/<a [^>]*href="\/pricing\/"[^>]*>/g)].map((m) => m[0]);
    assert.ok(tags.length > 0, f);
    for (const t of tags) assert.match(t, /class="ag-cta ag-cta-premium/, `${f}: ${t}`);
  }
  // 通常の取得 CTA は Premium 色にしない
  assert.match(read('src/components/acquisition/AcquisitionRaceList.astro'), /<button type="submit" class="ag-cta acq-btn">/);
});


test('会場タブ＝イエロー系ガラス・日付タブ＝黄緑の乳白色ガラス（文字も同系色）', () => {
  const tabs = read('src/components/acquisition/AcquisitionVenueTabs.astro');
  const list = read('src/components/acquisition/AcquisitionRaceList.astro');
  const active = (src, sel) => (src.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`)) || [])[0] || '';
  const venue = active(tabs, '.acq-venue-tabs a.is-active');
  assert.match(venue, /color: #713f12/);
  assert.match(venue, /rgba\(253, 224, 71/);
  assert.match(venue, /backdrop-filter: blur/);
  assert.match(tabs, /\.acq-venue-tabs a \{[^}]*color: #fde68a/);
  const date = active(list, '.acq-dates a.is-active');
  assert.match(date, /color: #365314/);
  assert.match(date, /rgba\(236, 252, 203/);
  assert.match(list, /\.acq-dates a \{[^}]*color: #d9f99d[^}]*backdrop-filter: blur/);
  assert.match(read('src/styles/acquisitionGlass.css'), /background: var\(--ag-cta\); color: #e0f2fe;/, '通常 CTA の文字は淡い青');
});

test('Preview 詳細の買い目カードは 1 枚（馬単買い目）だけ（2026-10-04 MK 確定）', () => {
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  const pv = body.slice(body.indexOf('{isPreview ? ('), body.indexOf(') : !isSrp ? ('));
  assert.equal((pv.match(/<article /g) || []).length, 1, 'プレビューの買い目カードが 1 枚ではない');
  assert.match(pv, /<h3>馬単買い目<\/h3>/);
  for (const w of ['馬単 通常の買い目', '馬単 点数を絞った買い目']) assert.equal(pv.includes(`<h3>${w}`), false, w);
});


test('Preview の「Premium なら」パネル: たくさん使えるメリットを主役に（2026-10-04 MK 確定）', () => {
  const board = read('src/components/acquisition/PremiumRaceBoard.astro');
  const side = board.slice(board.indexOf('<aside class="acq-preview-side"'), board.indexOf('</aside>'));
  assert.match(side, /取得回数に上限なし/);
  assert.match(side, /月額のまま、何レースでも。/);
  assert.match(side, /使うほど 1 レースあたりがお得に/);
  assert.equal(/通常の買い目と、点数を絞った買い目/.test(side), false, '買い目の種類を強調しない');
  assert.equal(/Premiumでできること/.test(side), false);
  assert.match(side, /class="ag-cta ag-cta-premium" href="\/pricing\/"/);
  assert.match(read('src/components/acquisition/AcquisitionValuePanel.astro'), /<h2>本日の使用状況<\/h2>/);
});

test('絞った買い目に「厳選」バッジを付けない（少点数は的中が難しく、確度を誇張しない／2026-10-04 MK）', () => {
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  assert.ok(!body.includes('厳選'), 'AcquiredPredictionBody に「厳選」表記が残っている');
  assert.ok(body.includes('data-kind="umatan-narrowed"'), '絞った買い目カード自体は維持');
});

test('絞った馬単買い目は通常の買い目と同じ配色（金色の強調を残さない／2026-10-05 MK）', () => {
  const body = read('src/components/acquisition/AcquiredPredictionBody.astro');
  const m = body.match(/data-kind="umatan-narrowed"[\s\S]*?<\/article>/);
  assert.ok(m, '絞った買い目カードが無い');
  const open = body.slice(body.lastIndexOf('<article', m.index), m.index);
  assert.ok(!/\bnarrowed\b/.test(open), 'カードに narrowed（金色枠）クラスが残っている');
  assert.ok(!/\bgold\b/.test(m[0]), 'カード内に gold ピルが残っている');
});

test('レースカードは乳白色を弱める（白の塗りを薄く／2026-10-05 MK）', () => {
  const list = read('src/components/acquisition/AcquisitionRaceList.astro');
  const m = list.match(/\.acq-race\.ag-glass \{ background: ([^;]*);/);
  assert.ok(m, 'レースカード専用の背景指定がない');
  const alphas = [...m[1].matchAll(/rgba\(\d+, \d+, \d+, (0\.\d+)\)/g)].map((x) => Number(x[1]));
  assert.ok(alphas.length >= 2 && Math.max(...alphas) <= 0.1, `塗りの不透明度が高い: ${alphas}`);
});

test('レースカードの枠線・上辺反射は白くしない（2026-10-05 MK）', () => {
  const list = read('src/components/acquisition/AcquisitionRaceList.astro');
  assert.match(list, /\.acq-race\.ag-glass \{ border-color: rgba\(165, 180, 252, 0\.2\d\)/, '枠は青紫寄りの控えめな線');
  assert.match(list, /\.acq-race\.ag-glass::before \{ background: linear-gradient\(90deg, transparent, rgba\(199, 210, 254, 0\.3\d\)/, '上辺の反射を弱める');
  const shadow = (list.match(/\.acq-race\.ag-glass \{ border-color[^}]*box-shadow: ([^;]*);/) || [])[1] || '';
  assert.ok(shadow && !/rgba\(255, 255, 255/.test(shadow), '内側の白ハイライトを使わない');
});
