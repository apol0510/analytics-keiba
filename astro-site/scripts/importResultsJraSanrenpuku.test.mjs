/**
 * importResultsJraSanrenpuku.test.mjs — JRA 三連複取込の単体テスト（node:test / 新規依存なし）
 *
 * 実行:
 *   node --test scripts/importResultsJraSanrenpuku.test.mjs
 *
 * 検証観点:
 *   - 失敗伝播契約（token 未設定 / fatal は writeArchive しない）
 *   - mergeSanrenpukuDayDataJra の複数会場・順序非依存・会場単位置換・JRA 会場順ソート
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runImport, mergeSanrenpukuDayDataJra } from './importResultsJraSanrenpuku.js';

const silent = { log() {}, warn() {}, error() {} };

function makeVenueDayData(venue, venueCode, races) {
  const totalRaces = races.length;
  const hitRaces = races.filter((r) => r.hit).length;
  const totalPayout = races.reduce((s, r) => s + (r.payout || 0), 0);
  const totalBetPoints = races.reduce((s, r) => s + (r.settlementPoints || 0), 0);
  return { venue, venueCode, totalRaces, hitRaces, totalPayout, totalBetPoints, races };
}
function race(raceNumber, venue, venueCode, { hit = false, payout = 0, narrow = false } = {}) {
  const hitTypes = [];
  if (hit) hitTypes.push('normal-honmei-axis');
  if (narrow) hitTypes.push('narrow');
  return { raceNumber, venue, venueCode, hit, payout, settlementPoints: 12, hitTypes };
}

// ── 失敗伝播契約 ──────────────────────────────────────────────
test('1. token 未設定は即 throw・read/process/write 未実行', async () => {
  let readCalled = 0, processCalled = 0;
  const write = { calls: [] };
  await assert.rejects(
    runImport({
      argv: ['--date', '2026-06-28'],
      resolveToken: () => { const e = new Error('no token'); e.code = 'TOKEN_MISSING'; throw e; },
      readArchive: () => { readCalled++; return {}; },
      processDayFn: async () => { processCalled++; return null; },
      writeArchive: (a) => write.calls.push(a),
      logger: silent,
    }),
  );
  assert.equal(readCalled, 0);
  assert.equal(processCalled, 0);
  assert.equal(write.calls.length, 0);
});

test('2. processDay が fatal を throw したら writeArchive されない', async () => {
  const write = { calls: [] };
  await assert.rejects(
    runImport({
      argv: ['--date', '2026-06-28'],
      resolveToken: () => {},
      resolveTargetsFn: () => ['2026-06-28'],
      readArchive: () => ({}),
      processDayFn: async () => { const e = new Error('boom'); e.code = 'SERVER_ERROR'; throw e; },
      writeArchive: (a) => write.calls.push(a),
      logger: silent,
    }),
    /Failed to import required JRA shared results/,
  );
  assert.equal(write.calls.length, 0);
});

test('3. 成功時は arch にマージして writeArchive される', async () => {
  const write = { calls: [] };
  const res = await runImport({
    argv: ['--date', '2026-06-28'],
    resolveToken: () => {},
    resolveTargetsFn: () => ['2026-06-28'],
    readArchive: () => ({}),
    processDayFn: async () => [makeVenueDayData('小倉', 'KOK', [race('1R', '小倉', 'KOK', { hit: true, payout: 5000 })])],
    writeArchive: (a) => write.calls.push(a),
    logger: silent,
  });
  assert.equal(res.written, true);
  assert.equal(write.calls.length, 1);
  const day = write.calls[0]['2026']['06']['28'];
  assert.equal(day.totalRaces, 1);
  assert.equal(day.hitRaces, 1);
  assert.deepEqual(day.venues, ['小倉']);
});

// ── mergeSanrenpukuDayDataJra ─────────────────────────────────
test('4. 複数会場マージで各 race の venue が区別される', () => {
  const tok = makeVenueDayData('東京', 'TOK', [race('1R', '東京', 'TOK', { hit: true, payout: 1000 })]);
  const kyo = makeVenueDayData('京都', 'KYO', [race('1R', '京都', 'KYO', { hit: false })]);
  const merged = mergeSanrenpukuDayDataJra(mergeSanrenpukuDayDataJra(null, tok), kyo);
  assert.equal(merged.totalRaces, 2);
  assert.deepEqual(merged.venues, ['東京', '京都']); // JRA 会場順 TOK→KYO
  const tokR = merged.races.find((r) => r.venueCode === 'TOK');
  const kyoR = merged.races.find((r) => r.venueCode === 'KYO');
  assert.equal(tokR.venue, '東京');
  assert.equal(kyoR.venue, '京都');
});

test('5. 取込順が逆でも同一結果（順序非依存）', () => {
  const tok = makeVenueDayData('東京', 'TOK', [race('1R', '東京', 'TOK', { hit: true, payout: 1000 })]);
  const kyo = makeVenueDayData('京都', 'KYO', [race('1R', '京都', 'KYO', { hit: true, payout: 2000 })]);
  const a = mergeSanrenpukuDayDataJra(mergeSanrenpukuDayDataJra(null, tok), kyo);
  const b = mergeSanrenpukuDayDataJra(mergeSanrenpukuDayDataJra(null, kyo), tok);
  assert.deepEqual(a.venues, b.venues);
  assert.equal(a.totalRaces, b.totalRaces);
  assert.equal(a.totalPayout, b.totalPayout);
  assert.deepEqual(a.races.map((r) => r.venueCode + r.raceNumber), b.races.map((r) => r.venueCode + r.raceNumber));
});

test('6. 同一会場の再取込は置換（重複しない・冪等）', () => {
  const tok1 = makeVenueDayData('東京', 'TOK', [race('1R', '東京', 'TOK', { hit: false })]);
  const tok2 = makeVenueDayData('東京', 'TOK', [race('1R', '東京', 'TOK', { hit: true, payout: 3000 })]);
  const merged = mergeSanrenpukuDayDataJra(mergeSanrenpukuDayDataJra(null, tok1), tok2);
  assert.equal(merged.totalRaces, 1); // 重複せず置換
  assert.equal(merged.hitRaces, 1);
  assert.equal(merged.totalPayout, 3000);
});

test('7. JRA 会場順で決定的にソートされる（TOK→NAK→KYO→HAN）', () => {
  const han = makeVenueDayData('阪神', 'HAN', [race('1R', '阪神', 'HAN')]);
  const tok = makeVenueDayData('東京', 'TOK', [race('1R', '東京', 'TOK')]);
  const nak = makeVenueDayData('中山', 'NAK', [race('1R', '中山', 'NAK')]);
  let m = mergeSanrenpukuDayDataJra(null, han);
  m = mergeSanrenpukuDayDataJra(m, tok);
  m = mergeSanrenpukuDayDataJra(m, nak);
  assert.deepEqual(m.venues, ['東京', '中山', '阪神']);
});

test('8. venueCode 解決不能は throw（誤削除防止）', () => {
  const bad = { venue: '存在しない場', races: [race('1R', '存在しない場', '')] };
  // venueToCode は未知名をそのまま返すため venueCode は '存在しない場' になり throw しない。
  // 完全に空(venue無し)のときのみ解決不能。
  const noVenue = { venue: '', races: [] };
  assert.throws(() => mergeSanrenpukuDayDataJra(null, noVenue), /cannot resolve venueCode/);
  // 未知会場名は落とさず取り込む（データ欠損より保全優先）
  const ok = mergeSanrenpukuDayDataJra(null, bad);
  assert.equal(ok.races.length, 1);
});
