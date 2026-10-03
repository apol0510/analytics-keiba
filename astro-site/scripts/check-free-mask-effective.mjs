#!/usr/bin/env node
/**
 * check-free-mask-effective.mjs — 無料ページのモザイクが「実際にぼける」ことを構造で保証する。
 *
 * ── なぜ必要か（2026-07-31 本番不具合）────────────────────────────────
 * 無料ページの 累積スコア / AI総合指数 はダミー値 88 を `filter: blur()` で隠す設計だが、
 * 親要素 `.stat-score` / `.stat-index` が
 *     background: linear-gradient(...); -webkit-background-clip: text;
 *     -webkit-text-fill-color: transparent;
 * で **gradient 文字**を描いていた。この場合、親が子孫の文字形にクリップして背景を描くため、
 * 子 span の blur は「ぼけた文字」を重ねるだけで、**下に鮮明な gradient 文字が残る**。
 * 結果、本番で 88 がくっきり読める状態になっていた（HTML 上は masked-* が付いていたので
 * 既存の verify-free-mask.mjs（markup 検査）はすり抜けた）。
 *
 * ── 何を検査するか ──────────────────────────────────────────────────
 *   1. masked-num を含む .stat-value 要素には必ず `stat-value-masked` が付いている
 *   2. そのページに `.stat-value.stat-value-masked` の打ち消し CSS がある
 *      （詳細度 2 クラス。`.stat-value-masked` 単独だと .stat-score と同点で定義順依存になる）
 *   3. 打ち消し CSS が gradient 文字を確実に無効化している
 *      （background-clip: initial と -webkit-text-fill-color の両方）
 *   4. `.masked-eval` に filter: blur( がある
 *   5. 検査対象が 0 件なら失敗（素通り防止）
 *
 * ⚠️ 「マスクは markup にある」だけでは不十分。**描画されて初めてマスク**である。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 2026-10-04: /free-prediction/ は Premium と同じ部品のプレビューになり、有料部分のモザイクは
 * 本文部品 AcquiredPredictionBody の preview 分岐（買い目 = .betting-teaser / 指数 = .acq-masked）が描く。
 * 守る条件は同じ: モザイクが構造的に効いていること（グラデーション文字の打ち消し＋blur）。
 */
const COMPONENT = 'src/components/acquisition/AcquiredPredictionBody.astro';
let failed = 0;
const src = readFileSync(join(root, COMPONENT), 'utf-8');
const problems = [];
const idx = (src.match(/\.acq-mark-index\.acq-masked strong\s*\{[^}]*\}/) || [])[0];
if (!idx) problems.push('.acq-mark-index.acq-masked strong のルールが無い（詳細度 2 クラス以上で書くこと）');
else {
  if (!/background-clip:\s*initial/.test(idx)) problems.push('指数モザイクに background-clip: initial が無い');
  if (!/-webkit-text-fill-color:/.test(idx)) problems.push('指数モザイクに -webkit-text-fill-color が無い');
  if (!/filter:\s*blur\(/.test(idx)) problems.push('指数モザイクに filter: blur( が無い');
}
const teaser = (src.match(/\.betting-teaser\s*\{[^}]*\}/) || [])[0];
if (!teaser || !/filter:\s*blur\(/.test(teaser)) problems.push('.betting-teaser に filter: blur( が無い');
if (!/class="betting-teaser ag-inset" aria-hidden="true"/.test(src)) problems.push('買い目のダミー表示が無い');
// プレビューで描く値はダミー（●）だけ
const pv = src.slice(src.indexOf('{isPreview ? ('), src.indexOf(') : !isSrp ? ('));
if (/\{(c\.umatan|l\.line|l\.points|h\.aiIndex)/.test(pv)) problems.push('プレビュー分岐で実データを描画している');
if (problems.length) { console.error(`❌ ${COMPONENT}\n   - ${problems.join('\n   - ')}`); failed++; }
else console.log(`✅ ${COMPONENT}: プレビューのモザイクが構造的に有効（打ち消しあり / blur あり / 実値なし）`);
if (failed) process.exit(1);
