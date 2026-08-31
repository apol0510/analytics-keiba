import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { latestArchiveMonth, resolveArchiveRedirect } from './archiveRedirect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASTRO_SITE = join(__dirname, '..', '..');

// ── 事故の再現（この修正が無いと落ちる）─────────────────────────────
test('回帰: /results は /archive/nankan/... へ飛ぶ（`/nankan` 欠落で 404 になっていた）', () => {
  const archive = [{ date: '2026-08-28' }, { date: '2026-08-27' }];
  assert.equal(resolveArchiveRedirect(archive, 'nankan'), '/archive/nankan/2026/08/');
  // 旧実装が作っていた壊れた URL を二度と作らない
  assert.notEqual(resolveArchiveRedirect(archive, 'nankan'), '/archive/2026/08/');
});

test('JRA 側は従来どおり /archive/jra/... を保つ', () => {
  assert.equal(resolveArchiveRedirect([{ date: '2026-08-30' }], 'jra'), '/archive/jra/2026/08/');
});

// ── 並び順に依存しない（archive[0] 決め打ちの禁止）──────────────────
test('archive[0] が最新でなくても最新月を選ぶ', () => {
  const shuffled = [{ date: '2026-04-10' }, { date: '2026-08-28' }, { date: '2026-06-01' }];
  assert.equal(resolveArchiveRedirect(shuffled, 'nankan'), '/archive/nankan/2026/08/');
});

test('nested { YYYY: { MM: ... } } 形式でも最新を選ぶ', () => {
  const nested = { 2025: { 12: {} }, 2026: { '03': {}, '08': {}, '01': {} } };
  assert.equal(resolveArchiveRedirect(nested, 'nankan'), '/archive/nankan/2026/08/');
});

// ── fail-closed: 確定できないときに存在しない URL を作らない ─────────
test('空・null・壊れた形は「今月」を推測せずカテゴリ索引へ落とす', () => {
  for (const bad of [null, undefined, [], {}, 'x', 42, [{ noDate: 1 }], { abc: {} }]) {
    assert.equal(resolveArchiveRedirect(bad, 'nankan'), '/archive/nankan/');
    assert.equal(resolveArchiveRedirect(bad, 'jra'), '/archive/jra/');
  }
});

test('date が YYYY-MM-DD でない要素は採用しない', () => {
  assert.equal(latestArchiveMonth([{ date: '2026/08/28' }, { date: '20260828' }]), null);
  // 正しい形が1件でもあればそれを使う
  assert.deepEqual(latestArchiveMonth([{ date: 'bad' }, { date: '2026-07-05' }]), {
    year: '2026',
    month: '07',
  });
});

test('未知の category は例外にする（黙って壊れた URL を作らない）', () => {
  assert.throws(() => resolveArchiveRedirect([], 'chuou'), TypeError);
});

// ── 実データとページ実体の突き合わせ ────────────────────────────────
test('実 archive から作った URL に対応するページが存在する', () => {
  for (const [file, category] of [
    ['archiveResults.json', 'nankan'],
    ['archiveResultsJra.json', 'jra'],
  ]) {
    const p = join(ASTRO_SITE, 'src', 'data', file);
    if (!existsSync(p)) continue; // データ未配置の環境では検査しない
    const url = resolveArchiveRedirect(JSON.parse(readFileSync(p, 'utf-8')), category);
    // 月別ページは src/pages/archive/{cat}/[year]/[month]/index.astro が担う
    const monthly = join(ASTRO_SITE, 'src', 'pages', 'archive', category, '[year]', '[month]', 'index.astro');
    const index = join(ASTRO_SITE, 'src', 'pages', 'archive', category, 'index.astro');
    assert.ok(url.startsWith(`/archive/${category}/`), `${category}: ${url} が /archive/${category}/ で始まらない`);
    assert.ok(
      url === `/archive/${category}/` ? existsSync(index) : existsSync(monthly),
      `${category}: ${url} を担うページが無い`
    );
  }
});
