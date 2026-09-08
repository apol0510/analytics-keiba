/**
 * sessionKeepAlive.guard.test.mjs — ak_session の延長経路が配線され続けることを強制する
 *   node --test src/lib/auth/sessionKeepAlive.guard.test.mjs
 *   （`npm run test:auth-session` の glob に含まれ、check:safety / CI で強制実行される）
 *
 * ── 背景 ────────────────────────────────────────────────────
 * `ak_session` の Max-Age は発行時に固定される（`DEFAULT_SESSION_TTL_MS` = 30日）。
 * 誰も `refresh-session` を叩かなければ **一度も延びず、最終ログインから 30 日で
 * 必ず再ログイン**になる。会員には「またメール認証を要求された」に見える。
 *
 * 2026-08-10 時点で keep-alive が入っていたのは `/premium-plus/` だけで、
 * `gatePaidPage` が守る有料予想ページ 11 枚はどれも叩いていなかった。
 * → 予想ページしか見ない会員（＝大半）は 30 日ごとに必ず締め出されていた。
 *
 * ── ここで守る恒久条件 ──────────────────────────────────────────
 * 1. `gatePaidPage` を使う SSR ページは **すべて** `SessionKeepAlive` を持つ
 *    （新しい有料ページを足したときの配線漏れを検知する）
 * 2. keep-alive の実装は `SessionKeepAlive.astro` **1 箇所だけ**
 *    （ページへ直接コピーしない。基準がズレて片方だけ直る事故を防ぐ）
 * 3. 会員と確定していないページ（無料・静的）へ置かない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const PAGES = join(SRC, 'pages');
const COMPONENT = join(SRC, 'components/SessionKeepAlive.astro');

function listAstro(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listAstro(full));
    else if (e.endsWith('.astro')) out.push(full);
  }
  return out;
}

const pageFiles = listAstro(PAGES).map((f) => ({ path: f, src: readFileSync(f, 'utf8') }));
const rel = (f) => relative(SRC, f);

/** サーバー側で会員と確定しているページ（= keep-alive を置いてよい／置くべき）。 */
const isMemberConfirmed = (src) => /gatePaidPage\(/.test(src) || /verifyPlanAccess\(/.test(src);
const hasKeepAlive = (src) => /<SessionKeepAlive\s*\/>/.test(src);

/**
 * `.astro` のテンプレート部（frontmatter `---` より後ろ）。
 *
 * ⚠️ keep-alive は**描画された HTML の中で動く script**なので、本文を描画しない
 *    ページ（認可付きリダイレクト専用など）に置いても**動かない**。
 *    2026-09-08: `premium-plus.astro` が v2 へのリダイレクト専用になったのに、
 *    この guard が v1 にも keep-alive を要求し続けて CI が赤くなった。
 *    要求する対象を「**本文を描画する**会員確定ページ」へ限定する。
 *    リダイレクト専用ページ側の契約は `redirectOnlyPages.guard.test.mjs` が固定する。
 */
function templateOf(src) {
  const s = String(src);
  if (!s.startsWith('---')) return s;
  const end = s.indexOf('\n---', 3);
  if (end < 0) return '';
  return s.slice(end + 4);
}
const rendersBody = (src) => templateOf(src).trim().length > 0;

test('部品が存在し、refresh-session を叩く実装を持つ', () => {
  const src = readFileSync(COMPONENT, 'utf8');
  assert.match(src, /\/\.netlify\/functions\/refresh-session/);
  assert.match(src, /credentials:\s*'include'/, 'Cookie を送っていない');
  assert.match(src, /method:\s*'POST'/);
  assert.match(src, /visibilitychange/, '復帰時の再延長が無い');
  // is:inline なので TS を書かない（inlineScriptNoTs.guard.test.mjs と対）
  assert.match(src, /<script is:inline>/);
});

test('gatePaidPage を使う SSR ページはすべて配線されている', () => {
  const gated = pageFiles.filter((p) => /gatePaidPage\(/.test(p.src));
  assert.ok(gated.length >= 11, `gatePaidPage 利用ページが ${gated.length} 件（想定 11 以上）`);
  const missing = gated.filter((p) => !hasKeepAlive(p.src)).map((p) => rel(p.path));
  assert.deepEqual(missing, [],
    'keep-alive 未配線の有料ページがある（30日で強制再ログインになる）:\n' + missing.join('\n'));
});

test('本文を描画する会員確定ページは、すべて同じ部品を使う（実装を 2 つ持たない）', () => {
  const rendering = pageFiles.filter((p) => isMemberConfirmed(p.src) && rendersBody(p.src));
  assert.ok(rendering.length >= 11,
    `会員確定かつ本文を描画するページが ${rendering.length} 件（検出が壊れている疑い）`);
  const missing = rendering.filter((p) => !hasKeepAlive(p.src)).map((p) => rel(p.path));
  assert.deepEqual(missing, [],
    'keep-alive 未配線の会員ページがある（30日で強制再ログインになる）:\n' + missing.join('\n'));
  // 商品ページの正本（v2）が対象から漏れていないこと
  const v2 = pageFiles.find((x) => x.path.endsWith('/premium-plus-v2.astro'));
  assert.ok(v2, 'premium-plus-v2.astro が見つからない');
  assert.ok(rendering.includes(v2), 'Premium Plus 商品ページが検査対象から外れている');
  assert.ok(hasKeepAlive(v2.src), 'premium-plus-v2.astro が SessionKeepAlive を使っていない');
});

test('本文を描画しないページには置かない（置いても動かない）', () => {
  const useless = pageFiles
    .filter((p) => hasKeepAlive(p.src) && !rendersBody(p.src))
    .map((p) => rel(p.path));
  assert.deepEqual(useless, [],
    'リダイレクト専用ページに keep-alive を置いている（描画されないので動かない）:\n'
    + useless.join('\n'));
});

test('keep-alive の実装はページに直書きしない（単一源）', () => {
  const inlined = pageFiles
    .filter((p) => /\/\.netlify\/functions\/refresh-session/.test(p.src))
    .map((p) => rel(p.path));
  assert.deepEqual(inlined, [],
    'ページが refresh-session を直接叩いている（SessionKeepAlive.astro へ寄せること）:\n'
    + inlined.join('\n'));
});

test('会員と確定していないページへ置かない', () => {
  const stray = pageFiles
    .filter((p) => hasKeepAlive(p.src) && !isMemberConfirmed(p.src))
    .map((p) => rel(p.path));
  assert.deepEqual(stray, [],
    '未ログイン利用者が毎表示 401 を叩くだけになる。会員確定ページ以外へ置かないこと:\n'
    + stray.join('\n'));
});

test('1 ページにつき 1 回だけ置く（多重 ping しない）', () => {
  const dup = pageFiles
    .map((p) => [rel(p.path), (p.src.match(/<SessionKeepAlive\s*\/>/g) || []).length])
    .filter(([, n]) => n > 1);
  assert.deepEqual(dup, [], `同一ページに複数配置されている: ${JSON.stringify(dup)}`);
});
