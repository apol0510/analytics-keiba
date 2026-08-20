/**
 * board.guard.test.mjs — 表示側（RaceViewpointsBoard.astro / ページ）の恒久ルールを固定する。
 *
 * 2026-08-19 のユーザー目視で確定した仕様を、コンポーネントのソースに対する検査で守る:
 *   - 出走馬と無料公開可能な印を詳細内に出す
 *   - 買い目 / pt / AI総合指数 / 役割 / 特徴量を出さない
 *   - CTA は /free-prediction/ を有料版プレビューとして案内する
 *   - details の開閉状態が識別できる
 *   - 意味別の多色 + 記号（色だけに依存しない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const board = readFileSync(join(ROOT, 'src/components/RaceViewpointsBoard.astro'), 'utf-8');
const loader = readFileSync(join(ROOT, 'src/lib/freeViewpoints/loadRaceViewpoints.js'), 'utf-8');

/**
 * コメントを落としてから検査する。
 * 「◯◯は出さない」と**説明している行**まで違反にしてしまうと、
 * 意図を書き残せなくなるため。検査対象は実際のコードだけ。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
const boardCode = stripComments(board);
const loaderCode = stripComments(loader);
const pages = ['jra', 'nankan'].map((c) => readFileSync(join(ROOT, `src/pages/race-viewpoints/${c}.astro`), 'utf-8'));

// ─── 出走馬を詳細内に出す ─────────────────────────────────────

test('詳細に出走馬の行を出す（別ページへ送るだけにしない）', () => {
  assert.ok(board.includes('horseRows'), '出走馬行を描画していない');
  assert.ok(board.includes('rvb-horse-name'), '馬名を出していない');
  assert.ok(board.includes('rvb-horse-num'), '馬番を出していない');
  assert.ok(board.includes('rvb-horse-mark'), '印の枠が無い');
});

test('馬単位の条件変化を出す（レースタグの根拠を馬まで辿れる）', () => {
  for (const k of ['distanceChanged', 'firstCourse', 'jockeyChanged', 'easyCompare']) {
    assert.ok(board.includes(k), `${k} を馬単位で出していない`);
  }
  assert.ok(board.includes('HORSE_CHANGE_CHIP'), 'チップ定義を使っていない');
});

// ─── 無料公開範囲を迂回しない ─────────────────────────────────

test('印は公開 DTO 経由でしか作らない（buildFreePublicRows を通す）', () => {
  assert.ok(loader.includes('buildFreePublicRows'), '公開 DTO の単一源を経由していない');
  assert.ok(!loaderCode.includes('row._horse'), '生データ参照を持ち出している');
  assert.ok(!boardCode.includes('_horse'), 'コンポーネントが生データを触っている');
});

test('公開してよい印だけを出す（headlineMark のみ）', () => {
  assert.ok(board.includes('headlineMark'), '公開 DTO の印を使っていない');
  // 役割名そのものを描画していないこと（◎○▲△ は DTO 側が決める）
  for (const role of ['本命', '対抗', '単穴', '連下', '補欠', '押さえ']) {
    assert.equal(boardCode.includes(role), false, `役割名「${role}」を描画してはいけない`);
  }
});

// ─── 有料項目の非表示 ─────────────────────────────────────────

test('買い目・pt・AI総合指数・役割・特徴量を描画しない', () => {
  const banned = [
    'bettingLines', 'betPoints', 'umatan', 'sanrenpuku',
    'computerIndex', 'sourceComputerIndex', 'getHorseAiIndex', 'getDisplayComputerIndex',
    'featureScores', 'importance', 'evalPoints', 'analyticsScore', 'displayScore', 'rawScore',
    '.pt', 'horse.role', 'AI総合指数', '累積スコア',
  ];
  for (const b of banned) {
    assert.equal(boardCode.includes(b), false, `コンポーネントのコードに ${b} が含まれている`);
    assert.equal(loaderCode.includes(b), false, `loader のコードに ${b} が含まれている`);
  }
});

test('有料データを読むモジュールを import していない', () => {
  for (const src of [boardCode, loaderCode]) {
    assert.equal(/from '.*shared-prediction-logic/.test(src), false);
    assert.equal(/from '.*loadFeatureScores/.test(src), false);
    assert.equal(/from '.*mainRaceBetting/.test(src), false);
    assert.equal(/from '.*osaeClassification/.test(src), false);
  }
});

// ─── CTA ──────────────────────────────────────────────────────

test('CTA は /free-prediction/ を有料版プレビューとして案内する', () => {
  assert.ok(board.includes('PAID_CTA'), 'CTA 定義を使っていない');
  assert.ok(board.includes('freeUrl'), '/free-prediction/ へのリンクが無い');
  assert.equal(board.includes('出走馬・印を見る'), false, '旧 CTA 文言が残っている');
  for (const p of pages) {
    assert.ok(/freeUrl="\/free-prediction\/(jra|nankan)\/"/.test(p), 'ページが /free-prediction/ を渡していない');
  }
});

// ─── details の開閉状態 ───────────────────────────────────────

test('details を開いた状態が class / 属性で識別できる', () => {
  assert.ok(board.includes('is-open'), '開いている状態の class が無い');
  assert.ok(board.includes("data-open"), '開閉状態の属性が無い');
  assert.ok(board.includes('.rvb-detail[open]'), '開いたときのスタイルが無い');
});

// ─── 色だけに依存しない ───────────────────────────────────────

test('タグ・状態・チップに記号と文字がある（色だけに意味を持たせない）', () => {
  assert.ok(board.includes('TAG_ICON'), 'タグの記号を出していない');
  assert.ok(board.includes('STATE_ICON'), '状態の記号を出していない');
  assert.ok(board.includes('rvb-legend'), '凡例が無い');
});

test('意味別に別の色クラスを持つ（単色にしない）', () => {
  for (const cls of ['tag-distance', 'tag-course', 'tag-jockey', 'tag-compare', 'tag-contrast',
    'st-neutral', 'st-nohistory', 'st-pending']) {
    assert.ok(board.includes(cls), `${cls} が無い`);
  }
  const colors = new Set((board.match(/#[0-9a-f]{6}/gi) || []).map((c) => c.toLowerCase()));
  assert.ok(colors.size >= 12, `色数が少なすぎる（${colors.size}）。意味別の多色にすること`);
});

// ─── データ不足時 fail closed ─────────────────────────────────

test('データ不足のレースはタグを出さず状態表示にする', () => {
  assert.ok(board.includes('RACE_STATE.TAGGED'), '状態で分岐していない');
  assert.ok(board.includes('STATE_LABEL'), '状態ラベルを出していない');
  assert.ok(board.includes('noChanges'), '近走が無い馬の扱いが無い');
});

test('ページは SSR のまま（最新開催日を出すため）', () => {
  for (const p of pages) {
    assert.ok(p.includes('prerender = false'), 'SSR 前提が変わっている');
  }
});

test('2026-08-20: nav に掲載し noindex を解除した', () => {
  for (const p of pages) {
    assert.equal(p.includes('noindex={true}'), false, 'noindex を戻してはいけない（nav 掲載済みのため）');
  }
  const layout = readFileSync(join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf-8');
  for (const href of ['/race-viewpoints/jra/', '/race-viewpoints/nankan/']) {
    assert.ok(layout.includes(href), `nav に ${href} が無い`);
  }
  assert.ok(layout.includes('無料予想'), 'nav のラベル（無料予想）が無い');
  // PC ナビ / モバイルナビ / フッターの 3 経路すべてに導線がある
  const count = (layout.match(/\/race-viewpoints\//g) || []).length;
  assert.ok(count >= 5, `導線が足りない（${count} 箇所）。PC・モバイル・フッターに置くこと`);
});
