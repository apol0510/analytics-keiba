#!/usr/bin/env node
/**
 * 【再発防止ガード】
 * astro-site/src/pages/premium-prediction/jra.astro に
 * 旧 keiba-intelligence 由来の表示ブロック・クラス・英語演出が
 * 再混入していないかを grep で検査する。
 *
 * 過去事案 (~2026-05-24):
 *   /premium-prediction/jra/ に nankan には無い旧 KI 風の演出
 *   (Ensemble Neural Network / XGBoost×LSTM / Multi-Dimensional
 *    Performance Analysis / WIN PROB / MODEL CERTAINTY 等) が
 *   残存しており、二重表示・著作権上の懸念があった。
 *
 *   削除コミット: a01b0a2, f6a0dcc, 42f9600 等で段階的に除去。
 *   再混入防止のためのガードがこのスクリプト。
 *
 * 検査対象ファイル:
 *   astro-site/src/pages/premium-prediction/jra.astro
 *
 * 禁止文字列が 1 件でも検出されれば exit code 1。
 *
 * このスクリプトを無効化することは禁止 (CLAUDE.md の方針)。
 * 旧 KI 風ブロックを別名で復活させた場合も検出するため、
 * テキスト・クラス名の両方を網羅する。
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TARGET = resolve(__dirname, '..', 'src', 'pages', 'premium-prediction', 'jra.astro');

// 禁止文字列リスト
// 各エントリ: { pattern: 文字列 or RegExp, reason: 理由, allowComment: コメント文脈は許可するか }
const BANNED = [
  // 英語演出フレーズ（旧 KI 風）
  { pattern: 'AI Recommended Betting Strategy', reason: '旧 KI 風買い目見出し。「AI推奨買い目」を使うこと' },
  { pattern: 'Multi-Dimensional Performance Analysis', reason: '旧 KI 風詳細分析テーブル見出し。削除済み・再描画禁止' },
  { pattern: '多次元パフォーマンス分析', reason: '旧 KI 風詳細分析テーブル見出し。削除済み・再描画禁止' },
  { pattern: 'Ensemble Neural Network', reason: '旧 KI 風 ML 演出文言。削除済み・再復活禁止' },
  { pattern: 'XGBoost', reason: '旧 KI 風 ML 演出文言。analytics-keiba 表示には使わない' },
  { pattern: 'LSTM', reason: '旧 KI 風 ML 演出文言。analytics-keiba 表示には使わない' },
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
  // 「Risk / リスク」だけは bet-strategy で「リスク」表現に再利用される可能性があるが、
  // qm-label 内の "Risk /" は禁止
  { pattern: /qm-label[^>]*>\s*Risk\s*\//i, reason: '詳細分析テーブルの Risk 指標。削除済み・再復活禁止' },

  // 旧 KI 風クラス名（別名復活防止）
  { pattern: 'ai-model-card', reason: '旧 KI 風カードクラス。削除済み・再復活禁止' },
  { pattern: 'detailed-horse-card', reason: '旧 KI 風詳細カードクラス。削除済み・再復活禁止' },
  { pattern: 'dhc-quick-metrics', reason: '旧 KI 風 metrics クラス。削除済み・再復活禁止' },
  { pattern: 'qm-label', reason: '旧 KI 風 metrics ラベル。削除済み・再復活禁止' },
  { pattern: 'qm-value', reason: '旧 KI 風 metrics 値。削除済み・再復活禁止' },
  { pattern: 'dhc-header', reason: '旧 KI 風カードヘッダー。削除済み・再復活禁止' },
  { pattern: 'dhc-main-info', reason: '旧 KI 風カード本体。削除済み・再復活禁止' },
  { pattern: 'dhc-info-card', reason: '旧 KI 風カード本体。削除済み・再復活禁止' },
  { pattern: 'dhc-title-line', reason: '旧 KI 風カードタイトル。削除済み・再復活禁止' },
  { pattern: 'dhc-jockey-trainer', reason: '旧 KI 風カードメタ。削除済み・再復活禁止' },

  // 旧 KI 風買い目フォーマット（formula-row 系）
  // ※ JS 内の '.betting-formula.pro-user-only' は後方互換 selector として
  //   セレクタ文字列内では許可。HTML レンダリング側の <div class="formula-row"> 等は禁止。
  { pattern: /class="formula-row/i, reason: '旧 KI 風買い目行クラス。nankan 統一 bet-item を使うこと' },
  { pattern: /class="axis-mark"/i, reason: '旧 KI 風買い目軸マーク。nankan 統一 bet-item を使うこと' },
  { pattern: /class="opponents-list"/i, reason: '旧 KI 風買い目相手リスト。nankan 統一 bet-item を使うこと' },
  { pattern: /class="opponent-paren"/i, reason: '旧 KI 風買い目相手括弧。削除済み・再復活禁止' },

  // 著作権上敏感な「総合評価★★★★(N)」表示
  // analytics-keiba 方針: JRA premium では星評価ブロック廃止、累積スコアのみ表示
  { pattern: /class="stat-stars-block"/i, reason: '総合評価★★★★ブロック。JRA premium では廃止（累積スコアのみ表示）' },
  { pattern: /class="star-rating"/i, reason: '星評価コンポーネント。JRA premium では非使用' },

  // Intelligence 由来コンポーネント（PR-I 追加: 無料側 guard と整合）
  // AIRaceComment / AIBettingSection が premium-prediction/jra.astro に
  // 別経路で混入することを防ぐ。AIBettingSection は南関 prediction/[slug] で現役のため、
  // 名前空間ベースで premium への流入だけを遮断する目的。
  { pattern: 'Powered by Keiba Intelligence', reason: 'AIRaceComment 内の KI クレジット。premium では使用禁止' },
  { pattern: /\bRecommended Betting Strategy\b/i, reason: 'AIBettingSection 内の旧 KI 風買い目見出し。premium では使用禁止' },
  { pattern: 'AI予想解説', reason: 'AIRaceComment のラベルテキスト。premium では非表示・使用禁止' },
  { pattern: 'AI買い目', reason: 'AIBettingSection のラベルテキスト。premium では非表示・使用禁止' },
  { pattern: 'AI振り返り', reason: 'AIRaceComment type=result 時のラベルテキスト。premium では非表示・使用禁止' },
  { pattern: 'AIRaceComment', reason: 'KI 由来コンポーネント。premium では import / 使用禁止' },
  { pattern: 'AIBettingSection', reason: 'KI 由来コンポーネント。premium では import / 使用禁止' },
  { pattern: /\bai-comment-(section|header|header-left|badge|pulse|badge-text|title-area|label|sub|masked-overlay|masked-lock|masked-title|masked-sub|masked-buttons|masked-cta)\b/i, reason: 'AIRaceComment 由来クラス (ai-comment-*)。premium では使用禁止' },
  { pattern: /\bai-betting-(section|header|header-left|badge|pulse|badge-text|title-area|label|sub|toggle|body|masked|masked-blur|masked-title)\b/i, reason: 'AIBettingSection 由来クラス (ai-betting-*)。premium では使用禁止' },
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
  console.log('✅ premium-prediction/jra.astro: 旧 KI 風ブロックの混入なし');
  process.exit(0);
}

console.error('❌ premium-prediction/jra.astro に旧 KI 風ブロックの混入を検出:');
console.error('');
for (const v of violations) {
  console.error(`  L${v.lineNo}  ${v.pattern}`);
  console.error(`    ${v.line.slice(0, 140)}`);
  console.error(`    → ${v.reason}`);
  console.error('');
}
console.error(`合計 ${violations.length} 件の違反`);
console.error('');
console.error('対処: astro-site/docs/PREMIUM_JRA_RULES.md を参照してください。');
process.exit(1);
