/**
 * prospectVerification.test.mjs — **最終判定は missing=0 のときだけ通る**
 *   node --test src/lib/marketing/prospectVerification.test.mjs
 *
 * 守る条件:
 *   1. 走査中は `missing > 0` でも続けてよい（窓は `scanned` で進むのでずれない）
 *   2. **最終判定は `missing` 合計 > 0 なら必ず不許可**（fail closed）
 *   3. 「わからない」を「消してよい」に倒さない（既定は必ず不許可）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildProspectVerificationVerdict, describeVerdict, VERIFY_FAIL,
} from './prospectVerification.js';

const DIGEST = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** 索引 `total` 件を `limit` 刻みで、`missingAt`（offset→件数）だけ値が欠けた走査結果 */
function walkWindows(total, limit, missingAt = {}) {
  const out = [];
  for (let offset = 0; offset < total; offset += limit) {
    const scanned = Math.min(limit, total - offset);
    const missing = missingAt[offset] || 0;
    out.push({
      offset, scanned, missing, returned: scanned - missing,
      indexSize: total, digest: DIGEST, ok: true,
    });
  }
  return out;
}

/* ── 1. 通るのは missing=0 のときだけ ───────────────────────────── */

test('【要件】11,976 件を欠けなく読み切ったときだけ最終検証 PASS', () => {
  const v = buildProspectVerificationVerdict({ windows: walkWindows(11976, 2000) });
  assert.equal(v.walk.ok, true);
  assert.equal(v.customersDeletionAllowed, true, '欠けが無いのに不許可になっている');
  assert.deepEqual(v.reasons, []);
  assert.equal(v.totals.indexSize, 11976);
  assert.equal(v.totals.scanned, 11976);
  assert.equal(v.totals.returned, 11976);
  assert.equal(v.totals.missing, 0);
  assert.match(describeVerdict(v), /^✅/);
});

test('⚠️【要件】missing が 1 件でもあれば Customers 削除可能判定を出さない', () => {
  const v = buildProspectVerificationVerdict({ windows: walkWindows(11976, 2000, { 4000: 1 }) });
  assert.equal(v.customersDeletionAllowed, false,
    '⚠️ 値を読めない人が居るのに「消してよい」と判定している');
  assert.ok(v.reasons.includes(VERIFY_FAIL.VALUE_MISSING));
  assert.equal(v.totals.missing, 1);
  assert.match(describeVerdict(v), /^✖/);
  assert.doesNotMatch(describeVerdict(v), /削除の前提を満たす/);
});

test('⚠️【要件】走査自体は missing > 0 でも最後まで成立する（止めない）', () => {
  const v = buildProspectVerificationVerdict({
    windows: walkWindows(11976, 2000, { 0: 7, 2000: 3, 10000: 11 }),
  });
  // 走査は筋が通っている（窓は scanned で進むので位置はずれない）
  assert.equal(v.walk.ok, true, '⚠️ 欠けを理由に走査ごと失敗にしている（続行してよい）');
  assert.equal(v.totals.scanned, 11976, '索引は最後まで走査している');
  assert.equal(v.totals.missing, 21);
  assert.equal(v.totals.returned, 11955);
  // それでも最終判定は通さない
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.VALUE_MISSING));
});

test('⚠️ missing が 何件であっても許可は出ない（1..500 を総当たり）', () => {
  for (let m = 1; m <= 500; m += 1) {
    const v = buildProspectVerificationVerdict({ windows: walkWindows(11976, 2000, { 6000: m }) });
    assert.equal(v.customersDeletionAllowed, false, `missing=${m} で許可が出た`);
  }
});

/* ── 2. 「わからない」は必ず不許可（fail closed）─────────────────── */

test('⚠️ 走査していなければ不許可', () => {
  for (const windows of [undefined, null, [], 'x', 123]) {
    const v = buildProspectVerificationVerdict({ windows });
    assert.equal(v.customersDeletionAllowed, false);
    assert.equal(v.walk.ok, false);
  }
  assert.ok(buildProspectVerificationVerdict({}).reasons.includes(VERIFY_FAIL.NO_WINDOWS));
});

test('⚠️ 引数そのものが無くても不許可（例外にしない）', () => {
  const v = buildProspectVerificationVerdict();
  assert.equal(v.customersDeletionAllowed, false);
});

test('⚠️ 最後まで走査していなければ不許可（途中で止めた）', () => {
  const v = buildProspectVerificationVerdict({ windows: walkWindows(11976, 2000).slice(0, 3) });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.COVERAGE_INCOMPLETE));
});

test('⚠️ 窓が飛んでいれば不許可（読み落としの疑い）', () => {
  const windows = walkWindows(6000, 2000);
  windows[1].offset = 2001;                      // 1 件飛ばした
  const v = buildProspectVerificationVerdict({ windows });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.WINDOW_NOT_CONTIGUOUS));
});

