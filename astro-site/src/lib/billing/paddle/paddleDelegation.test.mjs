/**
 * paddleDelegation.test.mjs — 分離案 B の検証。
 * 分離サイト（decidePaddleGrant＋signTsBody）→ 本番（verifyPaddleSignature＋applyPaddleGrant）の
 * 委譲経路が、直接 handlePaddleEvent と同じ付与になり、冪等で、署名が本物であることを確かめる。
 * ネットワークには出ない（偽の Paddle API / Airtable / Redis）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaddleWebhook, verifyPaddleSignature, signTsBody } from './paddleCore.js';
import { createPaddleCheckout, handlePaddleEvent, decidePaddleGrant, applyPaddleGrant } from './paddleServer.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const KEY = 'pdl_sdbx_apikey_TESTONLY';
const ENV = { PADDLE_API_KEY: KEY, AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' } } = {}) {
  const st = { fields: { ...fields }, txns: {}, patches: [], redis: new Map() };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  let n = 0;
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      if (init.method === 'PATCH') { const f = JSON.parse(init.body).fields; st.patches.push(f); Object.assign(st.fields, f); }
      return res(200, { id: REC, fields: st.fields });
    }
    if (u.pathname === '/transactions' && init.method === 'POST') {
      const b = JSON.parse(init.body); n += 1;
      const id = `txn_${String(n).padStart(2, '0')}abcdefghijklmnopqrstu`;
      st.txns[id] = {
        id, origin: 'api', status: 'ready', currency_code: 'JPY', custom_data: b.custom_data,
        details: { totals: { grand_total: b.items[0].price.unit_price.amount } }, checkout: { url: `${st.defaultLink}?_ptxn=${id}` },
      };
      return res(201, { data: st.txns[id] });
    }
    const m = u.pathname.match(/^\/transactions\/(txn_[a-z0-9]+)$/);
    if (m) return st.txns[m[1]] ? res(200, { data: st.txns[m[1]] }) : res(404, { error: { code: 'not_found' } });
    return res(404, {});
  };
  st.redisCmd = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return st.redis.has(key) ? st.redis.get(key) : null;
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return null; st.redis.set(key, val); return 'OK'; }
    throw new Error(`unexpected ${cmd}`);
  };
  st.notify = async () => {};
  st.defaultLink = `${PREVIEW}/checkout/paddle/`;
  st.pay = (id) => { Object.assign(st.txns[id], { status: 'completed', billed_at: '2026-10-11T03:00:00Z' }); };
  return st;
}
async function paidTxn(w) {
  const r = await createPaddleCheckout({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual', fetchImpl: w.fetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  w.pay(r.transactionId);
  return parsePaddleWebhook({ event_id: 'evt_1', event_type: 'transaction.completed', data: { id: r.transactionId } });
}

test('委譲: decide→apply が直接 handlePaddleEvent と同じ付与になる', async () => {
  const direct = world();
  const pd = await paidTxn(direct);
  const rD = await handlePaddleEvent({ env: ENV, origin: PREVIEW, parsed: pd, redis: direct.redisCmd, notify: direct.notify, fetchImpl: direct.fetch });

  const split = world();
  const ps = await paidTxn(split);
  const dec = await decidePaddleGrant({ env: ENV, origin: PREVIEW, parsed: ps, fetchImpl: split.fetch });
  assert.ok(dec.apply, `apply が返る: ${JSON.stringify(dec)}`);
  assert.equal(dec.apply.kind, 'grant');
  assert.equal(dec.apply.provider, 'paddle');
  assert.equal(dec.apply.recordId, REC);
  const rS = await applyPaddleGrant({ env: ENV, apply: dec.apply, redis: split.redisCmd, notify: split.notify, fetchImpl: split.fetch });

  assert.equal(rS.result, rD.result, '付与結果が一致');
  assert.deepEqual(split.patches, direct.patches, 'Airtable への書き込み内容が一致');
  assert.ok(direct.patches.length > 0, '実際に付与している');
});

test('委譲: 同じ apply を 2 回流しても二重付与しない（冪等）', async () => {
  const w = world();
  const parsed = await paidTxn(w);
  const dec = await decidePaddleGrant({ env: ENV, origin: PREVIEW, parsed, fetchImpl: w.fetch });
  const r1 = await applyPaddleGrant({ env: ENV, apply: dec.apply, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch });
  const patchesAfter1 = w.patches.length;
  const r2 = await applyPaddleGrant({ env: ENV, apply: dec.apply, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch });
  assert.notEqual(r2.result, r1.result, '2 回目は付与扱いにしない');
  assert.equal(w.patches.length, patchesAfter1, '2 回目は Airtable を書き換えない');
});

test('内部署名: 正しい secret だけ通り、本文改ざん・誤 secret は弾く', () => {
  const SECRET = 'internal-secret-32bytes-xxxxxxxx';
  const body = JSON.stringify({ apply: { kind: 'grant', provider: 'paddle', paymentId: 'txn_x', recordId: REC } });
  const header = signTsBody({ rawBody: body, secret: SECRET });
  assert.equal(verifyPaddleSignature({ header, rawBody: body, secret: SECRET }), true, '正しい secret で通る');
  assert.equal(verifyPaddleSignature({ header, rawBody: body, secret: 'wrong-secret' }), false, '誤 secret は弾く');
  assert.equal(verifyPaddleSignature({ header, rawBody: `${body} `, secret: SECRET }), false, '本文改ざんは弾く');
});

test('委譲: applyPaddleGrant は redis 無しなら再送扱い・provider 不正は無視', async () => {
  const w = world();
  const parsed = await paidTxn(w);
  const dec = await decidePaddleGrant({ env: ENV, origin: PREVIEW, parsed, fetchImpl: w.fetch });
  assert.deepEqual(await applyPaddleGrant({ env: ENV, apply: dec.apply, redis: null, notify: w.notify, fetchImpl: w.fetch }), { result: 'redis_missing', retry: true });
  assert.equal((await applyPaddleGrant({ env: ENV, apply: null, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch })).result, 'ignored_no_apply');
});
