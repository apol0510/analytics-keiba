/**
 * submissionHistoryWording.guard.test.mjs — 申請・送信履歴の文言を固定する
 *
 * ## なぜ必要か（2026-08-25 MK 指摘）
 *
 * > 「確認待ち」という表示のままは印象悪いですね
 *
 * この履歴は **この端末の localStorage に保存された「送信の記録」** で、
 * サーバーの処理状況は入ってこない。
 *
 *   - 記録するのは送信した瞬間の 1 回だけ（`recordSubmission`）
 *   - 入金確認は Airtable での手作業で、**1 件ごとの状態を持つ台帳が無い**
 *   - つまり「確認待ち」は送った瞬間だけ正しく、あとは**永久に古いまま**
 *
 * 入金が済んでいるのに「確認待ち」と出続けると、
 * 「まだ処理されていない」と読まれる（実際に 8/23 の申込で発生）。
 *
 * ## 直し方
 *
 * **あとから見ても嘘にならない言葉だけを使う。**
 * 送信できたことは事実なので「送信しました」。
 * 本当の状況は会員ステータスにあるので、その在り処を示す。
 *
 * ⚠️ サーバーの状態を推測して「完了」と出してはいけない。
 *    入金の確認はお金の話で、間違えると取り返しがつかない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../pages/dashboard.astro', import.meta.url).pathname, 'utf8');
/** コメントを除いたコード（説明の語で誤検知しない） */
const code = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 状態名の文言は**共有ファイル**にある（送信完了画面と食い違わせないため。2026-08-26）。
 * ここはその文言表を見る。
 */
const shared = readFileSync(new URL('../../../public/js/submission-result.js', import.meta.url).pathname, 'utf8');
const wording = (() => {
  const i = shared.indexOf('var STATUS_TEXT');
  assert.ok(i > 0, '履歴の文言表が見つからない（検査が素通りしている）');
  return shared.slice(i, i + 400);
})();

/** 履歴の描画スクリプト（マイページ側） */
const renderer = (() => {
  const i = code.indexOf('listEl.innerHTML = history.map');
  assert.ok(i > 0, '履歴の描画が見つからない（検査が素通りしている）');
  return code.slice(i, i + 1400);
})();

test('更新されない状態名を出さない（「確認待ち」を残さない）', () => {
  // ⚠️ この履歴は端末に閉じていて、あとから書き換わらない
  assert.ok(!wording.includes('確認待ち'), '止まっているように読める文言が残っている');
  assert.ok(!wording.includes('処理中'), '進行中に読める文言が残っている');
  assert.match(wording, /pending:\s*'送信しました'/, '送信の事実を出していない');
});

test('送信できなかったことは正直に出す', () => {
  assert.match(wording, /failed:\s*'[^']*送信できません[^']*'/, '失敗を隠している');
});

test('この記録だけで判断させない（処理状況は入らないと明示する）', () => {
  assert.match(code, /submission-history-hint/, '案内の行が無い');
  assert.match(code, /処理の状況は反映されません/, '記録の性質を書いていない');
  // ⚠️ 商品ごとの案内は行に出す（Premium Plus は会員ステータスに反映されない）
  assert.match(renderer, /describeFollowUp/, '商品ごとの案内を出していない');
});

test('未処理に見える色を使わない', () => {
  const css = page.slice(page.indexOf('.submission-history-status.status-pending'));
  const rule = css.slice(0, css.indexOf('}') + 1);
  assert.ok(!/245,\s*158,\s*11/.test(rule), '橙（処理待ち）のまま');
  assert.match(rule, /148,\s*163,\s*184/, '中立の色になっていない');
});

test('サーバーの状態を推測して「完了」と書かない（お金の話を勝手に確定させない）', () => {
  // 履歴の描画が Airtable / API の値を読みに行っていないこと
  assert.ok(!/status.*=.*customerData/.test(renderer), '会員データから状態を作っている');
  assert.ok(!renderer.includes('fetch('), '履歴の描画が通信している');
});

// ── スタイルが実際に当たること ────────────────────────────
//
// ⚠️ 履歴の中身は JS が作る（`listEl.innerHTML = ...`）。
//    Astro の scoped スタイルは `[data-astro-cid-…]` へ変換されるため、
//    **生成された要素には一切適用されない**。
//    実際、バッジも枠も効かず素のテキストが縦に並んでいた（2026-08-25 の報告画面）。
//    このリポジトリで何度も踏んでいる罠なので、構造で止める。

/** `<style is:global>` の中身をすべて連結して返す */
function globalCss(src) {
  let out = '';
  const re = /<style is:global>([\s\S]*?)<\/style>/g;
  for (const m of src.matchAll(re)) out += m[1];
  return out;
}
/** scoped `<style>`（is:global が付いていないもの）の中身 */
function scopedCss(src) {
  let out = '';
  const re = /<style(?! is:global)[^>]*>([\s\S]*?)<\/style>/g;
  for (const m of src.matchAll(re)) out += m[1];
  return out;
}

const GENERATED = [
  '.submission-history-list', '.submission-history-item', '.submission-history-badge',
  '.submission-history-main', '.submission-history-label', '.submission-history-meta',
  '.submission-history-status', '.submission-history-empty',
];

test('JS が作る要素のスタイルは is:global にある（scoped では効かない）', () => {
  const g = globalCss(page);
  const sc = scopedCss(page);
  assert.ok(g.length > 0, 'is:global のブロックが見つからない（検査が素通りしている）');
  for (const cls of GENERATED) {
    assert.ok(g.includes(cls), `${cls} が is:global に無い（画面に効かない）`);
    assert.ok(!sc.includes(cls), `${cls} が scoped 側に残っている（効かない指定）`);
  }
});

test('他ページへ漏らさない（専用の入れ物の中だけ）', () => {
  const g = globalCss(page);
  for (const line of g.split('\n')) {
    if (!GENERATED.some((c) => line.includes(c))) continue;
    assert.match(line.trim(), /^#submission-history-section /,
      `全ページに効く指定になっている: ${line.trim().slice(0, 60)}`);
  }
});
