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

test('お知らせは専用のナビ（🔔）に件数で出す', () => {
  // MK 要望（2026-08-23）: マイページ横の点ではなく、
  // 通知アイコン + 件数（アプリの通知バッジのような形）にしたい。
  const layout = read('../../layouts/BaseLayout.astro');
  assert.match(layout, /id="nav-notice"/, 'お知らせ専用のナビが無い');
  assert.match(layout, /id="mobile-nav-notice"/, 'モバイルにお知らせのナビが無い');
  assert.match(layout, /🔔/, '通知アイコンが無い');
  // ベルから行き先へ飛べる
  assert.match(layout, /href="\/dashboard\/#notifications"/);
  // ⚠️ 0 件のベルを常設しない（付いても目立たなくなる）
  assert.match(layout, /li\.style\.display = 'block'/);
  // マイページ側の点は廃止（指標を 2 つ出さない）
  const dash = layout.slice(layout.indexOf('id="nav-dashboard"'), layout.indexOf('id="nav-dashboard"') + 300);
  assert.ok(!dash.includes('data-notice-dot'), 'マイページ横にも点が残っている');
});

test('スマホはメニューを開かなくても気づける（ハンバーガーの外に出す）', () => {
  // ⚠️ 2026-08-23 MK 指摘: メニューの中だけだと、開いて最下部まで見ないと気づけない。
  const layout = read('../../layouts/BaseLayout.astro');
  const i = layout.indexOf('id="mobile-notice-bell"');
  assert.ok(i > 0, 'ハンバーガーの外にお知らせが無い');
  // ハンバーガーより**前**（左隣）に置く
  assert.ok(i < layout.indexOf('class="mobile-menu-toggle"'), 'ハンバーガーの中／後ろにある');
  // 件数があるときだけ出す
  assert.match(layout, /bell\.style\.display = 'inline-flex'/);
  // 中身を示す語は書かない（未ログイン者も見る）
  const bell = layout.slice(i - 200, i + 400);
  for (const w of ['クーポン', 'Premium Plus', '割引', '優待']) {
    assert.ok(!bell.includes(w), `スマホの鈴に「${w}」が出ている`);
  }
});

test('バッジは数字が読める大きさにする（小さくて気づけない を防ぐ）', () => {
  const layout = read('../../layouts/BaseLayout.astro');
  const css = layout.slice(layout.indexOf('.nav-notice-dot {'), layout.indexOf('.nav-notice-dot[hidden]'));
  const min = /min-width:\s*(\d+)px/.exec(css);
  const size = /font-size:\s*(\d+)px/.exec(css);
  assert.ok(min && Number(min[1]) >= 18, `バッジが小さい: ${css}`);
  assert.ok(size && Number(size[1]) >= 12, `文字が小さい: ${css}`);
});

