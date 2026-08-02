/**
 * marketingConsoleState.test.mjs — 管理画面の状態遷移
 *
 * 2026-08-02 に**「送信対象を確認（dry-run）」が押せない**不具合が本番で起きた。
 * 原因は「選択欄へプログラムから入れたキャンペーンを状態へ反映していなかった」こと。
 * 画面配線に判定を埋め込むと実行するまで分からないので、ここで DOM なしに固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRY_STATE, PAGE_SIZES,
  initialState, applyCampaigns, selectCampaign, applyCustomers, applySelection,
  applyFilters, applyPaging, startDryRun, dryRunSucceeded, dryRunFailed,
  hasUsableDryRun, buttonState, paginate, summarizeRows, selectVisible, maskEmail,
} from './marketingConsoleState.js';

const campaigns = [
  { campaignId: 'stopped', version: 1, name: '停止中', usable: false },
  { campaignId: 'expired-comeback', version: 2, name: 'カムバック', usable: true },
];
const rows = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => ({
  recordId: 'rec' + String(i).padStart(14, '0'),
  email: `user${i}@example.com`,
  sendable: true,
  ...over(i),
}));

// ── 今回の不具合 ────────────────────────────────────────────
test('キャンペーンを自動選択したら、状態にも必ず入る（dry-run が押せなくなる不具合の再発防止）', () => {
  const s = applyCampaigns(initialState(), { campaigns, sendEnabled: true, dispatchEnabled: true });
  assert.equal(s.campaignId, 'expired-comeback', '使用可能な先頭が状態へ入っていない');
  assert.equal(s.campaign.name, 'カムバック');
  // 顧客を選べば dry-run が押せる（キャンペーン未選択で無効化され続けない）
  const withSel = applySelection(applyCustomers(s, { rows: rows(3) }), ['rec00000000000000']);
  assert.equal(buttonState(withSel).dryRun.disabled, false, 'dry-run が押せないままになっている');
});

test('使用可能なキャンペーンが 1 つも無ければ選択しない（押せない理由も出す）', () => {
  const s = applyCampaigns(initialState(), { campaigns: [campaigns[0]] });
  assert.equal(s.campaignId, '');
  const b = buttonState(applySelection(applyCustomers(s, { rows: rows(1) }), ['rec00000000000000']));
  assert.equal(b.dryRun.disabled, true);
  assert.match(b.dryRun.reason, /キャンペーンを選択/);
});

test('顧客 0 名 / 実行中は押せない（理由つき）', () => {
  const s = applyCampaigns(initialState(), { campaigns });
  assert.match(buttonState(s).dryRun.reason, /顧客を 1 名以上/);
  const busy = { ...applySelection(applyCustomers(s, { rows: rows(2) }), ['rec00000000000000']), busy: true };
  assert.equal(buttonState(busy).dryRun.disabled, true);
  assert.match(buttonState(busy).dryRun.reason, /実行中/);
});

// ── 押した瞬間に必ず表示が変わる ────────────────────────────
test('押下で「確認中…」になる（無反応にしない）', () => {
  const s = startDryRun(applyCampaigns(initialState(), { campaigns }));
  assert.equal(s.dry.state, DRY_STATE.LOADING);
  assert.equal(s.dry.message, '確認中…');
  assert.equal(s.busy, true);
});

test('成功: 対象と除外の人数を出す', () => {
  const s = dryRunSucceeded(startDryRun(initialState()), { selected: 10, excluded: 3, willSend: 7 }, 'fp1');
  assert.equal(s.dry.state, DRY_STATE.OK);
  assert.equal(s.dry.message, '対象 7 名 / 除外 3 名');
  assert.equal(s.busy, false);
  assert.equal(hasUsableDryRun(s), true);
});

test('0 名: 「対象者がいません」と除外理由の確認を促す', () => {
  const s = dryRunSucceeded(startDryRun(initialState()), { selected: 5, excluded: 5, willSend: 0 }, 'fp');
  assert.equal(s.dry.state, DRY_STATE.EMPTY);
  assert.match(s.dry.message, /対象者がいません/);
  assert.equal(hasUsableDryRun(s), false, '0 名なのに次へ進めてしまう');
});

for (const [status, needle] of [[400, '不正'], [403, '管理シークレット'], [409, '取得し直して'], [500, 'サーバー側']]) {
  test(`失敗 ${status}: 原因と次の操作を出す`, () => {
    const s = dryRunFailed(startDryRun(initialState()), { status });
    assert.equal(s.dry.state, DRY_STATE.ERROR);
    assert.ok(s.dry.message.includes(needle), `${status} の説明が無い: ${s.dry.message}`);
    assert.equal(s.busy, false, '失敗後に実行中のままになっている');
  });
}

test('通信できないときも必ずエラー表示になる（API 未接続で無反応にしない）', () => {
  const s = dryRunFailed(startDryRun(initialState()), {});
  assert.equal(s.dry.state, DRY_STATE.ERROR);
  assert.match(s.dry.message, /通信できませんでした/);
});

// ── 失効 ────────────────────────────────────────────────────
const ready = () => {
  let s = applyCampaigns(initialState(), { campaigns, sendEnabled: true, dispatchEnabled: true });
  s = applyCustomers(s, { rows: rows(42) });
  s = applySelection(s, ['rec00000000000000', 'rec00000000000001']);
  return dryRunSucceeded(startDryRun(s), { selected: 2, excluded: 0, willSend: 2 }, 'fp');
};

for (const [label, mutate] of [
  ['選択を変えると', (s) => applySelection(s, ['rec00000000000000'])],
  ['キャンペーンを変えると', (s) => selectCampaign(s, 'stopped')],
  ['絞り込みを変えると', (s) => applyFilters(s, { contract: 'expired' })],
  ['ページを変えると', (s) => applyPaging(s, { page: 2 })],
  ['表示件数を変えると', (s) => applyPaging(s, { pageSize: 50 })],
  ['表示種別を変えると', (s) => applyPaging(s, { view: 'selected' })],
  ['一覧を取り直すと', (s) => applyCustomers(s, { rows: rows(10) })],
]) {
  test(`${label} dry-run 結果が失効する`, () => {
    const s = mutate(ready());
    assert.equal(s.dry.state, DRY_STATE.STALE, '失効していない');
    assert.equal(hasUsableDryRun(s), false);
    assert.equal(buttonState(s).enqueue.disabled, true, '失効後もキュー登録が押せる');
  });
}

test('同じ選択・同じキャンペーンなら失効しない（無駄な再確認をさせない）', () => {
  const s = ready();
  assert.equal(applySelection(s, ['rec00000000000001', 'rec00000000000000']).dry.state, DRY_STATE.OK);
  assert.equal(selectCampaign(s, 'expired-comeback').dry.state, DRY_STATE.OK);
});

// ── 42 名の一覧 ─────────────────────────────────────────────
test('42 件は 25 件ずつページングし、範囲を表示する', () => {
  let s = applyCustomers(applyCampaigns(initialState(), { campaigns }), { rows: rows(42) });
  assert.equal(s.pageSize, 25);
  let v = paginate(s);
  assert.equal(v.rows.length, 25);
  assert.equal(v.label, '42 件中 1〜25 件');
  assert.equal(v.pages, 2);
  s = applyPaging(s, { page: 2 });
  v = paginate(s);
  assert.equal(v.rows.length, 17);
  assert.equal(v.label, '42 件中 26〜42 件');
});

test('表示件数は 25 / 50 / 100 から選べる', () => {
  assert.deepEqual([...PAGE_SIZES], [25, 50, 100]);
  const s = applyPaging(applyCustomers(initialState(), { rows: rows(42) }), { pageSize: 100 });
  assert.equal(paginate(s).rows.length, 42);
});

test('「表示中を全選択」は現在ページの送信可能な行だけ', () => {
  let s = applyCustomers(applyCampaigns(initialState(), { campaigns }),
    { rows: rows(42, (i) => ({ sendable: i % 2 === 0 })) });
  s = selectVisible(s);
  assert.equal(s.selectedIds.length, 13, '現在ページ以外や送信不可を選んでいる');
  s = selectVisible(applyPaging(s, { page: 2 }));
  assert.equal(s.selectedIds.length, 21, '2 ページ目の分が加算されていない');
});

test('選択者のみ / 送信可能のみで絞り込める', () => {
  let s = applyCustomers(initialState(), { rows: rows(42, (i) => ({ sendable: i < 10 })) });
  s = applySelection(s, ['rec00000000000000', 'rec00000000000001']);
  assert.equal(paginate(applyPaging(s, { view: 'selected' })).total, 2);
  assert.equal(paginate(applyPaging(s, { view: 'sendable' })).total, 10);
});

test('要約に 該当 / 送信可能 / 送信不可 / 選択 を出す', () => {
  let s = applyCustomers(initialState(), { rows: rows(42, (i) => ({ sendable: i < 30 })) });
  s = applySelection(s, ['rec00000000000000']);
  const sum = summarizeRows(s);
  assert.deepEqual([sum.total, sum.sendable, sum.unsendable, sum.selected], [42, 30, 12, 1]);
  assert.match(sum.label, /該当 42 名/);
});

// ── PII ─────────────────────────────────────────────────────
test('一覧のアドレスは部分マスク（完全表示は詳細でのみ）', () => {
  assert.equal(maskEmail('someone@example.com'), 'so***@example.com');
  assert.equal(maskEmail('a@example.com'), 'a***@example.com');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail('broken'), '***');
});
