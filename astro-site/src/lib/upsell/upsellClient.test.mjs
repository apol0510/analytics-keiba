/**
 * upsellClient.test.mjs — マイページのクーポン受け渡しを**実挙動**で固定する
 *
 * ## なぜ実挙動テストが要るか（2026-08-22 の本番障害）
 *
 * サーバー（`/api/upsell.json`）が `coupon.canClaim = true` を返しても、
 * クライアントの `getReopenCoupon()` が **`claimed === true` だけを通していた**ため、
 * **未取得クーポンがここで捨てられ、マイページにカードが出なかった**。
 *
 * ソースの正規表現 guard（`dashboardCouponCard.test.mjs`）だけでは
 * 「書き方を変えた別の落とし方」を捕まえられないので、
 * **実際に fetch をスタブして関数を動かし、戻り値そのものを検査する**。
 *
 * ## テストの作り
 *
 * `getUpsellDecision()` はモジュール内で **1 回だけ通信して結果を使い回す**（memo 化）。
 * ケースごとに独立させるため、**import URL に一意のクエリを付けてモジュールを読み直す**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = new URL('./upsellClient.js', import.meta.url).href;

/** memo 化を跨がないよう、ケースごとに新しいモジュールを読む */
let caseId = 0;
async function loadFresh() {
  caseId += 1;
  return import(`${MODULE}?case=${caseId}`);
}

/**
 * `/api/upsell.json` の応答をスタブする。
 * @param {{ status?: number, body?: object, throws?: boolean }} opt
 * @returns {{ calls: string[] }} 実際に呼ばれた URL
 */
function stubFetch({ status = 200, body = {}, throws = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (throws) throw new Error('network down');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls };
}

/** サーバーが返す 1 件ぶんの応答（クーポン以外は最小限） */
const payload = (coupon) => ({
  channel: 'plus',
  sanrenpuku: { allowed: false },
  plus: { allowed: true },
  ...(coupon === undefined ? {} : { coupon }),
});

/** 取得できる状態のクーポン（サーバーが作った文字列をそのまま持つ） */
const CLAIMABLE = Object.freeze({
  claimed: false,
  canClaim: true,
  claimHref: '/premium-plus-coupon/',
  name: 'Premium Plus 再募集 優待クーポン',
  discountText: '10,000円OFF',
  priceText: '通常 68,000円 → 58,000円',
  expiryText: '2026年9月5日 15:54（JST）まで',
  expiryDetermined: true,
});

const CLAIMED = Object.freeze({
  claimed: true,
  canClaim: false,
  claimedAtText: '2026年8月18日 22:07',
  name: 'Premium Plus 再募集 優待クーポン',
  discountText: '10,000円OFF',
  cta: { show: true, purchasable: false, label: '再募集時に10,000円OFFで申し込めます', href: null },
});

let realFetch;
test.beforeEach(() => { realFetch = globalThis.fetch; });
test.afterEach(() => { globalThis.fetch = realFetch; });

// ── 本番で起きた障害そのもの ────────────────────────────────
test('未取得でも canClaim:true なら、その coupon をそのまま返す（本番障害の再現）', async () => {
  stubFetch({ body: payload(CLAIMABLE) });
  const { getReopenCoupon } = await loadFresh();

  const c = await getReopenCoupon();
  assert.equal(c.claimed, false);
  assert.equal(c.canClaim, true, '未取得クーポンを捨てている（本番障害）');
  // ⚠️ サーバーが作った文字列を**削らずに**渡すこと（画面で作り直さないため）
  assert.equal(c.name, CLAIMABLE.name);
  assert.equal(c.discountText, '10,000円OFF');
  assert.equal(c.priceText, '通常 68,000円 → 58,000円');
  assert.equal(c.expiryText, '2026年9月5日 15:54（JST）まで');
  assert.equal(c.claimHref, '/premium-plus-coupon/');
  assert.deepEqual(c, CLAIMABLE, 'サーバー応答をそのまま渡していない');
});

