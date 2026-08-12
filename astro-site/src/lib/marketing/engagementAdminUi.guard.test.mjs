/**
 * engagementAdminUi.guard.test.mjs — 管理画面が送信前に engagement を出しているか
 *   node --test src/lib/marketing/engagementAdminUi.guard.test.mjs
 *
 * 重点:
 *   - 「送信対象人数」と「反応なしで除外される人数」が**送信前に並んで見える**
 *   - 適用していないときに「0 名」とだけ出さない（未計測と 0 を混同させない）
 *   - 画面側で判定し直さない（サーバーの applied / reason をそのまま出す）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(
  new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8',
);

test('セグメント下見に engagement の枠がある', () => {
  assert.match(PAGE, /id="mkEngBox"/);
  assert.match(PAGE, /function mkRenderEngagement\(/);
  assert.match(PAGE, /mkRenderEngagement\(out\.engagement/);
});

test('5 区分と閾値を出す', () => {
  for (const label of ['反応あり', '観察中', '除外', '強い除外', '判断材料なし']) {
    assert.ok(PAGE.includes(label), `区分の表示が無い: ${label}`);
  }
  assert.match(PAGE, /eng\.thresholds/);
  assert.match(PAGE, /lowEngagementSends/);
  assert.match(PAGE, /inactiveDelivered/);
  assert.match(PAGE, /hardInactiveDelivered/);
});

test('【重要】送信対象人数と engagement 除外人数を並べて出す', () => {
  assert.match(PAGE, /このセグメントの送信対象/);
  assert.match(PAGE, /うち 反応なしで除外/);
  assert.match(PAGE, /blockedBySegment/);
});

test('送信確認モーダルにも「今回何人が反応なしで除外か」を出す', () => {
  assert.match(PAGE, /plan\.engagement/);
  assert.match(PAGE, /blockedThisPlan/);
});

test('適用していないときは 0 名と言わず理由を出す', () => {
  assert.match(PAGE, /適用していません/);
  assert.match(PAGE, /eg\.reasonLabel \|\| eg\.reason/);
  assert.match(PAGE, /参考値/);
});

test('画面側で閾値・判定を持たない（サーバーが単一源）', () => {
  const script = PAGE.slice(PAGE.indexOf('function mkRenderEngagement('));
  const body = script.slice(0, script.indexOf('$(\'mkSegLoad\')'));
  assert.equal(/delivered\s*>=\s*\d+/.test(body), false, '画面で閾値を判定している');
  assert.equal(/=== *'inactive'/.test(body), false, '画面で状態を判定している');
});

test('数えている期間と最終受信を出す（記録の欠落に気付けるように）', () => {
  assert.match(PAGE, /数えている期間/);
  assert.match(PAGE, /最後に反応を受信/);
  assert.match(PAGE, /開封を記録できている人数/);
});
