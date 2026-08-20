/**
 * accordionClose.guard.test.mjs
 *
 * 2026-08-20: レースを開くと中身が長くなる（出走馬 10 数頭 × 過去 5 走）ため、
 * 閉じるのに一番上まで戻る必要があった。閉じやすさを次で担保する。
 *
 *   ① 中身の末尾に閉じるボタンを置く
 *   ② そのボタンは sticky で、スクロール中も画面内に残る
 *   ③ 閉じたらそのレースの見出しへ戻す（画面外にいるときだけ）
 *   ④ 別のレースを開いたら前のレースは自動で閉じる（同時に開くのは 1 つ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const board = readFileSync(join(ROOT, 'src/components/RaceViewpointsBoard.astro'), 'utf-8');

test('開いた中身の末尾に閉じるボタンがある', () => {
  assert.ok(board.includes('data-close-race'), '閉じるボタンの目印が無い');
  assert.ok(board.includes('rvb-closebtn'), '閉じるボタンが無い');
  // summary より後ろ（＝中身の末尾側）に置かれていること
  const summary = board.indexOf('rvb-detail-sum');
  const closeBtn = board.indexOf('data-close-race');
  assert.ok(summary > -1 && closeBtn > summary, '閉じるボタンが中身の中に無い');
});

test('閉じるボタンはスクロール中も押せる（sticky）', () => {
  const m = board.match(/\.rvb-closebar\s*\{([^}]*)\}/);
  assert.ok(m, '.rvb-closebar のスタイルが無い');
  assert.ok(/position:\s*sticky/.test(m[1]), 'sticky になっていない（長い中身で押せなくなる）');
  assert.ok(/bottom:\s*0/.test(m[1]), '画面下に留まる指定が無い');
});

test('ボタンは button 要素で、レース番号が分かる', () => {
  assert.ok(/<button[^>]*class="rvb-closebtn"/.test(board), 'button 要素になっていない');
  assert.ok(board.includes('R を閉じる'), 'どのレースを閉じるのか分からない');
});

test('閉じたらそのレースの見出しへ戻す', () => {
  assert.ok(board.includes('scrollIntoView'), '閉じたあとの位置合わせが無い');
  assert.ok(/getBoundingClientRect[\s\S]{0,240}scrollIntoView/.test(board),
    '画面内にいるかを見ずに毎回スクロールしている');
});

test('同時に開くのは 1 つだけ', () => {
  assert.ok(/details\.rvb-detail\[open\]/.test(board), '他の開いているレースを探していない');
  assert.ok(/other\.open\s*=\s*false/.test(board), '他のレースを閉じていない');
});

test('summary でのトグルは残す（閉じ方を 1 つに減らさない）', () => {
  assert.ok(board.includes('<summary class="rvb-detail-sum"'), 'summary が無い');
  assert.equal(board.includes('preventDefault'), false, 'summary の既定動作を止めている');
});

/* ── 閉じている状態は塗り＋フル幅（2026-08-21 追加） ────────────────
   細い枠線だと押せることが伝わらず、全レースが同じ見た目で並ぶため
   一覧が「白と水色のツートンで単調」に見えていた（MK 指摘）。
   色相は変えず、塗りにして解決した。ボタン化・バッジ化でクリック領域を
   縮める案は、押せる幅が 931px → 約 230px になるため見送っている。 */
{
  const style = board.slice(board.indexOf('<style'), board.lastIndexOf('</style>'));

  test('閉じている状態に塗りの背景がある（枠線だけに戻さない）', () => {
    const m = style.match(/\.rvb-detail:not\(\[open\]\)\s*\{([^}]*)\}/);
    assert.ok(m, '.rvb-detail:not([open]) の指定が無い');
    assert.match(m[1], /background:\s*linear-gradient/,
      '閉じている状態が塗りでない。枠線だけだと押せることが伝わらない');
  });

  test('閉じている状態の指定が [open] を侵さない（開いた時はシアンのまま）', () => {
    // `:not([open])` を使っていれば、開いた瞬間に自動で解除される。
    const bad = /\.rvb-detail\s*\{[^}]*background:\s*linear-gradient/;
    assert.equal(bad.test(style), false,
      '.rvb-detail 本体に塗りを書くと開いた状態にも効いてしまう。:not([open]) を使うこと');
    assert.match(style, /\.rvb-detail\[open\][^{]*\{[^}]*border-color:\s*#22d3ee/,
      '開いている状態のシアンが消えている');
  });

  test('見出しをフル幅のまま保つ（ボタン化・バッジ化しない）', () => {
    const m = style.match(/\.rvb-detail:not\(\[open\]\)\s+\.rvb-detail-sum\s*\{([^}]*)\}/);
    if (!m) return;
    for (const shrink of ['width: auto', 'display: inline', 'float:']) {
      assert.equal(m[1].includes(shrink), false,
        `閉じた見出しを縮めている（${shrink}）。押せる幅が狭まりスマホで押しづらくなる`);
    }
  });
}

/* ── レース番号の色（2026-08-21 追加） ────────────────────────────
   もとは #38bdf8 で、閉じたアコーディオンの塗りと同じ水色だったため
   1 枚のカードに水色が 2 つ並んでいた。薄い緑へ分離した。
   濃い色に変えると暗い背景に沈むので、明るさを保つことも固定する。 */
{
  const style = board.slice(board.indexOf('<style'), board.lastIndexOf('</style>'));
  const rule = (style.match(/\.rvb-r\s*\{([^}]*)\}/) || [])[1] || '';
  const color = (rule.match(/color:\s*(#[0-9a-fA-F]{6})/) || [])[1] || '';

  test('レース番号がアコーディオンと同じ水色に戻っていない', () => {
    assert.ok(color, '.rvb-r の色指定が読めない');
    assert.notEqual(color.toLowerCase(), '#38bdf8',
      'レース番号が閉じたアコーディオンと同じ水色。カード内で水色が 2 つになる');
  });

  test('レース番号に枠や塗りを足していない（識別子なので装飾しない）', () => {
    for (const deco of ['background:', 'border:']) {
      assert.equal(rule.includes(deco), false, `.rvb-r に ${deco} を足している`);
    }
  });

  test('レース番号が暗い背景に沈まない明るさである', () => {
    // 濃紺のカード背景に対するコントラスト比が 4.5:1 以上（小さい文字の推奨値）。
    const rgb = [1, 3, 5].map((i) => parseInt(color.substr(i, 2), 16));
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (Math.max(lum(rgb), lum([16, 26, 45])) + 0.05) / (Math.min(lum(rgb), lum([16, 26, 45])) + 0.05);
    assert.ok(ratio >= 4.5,
      `レース番号のコントラストが ${ratio.toFixed(1)}:1。暗い背景に沈んで読みにくい（4.5:1 以上にすること）`);
  });
}
