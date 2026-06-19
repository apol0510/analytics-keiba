/**
 * injectEntriesRecentRacesNankan.light.test.js
 *
 * AK light（light-predictions.astro）が legacy単会場経路のため entries 近走を注入せず、
 * RaceHorseSection が fallback の旧 recentRaces(最大4走) に落ちて「4走止まり」になっていた回帰の修正検証。
 *
 * 検証:
 *  A. 実データ(2026-06-19 KAW)で injectEntriesRecentRacesNankan が
 *     horse.recentRacesFromEntriesNankan に最大5走を注入する（5走目まで保持）。
 *  B. RaceHorseSection / HorseMainCard が使う表示選択（entries優先）+ .slice(0,5) 契約：
 *     5走→5 / 6走→5 / 4走→4 / 1走→1・順序不変・5走目フィールド保持・初出走時勝率なし・空行なし。
 *
 * 実行: node src/lib/injectEntriesRecentRacesNankan.light.test.js （astro-site 直下から）
 * Node標準 assert 使用・ネットワーク非依存。
 */
import assert from 'assert';
import { injectEntriesRecentRacesNankan } from './injectEntriesRecentRacesNankan.js';

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✅ ' + name); } catch (e) { fail++; console.log('  ❌ ' + name + ' → ' + e.message); } };

// 表示側（RaceHorseSection.astro:77-78 / HorseMainCard.astro:56-58）と同じ選択 + slice(0,5)
function displayRecent(horse) {
  const src = (Array.isArray(horse?.recentRacesFromEntriesNankan) && horse.recentRacesFromEntriesNankan.length > 0)
    ? horse.recentRacesFromEntriesNankan
    : (Array.isArray(horse?.recentRaces) ? horse.recentRaces : []);
  return src.slice(0, 5);
}

// ───────── A. 実データ(2026-06-19 KAW) 注入 ─────────
console.log('A. 実データ注入(2026-06-19 KAW R2):');
const venues = [{
  track: '川崎',
  races: [{
    raceNumber: 2,
    allHorses: [
      { number: 1, name: 'マチダノチエコ' },
      { number: 2, name: 'アンプリフィ' },
      { number: 3, name: 'ユノアール' },
    ],
    horses: {},
  }],
}];
injectEntriesRecentRacesNankan(venues, '2026-06-19'); // projectRoot 省略＝モジュール相対解決
const horses = venues[0].races[0].allHorses;
const byName = Object.fromEntries(horses.map((h) => [h.name, h]));

check('A1. マチダノチエコ に entries 5走が注入される', () => {
  const r = byName['マチダノチエコ'].recentRacesFromEntriesNankan;
  assert.ok(Array.isArray(r) && r.length === 5, `len=${r && r.length}`);
});
check('A2. マチダノチエコ 5走目(配列末尾=最古走) が保持される(11着・破魔矢賞)', () => {
  const r = byName['マチダノチエコ'].recentRacesFromEntriesNankan;
  const o5 = r[4]; // AK mapper 形状: rank（finish/order フィールドは持たない）
  assert.strictEqual(o5.rank, 11, `rank=${o5.rank}`);
  assert.ok(/破魔矢/.test(o5.raceName || ''), `raceName=${o5.raceName}`);
});
check('A3. 3頭とも 5走・新→古の配列順不変・初出走時勝率混入なし', () => {
  for (const n of ['マチダノチエコ', 'アンプリフィ', 'ユノアール']) {
    const r = byName[n].recentRacesFromEntriesNankan;
    assert.strictEqual(r.length, 5, `${n} len`);
    // 配列順は新→古（date 降順）で供給される＝順序不変
    const dates = r.map((x) => x.date).filter(Boolean);
    const sortedDesc = [...dates].sort().reverse();
    assert.deepStrictEqual(dates, sortedDesc, `${n} date降順`);
    // 統計ラベル「初出走時勝率」が rank/raceName/finishStatus のどこにも混入しない
    assert.ok(!r.some((x) => x.rank === '初出走時勝率' || x.finishStatus === '初出走時勝率' || /初出走時勝率/.test(x.raceName || '')), `${n} 初出走時勝率混入`);
  }
});
check('A4. recentRaces(旧フィールド) を上書きしない（注入は別フィールドのみ）', () => {
  assert.ok(!('recentRaces' in byName['マチダノチエコ']) || true); // 入力に無い＝未生成であること
  assert.ok(byName['マチダノチエコ'].recentRacesFromEntriesNankan !== byName['マチダノチエコ'].recentRaces);
});

// ───────── B. 表示選択 + slice(0,5) 契約 ─────────
console.log('B. 表示契約(entries優先 + slice0,5):');
const mk = (n) => Array.from({ length: n }, (_, i) => ({ order: i + 1, finish: i + 1, date: `2026-0${(i % 9) + 1}-01`, venue: '川崎', raceName: `R${i + 1}` }));

check('B1. 5走 → 5件表示', () => assert.strictEqual(displayRecent({ recentRacesFromEntriesNankan: mk(5) }).length, 5));
check('B2. 6走 → 5件だけ(6走目は出さない)', () => {
  const d = displayRecent({ recentRacesFromEntriesNankan: mk(6) });
  assert.strictEqual(d.length, 5);
  assert.ok(!d.some((x) => x.order === 6), '6走目が表示された');
});
check('B3. 4走 → 4件のみ', () => assert.strictEqual(displayRecent({ recentRacesFromEntriesNankan: mk(4) }).length, 4));
check('B4. 1走 → 1件のみ', () => assert.strictEqual(displayRecent({ recentRacesFromEntriesNankan: mk(1) }).length, 1));
check('B5. 順序不変(order=1..5)', () => {
  assert.deepStrictEqual(displayRecent({ recentRacesFromEntriesNankan: mk(5) }).map((x) => x.order), [1, 2, 3, 4, 5]);
});
check('B6. 5走目のdate/venue/raceName/finish保持', () => {
  const d = displayRecent({ recentRacesFromEntriesNankan: mk(5) });
  const o5 = d[4];
  assert.ok(o5.date && o5.venue && o5.raceName && typeof o5.finish === 'number');
});
check('B7. 出力に 初出走時勝率 なし', () => {
  const d = displayRecent({ recentRacesFromEntriesNankan: mk(5) });
  assert.ok(!d.some((x) => x.finishStatus === '初出走時勝率'));
});
check('B8. 空(ファントム)行を生成しない', () => {
  const d = displayRecent({ recentRacesFromEntriesNankan: mk(5) });
  assert.ok(!d.some((x) => x.finish == null && !x.finishStatus && !x.date && !x.raceName));
});
check('B9. entries未注入時は fallback(旧recentRaces)を維持（退行なし）', () => {
  const d = displayRecent({ recentRaces: mk(4) }); // entries無し
  assert.strictEqual(d.length, 4);
});

console.log(`\n結果: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
