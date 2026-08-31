#!/usr/bin/env node
/**
 * check-cdn-cache-safety.mjs — CDN キャッシュを**個人化されたページに掛けていない**ことを検査する
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `netlify.toml` の `Netlify-CDN-Cache-Control` はエッジに応答を保持させる。
 * Cookie で内容が変わるページ（会員向け予想・認証・管理画面）に掛けると、
 * **ある利用者向けの HTML を別の利用者へ配信し得る**。
 * 対象パスは人が書くので、条件を機械で固定する。
 *
 * ── 何を検査するか ────────────────────────────────────────────
 * `netlify.toml` の `[[headers]]` のうち `Netlify-CDN-Cache-Control` を持つ `for` について、
 * そのパスに対応する `src/pages` 配下のページが
 *   `Astro.cookies` / `ak_session` / `gatePaidPage` / `verifyPlanAccess` /
 *   `requireAuth` / `AccessControl` / `SessionKeepAlive` / `credentials: 'include'`
 * を**1つも使っていない**ことを確認する。
 *
 * 併せて `/*` のような全体指定に CDN キャッシュを掛けていないことも確認する。
 *
 * exit 0 … 安全  /  exit 1 … 個人化ページに掛かっている（＝ CI を落とす）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASTRO_SITE = join(__dirname, '..');
const REPO_ROOT = join(ASTRO_SITE, '..');
const PAGES = join(ASTRO_SITE, 'src', 'pages');

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

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
}

/** netlify.toml から Netlify-CDN-Cache-Control を持つ `for` パターンを取り出す。 */
function cachedPatterns(toml) {
  const out = [];
  // [[headers]] ブロック単位で見る
  // ⚠️ コメント行を先に落とす。説明文に "Netlify-CDN-Cache-Control" と書いてあるだけの
  //    ブロックを誤検出しないため（実際に一度誤検出した）。
  const stripped = toml
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  for (const block of stripped.split('[[headers]]').slice(1)) {
    const next = block.indexOf('[[');
    const body = next === -1 ? block : block.slice(0, next);
    // 代入として書かれている場合だけを対象にする
    if (!/Netlify-CDN-Cache-Control\s*=/.test(body)) continue;
    const m = body.match(/for\s*=\s*"([^"]+)"/);
    if (m) out.push(m[1]);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.astro')) out.push(p);
  }
  return out;
}

/** `/archive/*` のようなパターンに対応する page ファイルを集める。 */
function pagesUnder(pattern, allPages) {
  const prefix = pattern.replace(/\*$/, '').replace(/^\//, '').replace(/\/$/, '');
  return allPages.filter((p) => {
    const rel = relative(PAGES, p).replace(/\\/g, '/');
    return rel === `${prefix}.astro` || rel.startsWith(`${prefix}/`);
  });
}

const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf-8');
const patterns = cachedPatterns(toml);
const allPages = existsSync(PAGES) ? walk(PAGES) : [];

console.log(`🔍 CDN キャッシュ対象 ${patterns.length} パターンを検査`);

if (patterns.length === 0) {
  console.log('ℹ️  CDN キャッシュ指定なし（検査対象なし）');
  process.exit(0);
}

for (const pat of patterns) {
  if (pat === '/*' || pat === '*') {
    fail(`全体指定 "${pat}" に CDN キャッシュを掛けている。個人化ページを巻き込むため禁止`);
    continue;
  }
  const targets = pagesUnder(pat, allPages);
  if (targets.length === 0) {
    fail(`"${pat}" に対応するページが src/pages に無い（パターンの綴り間違い？）`);
    continue;
  }
  const bad = [];
  for (const f of targets) {
    const src = readFileSync(f, 'utf-8');
    const hits = PERSONALIZED.filter((k) => src.includes(k));
    if (hits.length) bad.push(`${relative(PAGES, f)} → ${hits.join(', ')}`);
  }
  if (bad.length) {
    fail(`"${pat}" は個人化ページを含むので CDN キャッシュ禁止:\n     ` + bad.join('\n     '));
  } else {
    console.log(`✅ ${pat}  (${targets.length} ページ・個人化なし)`);
  }
}

if (process.exitCode === 1) {
  console.error('\n❌ CDN キャッシュの安全条件を満たしていない');
} else {
  console.log('\n✅ CDN キャッシュはすべて非個人化ページのみ');
}
