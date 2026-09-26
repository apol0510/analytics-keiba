/**
 * freeFunnelRoles.guard.test.mjs — 無料導線のページ役割（2026-09-27 MK 確定 / docs/spec.md 冒頭）。
 *
 *   /free/            = 無料予想本体・無料会員獲得の主入口（流入 → /free/ → /free-signup/）
 *   /free-prediction/ = 有料版プレビュー（主目的は有料転換。無料登録 CTA で有料 CTA と競合させない）
 *
 * 過去（8/20 以前）の「/free-prediction/ = 無料予想」と混同した変更を検知する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const board = read('src/components/RaceViewpointsBoard.astro');
const markup = board.slice(board.indexOf('<section class="rvb">'), board.indexOf('<script is:inline>'));

test('/free/ は無料登録の入口を持つ（無料獲得の主入口）', () => {
  for (const c of ['jra', 'nankan']) {
    assert.ok(read(`src/pages/free/${c}.astro`).includes('<RaceViewpointsBoard'), `/free/${c}/ が無料予想ボードを使っていない`);
  }
  // レースを開かなくても辿れる登録入口がある（アコーディオンの外）
  const topgate = markup.indexOf('class="rvb-topgate"');
  assert.ok(topgate > -1, '登録入口が無い');
  assert.match(markup.slice(topgate, topgate + 800), /href="\/free-signup\/"/);
});

test('/free/ の無料登録 CTA は主役にしない（価値体験 → 詳細 → 登録の順）', () => {
  const answer = markup.indexOf('class="rvb-answer"');
  const list = markup.indexOf('<ol class="rvb-list"');
  const firstSignup = markup.indexOf('href="/free-signup/"');
  assert.ok(answer > -1 && list > -1 && firstSignup > -1);
  assert.ok(answer < list && list < firstSignup, '無料登録 CTA が無料予想より前にある');
});

test('/free-prediction/ は有料版プレビュー: 有料導線を持ち、無料登録 CTA を置かない', () => {
  for (const c of ['jra', 'nankan']) {
    const src = read(`src/pages/free-prediction/${c}.astro`);
    assert.ok(src.includes('href="/pricing/"'), `${c}: 有料導線が無い`);
    assert.equal(src.includes('/free-signup/'), false, `${c}: 無料登録 CTA がある（有料 CTA と競合させない）`);
  }
});

test('GA4 の段: 無料予想は /free/ だけ。/free-prediction/ は有料版プレビューとして別の段', () => {
  const ga4 = read('docs/GA4_CONVERSION_FUNNEL.md');
  assert.equal(ga4.includes('^/free(-prediction)?/'), false, '/free/ と /free-prediction/ を 1 段に数えている');
  assert.ok(ga4.includes('Page path が `^/free/`'), '無料予想の段が /free/ になっていない');
  assert.ok(ga4.includes('有料版プレビュー 到達'), '有料版プレビューの段が無い');
});

test('役割の正本が spec にある', () => {
  const spec = read('../docs/spec.md');
  assert.ok(spec.includes('# 無料導線のページ役割と現在のファネル'), '役割の正本が無い');
  assert.ok(/\/free\/\{jra,nankan\}`\*\* \| \*\*無料予想の本体\*\*/.test(spec), '/free/ の役割が無い');
  assert.ok(spec.includes('**`/free-prediction/` → 無料登録 を主要ファネルとして扱わない。**'));
});