test('取得済みのときも従来どおりそのまま返す', async () => {
  stubFetch({ body: payload(CLAIMED) });
  const { getReopenCoupon } = await loadFresh();

  const c = await getReopenCoupon();
  assert.equal(c.claimed, true);
  assert.equal(c.claimedAtText, '2026年8月18日 22:07');
  assert.deepEqual(c, CLAIMED);
});

// ── 出さない側（fail closed）──────────────────────────────
test('取得済みでも取得可でもなければカードを出さない', async () => {
  stubFetch({ body: payload({ claimed: false, canClaim: false }) });
  const { getReopenCoupon } = await loadFresh();
  assert.deepEqual(await getReopenCoupon(), { claimed: false, canClaim: false });
});

test('coupon が無い応答でも落ちない（旧デプロイ互換）', async () => {
  stubFetch({ body: payload(undefined) });
  const { getReopenCoupon } = await loadFresh();
  assert.deepEqual(await getReopenCoupon(), { claimed: false, canClaim: false });
});

test('canClaim が真偽値でないときは出さない（"true" を真と誤読しない）', async () => {
  for (const bad of ['true', 1, {}, null]) {
    stubFetch({ body: payload({ claimed: false, canClaim: bad }) });
    const { getReopenCoupon } = await loadFresh();
    assert.deepEqual(await getReopenCoupon(), { claimed: false, canClaim: false }, String(bad));
  }
});

test('未ログイン（404）は従来どおり未取得扱い（例外を投げない）', async () => {
  stubFetch({ status: 404, body: {} });
  const { getReopenCoupon, getUpsellDecision, UPSELL_CLIENT_CHANNEL } = await loadFresh();
  assert.deepEqual(await getReopenCoupon(), { claimed: false, canClaim: false });
  assert.equal((await getUpsellDecision()).channel, UPSELL_CLIENT_CHANNEL.UNKNOWN);
});

test('通信エラーでも落ちない（この機能の障害で画面を壊さない）', async () => {
  stubFetch({ throws: true });
  const { getReopenCoupon, getUpsellDecision, UPSELL_CLIENT_CHANNEL } = await loadFresh();
  assert.deepEqual(await getReopenCoupon(), { claimed: false, canClaim: false });
  assert.equal((await getUpsellDecision()).channel, UPSELL_CLIENT_CHANNEL.UNKNOWN);
});

test('壊れた応答（channel が無い）は従来どおりへ倒す', async () => {
  stubFetch({ body: { coupon: CLAIMABLE } });   // channel なし
  const { getReopenCoupon, getUpsellDecision, UPSELL_CLIENT_CHANNEL } = await loadFresh();
  assert.equal((await getUpsellDecision()).channel, UPSELL_CLIENT_CHANNEL.UNKNOWN);
  assert.deepEqual(await getReopenCoupon(), { claimed: false, canClaim: false });
});

// ── 通信を増やさない ────────────────────────────────────────
test('クーポン用に通信を増やさない（同一ページで 1 回だけ）', async () => {
  const { calls } = stubFetch({ body: payload(CLAIMABLE) });
  const m = await loadFresh();

  await m.getUpsellDecision();
  await m.getReopenCoupon();
  await m.getReopenCoupon();
  await m.canShowPlusUpsell();

  assert.equal(calls.length, 1, `通信が ${calls.length} 回に増えている`);
  assert.equal(calls[0], '/api/upsell.json');
});

// ── 画面側の判定と噛み合うこと ──────────────────────────────
test('返り値は dashboard の表示条件（claimed || canClaim）と噛み合う', async () => {
  const shows = (c) => c.claimed === true || c.canClaim === true;   // dashboard.astro と同じ条件
  for (const [label, coupon, expected] of [
    ['未取得・取得可', CLAIMABLE, true],
    ['取得済み', CLAIMED, true],
    ['どちらでもない', { claimed: false, canClaim: false }, false],
  ]) {
    stubFetch({ body: payload(coupon) });
    const { getReopenCoupon } = await loadFresh();
    assert.equal(shows(await getReopenCoupon()), expected, label);
  }
});
