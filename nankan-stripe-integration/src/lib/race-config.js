/**
 * レース設定の一元管理
 * このファイルでレースのtier（会員レベル）を統一管理します
 */

// レース番号ごとのtier設定（絶対厳守）
export const RACE_TIERS = {
  1: 'premium',   // プレミアム会員専用
  2: 'premium',   
  3: 'premium',
  4: 'premium',
  5: 'premium',
  6: 'premium',
  7: 'premium',
  8: 'premium',
  9: 'premium',
  10: 'standard', // スタンダード会員
  11: 'free',     // 無料（メインレース）★重要★
  12: 'standard'  // スタンダード会員（最終レースだが無料ではない！）
};

// 10レース開催時のtier設定
export const RACE_TIERS_10R = {
  1: 'premium',
  2: 'premium',
  3: 'premium',
  4: 'premium',
  5: 'premium',
  6: 'premium',
  7: 'premium',
  8: 'premium',
  9: 'free',      // 10レース時は9Rがメインレース
  10: 'standard'
};

/**
 * レース番号からtierを取得
 * @param {number} raceNumber - レース番号（1-12）
 * @param {number} totalRaces - 総レース数（デフォルト: 12）
 * @returns {string} tier名（'free', 'standard', 'premium'）
 */
export function getRaceTier(raceNumber, totalRaces = 12) {
  if (totalRaces === 10) {
    return RACE_TIERS_10R[raceNumber] || 'premium';
  }
  return RACE_TIERS[raceNumber] || 'premium';
}

/**
 * メインレース番号を取得
 * @param {number} totalRaces - 総レース数
 * @returns {number} メインレース番号
 */
export function getMainRaceNumber(totalRaces = 12) {
  return totalRaces === 10 ? 9 : 11;
}

/**
 * レースがメインレースかどうか判定
 * @param {number} raceNumber - レース番号
 * @param {number} totalRaces - 総レース数
 * @returns {boolean} メインレースの場合true
 */
export function isMainRace(raceNumber, totalRaces = 12) {
  return raceNumber === getMainRaceNumber(totalRaces);
}

/**
 * プラン別アクセス可能レース設定
 */
export const PLAN_ACCESS = {
  free: {
    name: '無料会員',
    races: (totalRaces = 12) => [getMainRaceNumber(totalRaces)],
    features: ['メインレース予想']
  },
  standard: {
    name: 'スタンダード会員',
    races: (totalRaces = 12) => {
      if (totalRaces === 10) return [9, 10];
      return [10, 11, 12];
    },
    features: ['後半3レース予想', '基礎コンテンツ']
  },
  premium: {
    name: 'プレミアム会員',
    races: () => 'all', // 全レースアクセス可能
    features: ['全レース予想', 'すべてのコンテンツ']
  }
};

/**
 * ユーザーがレースにアクセス可能か判定
 * @param {string} userPlan - ユーザーのプラン（'free', 'standard', 'premium'）
 * @param {number} raceNumber - レース番号
 * @param {number} totalRaces - 総レース数
 * @returns {boolean} アクセス可能な場合true
 */
export function canAccessRace(userPlan, raceNumber, totalRaces = 12) {
  if (!userPlan) return false;
  if (userPlan === 'premium') return true;
  
  const raceTier = getRaceTier(raceNumber, totalRaces);
  
  if (userPlan === 'free') {
    return raceTier === 'free';
  }
  
  if (userPlan === 'standard') {
    return raceTier === 'free' || raceTier === 'standard';
  }
  
  return false;
}

/**
 * レース番号の表示名を取得
 * @param {number} raceNumber - レース番号
 * @param {number} totalRaces - 総レース数
 * @returns {string} 表示名（例: "11R (メイン・free)"）
 */
export function getRaceDisplayName(raceNumber, totalRaces = 12) {
  const tier = getRaceTier(raceNumber, totalRaces);
  const isMain = isMainRace(raceNumber, totalRaces);
  
  let displayName = `${raceNumber}R`;
  
  if (isMain) {
    displayName += ' (メイン・free)';
  } else if (tier === 'standard') {
    displayName += ' (standard)';
  } else if (tier === 'premium') {
    displayName += ' (premium)';
  }
  
  return displayName;
}

/**
 * tier別のスタイルクラス名を取得
 * @param {string} tier - tier名
 * @returns {string} CSSクラス名
 */
export function getTierStyleClass(tier) {
  const styles = {
    free: 'tier-free',
    standard: 'tier-standard',
    premium: 'tier-premium'
  };
  return styles[tier] || 'tier-default';
}

/**
 * tier別のカラーコードを取得
 * @param {string} tier - tier名
 * @returns {string} カラーコード
 */
export function getTierColor(tier) {
  const colors = {
    free: '#10b981',     // グリーン
    standard: '#3b82f6', // ブルー
    premium: '#8b5cf6'   // パープル
  };
  return colors[tier] || '#94a3b8';
}