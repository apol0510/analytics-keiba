/**
 * buttonProminence.guard.test.mjs — ボタンの**大きさと目立ち方**を固定する
 *
 * ## なぜ必要か（2026-08-25 MK 指摘）
 *
 * 1. **申込ボタンが狙いより 1.5 倍大きかった**
 *    このサイトには `box-sizing: border-box` の共通指定が無い。
 *    そのため `min-height: 44px` + `padding: .7rem` が**足し算**され、
 *    実測 66.4px の帯のようなボタンになっていた（ローカル実測値）。
 *    ⚠️ ブラウザの違いではない。マイページの申込ボタンと
 *       `/pricing/`・`/free-signup/` のご案内ボタンは**同じ大きさ**でなければならない。
 *
 * 2. **「本日の穴馬抽出ツール」が目立ちすぎた**
 *    オレンジの塗りつぶし + 浮き上がり + 強い影で、
 *    本文（予想）より主張が強かった。12 ページに同じ CSS がコピーされている。
 *
 * ソースの文字列を読む guard。**新しいページを足したときも自動で対象に入る**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;

/** src/pages 以下の .astro を全部集める（ページを足しても取りこぼさない） */
function allPages(dir = path.join(ROOT, 'src/pages'), out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allPages(p, out);
    else if (e.name.endsWith('.astro')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');

/** セレクタ 1 個ぶんの `{ ... }` を取り出す（同名が複数あれば全部） */
function rules(css, selector) {
  const re = new RegExp(`(?<![\\w.-])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  return [...css.matchAll(re)].map((m) => m[1]);
}
/** ルール内の 1 プロパティの値 */
function decl(rule, prop) {
  const m = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:([^;]*)`, 'i').exec(rule);
  return m ? m[1].trim() : null;
}

// ── 1. 申込ボタンの大きさ ────────────────────────────────
const DASHBOARD = path.join(ROOT, 'src/pages/dashboard.astro');
const BANNER = path.join(ROOT, 'src/components/CampaignBanner.astro');

test('申込ボタンは padding を足し算されない（border-box を明示する）', () => {
  // ⚠️ ここを外すと min-height 40px の指定が実測 60px になる
  for (const [file, sel] of [[DASHBOARD, '#campaign-section .campaign-apply'], [BANNER, '.ak-cb-cta']]) {
    const [rule] = rules(read(file), sel);
    assert.ok(rule, `${rel(file)}: ${sel} が無い`);
    assert.equal(decl(rule, 'box-sizing'), 'border-box', `${rel(file)}: ${sel} に border-box が無い`);
  }
});

test('マイページと案内バナーの申込ボタンは**同じ大きさ**', () => {
  // 別々に育つと「無料会員だけボタンが大きい」ように見える（2026-08-25 指摘）
  const a = rules(read(DASHBOARD), '#campaign-section .campaign-apply')[0];
  const b = rules(read(BANNER), '.ak-cb-cta')[0];
  for (const prop of ['min-height', 'padding', 'font-size', 'font-weight']) {
    assert.equal(decl(a, prop), decl(b, prop), `${prop} が揃っていない`);
  }
});

test('申込ボタンは控えめな高さに収まる（帯にしない）', () => {
  const rule = rules(read(DASHBOARD), '#campaign-section .campaign-apply')[0];
  const h = Number(String(decl(rule, 'min-height')).replace('px', ''));
  // 指で押せる下限（44px）は確保しつつ、それを超える指定はしない
  assert.equal(h, 44, `min-height=${h}px は大きすぎ／小さすぎ`);
});

// ── 2. 穴馬抽出ツールのリンク ────────────────────────────
const DARK_PAGES = allPages().filter((p) => read(p).includes('.dark-horse-link-btn'));

test('穴馬リンクを置いているページを取りこぼしていない', () => {
  // 0 件なら guard が素通りしている（検査対象の消失を失敗として扱う）
  assert.ok(DARK_PAGES.length >= 12, `検査対象が ${DARK_PAGES.length} ページしかない`);
});

test('穴馬リンクは塗りつぶしのオレンジにしない（本文より目立たせない）', () => {
  for (const p of DARK_PAGES) {
    const [rule] = rules(read(p), '.dark-horse-link-btn');
    assert.ok(rule, `${rel(p)}: ルールが無い`);
    const bg = String(decl(rule, 'background') ?? '');
    assert.ok(!/linear-gradient/.test(bg), `${rel(p)}: 塗りつぶしのグラデーションが残っている`);
    assert.match(bg, /rgba\(245,\s*158,\s*11/, `${rel(p)}: 想定の淡い背景ではない（${bg}）`);
  }
});

test('穴馬リンクは浮き上がらせない・強い影を落とさない', () => {
  for (const p of DARK_PAGES) {
    const [hover] = rules(read(p), '.dark-horse-link-btn:hover');
    assert.ok(hover, `${rel(p)}: :hover が無い`);
    assert.equal(decl(hover, 'transform'), null, `${rel(p)}: 浮き上がりが残っている`);
    assert.equal(decl(hover, 'box-shadow'), null, `${rel(p)}: 影が残っている`);
  }
});

test('穴馬リンクの文字は白い見出しにしない（淡い琥珀色）', () => {
  for (const p of DARK_PAGES) {
    const [title] = rules(read(p), '.dark-horse-title');
    assert.ok(title, `${rel(p)}: .dark-horse-title が無い`);
    const color = String(decl(title, 'color') ?? '');
    assert.ok(!/^(#fff|#ffffff|white)$/i.test(color), `${rel(p)}: 白い見出しのまま`);
  }
});

test('全ページで同じ大きさ（ページごとに育たせない）', () => {
  const sig = (p) => {
    const [r] = rules(read(p), '.dark-horse-link-btn');
    return ['padding', 'border-radius', 'gap', 'background'].map((k) => decl(r, k)).join('|');
  };
  const first = sig(DARK_PAGES[0]);
  for (const p of DARK_PAGES) assert.equal(sig(p), first, `${rel(p)}: 他ページと大きさが違う`);
});
