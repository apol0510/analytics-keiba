/**
 * darkHorsePageSsr.guard.test.mjs — 穴馬抽出ページが「ビルド時に当日を決める」実装へ戻らないための grep ガード
 *   node --test src/lib/darkHorse/darkHorsePageSsr.guard.test.mjs
 *
 * 事故（2026-08-30・お客様報告）:
 *   `/dark-horse-picks/` は `prerender = true`（静的生成）のまま、当日 (`todayJst`) を
 *   **ビルド時刻**で決めていた。ビルドは前日夕方の自動取込でしか走らないため、
 *   **当日は終日「前日のレース」しか表示されなかった**
 *   （本番 8/30 12 時の HTML が 2026-08-29 のデータ。8/30 分はリポジトリに揃っていた）。
 *
 * ここで固定する恒久仕様:
 *   1. `prerender = false`（SSR）。静的生成へ戻さない
 *   2. 当日は `jstDateString(new Date())` で**リクエストごと**に決める（ローカル再実装をしない）
 *   3. 読むのは `loadComputerEntriesForDate(todayJst)`（当日分のみ）。
 *      `import.meta.glob` で全日付をバンドルへ焼き込まない
 *   4. 選定は `selectTodaysEntries`（過去日 fallback なし）を通す
 *   5. SSR 経路で Airtable / 外部 API を呼ばない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../../pages/dark-horse-picks.astro', import.meta.url));
const src = readFileSync(PAGE, 'utf8');
/** frontmatter（先頭の --- ... --- ）だけを取り出す。表示側 HTML/JS は対象外。 */
const frontmatter = (() => {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'frontmatter を取り出せない');
  return m[1];
})();
/** コメントを除いた frontmatter（説明文の語句を実装と誤認しないため）。 */
const code = frontmatter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('1. SSR のまま（prerender = false）', () => {
  assert.match(code, /export\s+const\s+prerender\s*=\s*false/, 'prerender = false が無い');
  assert.doesNotMatch(code, /export\s+const\s+prerender\s*=\s*true/,
    '静的生成へ戻っている。ビルド時刻で当日が固定され前日データが終日表示される');
});

test('2. 当日はリクエスト時に jstDateString で決める（ローカル再実装しない）', () => {
  assert.match(code, /jstDateString\s*\(\s*new Date\(\)\s*\)/, 'jstDateString(new Date()) を呼んでいない');
  assert.doesNotMatch(code, /9\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    'JST 変換をページ内で再実装している（単一源 jstDateString を使うこと）');
  assert.doesNotMatch(code, /toLocaleDateString/, '環境依存の書式で当日を決めている');
});

test('3. 当日分だけを fs で読む（全日付をバンドルへ焼き込まない）', () => {
  assert.match(code, /loadComputerEntriesForDate\s*\(\s*todayJst\s*\)/, '当日 loader を呼んでいない');
  assert.doesNotMatch(code, /import\.meta\.glob/,
    'import.meta.glob が復活している（全日付がバンドルへ焼き込まれ SSR 関数が肥大する）');
});

test('4. 選定は selectTodaysEntries を通す（過去日 fallback を足さない）', () => {
  assert.match(code, /selectTodaysEntries\s*\(\s*allEntries\s*,\s*todayJst\s*\)/, '当日選定を通していない');
  // 「前日を代わりに出す」類の記述が入り込んでいないこと
  assert.doesNotMatch(code, /yesterday|previousDate|fallbackDate|latestDate\s*=/i,
    '前日 / 最新日への fallback を足している疑いがある');
});

test('5. SSR 経路で外部 API を呼ばない（fs のみ）', () => {
  for (const banned of [/airtable/i, /\bfetch\s*\(/, /sendgrid/i, /process\.env\.[A-Z_]*API_KEY/]) {
    assert.doesNotMatch(code, banned, `SSR frontmatter で外部依存を呼んでいる: ${banned}`);
  }
});

test('6. 日付が変わったら再検証させる Cache-Control を付けている', () => {
  assert.match(code, /Cache-Control/i, 'Cache-Control 未設定（CDN に寝かせると前日表示が再発する）');
  assert.doesNotMatch(code, /max-age=\s*[1-9]/, '正の max-age で CDN に寝かせている');
});
