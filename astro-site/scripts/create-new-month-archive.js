#!/usr/bin/env node

/**
 * 新月アーカイブ作成スクリプト
 * 月が変わるときに実行して、新しい月のアーカイブファイルとページを自動生成
 *
 * 使い方:
 *   node scripts/create-new-month-archive.js 2026 03
 *   node scripts/create-new-month-archive.js        （引数なし = 今月）
 */

const fs = require('fs');
const path = require('path');

// 引数から年月を取得、なければ今月
const args = process.argv.slice(2);
let year, month;

if (args.length >= 2) {
  year = args[0];
  month = args[1].padStart(2, '0');
} else {
  const now = new Date();
  year = now.getFullYear().toString();
  month = (now.getMonth() + 1).toString().padStart(2, '0');
}

console.log(`\n🚀 ${year}年${parseInt(month)}月の新規アーカイブを作成します...\n`);

// ============================================================
// 1. JSONファイル作成（馬単・三連複）
// ============================================================

const jsonTemplate = {
  [year]: {
    [month]: {}
  }
};

// 馬単アーカイブJSON
const umaTanJsonPath = path.join(__dirname, `../src/data/archiveResults_${year}-${month}.json`);
if (!fs.existsSync(umaTanJsonPath)) {
  fs.writeFileSync(umaTanJsonPath, JSON.stringify(jsonTemplate, null, 2), 'utf-8');
  console.log(`✅ 作成: src/data/archiveResults_${year}-${month}.json`);
} else {
  console.log(`⚠️  既存: src/data/archiveResults_${year}-${month}.json`);
}

// 三連複アーカイブJSON
const sanrenpukuJsonPath = path.join(__dirname, `../src/data/archiveSanrenpukuResults_${year}-${month}.json`);
if (!fs.existsSync(sanrenpukuJsonPath)) {
  fs.writeFileSync(sanrenpukuJsonPath, JSON.stringify(jsonTemplate, null, 2), 'utf-8');
  console.log(`✅ 作成: src/data/archiveSanrenpukuResults_${year}-${month}.json`);
} else {
  console.log(`⚠️  既存: src/data/archiveSanrenpukuResults_${year}-${month}.json`);
}

// public/data/にもコピー
const publicUmaTanJsonPath = path.join(__dirname, `../public/data/archiveResults_${year}-${month}.json`);
if (!fs.existsSync(publicUmaTanJsonPath)) {
  fs.writeFileSync(publicUmaTanJsonPath, JSON.stringify(jsonTemplate, null, 2), 'utf-8');
  console.log(`✅ 作成: public/data/archiveResults_${year}-${month}.json`);
} else {
  console.log(`⚠️  既存: public/data/archiveResults_${year}-${month}.json`);
}

const publicSanrenpukuJsonPath = path.join(__dirname, `../public/data/archiveSanrenpukuResults_${year}-${month}.json`);
if (!fs.existsSync(publicSanrenpukuJsonPath)) {
  fs.writeFileSync(publicSanrenpukuJsonPath, JSON.stringify(jsonTemplate, null, 2), 'utf-8');
  console.log(`✅ 作成: public/data/archiveSanrenpukuResults_${year}-${month}.json`);
} else {
  console.log(`⚠️  既存: public/data/archiveSanrenpukuResults_${year}-${month}.json`);
}

console.log('');

// ============================================================
// 2. 馬単アーカイブページ作成
// ============================================================

