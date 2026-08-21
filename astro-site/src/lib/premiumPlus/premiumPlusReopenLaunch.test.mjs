/**
 * premiumPlusReopenLaunch.test.mjs — 「販売再開 ＋ 再募集開始」を 1 操作にした判断を固定する
 *
 * 固定する仕様（2026-08-22 MK 仕様変更）:
 *   - 未開始 + 販売停止中 → **1 操作**で「開始日時の確定」と「販売の再開」を両方やる
 *   - 前提（read / gate）が 1 つでも欠けたら **何も書かない**（開始だけ確定させない）
 *   - 「途中成功」と「開始後の緊急停止」を**停止時刻で**取り違えない
 *   - 緊急停止は**この操作では解除しない**（明示的な「販売を再開する」を使わせる）
 *   - 状態ごとに admin の**主操作は 1 つだけ**（「販売を再開する」と並べない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAUNCH_STATE,
  LAUNCH_REJECT,
  classifyLaunch,
  planReopenLaunch,
  describeLaunchAction,
  buildLaunchConfirmText,
  computeReopenLockId,
  computeReopenOperationId,
} from './premiumPlusReopenLaunch.js';
import { PP_SALE_PAUSE_FIELDS } from './premiumPlusRelease.js';

const REC = 'recAAAAAAAAAAAAAA';
const OTHER = 'recBBBBBBBBBBBBBB';
const START = '2026-09-01T03:00:00.000Z';
const BEFORE = '2026-08-19T00:00:00.000Z';   // 開始より前に止めた（＝途中成功）
const AFTER = '2026-09-02T00:00:00.000Z';    // 開始より後に止めた（＝緊急停止）

const READY = { plusFieldsReady: true, salePauseWritable: true };
const notStarted = { available: true, startsAtIso: null };
const started = { available: true, startsAtIso: START };
const paused = (at) => ({
  [PP_SALE_PAUSE_FIELDS.PAUSED]: true,
  ...(at ? { [PP_SALE_PAUSE_FIELDS.UPDATED_AT]: at } : {}),
});
const plan = (reopen, fields, over = {}) => planReopenLaunch({
  reopen, fields, recordId: REC, ...READY, ...over,
});

// ── 1 操作で両方やる ────────────────────────────────────────
test('未開始 + 販売停止中 → 1 操作で「販売再開」と「開始日時の確定」を両方行う', () => {
  const p = plan(notStarted, paused(BEFORE));
  assert.equal(p.ok, true);
  assert.equal(p.writeStart, true);
  assert.equal(p.resumeSale, true);
  assert.equal(p.noop, false);
  assert.equal(p.state, LAUNCH_STATE.NOT_STARTED);
});

test('未開始 + 販売中 → 開始だけ（販売状態は触らない）', () => {
  const p = plan(notStarted, {});
  assert.equal(p.ok, true);
  assert.equal(p.writeStart, true);
  assert.equal(p.resumeSale, false, '不要な PATCH をしない');
});

test('開始済み + 販売中 → 何も書かない（冪等な成功）', () => {
  const p = plan(started, {});
  assert.equal(p.ok, true);
  assert.equal(p.writeStart, false, '開始日時を書き直さない');
  assert.equal(p.resumeSale, false, '不要な PATCH をしない');
  assert.equal(p.noop, true);
  assert.equal(p.alreadyStarted, true);
});

// ── 前提が欠けたら何も書かない ─────────────────────────────
test('開始状態を読めないときは何も書かない（fail closed）', () => {
  const p = plan({ available: false, reason: 'read_failed' }, {});
  assert.equal(p.ok, false);
  assert.equal(p.reason, LAUNCH_REJECT.UNAVAILABLE);
  assert.equal(p.state, LAUNCH_STATE.UNKNOWN);
  assert.match(p.message, /何も変更していません/);
});

test('販売停止を解除できない環境では**開始日時も書かない**（片側状態を作らない）', () => {
  const p = plan(notStarted, paused(BEFORE), { salePauseWritable: false });
  assert.equal(p.ok, false);
  assert.equal(p.reason, LAUNCH_REJECT.SALE_PAUSE_NOT_READY);
  // 販売中の会員なら解除は不要なので実行できる
  assert.equal(plan(notStarted, {}, { salePauseWritable: false }).ok, true);
});

test('Plus フィールドが未有効なら実行しない', () => {
  const p = plan(notStarted, {}, { plusFieldsReady: false });
  assert.equal(p.ok, false);
  assert.equal(p.reason, LAUNCH_REJECT.FIELDS_NOT_READY);
});

test('会員の指定が不正なら実行しない', () => {
  for (const bad of ['', 'nope', 'recSHORT', null, undefined]) {
    const p = planReopenLaunch({ reopen: notStarted, fields: {}, recordId: bad, ...READY });
    assert.equal(p.ok, false, String(bad));
    assert.equal(p.reason, LAUNCH_REJECT.INVALID_MEMBER, String(bad));
  }
});

// ── 途中成功 と 緊急停止 を取り違えない（この設計の要）──────────
test('停止が開始より前 → 途中成功（販売再開だけをやり直す）', () => {
  const v = classifyLaunch({ reopen: started, fields: paused(BEFORE) });
  assert.equal(v.state, LAUNCH_STATE.INCOMPLETE);
  assert.equal(v.needsRepair, true);
  assert.equal(v.deliberatePause, false);

  const p = plan(started, paused(BEFORE));
  assert.equal(p.ok, true);
  assert.equal(p.writeStart, false, '開始日時は書き直さない');
  assert.equal(p.resumeSale, true, '販売だけ再開する');
});

test('停止が開始より後 → 緊急停止（この操作では解除しない）', () => {
  const v = classifyLaunch({ reopen: started, fields: paused(AFTER) });
  assert.equal(v.state, LAUNCH_STATE.PAUSED_AFTER_START);
  assert.equal(v.deliberatePause, true);
  assert.equal(v.needsRepair, false);

  const p = plan(started, paused(AFTER));
  assert.equal(p.ok, false);
  assert.equal(p.reason, LAUNCH_REJECT.DELIBERATELY_PAUSED);
  assert.match(p.message, /勝手に解除しない/);
});

test('停止時刻が分からないときは緊急停止として扱う（安全側・自動再開しない）', () => {
  const v = classifyLaunch({ reopen: started, fields: paused(null) });
  assert.equal(v.state, LAUNCH_STATE.PAUSED_AFTER_START);
  assert.equal(v.pauseAnchorKnown, false);
  assert.match(v.note, /判別できません/);
  assert.equal(plan(started, paused(null)).ok, false);
});

// ── 開始後に停止 → 再度販売可能に戻しても開始日時は変わらない ─────
test('開始済み会員を後から停止しても、開始日時と期限の根拠は変わらない', () => {
  const afterPause = classifyLaunch({ reopen: started, fields: paused(AFTER) });
  assert.equal(afterPause.startsAtIso, START, '開始日時は保持される');
  // 再開後も同じ（開始日時は販売状態と独立）
  const resumed = classifyLaunch({ reopen: started, fields: {} });
  assert.equal(resumed.startsAtIso, START);
  assert.equal(resumed.state, LAUNCH_STATE.LIVE);
});

// ── admin の主操作は 1 つだけ ───────────────────────────────
test('未開始 + 停止中: 主操作は「再募集を開始」だけ（販売再開ボタンを並べない）', () => {
  const v = classifyLaunch({ reopen: notStarted, fields: paused(BEFORE) });
  const a = describeLaunchAction({ view: v, memberLabel: 'x@example.invalid', salePauseWritable: true });
  assert.equal(a.kind, 'start');
  assert.equal(a.enabled, true);
  assert.equal(a.showResumeSwitch, false, '「販売を再開する」を並べない');
  assert.equal(a.showPauseSwitch, false, '停止スイッチも出さない（停止中なので）');
  assert.match(a.confirmText, /販売一時停止を解除/);
  assert.match(a.confirmText, /x@example\.invalid/);
});

test('未開始 + 販売中: 主操作は開始。安全スイッチ（停止）だけ併存', () => {
  const v = classifyLaunch({ reopen: notStarted, fields: {} });
  const a = describeLaunchAction({ view: v, salePauseWritable: true });
  assert.equal(a.kind, 'start');
  assert.equal(a.showPauseSwitch, true);
  assert.equal(a.showResumeSwitch, false);
  assert.match(a.confirmText, /販売は既に停止していません/);
});

test('開始済み + 販売中: 主操作なし。安全スイッチ（停止）だけ', () => {
  const a = describeLaunchAction({ view: classifyLaunch({ reopen: started, fields: {} }), salePauseWritable: true });
  assert.equal(a.kind, 'none');
  assert.equal(a.showPauseSwitch, true);
  assert.equal(a.showResumeSwitch, false);
});

test('開始済み + 緊急停止: 「販売を再開する」だけ（再募集の開始は出さない）', () => {
  const a = describeLaunchAction({ view: classifyLaunch({ reopen: started, fields: paused(AFTER) }), salePauseWritable: true });
  assert.equal(a.kind, 'none');
  assert.equal(a.showResumeSwitch, true);
  assert.equal(a.showPauseSwitch, false);
});

test('途中成功: 「販売再開をやり直す」だけ（開始日時は変わらないと明示）', () => {
  const a = describeLaunchAction({ view: classifyLaunch({ reopen: started, fields: paused(BEFORE) }), salePauseWritable: true });
  assert.equal(a.kind, 'repair');
  assert.equal(a.showPauseSwitch, false);
  assert.equal(a.showResumeSwitch, false);
  assert.match(a.confirmText, /開始日時と有効期限は\*\*変わりません\*\*|開始日時/);
});

test('確認できない: 操作を 1 つも出さない', () => {
  const a = describeLaunchAction({
    view: classifyLaunch({ reopen: { available: false, reason: 'timeout' }, fields: {} }),
    salePauseWritable: true,
  });
  assert.equal(a.kind, 'none');
  assert.equal(a.showPauseSwitch, false);
  assert.equal(a.showResumeSwitch, false);
});

test('販売停止が本番で使えない環境では停止・再開スイッチを出さない', () => {
  for (const view of [
    classifyLaunch({ reopen: started, fields: {} }),
    classifyLaunch({ reopen: started, fields: paused(AFTER) }),
  ]) {
    const a = describeLaunchAction({ view, salePauseWritable: false });
    assert.equal(a.showPauseSwitch, false);
    assert.equal(a.showResumeSwitch, false);
  }
});

// ── 冪等キー・排他キー ──────────────────────────────────────
test('排他キー・操作 ID は会員ごとに一意で、再送しても同じ（時刻を材料にしない）', () => {
  assert.equal(computeReopenLockId(REC), computeReopenLockId(REC));
  assert.notEqual(computeReopenLockId(REC), computeReopenLockId(OTHER));
  assert.match(computeReopenLockId(REC), /^[0-9a-f]{32}$/);
  assert.equal(computeReopenOperationId(REC), computeReopenOperationId(REC));
  assert.notEqual(computeReopenOperationId(REC), computeReopenOperationId(OTHER));
  // 不正な会員では作らない
  assert.equal(computeReopenLockId('nope'), null);
  assert.equal(computeReopenOperationId(''), null);
  // クーポン実体の lock と衝突しない鍵空間
  assert.notEqual(computeReopenLockId(REC), computeReopenOperationId(REC));
});

test('確認文言は対象会員と「同時に何が起きるか」を必ず含む', () => {
  const t = buildLaunchConfirmText({ memberLabel: 'daniel@example.invalid', resumeSale: true });
  assert.match(t, /daniel@example\.invalid/);
  assert.match(t, /販売一時停止を解除/);
  assert.match(t, /サーバー時刻/);
  assert.match(t, /14日間/);
  assert.match(t, /変更・取り消しできません/);
  assert.match(t, /他の会員には影響しません/);
  assert.match(t, /販売資格・段階公開・会員権・決済は変更しません/);
  // 復旧のときは「開始日時は変わらない」ことを言う
  assert.match(buildLaunchConfirmText({ memberLabel: 'x', repair: true }), /変わりません/);
});

// ── 他会員に影響しない（判定は 1 レコードだけを見る）─────────────
test('判定は渡された 1 会員ぶんだけを見る（入力を書き換えない）', () => {
  const fields = paused(BEFORE);
  const snapshot = JSON.stringify(fields);
  classifyLaunch({ reopen: started, fields });
  plan(started, fields);
  describeLaunchAction({ view: classifyLaunch({ reopen: started, fields }), salePauseWritable: true });
  assert.equal(JSON.stringify(fields), snapshot);
});
