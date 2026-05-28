#!/usr/bin/env node
/**
 * 【再発防止ガード - free JRA index 用】
 *
 * astro-site/src/pages/free-prediction/jra.astro に
 * 旧 keiba-intelligence 由来の表示ブロック・クラス・英語演出が
 * 再混入していないかを grep で検査する。
 *
 * 背景:
 *   free-prediction/jra.astro は KI から fork した経緯があり、
 *   旧 KI 風の dead CSS (detailed-horse-card / dhc-* / qm-* / feature-* /
 *   rank-badge-large 系) と KI 由来コンポーネント (AIRaceComment / AIBettingSection)
 *   への参照が残存していた。PR #41 / #42 で [date].astro を整備、
 *   PR-F1 (2026-05-29) で index 側も dead CSS を一掃し、本 guard で再混入を防止する。
 *
 *   AI予想の技術的背景セクション (XGBoost / LSTM / Neural Network) は
 *   PR-F1 範囲外のため本 guard では検知しない（別 PR 判断）。
 *
 * 検査対象ファイル:
 *   astro-site/src/pages/free-prediction/jra.astro
 *
 * 禁止文字列が 1 件でも検出されれば exit code 1。
 *
 * このスクリプトを無効化することは禁止 (CLAUDE.md / FREE_JRA_RULES.md の方針)。
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TARGET = resolve(__dirname, '..', 'src', 'pages', 'free-prediction', 'jra.astro');

// 禁止文字列リスト
// check-no-ki-relics-free-jra-date.mjs と整合させた共通禁止項目。
// ※ XGBoost / LSTM / ニューラルネットワーク / Neural Network は本 guard では検知しない
//   （tech-background セクション存続の判断が別 PR スコープのため）。
const BANNED = [
  // 英語演出フレーズ（旧 KI 風）
  { pattern: 'AI Recommended Betting Strategy', reason: '旧 KI 風買い目見出し。AK では使わない' },
  { pattern: 'Multi-Dimensional Performance Analysis', reason: '旧 KI 風詳細分析テーブル見出し。削除済み・再復活禁止' },
  { pattern: '多次元パフォーマンス分析', reason: '旧 KI 風詳細分析テーブル見出し。削除済み・再復活禁止' },
  { pattern: /Cross[- ]?val(idation)?/i, reason: '旧 KI 風 ML 演出 (Cross-val)。削除済み・再復活禁止' },
  { pattern: 'Validation Accuracy', reason: '旧 KI 風 ML 演出。削除済み・再復活禁止' },
  { pattern: 'Training Loss', reason: '旧 KI 風 ML 演出。削除済み・再復活禁止' },
  { pattern: 'Feature Importance Analysis', reason: '旧 KI 風 6軸演出。削除済み・再復活禁止' },
  { pattern: /DEEP\s+LEARNING\s+PREDICTION/i, reason: '旧 KI 風バッジ。削除済み・再復活禁止' },
  { pattern: /PRO\s+MEMBER\s+EXCLUSIVE/i, reason: '旧 KI 風バッジ。削除済み・再復活禁止' },
  { pattern: 'Inference Time', reason: '旧 KI 風 ML 演出。削除済み・再復活禁止' },
  { pattern: 'CROSS-VAL', reason: '旧 KI 風指標。削除済み・再復活禁止' },

  // 詳細分析テーブル内の英語指標（quick-metrics 系）
  { pattern: /\bWin\s+Prob\.?\b/i, reason: '詳細分析テーブルの英語指標。削除済み・再復活禁止' },
  { pattern: /\bModel\s+Certainty\b/i, reason: '詳細分析テーブルの英語指標。削除済み・再復活禁止' },
  { pattern: /\bExpected\s+Value\b/i, reason: '詳細分析テーブルの英語指標。削除済み・再復活禁止' },

  // 旧 KI 風クラス（dead CSS として残っていたものを PR-F1 で完全削除）
  { pattern: /\.?\bdetailed-horse-card\b/i, reason: '旧 KI 風カードクラス。削除済み・再復活禁止' },
  { pattern: /\bdhc-(header|main-info|info-card|title-line|number|name|role-badge|pt|jockey-trainer|age|weight|jockey|trainer|quick-metrics|features|mark-mobile)\b/i, reason: '旧 KI 風カード子クラス (dhc-*)。削除済み・再復活禁止' },
  { pattern: /\bqm-(item|label|value)\b/i, reason: '旧 KI 風 metrics 表 (qm-*)。削除済み・再復活禁止' },
  { pattern: /\bfeature-(title|grid|item|label|icon|bar-container|bar-center|bar|value)\b/i, reason: '旧 KI 風 Feature Importance バー (feature-*)。削除済み・再復活禁止' },
  { pattern: /\brank-badge-large\b/i, reason: '旧 KI 風順位バッジ。削除済み・再復活禁止' },

  // 旧 KI 風 近走 grid
  // NOTE: recent-race-label は analytics 風 compact details で使うため除外
  { pattern: /\brecent-races-(title|grid)\b/i, reason: '旧 KI 風近走 grid 構造。analytics 風カードに置き換え済み・再復活禁止' },
  { pattern: /\brecent-race-(item|details)\b/i, reason: '旧 KI 風近走 grid 構造。削除済み・再復活禁止' },
  { pattern: /\brr-(venue|result|distance|condition)\b/i, reason: '旧 KI 風近走フィールドクラス (rr-*)。削除済み・再復活禁止' },

  // Intelligence 由来コンポーネント
  { pattern: 'Powered by Keiba Intelligence', reason: 'AIRaceComment 内の KI クレジット。free index では使用禁止' },
  { pattern: /\bRecommended Betting Strategy\b/i, reason: 'AIBettingSection 内の旧 KI 風買い目見出し。free index では使用禁止' },
  { pattern: 'AI予想解説', reason: 'AIRaceComment のラベルテキスト。free index では非表示・使用禁止' },
  { pattern: 'AI買い目', reason: 'AIBettingSection のラベルテキスト。free index では非表示・使用禁止' },
  { pattern: 'AI振り返り', reason: 'AIRaceComment type=result 時のラベルテキスト。free index では非表示・使用禁止' },
  { pattern: 'AIRaceComment', reason: 'KI 由来コンポーネント。free index では import / 使用禁止' },
  { pattern: 'AIBettingSection', reason: 'KI 由来コンポーネント。free index では import / 使用禁止' },
  { pattern: /\bai-comment-(section|header|header-left|badge|pulse|badge-text|title-area|label|sub|masked-overlay|masked-lock|masked-title|masked-sub|masked-buttons|masked-cta)\b/i, reason: 'AIRaceComment 由来クラス (ai-comment-*)。free index では使用禁止' },
  { pattern: /\bai-betting-(section|header|header-left|badge|pulse|badge-text|title-area|label|sub|toggle|body|masked|masked-blur|masked-title)\b/i, reason: 'AIBettingSection 由来クラス (ai-betting-*)。free index では使用禁止' },
];

if (!existsSync(TARGET)) {
  console.error('❌ 対象ファイルが見つかりません:', TARGET);
  process.exit(2);
}

const content = readFileSync(TARGET, 'utf-8');
const lines = content.split('\n');

const violations = [];
for (const { pattern, reason } of BANNED) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let hit = false;
    if (pattern instanceof RegExp) {
      hit = pattern.test(line);
    } else {
      hit = line.includes(pattern);
    }
    if (hit) {
      violations.push({
        lineNo: i + 1,
        line: line.trim(),
        pattern: pattern.toString(),
        reason,
      });
    }
  }
}

if (violations.length === 0) {
  console.log('✅ free-prediction/jra.astro: 旧 KI 風ブロックの混入なし');
  process.exit(0);
}

console.error('❌ free-prediction/jra.astro に旧 KI 風ブロックの混入を検出:');
console.error('');
for (const v of violations) {
  console.error(`  L${v.lineNo}  ${v.pattern}`);
  console.error(`    ${v.line.slice(0, 140)}`);
  console.error(`    → ${v.reason}`);
  console.error('');
}
console.error(`合計 ${violations.length} 件の違反`);
console.error('');
console.error('対処: astro-site/docs/FREE_JRA_RULES.md を参照してください。');
process.exit(1);