const umaTanPageTemplate = `---
export const prerender = true;
import archiveData from '../../../data/archiveResults_${year}-${month}.json';

const year = '${year}';
const month = '${month}';
const monthData = archiveData[year]?.[month] || {};
const days = Object.keys(monthData).sort().reverse(); // 新しい順

// 月間統計計算
let totalDays = days.length;
let perfectDays = 0;
let totalPayoutMonth = 0;
let totalHitRaces = 0;
let totalRaces = 0;

days.forEach(day => {
  const dayData = monthData[day];
  if (dayData.perfectHit) perfectDays++;
  totalPayoutMonth += dayData.totalPayout || 0;
  totalHitRaces += dayData.hitRaces || 0;
  totalRaces += dayData.totalRaces || 0;
});

const hitRate = totalRaces > 0 ? Math.round((totalHitRaces / totalRaces) * 100) : 0;
---

<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <!-- SEO最適化メタタグ -->
  <title>${year}年${parseInt(month)}月 南関競馬的中実績｜NANKANアナリティクス</title>
  <meta name="description" content="${year}年${parseInt(month)}月の南関競馬全的中実績を公開。的中率{hitRate}%・総配当¥{totalPayoutMonth.toLocaleString()}の実績データ。" />
  <meta name="keywords" content="南関競馬,的中実績,${year}年${parseInt(month)}月,的中率,配当,競馬予想" />
  <link rel="canonical" href="https://nankan-analytics.keiba.link/archive/${year}/${month}" />

  <!-- OGPタグ -->
  <meta property="og:title" content="${year}年${parseInt(month)}月 南関競馬的中実績" />
  <meta property="og:description" content="的中率{hitRate}%・総配当¥{totalPayoutMonth.toLocaleString()}の実績データ公開。" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://nankan-analytics.keiba.link/archive/${year}/${month}" />
  <meta property="og:site_name" content="NANKANアナリティクス" />
  <meta property="og:locale" content="ja_JP" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${year}年${parseInt(month)}月 南関競馬的中実績" />
  <meta name="twitter:description" content="的中率{hitRate}%・総配当¥{totalPayoutMonth.toLocaleString()}の実績データ公開。" />

  <!-- 構造化データ（JSON-LD） -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "${year}年${parseInt(month)}月 南関競馬的中実績",
    "description": "南関競馬の的中実績アーカイブ。特別レースを含む全レースの的中記録と配当金額。",
    "numberOfItems": {totalHitRaces},
    "itemListElement": [
      {
        "@type": "SportsEvent",
        "name": "南関競馬的中実績",
        "startDate": "${year}-${month}",
        "location": {
          "@type": "Place",
          "name": "南関競馬（大井・川崎・船橋・浦和）"
        },
        "sport": "競馬",
        "aggregateRating": {
          "@type": "AggregateRating",
          "ratingValue": "{hitRate}",
          "bestRating": "100",
          "worstRating": "0",
          "ratingCount": "{totalRaces}"
        }
      }
    ]
  }
  </script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 2rem 1rem;
      min-height: 100vh;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 3rem;
      padding: 2rem;
      background: rgba(30, 41, 59, 0.5);
      border-radius: 16px;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .title {
      font-size: 2.5rem;
      font-weight: bold;
      color: #f59e0b;
      margin-bottom: 1rem;
    }

    .subtitle {
      font-size: 1.2rem;
      color: #cbd5e1;
    }

    /* 月間統計 */
    .month-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }

    .stat-card {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 12px;
      padding: 1.5rem;
      text-align: center;
    }

    .stat-value {
      font-size: 2.5rem;
      font-weight: bold;
      color: #60a5fa;
      margin-bottom: 0.5rem;
    }

    .stat-label {
      font-size: 0.95rem;
      color: #94a3b8;
    }

    /* 日別アーカイブ */
    .day-section {
      background: rgba(30, 41, 59, 0.8);
      border-radius: 16px;
      padding: 2rem;
      margin-bottom: 2rem;
      border: 1px solid rgba(100, 116, 139, 0.3);
    }

    .day-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid rgba(100, 116, 139, 0.3);
    }

    .day-title {
      font-size: 1.8rem;
      font-weight: bold;
      color: #fbbf24;
    }

    .perfect-badge {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-weight: bold;
      font-size: 0.9rem;
    }

    .day-summary {
      display: flex;
      gap: 2rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }

    .summary-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #cbd5e1;
      font-size: 1rem;
    }

    .summary-value {
      color: #60a5fa;
      font-weight: bold;
    }

    /* レース一覧 */
    .races-grid {
      display: grid;
      gap: 1rem;
    }

    .race-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(100, 116, 139, 0.3);
      border-radius: 8px;
      padding: 1rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 0.3s;
    }

    .race-card:hover {
      border-color: rgba(16, 185, 129, 0.5);
      background: rgba(15, 23, 42, 0.8);
    }

    .race-info {
      display: flex;
      gap: 1rem;
      align-items: center;
      flex-wrap: wrap;
    }

    .race-number {
      font-size: 1.2rem;
      font-weight: bold;
      color: #fbbf24;
      min-width: 3rem;
    }

    .race-name {
      color: #94a3b8;
      font-size: 0.85rem;
      font-weight: 400;
      opacity: 0.8;
    }

    .bet-info {
      color: #8b5cf6;
      font-size: 0.9rem;
      font-weight: 600;
    }

    .race-result {
      display: flex;
      gap: 1rem;
      align-items: center;
    }

    .hit-badge {
      background: rgba(16, 185, 129, 0.2);
      color: #10b981;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-weight: bold;
      font-size: 0.9rem;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .payout {
      font-size: 1.2rem;
      font-weight: bold;
      color: #fbbf24;
    }

    .back-link {
      text-align: center;
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid rgba(100, 116, 139, 0.3);
    }

    .back-link a {
      color: #60a5fa;
      text-decoration: none;
      font-size: 1rem;
      transition: color 0.3s;
    }

    .back-link a:hover {
      color: #3b82f6;
    }

    /* Sticky CTA */
    .sticky-cta {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(30, 41, 59, 0.98));
      border-top: 2px solid rgba(59, 130, 246, 0.5);
      padding: 1rem;
      z-index: 1000;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(10px);
    }

    .sticky-cta-content {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .sticky-cta-text {
      flex: 1;
    }

    .sticky-cta-title {
      font-size: 1.1rem;
      font-weight: bold;
      color: #fbbf24;
      margin-bottom: 0.25rem;
    }

    .sticky-cta-description {
      font-size: 0.9rem;
      color: #cbd5e1;
    }

    .sticky-cta-buttons {
      display: flex;
      gap: 0.75rem;
    }

    .sticky-cta-button {
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-weight: bold;
      font-size: 1rem;
      text-decoration: none;
      transition: all 0.3s;
      white-space: nowrap;
    }

    .sticky-cta-button-primary {
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      color: white;
    }

    .sticky-cta-button-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    }

    .sticky-cta-button-secondary {
      background: rgba(100, 116, 139, 0.3);
      color: #cbd5e1;
      border: 1px solid rgba(100, 116, 139, 0.5);
    }

    .sticky-cta-button-secondary:hover {
      background: rgba(100, 116, 139, 0.5);
    }

    /* ページ下部の余白を確保 */
    body {
      padding-bottom: 100px;
    }

    @media (max-width: 768px) {
      .title {
        font-size: 1.8rem;
      }

      .day-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 1rem;
      }

      .race-card {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.75rem;
      }

      .race-info {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.5rem;
      }

      .race-name {
        grid-column: 1 / -1;
      }

      .race-result {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .sticky-cta {
        padding: 0.75rem;
      }

      .sticky-cta-content {
        flex-direction: column;
        align-items: stretch;
        gap: 0.75rem;
      }

      .sticky-cta-title {
        font-size: 1rem;
        margin-bottom: 0.15rem;
      }

      .sticky-cta-description {
        font-size: 0.85rem;
      }

      .sticky-cta-buttons {
        flex-direction: column;
        gap: 0.5rem;
      }

      .sticky-cta-button {
        width: 100%;
        padding: 0.65rem 1rem;
        font-size: 0.95rem;
      }

      body {
        padding-bottom: 180px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">🏆 ${year}年${parseInt(month)}月 的中実績アーカイブ</h1>
      <p class="subtitle">全レースの的中記録を公開</p>
    </div>

    <!-- 月間統計 -->
    <div class="month-stats">
      <div class="stat-card">
        <div class="stat-value">{totalDays}日</div>
        <div class="stat-label">開催日数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{hitRate}%</div>
        <div class="stat-label">月間的中率</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">¥{totalPayoutMonth.toLocaleString()}</div>
        <div class="stat-label">月間合計配当</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{totalHitRaces}/{totalRaces}</div>
        <div class="stat-label">的中レース数</div>
      </div>
    </div>

    <!-- 日別アーカイブ -->
    {days.map(day => {
      const dayData = monthData[day];
      const hitRate = dayData.totalRaces > 0 ? Math.round((dayData.hitRaces / dayData.totalRaces) * 100) : 0;
      const totalBetPoints = dayData.races.reduce((sum, race) => sum + (race.betPoints || 0), 0);
      const totalInvestment = totalBetPoints * 100; // 1点=100円
      const recoveryRate = totalInvestment > 0 ? Math.round((dayData.totalPayout / totalInvestment) * 100) : 0;
      return (
        <div class="day-section">
          <div class="day-header">
            <h2 class="day-title">${parseInt(month)}月{parseInt(day)}日 {dayData.venue}競馬</h2>
            <div class="perfect-badge">🏆 {dayData.hitRaces}/{dayData.totalRaces}的中</div>
          </div>

          <div class="day-summary">
            <div class="summary-item">
              📊 的中率: <span class="summary-value">{hitRate}%</span>
            </div>
            <div class="summary-item">
              📈 回収率: <span class="summary-value">{recoveryRate}%</span>
            </div>
            <div class="summary-item">
              🎯 合計購入点数: <span class="summary-value">{totalBetPoints}点</span>
            </div>
            <div class="summary-item">
              💰 合計配当: <span class="summary-value">¥{dayData.totalPayout.toLocaleString()}</span>
            </div>
          </div>

          <div class="races-grid">
            {dayData.races.filter(race => race.hit).map(race => (
              <div class="race-card">
                <div class="race-info">
                  <div class="race-number">{race.raceNumber}</div>
                  <div class="race-name">{race.raceName}</div>
                </div>
                <div class="race-result">
                  <div class="hit-badge">✅ 的中</div>
                  <div class="bet-info">{race.betType}{race.betPoints}点</div>
                  <div class="payout">¥{race.payout.toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    })}

    <div class="back-link">
      <a href="/archive/">← アーカイブトップ</a> |
      <a href="/pricing/">プレミアム予想</a>
    </div>
  </div>

  <!-- Sticky CTA（画面下部固定） -->
  <div class="sticky-cta">
    <div class="sticky-cta-content">
      <div class="sticky-cta-text">
        <div class="sticky-cta-title">🎯 高精度な予想をお求めの方へ</div>
        <div class="sticky-cta-description">AI分析による全レースの詳細な買い目を提供</div>
      </div>
      <div class="sticky-cta-buttons">
        <a href="/pricing/" class="sticky-cta-button sticky-cta-button-primary">
          💎 有料プランを見る
        </a>
        <a href="/free-prediction/nankan/" class="sticky-cta-button sticky-cta-button-secondary">
          🆓 無料予想を試す
        </a>
      </div>
    </div>
  </div>
</body>
</html>
`;

