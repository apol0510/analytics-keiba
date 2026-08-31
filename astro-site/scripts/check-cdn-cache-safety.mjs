#!/usr/bin/env node
/**
 * check-cdn-cache-safety.mjs — CDN キャッシュを**個人化されたページに掛けていない**ことを検査する
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `Netlify-CDN-Cache-Control` はエッジに応答を保持させる。Cookie で内容が変わるページ
 * （会員向け予想・認証・管理画面）に掛けると、**ある利用者向けの HTML を
 * 別の利用者へ配信し得る**。対象は人が選ぶので、条件を機械で固定する。
 *
 * ── 何を検査するか ────────────────────────────────────────────
 * 1. `setPublicCdnCache(` を呼ぶ `src/pages` 配下のページが、
 *    `Astro.cookies` / `ak_session` / `gatePaidPage` / `verifyPlanAccess` /
 *    `requireAuth` / `AccessControl` / `SessionKeepAlive` / `credentials: 'include'`
 *    を**1つも使っていない**こと。
 * 2. `Netlify-CDN-Cache-Control` を **`src/lib/cdnCache.mjs` 以外で直接書いていない**こと
 *    （検査を迂回して個別に書かれると 1 の検査が意味を失う）。
 * 3. `netlify.toml` に `Netlify-CDN-Cache-Control` を書いていないこと。
 *    ⚠️ **netlify.toml の [[headers]] は SSR 応答に効かない**（2026-08-31 に deploy preview で実測。
 *    毎回 `cache-status: "Netlify Edge"; fwd=miss` のままだった）。効かない指定を残すと
 *    「キャッシュしているつもり」で判断を誤る。
 *
 * exit 0 … 安全  /  exit 1 … 条件違反（＝ CI を落とす）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASTRO_SITE = join(__dirname, '..');
const REPO_ROOT = join(ASTRO_SITE, '..');
const PAGES = join(ASTRO_SITE, 'src', 'pages');
const HELPER = join(ASTRO_SITE, 'src', 'lib', 'cdnCache.mjs');

/** 個人化の痕跡。1つでもあれば CDN キャッシュ禁止。 */
const PERSONALIZED = [
  'Astro.cookies',
  'ak_session',
  'gatePaidPage',
  'verifyPlanAccess',
  'requireAuth',
  'AccessControl',
  'SessionKeepAlive',
  "credentials: 'include'",
];

let failed = false;
function fail(msg) {
  console.error(`❌ ${msg}`);
  failed = true;
}

function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

// ── 1. helper を呼ぶページが個人化されていないか ──────────────────
const pages = existsSync(PAGES) ? walk(PAGES, '.astro') : [];
const cached = pages.filter((p) => readFileSync(p, 'utf-8').includes('setPublicCdnCache('));

console.log(`🔍 CDN キャッシュを掛けているページ: ${cached.length} 件`);
if (cached.length === 0) {
  console.log('ℹ️  対象なし');
}
for (const f of cached) {
  const src = readFileSync(f, 'utf-8');
  const hits = PERSONALIZED.filter((k) => src.includes(k));
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  if (hits.length) fail(`${rel} は個人化されているので CDN キャッシュ禁止 → ${hits.join(', ')}`);
  else console.log(`✅ ${rel}`);
}

// ── 2. helper を経由しない直書きを禁止 ────────────────────────────
const sources = [...walk(join(ASTRO_SITE, 'src'), '.astro'), ...walk(join(ASTRO_SITE, 'src'), '.mjs')];
for (const f of sources) {
  if (f === HELPER) continue;
  if (readFileSync(f, 'utf-8').includes('Netlify-CDN-Cache-Control')) {
    fail(
      `${relative(ASTRO_SITE, f)} が Netlify-CDN-Cache-Control を直接書いている。` +
        ` src/lib/cdnCache.mjs の setPublicCdnCache() を使うこと（検査を迂回させない）`
    );
  }
}

// ── 3. netlify.toml に書かない（SSR 応答に効かないため）──────────
const tomlPath = join(REPO_ROOT, 'netlify.toml');
if (existsSync(tomlPath)) {
  const toml = readFileSync(tomlPath, 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  if (/Netlify-CDN-Cache-Control\s*=/.test(toml)) {
    fail(
      'netlify.toml に Netlify-CDN-Cache-Control がある。[[headers]] は SSR 応答に効かないため' +
        '（2026-08-31 実測）、ページ側の setPublicCdnCache() を使うこと'
    );
  }
}

if (failed) {
  console.error('\n❌ CDN キャッシュの安全条件を満たしていない');
  process.exit(1);
}
console.log('\n✅ CDN キャッシュはすべて非個人化ページのみ・helper 経由');
