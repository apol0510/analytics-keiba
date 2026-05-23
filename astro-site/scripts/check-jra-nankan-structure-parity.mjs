#!/usr/bin/env node
/**
 * 【再発防止ガード】
 * /premium-prediction/jra/ を /premium-prediction/nankan/ の有料ページ構造に
 * 寄せる方針 (analytics-keiba 2026-05-24 集約) を維持するため、
 * nankan には存在するが jra には存在しない重要セクション (= 構造パリティ違反) を検出する。
 *
 * チェック内容:
 *   nankan.astro と jra.astro の両方に必須クラス・キーワードが
 *   存在することを確認する。jra にだけ欠けていたら fail。
 *
 *   逆方向 (jra にあって nankan に無い禁止ブロック) は
 *   check-no-ki-relics-premium-jra.mjs が検出する。
 *
 * 必須セクション:
 *   - AI分析完了 バッジ           (.ai-badge, ai-status)
 *   - リッチタイトル               (.race-title)
 *   - 穴馬抽出ツールバナー         (.dark-horse-link-section, /dark-horse-picks/)
 *   - プレミアム会員バッジ         (.premium-status)
 *   - 本日の傾向分析               (.daily-analysis-section)
 *   - AI推奨買い目 (統一カード)    (.recommendation-section, .unified-bet-card)
 *   - 連下候補ミニカード           (.minor-group-renka, .minor-horse-card-renka)
 *   - 抑え候補ミニカード           (.minor-group-osae, .minor-horse-card-osae)
 *   - 不要馬・見送り馬             (.ineligible-section)
 *
 * このスクリプトを無効化することは禁止 (CLAUDE.md の方針)。
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JRA = resolve(__dirname, '..', 'src', 'pages', 'premium-prediction', 'jra.astro');
const NANKAN = resolve(__dirname, '..', 'src', 'pages', 'premium-prediction', 'nankan.astro');

// 必須セクション: nankan に存在し、jra にも必ず存在すべきクラス・キーワード
const REQUIRED = [
  { key: 'ai-badge',                  label: 'AI分析完了バッジ',                   advice: 'header-section 内に <div class="ai-badge"> を配置' },
  { key: 'ai-status',                 label: 'AI分析完了テキスト',                 advice: 'class="ai-status" の <span> に「AI分析完了」を入れる' },
  { key: 'race-title',                label: 'リッチタイトル (.race-title)',       advice: 'header-section 内に <h1 class="race-title"> を配置' },
  { key: 'dark-horse-link-section',   label: '穴馬抽出ツールバナー',               advice: '<a href="/dark-horse-picks/"> を含む dark-horse-link-section' },
  { key: '/dark-horse-picks/',        label: '穴馬ページへのリンク先',             advice: '穴馬バナーの href を /dark-horse-picks/ に設定' },
  { key: 'premium-status',            label: 'プレミアム会員限定コンテンツバッジ', advice: '<div class="premium-status"> 👑 プレミアム会員限定コンテンツ' },
  { key: 'daily-analysis-section',    label: '本日の傾向分析セクション',           advice: 'venue-content 内に daily-analysis-section を配置 (会場ごと)' },
  { key: 'recommendation-section',    label: 'AI推奨買い目セクション',             advice: '買い目を recommendation-section + unified-bet-card で表示' },
  { key: 'unified-bet-card',          label: '統一買い目カード (.unified-bet-card)', advice: 'nankan 統一の bet-strategy.unified-bet-card 形式を使う' },
  { key: 'bet-list',                  label: '買い目リスト (.bet-list)',           advice: '買い目本体は <div class="bet-list"> + <div class="bet-item">' },
  { key: 'bet-item',                  label: '買い目アイテム (.bet-item)',         advice: '<div class="bet-item"> 内に bet-type / bet-horses / bet-points' },
  { key: 'minor-group-renka',         label: '連下候補ミニカードグループ',         advice: '.horse-card-minor.minor-group-renka' },
  { key: 'minor-horse-card-renka',    label: '連下候補ミニカード',                 advice: '.minor-horse-card.minor-horse-card-renka' },
  { key: 'minor-group-osae',          label: '抑え候補ミニカードグループ',         advice: '.horse-card-minor.minor-group-osae' },
  { key: 'minor-horse-card-osae',     label: '抑え候補ミニカード',                 advice: '.minor-horse-card.minor-horse-card-osae' },
  { key: 'ineligible-section',        label: '不要馬・見送り馬セクション',         advice: '<details class="ineligible-section">' },
  { key: 'isOsaeCandidate',           label: '抑え判定 (単一源)',                  advice: 'shared-prediction-logic.js から isOsaeCandidate を import' },
  { key: 'isIneligibleHorse',         label: '不要馬判定 (単一源)',                advice: 'shared-prediction-logic.js から isIneligibleHorse を import' },
];

function checkFile(path) {
  if (!existsSync(path)) {
    console.error('❌ ファイルが見つかりません:', path);
    process.exit(2);
  }
  return readFileSync(path, 'utf-8');
}

const jraContent = checkFile(JRA);
const nankanContent = checkFile(NANKAN);

const missing = [];
const okList = [];

for (const r of REQUIRED) {
  const inNankan = nankanContent.includes(r.key);
  const inJra = jraContent.includes(r.key);

  if (!inNankan) {
    // 基準テンプレートに無ければ警告のみ (基準が変わった可能性 → CLAUDE.md 更新が必要)
    console.warn(`⚠️ nankan 側にも「${r.label}」が見つかりません (基準テンプレートが変わった?): ${r.key}`);
    continue;
  }
  if (!inJra) {
    missing.push(r);
  } else {
    okList.push(r);
  }
}

if (missing.length === 0) {
  console.log(`✅ premium-prediction/jra.astro: nankan 構造パリティ OK (必須 ${okList.length} 項目すべて存在)`);
  process.exit(0);
}

console.error('❌ premium-prediction/jra.astro が nankan 構造パリティを満たしていません:');
console.error('');
console.error(`OK (${okList.length}): ${okList.map((r) => r.key).join(', ')}`);
console.error('');
console.error(`MISSING (${missing.length}):`);
for (const r of missing) {
  console.error(`  ・「${r.label}」 (キー: ${r.key})`);
  console.error(`    → ${r.advice}`);
}
console.error('');
console.error('対処: astro-site/docs/PREMIUM_JRA_RULES.md を参照してください。');
console.error('');
console.error('方針: /premium-prediction/jra/ は /premium-prediction/nankan/ の');
console.error('      有料ページ構造に寄せる (2026-05-24 集約)。');
process.exit(1);
