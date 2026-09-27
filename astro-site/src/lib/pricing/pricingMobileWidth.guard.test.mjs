/**
 * pricingMobileWidth.guard.test.mjs — /pricing/ は主要スマホ幅（320 / 360 / 390px）で横スクロールしない（2026-09-27）。
 *
 * 事象: 無料プランのボタンだけ <a> 要素で既定の box-sizing: content-box のため、
 *       `.plan-button { width: 100% }` ＋ 余白 ＋ 枠でカードからはみ出し、ページが 401px（390px 画面）まで広がった。
 *       <button> 要素はブラウザ既定で border-box なので、他のプランのボタンでは起きていなかった。
 * 修正: `.plan-button` に box-sizing: border-box。
 *
 * 実測（プラン出し分け 5 状態・銀行振込モーダル表示中）は PR で実施。ここでは再発の原因を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const page = readFileSync(join(ROOT, 'src/pages/pricing.astro'), 'utf-8');
const style = page.slice(page.indexOf('<style'), page.lastIndexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (sel) => [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]);

test('.plan-button は幅に余白・枠を含める（box-sizing: border-box）', () => {
  const decl = rules('.plan-button').join(';');
  assert.match(decl, /box-sizing:\s*border-box/, '.plan-button に border-box が無い（<a> のボタンがカードからはみ出す）');
  assert.match(decl, /width:\s*100%/, '前提（width: 100%）が変わった');
});

test('<a> で作ったプランボタンがある限り、上の指定が要る', () => {
  const anchors = [...page.matchAll(/<a\b[^>]*class="[^"]*\bplan-button\b[^"]*"/g)];
  assert.ok(anchors.length >= 1, '<a> のプランボタンが無くなった（前提が変わったらこのテストを見直す）');
  // どのプランボタンも box-sizing を content-box に戻していない
  for (const sel of ['.plan-button-free', '.plan-button-standard', '.plan-button-annual', '.plan-button-monthly', '.plan-button-lifetime', '.plan-button-premium']) {
    assert.equal(/box-sizing:\s*content-box/.test(rules(sel).join(';')), false, `${sel} が content-box に戻している`);
  }
});

test('無料プランの CTA の文言とリンク先は変えていない', () => {
  assert.ok(/<a href="\/free-signup\/" class="plan-button plan-button-free">\s*無料会員登録\s*<\/a>/.test(page), '無料プランの CTA が変わった');
});