test('⚠️ 窓が重なっていれば不許可（二重読みの疑い）', () => {
  const windows = walkWindows(6000, 2000);
  windows[2].offset = 3500;                      // 前の窓と重なる
  const v = buildProspectVerificationVerdict({ windows });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.WINDOW_NOT_CONTIGUOUS));
});

test('⚠️ 指紋が窓ごとに違えば不許可（途中で集合が変わった）', () => {
  const windows = walkWindows(6000, 2000);
  windows[1].digest = 'ffffffffffffffffffffffffffffffff';
  const v = buildProspectVerificationVerdict({ windows });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.DIGEST_MISMATCH));
});

test('⚠️ 索引の件数が窓ごとに違えば不許可', () => {
  const windows = walkWindows(6000, 2000);
  windows[2].indexSize = 6001;
  const v = buildProspectVerificationVerdict({ windows });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.INDEX_SIZE_MISMATCH));
});

test('⚠️ 期待した索引件数と違えば不許可', () => {
  const v = buildProspectVerificationVerdict({
    windows: walkWindows(11970, 2000), expectIndexSize: 11976,
  });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.INDEX_SIZE_MISMATCH));
});

test('⚠️ 失敗した窓が混ざっていれば不許可', () => {
  const windows = walkWindows(6000, 2000);
  windows[1].ok = false;
  const v = buildProspectVerificationVerdict({ windows });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.WINDOW_FAILED));
});

test('⚠️ 数え方の辻褄が合わなければ不許可（scanned - missing ≠ returned）', () => {
  const windows = walkWindows(6000, 2000);
  windows[0].returned = 2000; windows[0].missing = 5;    // 合わない
  const v = buildProspectVerificationVerdict({ windows });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.COUNT_INCONSISTENT));
});

test('⚠️ 壊れた値（負数・NaN・欠落）でも例外にせず不許可', () => {
  for (const bad of [
    { offset: -1 }, { scanned: NaN }, { returned: undefined },
    { missing: -3 }, { indexSize: null }, { digest: '' }, { scanned: 'x' },
  ]) {
    const w = { offset: 0, scanned: 10, returned: 10, missing: 0, indexSize: 10, digest: DIGEST, ...bad };
    const v = buildProspectVerificationVerdict({ windows: [w] });
    assert.equal(v.customersDeletionAllowed, false, `${JSON.stringify(bad)} で許可が出た`);
  }
});

test('索引が 0 件なら不許可（何も確かめていない）', () => {
  const v = buildProspectVerificationVerdict({
    windows: [{ offset: 0, scanned: 0, returned: 0, missing: 0, indexSize: 0, digest: DIGEST, ok: true }],
  });
  assert.equal(v.customersDeletionAllowed, false);
  assert.ok(v.reasons.includes(VERIFY_FAIL.COVERAGE_INCOMPLETE));
});

/* ── 3. 総当たり: missing>0 で許可が出る組み合わせは存在しない ───── */

test('⚠️【要件】missing > 0 で許可が出る組み合わせは 1 つも無い（総当たり）', () => {
  const rnd = (() => { let x = 987654321; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; })();
  let allowedWithMissing = 0;
  for (let i = 0; i < 3000; i += 1) {
    const total = 1 + Math.floor(rnd() * 5000);
    const limit = 1 + Math.floor(rnd() * 900);
    const at = Math.floor(rnd() * total / limit) * limit;
    const windows = walkWindows(total, limit, { [at]: 1 + Math.floor(rnd() * 20) });
    const v = buildProspectVerificationVerdict({ windows });
    if (v.totals.missing > 0 && v.customersDeletionAllowed) allowedWithMissing += 1;
  }
  assert.equal(allowedWithMissing, 0, '⚠️ missing があるのに許可が出た組み合わせがある');
});

/* ── 4. guard: 走査スクリプトが判定を通している ─────────────────── */

const verifySrc = readFileSync(fileURLToPath(
  new URL('../../../scripts/verify-prospect-migration.mjs', import.meta.url),
), 'utf8');

test('⚠️ guard: 最終検証スクリプトは単一源の判定を通し、不許可なら非ゼロで落ちる', () => {
  assert.match(verifySrc, /buildProspectVerificationVerdict/,
    '⚠️ 判定を通していない（合算を眺めるだけでは最終検証にならない）');
  assert.match(verifySrc, /customersDeletionAllowed/);
  assert.match(verifySrc, /process\.exit\(1\)/, '不許可でも成功終了している');
  assert.match(verifySrc, /missing/, 'missing を集計していない');
});

test('⚠️ guard: 走査中は missing を理由に中断していない（最後まで読む）', () => {
  assert.doesNotMatch(verifySrc, /missing[^\n]*\)\s*\{[^}]*break/,
    '⚠️ missing を見つけた時点で走査を打ち切っている（全体の欠け件数が分からなくなる）');
});
