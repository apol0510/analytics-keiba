/**
 * couponNotice.test.mjs — 渡したクーポンに気づいてもらえることを固定する
 *
 * MK 指摘（2026-08-23）「クーポンを再発行したら顧客に通知は？」→ **無かった**。
 * 渡したのに気づかれないのは、渡していないのと同じ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeCouponNotice, isCouponNoticeUnseen, COUPON_NOTICE_KIND } from './couponNotice.js';

const known = (over = {}) => ({ used: false, reserved: false, known: true, ...over });

test('受け取れるクーポンがあれば知らせる', () => {
  const n = describeCouponNotice({ claimed: false, canClaim: true, expiryText: '9月5日まで' });
  assert.equal(n.show, true);
  assert.equal(n.kind, COUPON_NOTICE_KIND.CLAIMABLE);
  assert.equal(n.count, 1);
  assert.ok(n.label.length > 0);
});

test('取得済みでまだ使っていなければ知らせる', () => {
  const n = describeCouponNotice({ claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: known() });
  assert.equal(n.show, true);
  assert.equal(n.kind, COUPON_NOTICE_KIND.USABLE);
});

test('使い終わった / 申込に適用済みなら知らせない（行動は終わっている）', () => {
  for (const usage of [known({ used: true }), known({ reserved: true })]) {
    const n = describeCouponNotice({ claimed: true, claimedAt: '2026-08-22T00:00:00.000Z', usage });
    assert.equal(n.show, false);
  }
});

test('状態を確認できないときは「使えます」と言わない', () => {
  const n = describeCouponNotice({
    claimed: true, claimedAt: '2026-08-22T00:00:00.000Z', usage: { known: false },
  });
  assert.equal(n.show, false);
});

test('対象外（クーポンが無い）なら何も出さない', () => {
  for (const c of [null, {}, { claimed: false, canClaim: false }]) {
    assert.equal(describeCouponNotice(c).show, false);
  }
});

test('いつ渡したか分からないものは知らせない', () => {
  assert.equal(describeCouponNotice({ claimed: true, usage: known() }).show, false);
});

// ── 既読の見分け ────────────────────────────────────────────
test('一度見たら出続けない', () => {
  const n = describeCouponNotice({ claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: known() });
  assert.equal(isCouponNoticeUnseen(n, ''), true);
  assert.equal(isCouponNoticeUnseen(n, n.signature), false);
});

test('**もう一度渡し直したら、また知らせる**（本件の要件）', () => {
  const first = describeCouponNotice({ claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: known() });
  // 管理画面で「もう一度渡せるようにする」→「再発行」した後は取得日時が変わる
  const again = describeCouponNotice({ claimed: true, claimedAt: '2026-08-24T01:00:00.000Z', usage: known() });
  assert.notEqual(again.signature, first.signature);
  assert.equal(isCouponNoticeUnseen(again, first.signature), true, '渡し直しに気づけない');
});

test('知らせるものが無ければ未読にならない', () => {
  assert.equal(isCouponNoticeUnseen(describeCouponNotice({}), ''), false);
});

test('既読の値を読めないときは知らせる側へ倒す（見落としを作らない）', () => {
  const n = describeCouponNotice({ claimed: false, canClaim: true, expiryText: '9月5日まで' });
  for (const bad of [null, undefined, '']) {
    assert.equal(isCouponNoticeUnseen(n, bad), true);
  }
});

// ── 画面への配線 ────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('ナビの赤い点に商品名・中身を書かない（未ログイン者も見るため）', () => {
  const layout = read('../../layouts/BaseLayout.astro');
  const i = layout.indexOf('data-notice-dot');
  assert.ok(i > 0, 'ナビにお知らせのバッジが無い');
  // バッジまわりのマークアップ・スクリプトに商品の語を出さない
  const block = layout.slice(i - 400, layout.indexOf('認証機能は一時的に無効化'));
  for (const w of ['クーポン', 'Premium Plus', '優待', '割引', '三連複']) {
    assert.ok(!block.includes(w), `未ログイン者に見えるナビへ「${w}」が出ている`);
  }
  // 出すのは件数だけ
  assert.match(layout, /新しいお知らせ \$\{n\.count\} 件/);
});

test('お知らせは追加の通信をしない（判定は既存の 1 回に相乗り）', () => {
  const client = read('../../lib/upsell/upsellClient.js');
  const fn = client.slice(client.indexOf('export async function getCouponNotice'));
  assert.match(fn.slice(0, 400), /await getUpsellDecision\(\)/);
  assert.doesNotMatch(fn.slice(0, 400), /fetch\(/, 'お知らせのために通信を増やしている');
});

test('描画しただけで既読にしない（実際に見えたときだけ消す）', () => {
  const page = read('../../pages/dashboard.astro');
  assert.match(page, /IntersectionObserver/, 'カードが見えたかを判定していない');
  const fn = page.slice(page.indexOf('async function markCouponCardSeenWhenVisible'));
  const body = fn.slice(0, fn.indexOf('\n      }\n'));
  assert.match(body, /markCouponNoticeSeen\(notice\.signature\)/);
  // 未読でなければ何もしない
  assert.match(body, /notice\.unseen !== true/);
  // 一瞬映っただけで既読にしない
  assert.match(body, /setTimeout\(/, '目に入る時間を待っていない');
  assert.match(body, /clearTimeout\(timer\)/, '通り過ぎただけで既読にしている');
});

test('マイページでも「届いた」ことが見える（本番で赤い点が出なかった原因）', () => {
  // ⚠️ 2026-08-23 MK 報告「マイページで赤い 1 出ないぞ」。
  //    ナビの赤い点はカードを見た時点で消えるため、**マイページ上では常に消えた後**だった。
  //    カード側にも新着を出し、その訪問のあいだは消さない。
  const page = read('../../pages/dashboard.astro');
  assert.match(page, /id="reopen-coupon-new"/, 'カードに新着の目印が無い');
  assert.match(page, /function showCouponNewBadge/, '新着をカードへ反映していない');

  // ⚠️ 既読にする**前**に未読を確定させること（先に既読化すると常に新着なしになる）
  const load = page.slice(page.indexOf('const noticeAtLoad'), page.indexOf('markCouponCardSeenWhenVisible(noticeAtLoad)'));
  assert.ok(load.includes('showCouponNewBadge(noticeAtLoad)'), '既読化の後に判定している');
  assert.ok(load.indexOf('getCouponNotice()') < load.indexOf('showCouponNewBadge'),
    '未読の確定より先に表示を決めている');

  // カードの NEW は既読化で消さない（消えるところを見せないと届いたことが伝わらない）
  const seenFn = page.slice(page.indexOf('const seen = () =>'));
  const seenBody = seenFn.slice(0, seenFn.indexOf('};'));
  assert.doesNotMatch(seenBody, /reopen-coupon-new/, '既読化でカードの新着まで消している');
});

test('既読は端末の保存だけ（本番 schema を増やさない）', () => {
  const client = read('../../lib/upsell/upsellClient.js');
  assert.match(client, /localStorage/);
  // 保存できない環境でも落ちない
  assert.match(client, /catch \{ return ''; \}/);
});
