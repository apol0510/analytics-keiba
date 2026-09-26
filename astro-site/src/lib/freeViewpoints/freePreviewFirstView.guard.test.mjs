/**
 * freePreviewFirstView.guard.test.mjs — `/free-prediction/{jra,nankan}` のファーストビュー配線（2026-09-27 MK 確定）。
 *
 * 「結論・注目馬 → 短い理由 → 無料登録 CTA → 詳しい分析」の並びと、
 * 無料登録 CTA が**ゲートではない**こと（全頭解放・買い目解放と読めない / 中身を出し分けない）を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const COMP = read('src/components/FreePreviewFirstView.astro');
const LIB = read('src/lib/freePreviewFirstView.js');
const PAGES = ['nankan', 'jra'].map((c) => ({ name: c, src: read(`src/pages/free-prediction/${c}.astro`) }));

test('2 ページとも、ヘッダーの直後・プレビューバナーより前にファーストビューを置く', () => {
  for (const { name, src } of PAGES) {
    const header = src.indexOf('class="header-section"');
    const fv = src.indexOf('<FreePreviewFirstView');
    const banner = src.indexOf('class="preview-banner"');
    const firstRace = src.indexOf('locked-content locked-paid');
    assert.ok(header > -1 && fv > -1 && banner > -1, `${name}: 位置を判定できない`);
    assert.ok(header < fv && fv < banner && banner < firstRace, `${name}: 並びが「ヘッダー → 注目馬 → バナー → 各レース」になっていない`);
    assert.ok(src.includes(`category="${name}"`), `${name}: category が違う`);
  }
});

test('注目馬は公開 DTO 経由のライブラリだけから作る', () => {
  for (const { name, src } of PAGES) {
    assert.ok(src.includes("from '../../lib/freePreviewFirstView.js'"), `${name}: 単一源を使っていない`);
    assert.ok(/buildFirstViewPick\(/.test(src), `${name}: buildFirstViewPick を使っていない`);
  }
  assert.ok(LIB.includes("from './freePublicView.js'"), 'ライブラリが公開 DTO を通していない');
  // 有料情報を読む・返す記述を置かない
  for (const bad of ['computerIndex', 'sourceComputerIndex', 'getHorseAiIndex', 'displayScore', 'rawScore', 'bettingLines', '_horse:', 'importance', 'evalPoints']) {
    assert.equal(LIB.includes(bad), false, `ライブラリに ${bad} がある`);
  }
  assert.equal(/\bh\.pt\b|\.pt\b/.test(LIB), false, 'ライブラリが pt を読んでいる');
});

test('コンポーネントは有料情報を描画しない', () => {
  for (const bad of ['computerIndex', 'getHorseAiIndex', 'getDisplayComputerIndex', 'bettingLines', '.pt}', 'role', 'masked-eval']) {
    assert.equal(COMP.includes(bad), false, `コンポーネントに ${bad} がある`);
  }
});

test('無料登録 CTA は /free-signup/ へ進み、何が得られるかを書く', () => {
  assert.ok(COMP.includes('href="/free-signup/"'), '/free-signup/ への導線が無い');
  assert.ok(COMP.includes('MEMBER_EXTRAS.benefits'), '得られるもの（単一源）を出していない');
  assert.ok(COMP.includes('MEMBER_EXTRAS.note'), '「買い目は有料版のみ」の注記が無い');
  assert.ok(COMP.includes('料金はかかりません'), '無料であることが書かれていない');
});

test('無料登録 CTA は全頭解放・買い目解放と読める文言を持たない（2026-08-20 撤廃分を復活させない）', () => {
  for (const bad of ['全頭', '解放', '買い目が見', '買い目を見', 'locked-free', 'cta-badge-free', 'locked-content']) {
    assert.equal(COMP.includes(bad), false, `CTA に ${bad} がある`);
  }
});

test('無料登録 CTA はゲートではない（中身を出し分けず、CTA の表示だけ切り替える）', () => {
  // 出し分けの対象は data-fpfv-guest-only（CTA）だけ
  const targets = [...COMP.matchAll(/querySelectorAll\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['[data-fpfv-guest-only]'], `CTA 以外を出し分けている: ${targets}`);
  const guestBlocks = (COMP.match(/data-fpfv-guest-only>/g) || []).length;
  assert.equal(guestBlocks, 1, '未ログイン向けブロックは CTA 1 つだけ');
  // 既定は表示（JS が動かなくても CTA が出る）
  assert.equal(/<div[^>]*data-fpfv-guest-only[^>]*\bhidden\b/.test(COMP), false, '既定で CTA を隠している');
  // ログイン判定は /free/ と同じ 5 キー
  for (const k of ['user-plan', 'userPlan', 'user_plan', 'user_email', 'userEmail', 'auth_data', 'isLoggedIn']) {
    assert.ok(COMP.includes(`'${k}'`), `ログイン判定に ${k} が無い`);
  }
});

test('有料 CTA は各レース 1 枚のまま（無料登録 CTA と混ぜない）', () => {
  for (const { name, src } of PAGES) {
    const count = (src.match(/class="locked-content/g) || []).length;
    assert.equal(count, 1, `${name}: 有料 CTA の数が変わった（${count}）`);
    assert.ok(src.includes('class="preview-banner-cta" href="/pricing/"'), `${name}: バナーの有料導線が消えた`);
  }
});

test('GA4 のイベントを足さない（計測は既存の funnel-analytics.js だけ）', () => {
  for (const src of [COMP, LIB, ...PAGES.map((p) => p.src)]) {
    assert.equal(/gtag\s*\(/.test(src), false, 'ページ側で gtag を呼んでいる');
    assert.equal(src.includes('AkFunnel'), false, 'ページ側で計測関数を呼んでいる');
  }
});

test('スマホで読める大きさ（本文 0.85rem 以上 / 馬名は大きく）', () => {
  const sizes = [...COMP.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0);
  assert.ok(Math.min(...sizes) >= 0.85, `小さすぎる文字がある: ${Math.min(...sizes)}rem`);
  assert.ok(/\.fpfv-name\s*\{[^}]*font-size:\s*1\.[3-9]/.test(COMP), '馬名が大きくない');
  assert.ok(/\.fpfv-signup-cta\s*\{[^}]*display:\s*block/.test(COMP), 'CTA が押しやすい幅になっていない');
});
