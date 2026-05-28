#!/usr/bin/env node
/**
 * 【再発防止ガード - free JRA [date] アーカイブページ用】
 *
 * astro-site/src/pages/free-prediction/jra/[date].astro に
 * 旧 keiba-intelligence 由来の表示ブロック・クラス・英語演出が
 * 再混入していないかを grep で検査する。
 *
 * 背景:
 *   free-prediction/jra/[date].astro は KI から fork した経緯があり、
 *   旧 KI 風の演出 (DEEP LEARNING PREDICTION / Ensemble Neural Network /
 *    Multi-Dimensional Performance Analysis / Feature Importance Analysis /
 *    Win Prob / Model Certainty / Expected Value 等) が PR-E (2026-05-28) まで残存していた。
 *
 *   PR-E で完全除去 + 過去走データ UI を analytics 風 horse-card に再配置。
 *   再混入防止のためのガードがこのスクリプト。
 *
 * 検査対象ファイル:
 *   astro-site/src/pages/free-prediction/jra/[date].astro
 *
 * 禁止文字列が 1 件でも検出されれば exit code 1。
 *
 * このスクリプトを無効化することは禁止 (CLAUDE.md / FREE_JRA_RULES.md の方針)。
 * 旧 KI 風ブロックを別名で復活させた場合も検出するため、
 * テキスト・クラス名の両方を網羅する。
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TARGET = resolve(__dirname, '..', 'src', 'pages', 'free-prediction', 'jra', '[date].astro');

// 禁止文字列リスト
// premium-prediction/jra.astro 用の check-no-ki-relics-premium-jra.mjs と整合。
const BANNED = [
  // 英語演出フレーズ（旧 KI 風）
  { pattern: 'AI Recommended Betting Strategy', reason: '旧 KI 風買い目見出し。AK では使わない' },
  { pattern: 'Multi-Dimensional Performance Analysis', reason: '旧 KI 風詳細分析テーブル見出し。削除済み・再復活禁止' },
  { pattern: '多次元パフォーマンス分析', reason: '旧 KI 風詳細分析テーブル見出し。削除済み・再復活禁止' },
  { pattern: 'Ensemble Neural Network', reason: '旧 KI 風 ML 演出文言。削除済み・再復活禁止' },
  { pattern: 'XGBoost', reason: '旧 KI 風 ML 演出文言。AK 表示には使わない' },
  { pattern: 'LSTM', reason: '旧 KI 風 ML 演出文言。AK 表示には使わない' },
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

  // 旧 KI 風クラス
  { pattern: /\.?\bdetailed-horse-card\b/i, reason: '旧 KI 風カードクラス。削除済み・再復活禁止' },
  { pattern: /\bdhc-(header|main-info|info-card|title-line|number|name|role|age|weight|jockey|trainer|quick-metrics|features)\b/i, reason: '旧 KI 風カード子クラス (dhc-*)。削除済み・再復活禁止' },
  { pattern: /\bqm-(item|label|value)\b/i, reason: '旧 KI 風 metrics 表 (qm-*)。削除済み・再復活禁止' },
  { pattern: /\bfeature-(title|grid|item|label|icon|bar-container|bar-center|bar|value)\b/i, reason: '旧 KI 風 Feature Importance バー (feature-*)。削除済み・再復活禁止' },
  { pattern: /\brank-badge-large\b/i, reason: '旧 KI 風順位バッジ。削除済み・再復活禁止' },

  // 旧 KI 風 近走 grid (近走自体の表示は OK だが、旧形式の recent-races-grid / recent-race-item / rr-* は禁止)
  { pattern: /\brecent-races-(title|grid)\b/i, reason: '旧 KI 風近走 grid 構造。analytics 風カードに置き換え済み・再復活禁止' },
  { pattern: /\brecent-race-(item|label|details)\b/i, reason: '旧 KI 風近走 grid 構造。削除済み・再復活禁止' },
  { pattern: /\brr-(venue|result|distance|condition)\b/i, reason: '旧 KI 風近走フィールドクラス (rr-*)。削除済み・再復活禁止' },
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
  console.log('✅ free-prediction/jra/[date].astro: 旧 KI 風ブロックの混入なし');
  process.exit(0);
}

console.error('❌ free-prediction/jra/[date].astro に旧 KI 風ブロックの混入を検出:');
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
