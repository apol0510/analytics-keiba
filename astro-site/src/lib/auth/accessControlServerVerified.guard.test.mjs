/**
 * 2026-10-05: 旧銀行振込 Light の有効会員（澤田様の事例）が、入金前の無料ログインで残った
 * localStorage（plan='free'）のせいで、サーバーが認可した Light ページを「無料プランです」と拒否された。
 * 認可の正本はサーバー（ak_session + Airtable）。サーバーが通したページではクライアントの古い表示用データで拒否しない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PAGES = [
  'light-predictions', 'light-predictions-jra', 'premium-prediction/nankan', 'premium-prediction/jra',
  'premium-predictions-urawa', 'premium-predictions-funabashi', 'premium-select',
  'premium-sanrenpuku', 'premium-sanrenpuku-jra',
];

test('サーバー認可済みのページは AccessControl に serverVerified を渡す', () => {
  for (const p of PAGES) {
    const src = read(`../../pages/${p}.astro`);
    assert.match(src, /const gate = await gatePaidPage\(/, `${p}: サーバー側認可が無い`);
    assert.match(src, /<AccessControl [^>]*serverVerified=\{gate\.ok === true\} serverTier=\{gate\.entitlements\?\.effectiveTier \|\| ''\}/, p);
  }
});

test('AccessControl はサーバー認可を優先し、古い表示用 plan を Light / Premium に限って補正する', () => {
  const src = read('../../components/AccessControl.astro');
  assert.match(src, /data-server-verified=\{serverVerified \? '1' : '0'\}/);
  assert.match(src, /if \(isDevelopmentMode\(\) \|\| clientAllowed \|\| serverVerified\)/);
  assert.match(src, /serverTier === 'light' \? 'Light' : serverTier === 'premium' \? 'Premium' : null/);
  // 既定は false（サーバー認可の無いページでは従来どおりクライアント判定）
  assert.match(src, /serverVerified = false/);
});
