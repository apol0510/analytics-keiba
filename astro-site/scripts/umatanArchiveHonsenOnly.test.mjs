/**
 * umatanArchiveHonsenOnly.test.mjs
 * AK馬単アーカイブ「公開本線のみ判定」（2026-07 仕様）の恒久テスト。
 *   node --test scripts/umatanArchiveHonsenOnly.test.mjs
 *
 * 固定する契約:
 *   - 本線相手で 1着・2着成立 → 的中 / 抑え馬だけ絡む → 不的中
 *   - 本線と抑え両方に存在 → 本線として的中 / 抑え表記なし → 従来どおり
 *   - 半角/全角括弧・dash/↔/⇔/→ の各形式対応
 *   - 投資額5点固定不変・払戻/回収率の集計式不変
 *   - 2026-07-01 大井 R10 が不的中 / 開催集計 10-12・払戻¥22,090・ROI≈368.2%
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkUmatanHit as checkNankan } from './importResults.js';
import { checkUmatanHit as checkJra } from './importResultsJra.js';
import { recomputeEntry } from './recalculate-umatan-archive-honsen-only.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const res = (first, second) => ({ results: [{ number: first }, { number: second }] });

// 南関・JRA は同一判定ロジック。両方に同じ契約を適用する。
for (const [label, check] of [['南関', checkNankan], ['JRA', checkJra]]) {
  test(`[${label}] 本線相手で1着・2着成立 → 的中（双方向）`, () => {
    assert.equal(check('5↔9.11.6.8.4', res(5, 9)), true);  // 軸1着・本線相手2着
    assert.equal(check('5↔9.11.6.8.4', res(9, 5)), true);  // 本線相手1着・軸2着
  });

  test(`[${label}] 抑え馬だけが絡む → 不的中`, () => {
    assert.equal(check('5↔9.11.6.8.4(抑え3.7)', res(5, 3)), false); // 3は抑えのみ
    assert.equal(check('5↔9.11.6.8.4(抑え3.7)', res(7, 5)), false); // 7は抑えのみ
  });

  test(`[${label}] 本線と抑えの両方に存在 → 本線として的中`, () => {
    assert.equal(check('5↔9.11(抑え9.7)', res(5, 9)), true); // 9は本線にも居る→的中
  });

  test(`[${label}] 抑え表記なし → 従来どおり`, () => {
    assert.equal(check('5↔9.11.6.8.4', res(5, 11)), true);
    assert.equal(check('5↔9.11.6.8.4', res(5, 2)), false); // 2は不在
  });

  test(`[${label}] 半角括弧対応`, () => {
    assert.equal(check('5-9.11(抑え3)', res(5, 3)), false);
    assert.equal(check('5-9.11(抑え3)', res(5, 9)), true);
  });

  test(`[${label}] 全角括弧対応`, () => {
    assert.equal(check('5↔9.11（抑え3）', res(5, 3)), false);
    assert.equal(check('5↔9.11（抑え3）', res(5, 9)), true);
  });

  test(`[${label}] dash / ↔ / ⇔ / → の各区切り記号対応`, () => {
    for (const sep of ['-', '↔', '⇔', '→']) {
      assert.equal(check(`5${sep}9.11`, res(5, 9)), true, `sep=${sep} axis1着`);
      assert.equal(check(`5${sep}9.11`, res(9, 5)), true, `sep=${sep} 相手1着`);
      assert.equal(check(`5${sep}9.11`, res(5, 2)), false, `sep=${sep} 不在`);
    }
  });

  test(`[${label}] 1着/2着欠落 → 不的中（防御）`, () => {
    assert.equal(check('5↔9.11', res(undefined, 9)), false);
    assert.equal(check('不正文字列', res(5, 9)), false);
  });
}

// ── recomputeEntry: 開催集計・投資額不変・限定フィールド ──
function loadNankanEntry(date) {
  const arch = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'data', 'archiveResults.json'), 'utf-8'));
  return arch.find((e) => (e.date || e.raceDate) === date);
}
function loadFirstJraEntry() {
  const arch = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'data', 'archiveResultsJra.json'), 'utf-8'));
  return arch.find((e) => (e.races || []).every((r) => r.bettingLines && r.bettingLines.length)); // 判定可能な開催
}

test('[南関] 2026-07-01 大井 R10 が本線のみ判定で不的中', () => {
  const entry = loadNankanEntry('2026-07-01');
  const { entry: after } = recomputeEntry(entry, checkNankan);
  const r10 = after.races.find((r) => String(r.raceNumber) === '10');
  assert.equal(r10.isHit, false, 'R10 (12-9) は本線では不的中');
  assert.deepEqual(r10.hitLines, []);
});

test('[南関] 2026-07-01 開催集計 = 10/12・払戻¥22,090・ROI≈368.2%', () => {
  const entry = loadNankanEntry('2026-07-01');
  const { entry: after, legacy } = recomputeEntry(entry, checkNankan);
  assert.equal(legacy, false);
  assert.equal(after.hitRaces, 10);
  assert.equal(after.missRaces, 2);
  assert.equal(after.totalPayout, 22090);
  assert.equal(after.returnRate, 368.2);
  assert.equal(after.recoveryRate, 368.2); // 集計式: totalPayout / betAmount * 100
});

test('[南関] 投資額5点固定は再計算で不変', () => {
  const entry = loadNankanEntry('2026-07-01');
  const { entry: after } = recomputeEntry(entry, checkNankan);
  assert.equal(after.betAmount, entry.betAmount);           // ¥6,000
  assert.equal(after.betPointsPerRace, entry.betPointsPerRace); // 5
  assert.equal(after.totalBetPoints, entry.totalBetPoints);
  assert.equal(after.totalInvestment, entry.totalInvestment);
  assert.equal(after.betAmount, after.totalRaces * 5 * 100);
});

test('[南関] 再計算は的中依存フィールドのみ変更し、着順・bettingLines・並び順は不変', () => {
  const entry = loadNankanEntry('2026-07-01');
  const { entry: after } = recomputeEntry(entry, checkNankan);
  // キー順序保持
  assert.deepEqual(Object.keys(after), Object.keys(entry));
  after.races.forEach((r, i) => {
    assert.deepEqual(Object.keys(r), Object.keys(entry.races[i]));       // race キー順序保持
    assert.deepEqual(r.bettingLines, entry.races[i].bettingLines);        // 買い目不変
    assert.deepEqual(r.result, entry.races[i].result);                    // 着順不変
    assert.deepEqual(r.umatan, entry.races[i].umatan);                    // 払戻元不変
    assert.equal(r.raceNumber, entry.races[i].raceNumber);                // レース番号不変
  });
});

test('[JRA] 判定可能開催の再計算で投資額5点固定・集計式が不変', () => {
  const entry = loadFirstJraEntry();
  const { entry: after, legacy } = recomputeEntry(entry, checkJra);
  assert.equal(legacy, false);
  assert.equal(after.betAmount, after.totalRaces * 5 * 100);
  assert.equal(after.recoveryRate, after.returnRate);
  assert.equal(after.returnRate, +(after.totalPayout / after.betAmount * 100).toFixed(1));
  assert.equal(after.missRaces, after.totalRaces - after.hitRaces);
});

test('[レガシー] 2026-04-10 川崎（bettingLines欠落）は据置・値不変', () => {
  const entry = loadNankanEntry('2026-04-10');
  const out = recomputeEntry(entry, checkNankan);
  assert.equal(out.legacy, true);
  assert.equal(out.changed, false);
  assert.equal(out.entry, entry); // 同一参照＝一切変更しない
});
