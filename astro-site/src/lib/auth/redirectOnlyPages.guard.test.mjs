/**
 * redirectOnlyPages.guard.test.mjs — **認可付きリダイレクト専用ページ**の契約
 *   node --test src/lib/auth/redirectOnlyPages.guard.test.mjs
 *   （`npm run test:auth-session` の glob に含まれ、check:safety / CI で強制実行される）
 *
 * ## なぜ要るか（2026-09-08）
 *
 * `/premium-plus/` は v2 へ一本化され、**本文を持たない認可付きリダイレクト**になった
 * （`src/pages/premium-plus.astro` 1,973 行 → 57 行）。商品ページの正本は
 * `premium-plus-v2.astro` ただ 1 枚。
 *
 * この形は 2 つの guard の前提を同時に崩す:
 *   - `<AccessControl>` を持たないので、有料ページの分類（`authSecurity.guard`）に出てこない
 *   - 本文を描画しないので、keep-alive（`sessionKeepAlive.guard`）を置いても動かない
 *
 * どちらも「**認可が外れた**」のか「**リダイレクト専用になった**」のかを区別できないと、
 * 静かに穴が開いても気づけない。そこで**リダイレクト専用であること自体**をここで固定する。
 *
 * ## 守る契約（1 つでも崩れたら fail）
 *
 *   1. SSR のまま（`prerender = false`）… 静的化すると認可が消える
 *   2. サーバー側認可を通す（`verifyPlanAccess`）
 *   3. 非会員は **404**（存在秘匿。301 を返すと商品の存在が漏れる）
 *   4. 会員だけ **301** で正本 URL へ送る
 *   5. **本文を描画しない**（商品マークアップ・価格を復活させない = 二重管理へ戻さない）
 *   6. CDN で共有しない（`private, no-store` / `Vary: Cookie`）
 *   7. `netlify.toml` に**静的リダイレクトを足さない**（誰にでも 301 = 存在が漏れる）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // astro-site/
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 認可付きリダイレクト専用ページの一覧。
 * **ここへ足すのは「本文を捨てて別 URL へ寄せた」ときだけ。**
 */
const REDIRECT_ONLY_PAGES = [
  {
    file: 'src/pages/premium-plus.astro',
    /** 正本（本文を持つ側） */
    canonical: '/premium-plus-v2/',
    reason: 'Premium Plus 商品ページを v2 へ一本化（2026-09-08）。配信済みメールの CTA を生かす',
  },
];

/** `.astro` のテンプレート部（frontmatter `---` より後ろ） */
function templateOf(src) {
  const s = String(src);
  if (!s.startsWith('---')) return s;
  const end = s.indexOf('\n---', 3);
  if (end < 0) return '';
  return s.slice(end + 4);
}

test('一覧が空でない（この guard が素通りしていない）', () => {
  assert.ok(REDIRECT_ONLY_PAGES.length > 0, 'リダイレクト専用ページを 1 件も見ていない');
});

for (const page of REDIRECT_ONLY_PAGES) {
  test(`${page.file}: SSR のままサーバー側認可を通す`, () => {
    const raw = read(page.file);
    assert.match(raw, /export const prerender\s*=\s*false/,
      '静的化されている（認可が消え、誰でも読めるようになる）');
    assert.match(raw, /verifyPlanAccess\(/, 'サーバー側認可を通していない');
    assert.match(raw, /SESSION_SIGNING_SECRET/, '署名鍵を使っていない（Cookie を検証していない）');
  });

  test(`${page.file}: 非会員は 404、会員だけ 301（存在を漏らさない）`, () => {
    const raw = read(page.file);
    assert.match(raw, /status:\s*404/, '非会員へ 404 を返していない');
    assert.match(raw, /status:\s*301/, '会員向けのリダイレクトが無い');
    assert.ok(raw.includes(page.canonical), `正本 URL（${page.canonical}）へ送っていない`);
    // 404 の判定が先（認可に失敗した相手へ Location を返さない）
    assert.ok(raw.indexOf('status: 404') < raw.indexOf('status: 301'),
      '認可失敗より前にリダイレクトを返している（存在秘匿が壊れる）');
  });

  test(`${page.file}: 本文を描画しない（商品ページを復活させない）`, () => {
    const raw = read(page.file);
    const body = templateOf(raw).trim();
    assert.equal(body, '',
      `テンプレートに本文が復活している（${body.length} 文字）。正本は ${page.canonical} の 1 枚だけ`);
    // 商品ページ由来の部品・価格を持ち込まない（二重管理へ逆戻りする合図）
    for (const forbidden of ['<AccessControl', '<SessionKeepAlive', 'LIST_PRICE']) {
      assert.equal(raw.includes(forbidden), false,
        `${forbidden} を持っている（本文を持つページに戻りかけている）`);
    }
  });

  test(`${page.file}: 会員かどうかで応答が変わるので CDN で共有しない`, () => {
    const raw = read(page.file);
    assert.match(raw, /'Cache-Control':\s*'private, no-store'/, 'CDN キャッシュを禁止していない');
    assert.match(raw, /'Vary':\s*'Cookie'/, 'Cookie による出し分けを宣言していない');
  });
}

test('netlify.toml に静的リダイレクトを足していない（誰にでも 301 = 存在が漏れる）', () => {
  const toml = read('../netlify.toml');
  for (const page of REDIRECT_ONLY_PAGES) {
    const from = page.file.replace(/^src\/pages/, '').replace(/\.astro$/, '');
    // `from = "/premium-plus"` のような静的リダイレクト定義が無いこと
    const re = new RegExp(`from\\s*=\\s*"${from}/?"`);
    assert.equal(re.test(toml), false,
      `${from} に静的リダイレクトがある。非会員にも 301 が返り、商品の存在が漏れる`);
  }
});
