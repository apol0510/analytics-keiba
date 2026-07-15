/**
 * recoverySelection.test.mjs — 固定6点・案2「150%最近傍」選定の契約テスト。
 *   node --test src/lib/recoverySelection.test.mjs
 *
 * 重点:
 *   - DP 復元バグの回帰防止（独立ブルートフォース照合）
 *   - 公開値の恒等式
 *   - 冪等性（candidateHit を候補源に固定・2回目以降で候補が減らない）
 *   - tie-break の決定性
 *   - 健全化（payout 0/NaN/負の除外）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCountedHits, computeRecoveryDay } from './recoverySelection.js';

const UNIT = 100, PPR = 6, TARGET = 150, CAP = 200;

// ---- 独立オラクル: 全部分集合を総当りして案2の最適解を求める（tie-break込み）----
function bruteforce(hits, races) {
  const denom = races * PPR * UNIT;
  const cap = CAP / 100 * denom;
  const target = TARGET / 100 * denom;
  // 正準順（モジュールと同一）
  const cand = hits
    .map((h) => ({ ...h, payout: Number(h.payout) }))
    .filter((h) => Number.isFinite(h.payout) && h.payout > 0)
    .sort((a, b) => (a.venue !== b.venue ? (a.venue < b.venue ? -1 : 1)
      : a.raceNumber !== b.raceNumber ? a.raceNumber - b.raceNumber
      : String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0));
  const n = cand.length;
  let best = null; // {sum, dist, mask}
  for (let mask = 0; mask < (1 << n); mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += cand[i].payout;
    if (sum > cap) continue;
    const dist = Math.abs(sum - target);
    if (best === null || dist < best.dist || (dist === best.dist && sum > best.sum)) {
      best = { sum, dist, mask, tie: [mask] };
    } else if (dist === best.dist && sum === best.sum) {
      best.tie.push(mask);
    }
  }
  // tie-break: 同 (dist,sum) が複数 → 「より早いレース(低 index)を採用」= 高 index を除外優先。
  // = 選択 index 集合を降順比較して、大きい index を含まない方を選ぶ（lexicographically smallest by descending index）。
  let chosen = best.tie[0];
  const rank = (mask) => { // 高 index ほど重い → 小さいほど「早いレース寄り」
    let r = 0n; for (let i = n - 1; i >= 0; i--) { r = r * 2n + ((mask & (1 << i)) ? 1n : 0n); } return r;
  };
  for (const m of best.tie) if (rank(m) < rank(chosen)) chosen = m;
  const countedKeys = [];
  for (let i = 0; i < n; i++) if (chosen & (1 << i)) countedKeys.push(cand[i].key);
  return { countedPayout: best.sum, countedKeys };
}

function mkHits(payouts) {
  // venue 固定・raceNumber を index にして正準順を安定化
  return payouts.map((p, i) => ({ key: `r${i}`, venue: '大井', raceNumber: i + 1, payout: p }));
}

test('DP復元バグ回帰: countedPayout が DP最適(ブルートフォース)と一致・cap以下', () => {
  const cases = [
    [2410, 2110, 3270, 3930, 7660, 2940, 11400, 870, 6990, 1230, 4500], // 2026-06-25 実データ相当
    [15000], // 単一 >200% (denom=600) → 強制空
    [1000, 2000, 3000, 4000, 5000, 6000],
    [800, 800, 800, 800, 800, 800, 800, 800, 800, 800, 800, 800],
    [13310, 120, 990, 7200, 3600, 250],
    [10800], // ちょうど150% (races=12)
    [], // 候補なし
  ];
  for (const payouts of cases) {
    const races = 12;
    const hits = mkHits(payouts);
    const out = selectCountedHits({ races, hits });
    const oracle = bruteforce(hits, races);
    // 恒等: countedPayout == countedKeys の payout 合計
    const byKey = new Map(hits.map((h) => [h.key, h.payout]));
    const sumSel = out.countedKeys.reduce((s, k) => s + byKey.get(k), 0);
    assert.equal(sumSel, out.countedPayout, `countedPayout != Σselected for ${payouts}`);
    // cap 以下
    assert.ok(out.countedPayout <= CAP / 100 * races * PPR * UNIT, `over cap for ${payouts}`);
    // DP最適と一致
    assert.equal(out.countedPayout, oracle.countedPayout, `not optimal for ${payouts}`);
    // tie-break まで一致（採用キー集合）
    assert.deepEqual([...out.countedKeys].sort(), [...oracle.countedKeys].sort(), `key set differs for ${payouts}`);
  }
});

test('DP復元: s<w の要素を誤って採用しない（負残額を出さない）', () => {
  // 大きな高index要素があり、最適が小さい合計になるケース（旧バグの典型）
  const races = 12; // denom 7200, cap 14400, target 10800
  const hits = mkHits([500, 300, 200, 100, 14000]); // 14000単独は<=cap だが target近傍は 14000(dist3200) vs 1100(dist9700) → 14000採用
  const out = selectCountedHits({ races, hits });
  const oracle = bruteforce(hits, races);
  assert.equal(out.countedPayout, oracle.countedPayout);
  assert.ok(out.countedPayout <= 14400);
});

test('決定的 seeded スイープ: 200ケースで DP=ブルートフォース', () => {
  // 決定的 LCG（Math.random 不使用）
  let seed = 123456789;
  const rnd = () => { seed = (1103515245 * seed + 12345) % 2147483648; return seed / 2147483648; };
  for (let t = 0; t < 200; t++) {
    const n = Math.floor(rnd() * 10); // 0..9 候補
    const races = 8 + Math.floor(rnd() * 5); // 8..12
    const payouts = Array.from({ length: n }, () => (1 + Math.floor(rnd() * 300)) * 10); // 10〜3000, 10円単位
    const hits = mkHits(payouts);
    const out = selectCountedHits({ races, hits });
    const oracle = bruteforce(hits, races);
    assert.equal(out.countedPayout, oracle.countedPayout, `sweep t=${t} payouts=${payouts} races=${races}`);
    assert.deepEqual([...out.countedKeys].sort(), [...oracle.countedKeys].sort(), `sweep keys t=${t}`);
  }
});

test('全候補採用でも150%未満なら全採用（除外0・fullyAdopted）', () => {
  const races = 12; // target 10800
  const hits = mkHits([1000, 1500, 2000]); // Σ4500 < 10800
  const out = selectCountedHits({ races, hits });
  assert.equal(out.countedPayout, 4500);
  assert.equal(out.excludedKeys.length, 0);
  assert.equal(out.fullyAdopted, true);
  assert.equal(out.reachedTarget, false);
});

test('単一払戻が>200%: 強制空集合・forcedEmpty・exceeds-200-cap', () => {
  const races = 1; // denom 600, cap 1200
  const hits = mkHits([5000]);
  const out = selectCountedHits({ races, hits });
  assert.equal(out.countedPayout, 0);
  assert.equal(out.countedKeys.length, 0);
  assert.equal(out.forcedEmpty, true);
});

test('健全化: payout 0/NaN/負/欠損は候補から除外', () => {
  const races = 12;
  const hits = [
    { key: 'a', venue: '大井', raceNumber: 1, payout: 3000 },
    { key: 'b', venue: '大井', raceNumber: 2, payout: 0 },
    { key: 'c', venue: '大井', raceNumber: 3, payout: -100 },
    { key: 'd', venue: '大井', raceNumber: 4, payout: NaN },
    { key: 'e', venue: '大井', raceNumber: 5 }, // payout 欠損
  ];
  const out = selectCountedHits({ races, hits });
  assert.equal(out.rawPayout, 3000);
  assert.ok(out.countedKeys.every((k) => k === 'a') || out.countedKeys.length === 0);
});

// ---- computeRecoveryDay: 恒等式 & 冪等性 ----
function mkRace(raceNumber, venue, isHit, payout, lines = []) {
  return { raceNumber, venue, raceName: `${raceNumber}R`, isHit, hitLines: isHit ? lines : [],
    umatan: { combination: '1-2', payout }, result: { first: { number: 1 } }, bettingLines: lines };
}

test('公開値恒等式: totalPayout==Σ(isHit payout)・不採用payout0・betAmount・回収率≤200', () => {
  const rr = [
    mkRace(1, '大井', true, 13310, ['1↔2']),
    mkRace(2, '大井', true, 2410, ['2↔1']),
    mkRace(3, '大井', true, 3270, ['3↔1']),
    mkRace(4, '大井', false, 0),
    ...Array.from({ length: 8 }, (_, i) => mkRace(i + 5, '大井', false, 0)),
  ];
  const { races, day } = computeRecoveryDay(rr, { pointsPerRace: 6 });
  const sumIsHit = races.filter((r) => r.isHit).reduce((s, r) => s + r.payout, 0);
  assert.equal(day.totalPayout, sumIsHit);
  assert.equal(day.hitRaces, races.filter((r) => r.isHit).length);
  assert.equal(day.missRaces, day.totalRaces - day.hitRaces);
  for (const r of races) if (!r.isHit) assert.equal(r.payout, 0, 'excluded payout must be 0');
  assert.equal(day.betPointsPerRace, 6);
  assert.equal(day.betAmount, day.totalRaces * 6 * 100);
  assert.equal(day.totalInvestment, day.betAmount);
  assert.equal(day.returnRate, day.recoveryRate);
  assert.equal(day.returnRate, Math.round((day.totalPayout / day.betAmount) * 1000) / 10);
  assert.ok(day.returnRate <= 200, `returnRate ${day.returnRate} > 200`);
  // 原本不変
  assert.equal(races[0].umatan.payout, 13310);
});

test('冪等性: 2回目以降で candidate 数・選択が減らない（candidateHit を候補源に固定）', () => {
  const rr = Array.from({ length: 12 }, (_, i) => mkRace(i + 1, '大井', i < 8, i < 8 ? (i + 1) * 700 : 0, [`${i + 1}↔1`]));
  const run1 = computeRecoveryDay(rr, { pointsPerRace: 6 });
  // run1.races は candidateHit を持ち isHit は案2採用済み。これを再投入。
  const run2 = computeRecoveryDay(run1.races, { pointsPerRace: 6 });
  assert.deepEqual(run2.day, run1.day, 'day fields must be stable across recompute');
  const cand1 = run1.races.filter((r) => r.candidateHit).length;
  const cand2 = run2.races.filter((r) => r.candidateHit).length;
  assert.equal(cand2, cand1, 'candidate count must not shrink');
  assert.ok(cand2 >= run2.races.filter((r) => r.isHit).length, 'candidates >= public hits');
  const hit1 = run1.races.map((r) => r.isHit).join(',');
  const hit2 = run2.races.map((r) => r.isHit).join(',');
  assert.equal(hit2, hit1, 'public isHit set must be identical across recompute');
  // 3回目も安定
  const run3 = computeRecoveryDay(run2.races, { pointsPerRace: 6 });
  assert.deepEqual(run3.day, run1.day);
});

test('旧フォーマット: umatan無し・top-level payout を候補払戻に採用し、再計算で不変', () => {
  // 月次形式の day（umatan 無し・top-level payout 有り・isHit=true）
  const legacy = [
    { raceNumber: '1R', raceName: '3歳', betType: '馬単', betPoints: 6, isHit: true, payout: 2020, venue: '川崎' },
    { raceNumber: '2R', raceName: '3歳', betType: '馬単', betPoints: 6, isHit: true, payout: 8800, venue: '川崎' },
    ...Array.from({ length: 10 }, (_, i) => ({ raceNumber: `${i + 3}R`, betType: '馬単', betPoints: 6, isHit: false, payout: 0, venue: '川崎' })),
  ];
  const run1 = computeRecoveryDay(legacy, { pointsPerRace: 6 });
  // 候補払戻は top-level payout から拾える（rawTotalPayout = 2020+8800）
  assert.equal(run1.day.rawTotalPayout, 10820);
  assert.equal(run1.day.candidateHitRaces, 2);
  // 恒等式
  const sumIsHit = run1.races.filter((r) => r.isHit).reduce((s, r) => s + r.payout, 0);
  assert.equal(run1.day.totalPayout, sumIsHit);
  assert.ok(run1.day.returnRate <= 200);
  // 冪等: 再投入で candidate 数・選択・回収率が不変
  const run2 = computeRecoveryDay(run1.races, { pointsPerRace: 6 });
  assert.deepEqual(run2.day, run1.day);
  assert.equal(run2.races.filter((r) => r.candidateHit).length, 2);
});

test('決定性: 同一入力→同一出力（100回）', () => {
  const rr = Array.from({ length: 12 }, (_, i) => mkRace(i + 1, '大井', i % 2 === 0, i % 2 === 0 ? 1000 + i * 130 : 0, [`${i + 1}↔1`]));
  const first = JSON.stringify(computeRecoveryDay(rr));
  for (let k = 0; k < 100; k++) assert.equal(JSON.stringify(computeRecoveryDay(rr)), first);
});
