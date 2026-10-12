// 決済会社 Sandbox 専用の中立ホスト sandbox.checkout.tirol.link は、Deploy Preview が受けたときだけ信用する。
// 本番（analytics.keiba.link）が受けたときは信用しない＝本番の CORS・戻り先・カード受付を広げない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, resolveSiteOrigin, corsHeaders, PRODUCTION_ORIGIN } from './stripeRuntime.js';
import { resolveCardMode } from './cardSales.js';

const SBX = 'https://sandbox.checkout.tirol.link';
const PREVIEW = 'deploy-preview-792--analytics-keiba.netlify.app';

test('Deploy Preview が受けたときだけ Sandbox ホストを許可する', () => {
  assert.equal(isAllowedOrigin(SBX, PREVIEW), true);
  assert.equal(isAllowedOrigin(SBX, 'sandbox.checkout.tirol.link'), true); // プロキシ経由（Host が元のまま）
  assert.equal(isAllowedOrigin(SBX, 'checkout.tirol.link'), false);
  assert.equal(isAllowedOrigin(SBX, 'analytics.keiba.link'), false);
  assert.equal(isAllowedOrigin(SBX, ''), false);
  assert.equal(isAllowedOrigin(SBX), false);
  assert.equal(isAllowedOrigin('https://evil.checkout.tirol.link', PREVIEW), false);
  assert.equal(isAllowedOrigin('https://checkout.tirol.link', PREVIEW), false);
});

test('本番が受けた Sandbox オリジンは本番扱いに倒れ、CORS も本番のまま', () => {
  const prodHeaders = { origin: SBX, host: 'analytics.keiba.link' };
  assert.equal(resolveSiteOrigin(prodHeaders), PRODUCTION_ORIGIN);
  assert.equal(corsHeaders(prodHeaders)['Access-Control-Allow-Origin'], PRODUCTION_ORIGIN);
});

test('Preview 経由の Sandbox オリジンはテスト鍵だけ通り、本番鍵は拒否', () => {
  const origin = resolveSiteOrigin({ origin: SBX, host: PREVIEW });
  assert.equal(origin, SBX);
  assert.equal(corsHeaders({ origin: SBX, host: PREVIEW })['Access-Control-Allow-Origin'], SBX);
  assert.deepEqual(resolveCardMode({ provider: 'paddle', keyMode: 'test', origin }), { ok: true, mode: 'test' });
  assert.equal(resolveCardMode({ provider: 'paddle', keyMode: 'live', origin, salesOpen: true }).ok, false);
});
