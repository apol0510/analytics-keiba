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
  assert.deepEqual(out, ['predictions/view.astro']);
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
    assert.match(body, new RegExp(`<AcquisitionRaceList product="${product}"`), p);
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
  assert.equal(c.sanrenpuku.center, undefined, 'Premium には中心買い目を出さない');
});

test('Premium 三連複は通常買い目（本命軸・対抗軸）', () => {
  const c = buildPredictionContent({ product: 'premium', cat: 'nankan', venueName: '船橋', race: race(1), venueTotalRaces: 12 });
  assert.equal(c.sanrenpuku.normal.length, 2);
  assert.match(c.sanrenpuku.normal[0].line, /^3 - /);
  assert.match(c.sanrenpuku.normal[1].line, /^4 - /);
  assert.ok(c.sanrenpuku.normal.every((l) => l.points > 0));
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

test('会場別 Premium（中央版・南関版）も取得の入口を通り、取得できるのは契約した会場だけ', async () => {
  const { ACQUISITION_DOOR_PLANS } = await import('./acquisitionServer.js');
  for (const p of ['premium', 'premium-jra', 'premium-nankan', 'Premium Sanrenpuku']) assert.ok(ACQUISITION_DOOR_PLANS.includes(p), p);
  const now = Date.parse('2026-10-03T03:00:00Z');
  const jraOnly = resolveEntitlements(fromAirtableFields({ 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-04', PaidAt: 'x', VenueAccess: 'jra' }), now);
  assert.equal(canAcquire(jraOnly, { product: 'premium', cat: 'jra' }), true);
  assert.equal(canAcquire(jraOnly, { product: 'premium', cat: 'nankan' }), false);
  assert.equal(canAcquire(jraOnly, { product: 'srp', cat: 'jra' }), false);
});