const umaTanPagePath = path.join(__dirname, `../src/pages/archive/${year}/${month}.astro`);
const yearDir = path.join(__dirname, `../src/pages/archive/${year}`);
if (!fs.existsSync(yearDir)) {
  fs.mkdirSync(yearDir, { recursive: true });
}

if (!fs.existsSync(umaTanPagePath)) {
  fs.writeFileSync(umaTanPagePath, umaTanPageTemplate, 'utf-8');
  console.log(`✅ 作成: src/pages/archive/${year}/${month}.astro`);
} else {
  console.log(`⚠️  既存: src/pages/archive/${year}/${month}.astro`);
}

console.log('');

// ============================================================
// 3. 次のステップ案内
// ============================================================

console.log(`📝 次のステップ:\n`);
console.log(`1. archive/index.astro を更新（${year}-${month}データをインポート）`);
console.log(`2. archive/${year}/index.astro を更新（${year}-${month}データをインポート）`);
console.log(`3. archive-sanrenpuku/index.astro を更新（${year}-${month}データをインポート）`);
console.log(`4. archive-sanrenpuku/${year}/index.astro を更新（${year}-${month}データをインポート）`);
console.log(`5. archive-sanrenpuku/${year}/${month}.astro を作成（前月をコピー）`);
console.log('');
console.log(`💡 自動更新スクリプトを実行:`);
console.log(`   node scripts/update-archive-imports.js ${year} ${month}`);
console.log('');

console.log(`✅ 完了！\n`);
