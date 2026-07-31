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
const PAGES = [
  'src/pages/free-prediction/jra.astro',
  'src/pages/free-prediction/nankan.astro',
];

/** gradient 文字を使う親クラス（子の blur が効かなくなる組み合わせ） */
const GRADIENT_TEXT_CLASSES = ['stat-score', 'stat-index'];

let failed = 0;
let checkedElements = 0;

for (const rel of PAGES) {
  const path = join(root, rel);
  let src;
  try {
    src = readFileSync(path, 'utf-8');
  } catch {
    console.error(`❌ ${rel}: ファイルが読めない`);
    failed++;
    continue;
  }

  const problems = [];

  // 1. masked-num を持つ .stat-value 要素は stat-value-masked 必須
  const statValueTags = src.match(/<div\s+class="[^"]*stat-value[^"]*"[^>]*>[\s\S]{0,240}?<\/div>/g) || [];
  const maskedTags = statValueTags.filter((t) => /masked-num|masked-eval/.test(t));
  for (const tag of maskedTags) {
    const cls = (tag.match(/<div\s+class="([^"]*)"/) || [, ''])[1];
    const usesGradient = GRADIENT_TEXT_CLASSES.some((c) => cls.split(/\s+/).includes(c));
    if (!usesGradient) continue; // gradient 文字でなければ子の blur がそのまま効く
    checkedElements++;
    if (!cls.split(/\s+/).includes('stat-value-masked')) {
      problems.push(`gradient 文字の親に stat-value-masked が無い: class="${cls}"`);
    }
  }

  // 2〜3. 打ち消し CSS の存在と内容
  const rule = (src.match(/\.stat-value\.stat-value-masked\s*\{[^}]*\}/) || [])[0];
  if (!rule) {
    problems.push('.stat-value.stat-value-masked の打ち消し CSS が無い（詳細度 2 クラスで書くこと）');
  } else {
    if (!/background-clip:\s*initial/.test(rule)) problems.push('打ち消し CSS に background-clip: initial が無い');
    if (!/-webkit-text-fill-color:/.test(rule)) problems.push('打ち消し CSS に -webkit-text-fill-color が無い');
  }

  // 4. blur 本体
  const maskedEval = (src.match(/\.masked-eval\s*\{[^}]*\}/) || [])[0];
  if (!maskedEval || !/filter:\s*blur\(/.test(maskedEval)) {
    problems.push('.masked-eval に filter: blur( が無い');
  }

  if (problems.length) {
    console.error(`❌ ${rel}\n   - ${problems.join('\n   - ')}`);
    failed++;
  } else {
    console.log(`✅ ${rel}: モザイクが構造的に有効（gradient 打ち消しあり / blur あり）`);
  }
}

// 5. 素通り防止
if (checkedElements === 0) {
  console.error('❌ 検査対象（gradient 文字 × モザイク）が 0 件。セレクタか対象ページの変更を確認すること');
  failed++;
}

if (failed) {
  console.error(`\n無料モザイク実効性チェック 失敗: ${failed} 件`);
  process.exit(1);
}
console.log(`\n✅ 無料モザイク実効性チェック 合格（検査要素 ${checkedElements} 箇所）`);