test('マイページのお知らせは最上部・読める配色にする', () => {
  const page = read('../../pages/dashboard.astro');
  // ⚠️ 最上部（穴馬リンク・会員ステータスより前）に置く
  const notice = page.indexOf('id="notifications"');
  assert.ok(notice > 0);
  assert.ok(notice < page.indexOf('穴馬ページリンク'), 'お知らせが下にある');
  assert.ok(notice < page.indexOf('<!-- 会員ステータス -->'), 'お知らせが会員ステータスより下にある');

  // ⚠️ 配色は 2026-08-24 に見直した（明るい黄色の地は暗いサイトから浮く）。
  //    暗いカード + 左の色帯 + 明るい文字にする。
  //    ⚠️ JS で作る要素に効かせるため **is:global 側**に置くこと。
  const css = page.slice(page.indexOf('<style is:global>'), page.indexOf('</style>'));
  assert.doesNotMatch(css, /background:\s*rgba\(239, 68, 68/, '暗い赤のままで読みにくい');
  assert.doesNotMatch(css, /linear-gradient\(135deg, #fde68a/, '明るい黄色の地のままで浮いている');
  // ⚠️ 2026-08-25 MK 指示で**左の色帯を削除**。戻さないこと。
  //    カード本体の枠線・角丸・背景・余白・文字は変更していない。
  assert.doesNotMatch(css, /\.notice-card \{ border-left/, 'お知らせの左の色帯が戻っている');
  assert.doesNotMatch(css, /\.campaign-card \{ border-left/, 'ご優待の左の色帯が戻っている');
  // 左側の疑似要素で同じ見た目を作らない
  assert.doesNotMatch(css, /\.notice-card::(before|after)/, '疑似要素で色帯を作っている');
  assert.doesNotMatch(css, /\.campaign-card::(before|after)/, '疑似要素で色帯を作っている');
  // カード本体の見た目は維持する
  assert.match(css, /border-radius: 14px/, 'カードの角丸が消えている');
  assert.match(css, /border: 1px solid rgba\(148, 163, 184, \.22\)/, 'カードの枠線が消えている');
  assert.match(css, /background: #101a2f/, 'カードの背景が消えている');
  assert.match(css, /padding: 1\.15rem 1\.25rem/, 'カードの余白が変わっている');

  // ⚠️ 見出しの**文字だけ**をバッジ状に囲む（2026-08-25 MK 指示）。
  //    カード全体を囲み直したり、左の色帯へ戻したりしないこと。
  for (const [label, sel] of [['お知らせ', '.notice-title'], ['ご優待', '.campaign-title']]) {
    const rule = css.slice(css.indexOf(`${sel} {`));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.match(body, /border-radius: 999px/, `${label}: 見出しが囲まれていない`);
    assert.match(body, /border: 1px solid/, `${label}: 見出しの枠が無い`);
    assert.match(body, /display: inline-block/, `${label}: 文字幅に収まっていない`);
  }
  assert.match(css, /color: #fbbf24/, 'リンクが暗い地に沈む色のまま');
});

test('ベルの行き先にお知らせの中身がある（飛んだ先が空にならない）', () => {
  const page = read('../../pages/dashboard.astro');
  assert.match(page, /id="notifications"/, 'ベルの行き先が無い');
  assert.match(page, /function renderNotifications/, 'お知らせを描画していない');
  const fn = page.slice(page.indexOf('function renderNotifications'));
  const body = fn.slice(0, fn.indexOf('\n      }\n'));
  // 未読が無ければ出さない（空の「お知らせ」を見せない）
  assert.match(body, /notice\.unseen !== true/);
  // 文言はサーバー由来（画面で作らない）
  assert.match(body, /it\.label|notice\.label/);
  // ⚠️ コメントは除いて検査する（説明のための語まで禁止すると、
  //    正しい実装なのに落ちる。見るべきは**画面に出す文字列**だけ）
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /textContent = '[^']*クーポン/, '画面で文言を組み立てている');
});

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

test('マイページを開いただけでは既読にしない（開いた／押したときだけ）', () => {
  // ⚠️ 2026-08-23 MK 報告「変わらない」。カードが画面に入った時点で既読にしていたため、
  //    別の用事でマイページを開いただけで通知が消え、届いたことに気づけなかった。
  const page = read('../../pages/dashboard.astro');
  assert.ok(!page.includes('markCouponCardSeenWhenVisible'), '見えただけで既読にしている');
  assert.ok(!page.includes('IntersectionObserver'), '可視判定で既読にしている');

  assert.match(page, /function markNoticeRead/, '既読にする経路が無い');
  const fn = page.slice(page.indexOf('function markNoticeRead'));
  const body = fn.slice(0, fn.indexOf('\n      }\n'));
  assert.match(body, /markCouponNoticeSeen\(notice\.signature\)/);
  assert.match(body, /notice\.unseen !== true/);

  // 既読になるのは「ベルから来た」か「お知らせを押した」ときだけ
  assert.match(page, /location\.hash === '#notifications'\) markNoticeRead/, 'ベル経由で既読にしていない');
  // ⚠️ 検索は**お知らせの描画関数の中**に限る。ページ全体から探すと
  //    別の関数の `cta.addEventListener('click'` にも当たってしまう。
  const render = page.slice(page.indexOf('function renderNotifications'));
  const renderBody = render.slice(0, render.indexOf('\n      }\n'));
  const click = renderBody.slice(renderBody.indexOf("addEventListener('click'"));
  assert.match(click.slice(0, 400), /markNoticeRead\(notice\)/, '押しても既読にならない');
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
  // 種類ごとに既読を持つので JSON で保存する（1 つ見て両方消えない）
  assert.match(client, /localStorage\.setItem\(SEEN_KEY, JSON\.stringify\(seen\)\)/);
  // 保存できない環境でも落ちない
  assert.match(client, /catch \{ return \{\}; \}/);
});
