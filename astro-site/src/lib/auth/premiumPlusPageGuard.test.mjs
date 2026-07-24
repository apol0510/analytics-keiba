/**
 * premiumPlusPageGuard.test.mjs — Premium Plus 商品ページの SSR 認可ゲートが
 * revert / コピペ同期で消えないことを固定する source ガード。
 *   node --test src/lib/auth/premiumPlusPageGuard.test.mjs
 *
 * 対象ページ（どちらも同一の fail-closed 認可ゲートを持つこと）:
 *   - src/pages/premium-plus.astro     … 旧 SSR 経路（Netlify functions cache 固着のため
 *                                          非公開のまま残置。導線からは切り離し済み）
 *   - src/pages/premium-plus-v2.astro   … 新しい正式商品ページ（本番検証済みの新モジュール経路）
 *
 * 検知内容（いずれか欠けたら fail）:
 *   - prerender=false（静的化＝ビルド時 HTML 露出への逆戻り禁止）
 *   - verifyPlanAccess をサーバー側で呼ぶ
 *   - Cookie を Astro.request.headers から読む
 *   - 認可 NG で 404 を返す（401/403 ＝存在を漏らす応答は使わない）
 *   - Cache-Control: private, no-store（会員別 HTML の CDN 共有防止）
 *   - SESSION_SIGNING_SECRET をサーバー env から取得
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGES = ['../../pages/premium-plus.astro', '../../pages/premium-plus-v2.astro'];

for (const rel of PAGES) {
  const label = rel.split('/').pop();
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  // フロントマター（最初の --- ... --- ブロック）だけを対象にする
  const fm = src.slice(0, src.indexOf('\n---', 3) + 4);

  test(`${label}: prerender=false（静的化禁止）`, () => {
    assert.match(fm, /export\s+const\s+prerender\s*=\s*false/);
    assert.doesNotMatch(fm, /export\s+const\s+prerender\s*=\s*true/);
  });

  test(`${label}: verifyPlanAccess をサーバー側で呼ぶ`, () => {
    assert.match(fm, /verifyPlanAccess\s*\(/);
  });

  test(`${label}: Cookie を Astro.request.headers から読む`, () => {
    assert.match(fm, /Astro\.request\.headers\.get\(\s*['"]cookie['"]\s*\)/);
  });

  test(`${label}: 認可 NG で 404 を返す`, () => {
    assert.match(fm, /status:\s*404/);
    // 存在を漏らす 401/403 を認可ゲートで使っていない
    assert.doesNotMatch(fm, /status:\s*40[13]/);
  });

  test(`${label}: 会員別 HTML を CDN 共有させない`, () => {
    assert.match(fm, /private,\s*no-store/);
  });

  test(`${label}: SESSION_SIGNING_SECRET をサーバー env から取得`, () => {
    assert.match(fm, /process\.env\.SESSION_SIGNING_SECRET/);
  });
}
