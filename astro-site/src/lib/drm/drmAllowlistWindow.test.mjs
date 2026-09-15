/**
 * drmAllowlistWindow.test.mjs — 窓を刻んだ確認の**合否の決め方**
 *   node --test src/lib/drm/drmAllowlistWindow.test.mjs
 *
 * ⚠️ ここで守るいちばん大事なこと:
 *    **窓ごとの人数を足して判定しない。** 同じ許可リスト対象は複数の窓で観測されるので、
 *    足した数には意味が無い。見るのは「固定した planner の集合の外へ出ていないか」だけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  digestRecordIds, assertPlannerStable, judgeWindow,
  emptyWindowRun, mergeWindowRun, finalizeWindowRun, WINDOW_FAIL,
} from './drmAllowlistWindow.js';

const IDS = ['recC', 'recA', 'recB'];

// ── 指紋（PII を出さない集合の同一性）──────────────────────────
test('【重要】指紋は並び順で変わらない（同じ集合なら同じ指紋）', () => {
  assert.equal(digestRecordIds(IDS), digestRecordIds(['recA', 'recB', 'recC']));
});

test('【重要】指紋に recordId そのものを含めない', () => {
  const d = digestRecordIds(IDS);
  assert.match(d, /^[0-9a-f]{64}$/);
  for (const id of IDS) assert.ok(!d.includes(id));
});

test('【重要】1 人でも違えば指紋が変わる（人数が同じでも見抜ける）', () => {
  const a = digestRecordIds(['recA', 'recB', 'recC']);
  const b = digestRecordIds(['recA', 'recB', 'recD']);
  assert.notEqual(a, b);
});

test('重複は 1 つに畳む / 空集合には指紋を作らない', () => {
  assert.equal(digestRecordIds(['recA', 'recA', 'recB']), digestRecordIds(['recA', 'recB']));
  assert.equal(digestRecordIds([]), null);
  assert.equal(digestRecordIds(null), null);
});

// ── planner の固定 ─────────────────────────────────────────────
test('【最重要】人数が同じでも中身が入れ替わったら通さない', () => {
  const expected = { count: 3, digest: digestRecordIds(['recA', 'recB', 'recC']) };
  const current = { count: 3, digest: digestRecordIds(['recA', 'recB', 'recZ']) };
  const r = assertPlannerStable({ expected, current });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WINDOW_FAIL.PLANNER_CHANGED);
});

test('1 窓目は比較相手が無いので基準になる', () => {
  const r = assertPlannerStable({ expected: null, current: { count: 3, digest: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(r.first, true);
});

// ── 1 窓の合否 ─────────────────────────────────────────────────
const okWindow = { plannerCount: 3, finalRecipients: 3, outsideAllowlist: 0, prospectInFinal: 0, prospectSkipped: null };

test('【最重要】許可リスト外が残っていたら不合格', () => {
  const v = judgeWindow({ ...okWindow, outsideAllowlist: 1 });
  assert.equal(v.ok, false);
  assert.ok(v.violations.includes(WINDOW_FAIL.OUTSIDE_ALLOWLIST));
});

test('【最重要】最終集合に prospect が残っていたら不合格', () => {
  const v = judgeWindow({ ...okWindow, prospectInFinal: 1 });
  assert.equal(v.ok, false);
  assert.ok(v.violations.includes(WINDOW_FAIL.PROSPECT_IN_FINAL));
});

test('【最重要】planner を超えたら不合格（事故時の姿）', () => {
  const v = judgeWindow({ ...okWindow, finalRecipients: 50 });
  assert.equal(v.ok, false);
  assert.ok(v.violations.includes(WINDOW_FAIL.OVER_PLANNER));
});

test('【最重要】prospect 索引が途中で変わったら不合格（読み飛ばしを合格にしない）', () => {
  const v = judgeWindow({ ...okWindow, prospectSkipped: WINDOW_FAIL.PROSPECT_INDEX_CHANGED });
  assert.equal(v.ok, false);
  assert.ok(v.violations.includes(WINDOW_FAIL.PROSPECT_INDEX_CHANGED));
});

test('人数が減るのは合格（安全判定で減るのは許容）', () => {
  assert.equal(judgeWindow({ ...okWindow, finalRecipients: 0 }).ok, true);
  assert.equal(judgeWindow({ ...okWindow, finalRecipients: 2 }).ok, true);
});

// ── 窓をまたいだ積み上げ ────────────────────────────────────────
const planner = { count: 3, digest: digestRecordIds(['recA', 'recB', 'recC']) };

test('【最重要】窓ごとの人数を足さない（同じ人が何度も観測される）', () => {
  let acc = emptyWindowRun();
  // 6 窓すべてで同じ 3 名が見えている。足したら 18 になるが、それは人数ではない
  for (let i = 0; i < 6; i += 1) {
    acc = mergeWindowRun(acc, {
      planner, finalRecipients: 3, verdict: judgeWindow(okWindow), done: i === 5,
    });
  }
  const out = finalizeWindowRun(acc);
  assert.equal(out.windows, 6);
  assert.equal(out.maxFinalInWindow, 3, '足していない（18 になっていない）');
  assert.equal(out.planner.count, 3);
  assert.equal(out.allowlistHolds, true);
});

test('【最重要】読み切っていなければ「効いている」と言わない', () => {
  let acc = emptyWindowRun();
  acc = mergeWindowRun(acc, { planner, finalRecipients: 3, verdict: judgeWindow(okWindow), done: false });
  const out = finalizeWindowRun(acc);
  assert.equal(out.complete, false);
  assert.equal(out.allowlistHolds, false);
  assert.match(out.note, /まだ読み切っていません/);
});

test('【最重要】途中で planner が変わったら積み上げごと不合格', () => {
  let acc = emptyWindowRun();
  acc = mergeWindowRun(acc, { planner, finalRecipients: 3, verdict: judgeWindow(okWindow), done: false });
  acc = mergeWindowRun(acc, {
    planner: { count: 3, digest: digestRecordIds(['recA', 'recB', 'recZ']) },
    finalRecipients: 3, verdict: judgeWindow(okWindow), done: true,
  });
  const out = finalizeWindowRun(acc);
  assert.ok(out.violations.includes(WINDOW_FAIL.PLANNER_CHANGED));
  assert.equal(out.allowlistHolds, false);
});

test('1 窓でも外へ出ていたら、他が全部きれいでも不合格', () => {
  let acc = emptyWindowRun();
  acc = mergeWindowRun(acc, { planner, finalRecipients: 3, verdict: judgeWindow(okWindow), done: false });
  acc = mergeWindowRun(acc, {
    planner, finalRecipients: 4,
    verdict: judgeWindow({ ...okWindow, outsideAllowlist: 1, finalRecipients: 4 }), done: true,
  });
  const out = finalizeWindowRun(acc);
  assert.equal(out.allowlistHolds, false);
  assert.ok(out.violations.includes(WINDOW_FAIL.OUTSIDE_ALLOWLIST));
});
