/**
 * navLayout.guard.test.mjs — 上部ナビが**入りきる件数**であることを守る
 *
 * ## なぜ必要か（2026-08-25 MK 指摘「ナビが長い」）
 *
 * ログイン後は `🔔 お知らせ` が加わって上部が 7 項目になり、
 * ロゴ 205px ＋ メニュー 807px = **1012px** がヘッダの **955px** に収まらなくなっていた
 * （ローカル実測）。項目を足すたびに静かに窮屈になり、気づくのは画面が崩れてから。
 *
 * そこで「一度読めば足りる紹介ページ」をフッターへ移した。
 * ⚠️ **移した先から辿れること**まで確認する（消しただけにしない）。
 *
 * 数えるのは**同時に画面へ出る最大数**。`nav-signup` / `nav-login` は未ログイン、
 * `nav-notice` / `nav-dashboard` はログイン後にだけ出るので、足し合わせない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LAYOUT = new URL('../../layouts/BaseLayout.astro', import.meta.url).pathname;
const src = readFileSync(LAYOUT, 'utf8');

/** `<ul class="nav-menu">` 直下の `<li>` を取り出す（submenu の中は数えない） */
function topLevelItems() {
  const start = src.indexOf('<ul class="nav-menu"');
  assert.ok(start > 0, '上部ナビが見つからない');
  const block = src.slice(start, src.indexOf('</ul>', src.indexOf('<li', start)) + 0);
  // ネストを追うより、行頭インデントで直下の <li> を拾うほうが壊れにくい
  const menu = src.slice(start, src.indexOf('\n                    </ul>', start));
  return menu.split('\n').filter((l) => /^ {24}<li[ >]/.test(l));
}

/** 未ログイン / ログイン後で**同時に**出る項目数 */
function simultaneousCounts() {
  const items = topLevelItems();
  const always = items.filter((l) => !l.includes('nav-auth-item'));
  // 2026-09-02: 先頭項目も入れ替え制になった（未ログイン=nav-free / ログイン後=nav-today）。
  // ⚠️ ここに id を書き足し忘れると、その項目が**どちらの合計にも入らず**、
  //    上限 6 の検査が静かに緩む（項目を足しても気づけなくなる）。
  const loggedOut = items.filter((l) => /id="nav-(signup|login|free)"/.test(l));
  const loggedIn = items.filter((l) => /id="nav-(notice|dashboard|today)"/.test(l));
  return {
    items,
    loggedOut: always.length + loggedOut.length,
    loggedIn: always.length + loggedIn.length,
  };
}

test('上部ナビは同時に 6 項目まで（実測でヘッダに収まる上限）', () => {
  const c = simultaneousCounts();
  assert.ok(c.items.length > 0, 'ナビの項目を数えられていない（検査が素通りしている）');
  assert.ok(c.loggedOut <= 6, `未ログイン時に ${c.loggedOut} 項目ある`);
  assert.ok(c.loggedIn <= 6, `ログイン後に ${c.loggedIn} 項目ある`);
});

test('入れ替え制の項目は必ずどちらかの合計に入る（検査が静かに緩まない）', () => {
  const items = topLevelItems();
  const authItems = items.filter((l) => l.includes('nav-auth-item'));
  const counted = items.filter((l) => /id="nav-(signup|login|free|notice|dashboard|today)"/.test(l));
  assert.equal(
    authItems.length, counted.length,
    '出し分け項目のうち、上の集計 id に載っていないものがある'
    + `（未集計: ${authItems.filter((l) => !counted.includes(l)).map((l) => (l.match(/id="([^"]+)"/) || [])[1]).join(', ')}）`,
  );
});

test('紹介ページはフッターから辿れる（ナビから外した先が行き止まりにならない）', () => {
  const footer = src.slice(src.indexOf('<footer'));
  for (const [href, label] of [['/about/', '開発者'], ['/technology/', 'AI技術']]) {
    assert.ok(footer.includes(`href="${href}"`), `フッターに ${href} が無い`);
    assert.ok(footer.includes(label), `フッターの言葉「${label}」が無い（ナビと同じ言葉で探せない）`);
  }
});

test('スマホのハンバーガーには「サイト紹介」を残す（フッターが遠いため）', () => {
  const mobile = src.slice(src.indexOf('id="mobile-nav-menu"'), src.indexOf('<footer'));
  assert.ok(mobile.includes('サイト紹介'), 'スマホからも辿れなくなっている');
  assert.ok(mobile.includes('href="/technology/"'), 'AI技術へ行けない');
});

test('フッターに同じページを二重に置かない（どれを押せばいいか迷わせない）', () => {
  const footer = src.slice(src.indexOf('<footer'));
  const hrefs = [...footer.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  const dup = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
  assert.deepEqual([...new Set(dup)], [], `フッターに重複したリンクがある: ${[...new Set(dup)]}`);
});
