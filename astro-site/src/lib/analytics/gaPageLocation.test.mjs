/**
 * gaPageLocation.test.mjs — BaseLayout の gtag('config') が token だけを外し、utm_* を残すこと（2026-10-22）
 *
 * マジックリンク `/auth/verify/?token=…` のトークンを GA4 の page_location / page_referrer に送らない。
 * 一方、feeder サイトからの `utm_source` / `utm_medium` は GA4 の流入元判定に要るので**消さない**。
 *   node --test src/lib/analytics/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const layout = readFileSync(fileURLToPath(new URL('../../layouts/BaseLayout.astro', import.meta.url)), 'utf8');
const start = layout.indexOf('window.dataLayer = window.dataLayer || [];');
const inline = layout.slice(start, layout.indexOf('</script>', start));

function run(href, referrer = '') {
  const ctx = { window: {}, location: { href }, document: { referrer }, URL };
  ctx.window = ctx;
  vm.runInNewContext(inline, ctx);
  const config = ctx.dataLayer.map((a) => Array.from(a)).find((a) => a[0] === 'config');
  return config;
}

test('token が無いページ: 従来どおり（page_location を上書きしない）', () => {
  const c = run('https://analytics.keiba.link/pricing/?utm_source=keiba-site&utm_medium=referral');
  assert.equal(c[1], 'G-BTDCZE1B13');
  assert.equal(JSON.stringify(c[2]), '{}');
});

test('マジックリンク: token だけを外し、utm_* は残す', () => {
  const c = run('https://analytics.keiba.link/auth/verify/?token=SECRETVALUE&utm_source=feed&utm_medium=referral');
  assert.equal(c[2].page_location, 'https://analytics.keiba.link/auth/verify/?utm_source=feed&utm_medium=referral');
  assert.ok(!JSON.stringify(c).includes('SECRETVALUE'));
});

test('verify の次のページ: page_referrer からも token を外す', () => {
  const c = run('https://analytics.keiba.link/dashboard/', 'https://analytics.keiba.link/auth/verify/?token=SECRETVALUE');
  assert.equal(c[2].page_location, undefined);
  assert.equal(c[2].page_referrer, 'https://analytics.keiba.link/auth/verify/');
  assert.ok(!JSON.stringify(c).includes('SECRETVALUE'));
});

test('外部の参照元（feeder サイト）はそのまま GA4 に任せる', () => {
  const c = run('https://analytics.keiba.link/seo/x/?utm_source=a&utm_medium=referral', 'https://feeder.example/page/');
  assert.equal(JSON.stringify(c[2]), '{}');
});
