/**
 * marketingConsoleFlow.test.mjs — 管理画面の操作順を強制する判定
 *
 * 「確認せずに送れる」「対象を変えたのに古い確認結果で送れる」を**構造として**塞ぐ。
 * 画面の見た目ではなく、押せる／押せないの根拠をここで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP, BLOCK, BLOCK_LABEL,
  computeSelectionFingerprint, isDryRunStale, resolveStep,
  canDryRun, canEnqueue, canDispatchCheck, canDispatchSend,
  groupCampaigns, buildSendConfirmation, resolveJobBadge,
  summarizeFilters, summarizeExclusions,
} from './marketingConsoleFlow.js';

const campaign = { campaignId: 'expired-comeback', version: 2, name: '期限切れカムバック' };
const base = (over = {}) => ({
  loadedCount: 10,
  selectedIds: ['recA', 'recB'],
  filters: { contract: 'expired', plan: 'all' },
  campaignId: 'expired-comeback',
  campaignVersion: 2,
  campaign,
  sendEnabled: true,
  dispatchEnabled: true,
  ...over,
});
const freshDryRun = (state, willSend = 2) => ({
  fingerprint: computeSelectionFingerprint(state),
  selected: state.selectedIds.length,
  excluded: 0,
  willSend,
});

// ── 順序の強制 ──────────────────────────────────────────────
test('dry-run 前は送れない（キュー登録できない）', () => {
  const s = base({ dryRun: null });
  assert.deepEqual(canEnqueue(s), { allowed: false, reason: BLOCK.NO_DRY_RUN });
});

test('顧客 0 名では dry-run もキュー登録もできない', () => {
  const s = base({ selectedIds: [] });
  assert.equal(canDryRun(s).reason, BLOCK.NO_SELECTION);
  assert.equal(canEnqueue(s).reason, BLOCK.NO_SELECTION);
});

test('キャンペーン未選択では dry-run できない', () => {
  const s = base({ campaignId: '' });
  assert.equal(canDryRun(s).reason, BLOCK.NO_CAMPAIGN);
});

test('dry-run の送信対象が 0 名ならキュー登録できない', () => {
  const s = base();
  s.dryRun = freshDryRun(s, 0);
  assert.equal(canEnqueue(s).reason, BLOCK.NO_RECIPIENTS);
});

test('確認が最新ならキュー登録できる', () => {
  const s = base();
  s.dryRun = freshDryRun(s);
  assert.deepEqual(canEnqueue(s), { allowed: true, reason: null });
});

// ── 確認結果の失効 ──────────────────────────────────────────
test('顧客の選択を変えると dry-run 結果が失効する', () => {
  const s = base();
  s.dryRun = freshDryRun(s);
  const changed = { ...s, selectedIds: ['recA', 'recB', 'recC'] };
  assert.equal(isDryRunStale({ dryRun: s.dryRun, current: changed }), true);
  assert.equal(canEnqueue(changed).reason, BLOCK.DRY_RUN_STALE);
});

test('フィルターを変えると dry-run 結果が失効する', () => {
  const s = base();
  s.dryRun = freshDryRun(s);
  const changed = { ...s, filters: { contract: 'active', plan: 'all' } };
  assert.equal(canEnqueue(changed).reason, BLOCK.DRY_RUN_STALE);
});

test('キャンペーンを変えると dry-run 結果が失効する', () => {
  const s = base();
  s.dryRun = freshDryRun(s);
  const changed = { ...s, campaignId: 'premium-renewal' };
  assert.equal(canEnqueue(changed).reason, BLOCK.DRY_RUN_STALE);
});

test('version を上げても失効する（本文差し替え後の取り違え防止）', () => {
  const s = base();
  s.dryRun = freshDryRun(s);
  assert.equal(isDryRunStale({ dryRun: s.dryRun, current: { ...s, campaignVersion: 3 } }), true);
});

test('選択の順序が違うだけなら失効しない（並び替えで再確認させない）', () => {
  const s = base();
  s.dryRun = freshDryRun(s);
  assert.equal(isDryRunStale({ dryRun: s.dryRun, current: { ...s, selectedIds: ['recB', 'recA'] } }), false);
});

// ── gate ────────────────────────────────────────────────────
test('キュー登録 gate が閉じていれば登録できない', () => {
  const s = base({ sendEnabled: false });
  s.dryRun = freshDryRun(s);
  assert.equal(canEnqueue(s).reason, BLOCK.GATE_ENQUEUE_CLOSED);
});

test('実配信 gate が閉じていれば送れない（キュー登録まではできる）', () => {
  const s = base({ dispatchEnabled: false, enqueued: true, dispatch: { check: { willSend: 1 } } });
  s.dryRun = freshDryRun(s);
  assert.equal(canEnqueue(s).allowed, true);
  assert.equal(canDispatchSend(s).reason, BLOCK.GATE_DISPATCH_CLOSED);
});

// ── キュー登録 → 送信直前確認 → 送信 ────────────────────────
test('キュー登録前は送信直前の確認も実送信もできない', () => {
  const s = base({ enqueued: false });
  assert.equal(canDispatchCheck(s).reason, BLOCK.NOT_ENQUEUED);
  assert.equal(canDispatchSend(s).reason, BLOCK.NOT_ENQUEUED);
});

test('送信直前の確認をしていなければ実送信できない', () => {
  const s = base({ enqueued: true, dispatch: {} });
  assert.equal(canDispatchSend(s).reason, BLOCK.NO_DISPATCH_CHECK);
});

test('確認で送信対象 0 通なら実送信できない', () => {
  const s = base({ enqueued: true, dispatch: { check: { willSend: 0 } } });
  assert.equal(canDispatchSend(s).reason, BLOCK.NO_RECIPIENTS);
});

test('確認済み・対象ありなら実送信できる', () => {
  const s = base({ enqueued: true, dispatch: { check: { willSend: 3 } } });
  assert.deepEqual(canDispatchSend(s), { allowed: true, reason: null });
});

test('実行中はどの操作も押せない（二重クリックで二重送信しない）', () => {
  const s = base({ busy: true, enqueued: true, dispatch: { check: { willSend: 1 } } });
  s.dryRun = freshDryRun(s);
  for (const fn of [canDryRun, canEnqueue, canDispatchCheck, canDispatchSend]) {
    assert.equal(fn(s).reason, BLOCK.BUSY);
  }
});

// ── 現在地 ──────────────────────────────────────────────────
test('現在地は状態から決まる', () => {
  assert.equal(resolveStep({ loadedCount: 0, selectedIds: [] }), STEP.FILTER);
  assert.equal(resolveStep({ loadedCount: 5, selectedIds: [] }), STEP.SELECT);
  assert.equal(resolveStep({ loadedCount: 5, selectedIds: ['a'] }), STEP.CAMPAIGN);
  assert.equal(resolveStep(base({ dryRun: null })), STEP.DRY_RUN);
  const s = base();
  s.dryRun = freshDryRun(s);
  assert.equal(resolveStep(s), STEP.SEND);
  assert.equal(resolveStep({ ...s, dispatch: { sent: true } }), STEP.RESULT);
});

// ── キャンペーンの分離 ──────────────────────────────────────
test('運用テスト専用キャンペーンを通常一覧に混ぜない', () => {
  const { normal, testOnly } = groupCampaigns([
    campaign,
    { campaignId: 'marketing-canary', version: 2, testOnly: true },
    { campaignId: 'premium-renewal', version: 2 },
  ]);
  assert.deepEqual(normal.map((c) => c.campaignId), ['expired-comeback', 'premium-renewal']);
  assert.deepEqual(testOnly.map((c) => c.campaignId), ['marketing-canary']);
});

test('testOnly キャンペーンは最終確認で「テスト受信者のみ」と明示する', () => {
  const conf = buildSendConfirmation({
    campaign: { campaignId: 'marketing-canary', version: 2, testOnly: true, name: 'カナリア' },
    dryRun: { selected: 1, excluded: 0, willSend: 1 },
    dispatchCheck: { willSend: 1 },
    sendEnabled: true, dispatchEnabled: true, operationId: 'op-1',
  });
  assert.equal(conf.testOnly, true);
  assert.match(conf.audience, /テスト受信者/);
  assert.equal(conf.audience.includes('一般顧客'), false);
});

// ── 最終確認の内容 ──────────────────────────────────────────
test('最終確認には人数・gate・取消可否・二重送信防止・実メールが届くことを必ず含める', () => {
  const conf = buildSendConfirmation({
    campaign, dryRun: { selected: 10, excluded: 3, willSend: 7 },
    dispatchCheck: { willSend: 7 }, sendEnabled: true, dispatchEnabled: true, operationId: 'op-9',
  });
  assert.equal(conf.campaignName, '期限切れカムバック');
  assert.equal(conf.version, '2');
  assert.equal(conf.selected, 10);
  assert.equal(conf.excluded, 3);
  assert.equal(conf.willSend, 7);
  assert.deepEqual(conf.gate, { enqueue: true, dispatch: true });
  assert.equal(conf.audience, '一般顧客');
  assert.match(conf.cancelable, /PENDING/);
  assert.match(conf.afterSend, /取り消せません/);
  assert.match(conf.duplicateGuard, /DeliveryKey/);
  assert.match(conf.effect, /実際にメールが届きます/);
  assert.match(conf.effect, /delivered/, '受理と実配信の違いを説明していない');
  assert.equal(conf.operationId, 'op-9');
});

// ── 送信状況のバッジ ────────────────────────────────────────
test('部分失敗を「送信済み」と読ませない', () => {
  assert.equal(resolveJobBadge({ status: 'SENT', counts: { sent: 5, failed: 2 } }).key, 'PARTIAL');
  assert.equal(resolveJobBadge({ status: 'SENT', counts: { sent: 5, failed: 0 } }).key, 'SENT');
  assert.equal(resolveJobBadge({ status: 'PENDING', counts: {} }).key, 'PENDING');
  assert.equal(resolveJobBadge({ status: 'CANCELLED', counts: {} }).key, 'CANCELLED');
  assert.equal(resolveJobBadge({ status: 'なにか', counts: {} }).key, 'PENDING');
});

// ── 画面に出す集計 ──────────────────────────────────────────
test('適用中フィルターの数を数える（既定値は数えない）', () => {
  const s = summarizeFilters({ contract: 'expired', plan: 'all', q: '' }, { contract: 'all', plan: 'all', q: '' });
  assert.equal(s.count, 1);
  assert.deepEqual(s.applied, [{ key: 'contract', value: 'expired' }]);
});

test('除外理由は件数の多い順（失敗理由とは別集計）', () => {
  const rows = summarizeExclusions([
    { reason: 'already_delivered', count: 2 },
    { reason: 'unsubscribed', count: 5 },
    { reason: 'zero', count: 0 },
  ]);
  assert.deepEqual(rows, [{ reason: 'unsubscribed', count: 5 }, { reason: 'already_delivered', count: 2 }]);
});

test('理由コードには必ず「何をすべきか」の文言がある', () => {
  for (const code of Object.values(BLOCK)) {
    assert.equal(typeof BLOCK_LABEL[code], 'string', `${code} の文言が無い`);
    assert.ok(BLOCK_LABEL[code].length > 5);
  }
});
