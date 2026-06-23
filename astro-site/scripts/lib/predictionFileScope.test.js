/**
 * predictionFileScope.test.js
 *
 * check-prediction-data-integrity.mjs の走査対象判定（純粋関数）の単体テスト（Node標準 assert）。
 * 南関走査漏れ修正（YYYY-MM-DD-<venueSlug>.json を南関対象に含める）の回帰防止。
 *
 * 実行: node scripts/lib/predictionFileScope.test.js （astro-site 直下から）
 */
import assert from 'assert';
import {
  NANKAN_VENUE_SLUGS,
  isJraPredictionFilename,
  parseNankanPredictionFilename,
  inWindow,
} from './predictionFileScope.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };

// 窓判定は時刻依存を避けるため固定 today を注入し、明確なマージンの日付のみ使う。
const TODAY = new Date('2026-06-24T03:00:00Z');

// ドリフト防止: 南関4会場 slug 固定（大井/川崎/船橋/浦和。importPrediction venueMap / inject*Nankan と一致）
t('NANKAN_VENUE_SLUGS は4会場固定（ooi/funabashi/kawasaki/urawa）', () => {
  assert.deepStrictEqual([...NANKAN_VENUE_SLUGS].sort(), ['funabashi', 'kawasaki', 'ooi', 'urawa']);
});

// 1. JRA YYYY-MM-DD.json → JRA対象（南関としては解釈しない）
t('1. JRA YYYY-MM-DD.json → JRA対象・南関非該当', () => {
  assert.strictEqual(isJraPredictionFilename('2026-06-21.json'), true);
  assert.strictEqual(parseNankanPredictionFilename('2026-06-21.json'), null);
});

// 2. 南関 urawa → 南関対象
t('2. 2026-06-24-urawa.json → 南関対象', () => {
  assert.deepStrictEqual(parseNankanPredictionFilename('2026-06-24-urawa.json'), { date: '2026-06-24', venueSlug: 'urawa' });
  assert.strictEqual(isJraPredictionFilename('2026-06-24-urawa.json'), false);
});

// 3. 南関 kawasaki → 南関対象
t('3. 2026-06-19-kawasaki.json → 南関対象', () => {
  assert.deepStrictEqual(parseNankanPredictionFilename('2026-06-19-kawasaki.json'), { date: '2026-06-19', venueSlug: 'kawasaki' });
});

// 4. 南関 ooi / funabashi（実在の正規slug）→ 南関対象
t('4. ooi / funabashi → 南関対象', () => {
  assert.deepStrictEqual(parseNankanPredictionFilename('2026-06-10-ooi.json'), { date: '2026-06-10', venueSlug: 'ooi' });
  assert.deepStrictEqual(parseNankanPredictionFilename('2026-05-04-funabashi.json'), { date: '2026-05-04', venueSlug: 'funabashi' });
});

// 5. 無関係なJSON → 対象外（JRA も南関も拾わない）
t('5. 無関係JSON → 対象外', () => {
  for (const n of ['archiveResults.json', 'index.json', 'config.json', 'README.json']) {
    assert.strictEqual(isJraPredictionFilename(n), false, `${n} を JRA 扱い`);
    assert.strictEqual(parseNankanPredictionFilename(n), null, `${n} を南関扱い`);
  }
  // JRA/別データ会場を誤って南関に拾わない（slug が南関4会場以外）
  assert.strictEqual(parseNankanPredictionFilename('2026-06-24-tokyo.json'), null);
  assert.strictEqual(parseNankanPredictionFilename('2026-06-24-nakayama.json'), null);
});

// 6. 日付不正 → 対象外
t('6. 日付不正 → 対象外', () => {
  // 桁不足はそもそも filename 解析で null
  assert.strictEqual(parseNankanPredictionFilename('2026-6-1-urawa.json'), null);
  assert.strictEqual(isJraPredictionFilename('2026-6-1.json'), false);
  // 構造は通るが暦として不正（Invalid Date）→ inWindow で除外
  const bad = parseNankanPredictionFilename('2026-13-99-urawa.json');
  assert.ok(bad && bad.date === '2026-13-99');
  assert.strictEqual(inWindow('2026-13-99', TODAY), false);
});

// 7. 期間窓外 → 対象外（過去・未来とも）
t('7. 期間窓外（過去/未来）→ inWindow false', () => {
  assert.strictEqual(inWindow('2026-05-01', TODAY), false);  // 54日前
  assert.strictEqual(inWindow('2026-08-01', TODAY), false);  // 38日後
});

// 8. 期間窓内の南関ファイル → 解析成功かつ inWindow true（＝検査件数へ加算される条件）
t('8. 期間窓内 南関 → 解析成功 && inWindow true（加算対象）', () => {
  const parsed = parseNankanPredictionFilename('2026-06-24-urawa.json');
  assert.ok(parsed, '解析失敗');
  assert.strictEqual(inWindow(parsed.date, TODAY), true, '窓内なのに除外された');
  // 窓内 JRA も従来どおり加算対象
  assert.ok(isJraPredictionFilename('2026-06-24.json') && inWindow('2026-06-24', TODAY));
});

console.log(`\npredictionFileScope: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
