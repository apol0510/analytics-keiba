/**
 * premiumPlusFunnelClient.test.mjs — CTA の配線が**数えすぎず・取りこぼさず・画面を壊さない**こと
 *   node --test src/lib/premiumPlus/premiumPlusFunnelClient.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFunnelClient, normalizeQueueItem, installPlusFunnel,
  FUNNEL_QUEUE_KEY, FUNNEL_INSTALLED_KEY,
} from './premiumPlusFunnelClient.js';
import { FUNNEL_EVENT } from './premiumPlusFunnelStore.js';

/** 送信の記録だけ取る client */
function spyClient({ observe } = {}) {
  const posted = [];
  const c = createFunnelClient({ post: (e) => posted.push(e), observe });
  return { c, posted };
}

test('未知のイベントはキューから捨てる', () => {
  assert.equal(normalizeQueueItem('purchase'), null);
  assert.equal(normalizeQueueItem({ event: 'purchase' }), null);
  assert.equal(normalizeQueueItem(null), null);
  // 導線（source）は運ぶだけ。**採否はサーバーの allow-list**が決める
  assert.deepEqual(normalizeQueueItem('cta_click'), { event: 'cta_click', el: null, source: null });
  assert.deepEqual(normalizeQueueItem({ event: 'cta_click', source: 'dashboard' }),
    { event: 'cta_click', el: null, source: 'dashboard' });
  // 文字列でない source は運ばない（送信本文に妙な型を混ぜない）
  assert.deepEqual(normalizeQueueItem({ event: 'cta_click', source: { evil: 1 } }),
    { event: 'cta_click', el: null, source: null });
});

test('【重要】1 ページ表示で同じ種別は 1 回しか送らない', () => {
  const { c, posted } = spyClient();
  assert.equal(c.accept(FUNNEL_EVENT.CTA_VIEW), true);
  assert.equal(c.accept(FUNNEL_EVENT.CTA_VIEW), false, '再描画で二重送信している');
  assert.equal(c.accept(FUNNEL_EVENT.CTA_CLICK), true);
  assert.deepEqual(posted, ['cta_view', 'cta_click']);
});

test('【重要】要素を渡したら「画面に入るまで」数えない', () => {
  let fire = null;
  const { c, posted } = spyClient({ observe: (_el, onVisible) => { fire = onVisible; } });
  c.accept({ event: FUNNEL_EVENT.CTA_VIEW, el: { tag: 'div' } });
  assert.deepEqual(posted, [], 'DOM に足しただけで表示として数えている');
  fire();
  assert.deepEqual(posted, ['cta_view']);
});

test('送信が例外を投げても呼び出し側へ伝播しない（CTA の遷移を止めない）', () => {
  const c = createFunnelClient({ post: () => { throw new Error('network down'); } });
  assert.doesNotThrow(() => c.accept(FUNNEL_EVENT.CTA_CLICK));
});

test('post が無ければ生成時に落とす（黙って無計測にしない）', () => {
  assert.throws(() => createFunnelClient({}), TypeError);
});

// ── install（読み込み順に依存しない）────────────────────────
test('【重要】install 前に積まれた分も取りこぼさない', () => {
  const fetched = [];
  const win = {
    fetch: (url, opt) => { fetched.push(JSON.parse(opt.body).event); return Promise.resolve({}); },
    [FUNNEL_QUEUE_KEY]: [{ event: 'cta_view' }, 'cta_click'],
  };
  installPlusFunnel(win);
  assert.deepEqual(fetched, ['cta_view', 'cta_click']);

  // install 後の push は即時送信になる
  win[FUNNEL_QUEUE_KEY].push('page_view');
  assert.deepEqual(fetched, ['cta_view', 'cta_click', 'page_view']);
});

test('install は 2 回目を無視する（二重計上しない）', () => {
  const fetched = [];
  const win = { fetch: (u, o) => { fetched.push(JSON.parse(o.body).event); return Promise.resolve({}); } };
  installPlusFunnel(win);
  assert.equal(win[FUNNEL_INSTALLED_KEY], true);
  assert.equal(installPlusFunnel(win), null);
  win[FUNNEL_QUEUE_KEY].push('cta_view');
  assert.deepEqual(fetched, ['cta_view']);
});

test('【重要】送るのはイベント名だけ（recordId / Email を送らない）', () => {
  let body = null;
  const win = { fetch: (u, o) => { body = o.body; return Promise.resolve({}); } };
  installPlusFunnel(win);
  win[FUNNEL_QUEUE_KEY].push('cta_click');
  assert.deepEqual(JSON.parse(body), { event: 'cta_click' });
});

test('fetch が無い環境でも落ちない', () => {
  const win = {};
  installPlusFunnel(win);
  assert.doesNotThrow(() => win[FUNNEL_QUEUE_KEY].push('cta_view'));
});
