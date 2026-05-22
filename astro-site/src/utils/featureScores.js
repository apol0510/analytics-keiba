/**
 * featureScores.js
 *
 * racebook/pastRaces由来の実データから特徴量を算出するルールベースロジック
 * 全予想ページ共通で使用
 */

/**
 * レースタイムから距離を推定する（racebook近走に distance がない場合のフォールバック）
 * タイム形式: "1.24.4" (分.秒.コンマ) or "59.8" (秒.コンマ)
 * JRA近走の time は "内1.23.4" / "外1.21.9" のようにトラックバイアス記号（内/外/中 等）が
 * 先頭に付くため、最初の数字までを除去してからパースする。
 * 精度は ±200m 程度のため、calcDistanceFitness の ±200m 許容範囲で機能する。
 */
function estimateDistanceFromTime(timeStr) {
  if (!timeStr) return 0;
  const t = String(timeStr).replace(/^[^\d]+/, '').trim();
  let totalSeconds = 0;
  const minsMatch = t.match(/^(\d+)\.(\d{2})\.(\d)$/);
  if (minsMatch) {
    totalSeconds = parseInt(minsMatch[1]) * 60 + parseInt(minsMatch[2]) + parseInt(minsMatch[3]) * 0.1;
  } else {
    const secsMatch = t.match(/^(\d{2})\.(\d)$/);
    if (secsMatch) {
      totalSeconds = parseInt(secsMatch[1]) + parseInt(secsMatch[2]) * 0.1;
    } else {
      return 0;
    }
  }
  if (totalSeconds < 55) return 0; // 異常値
  if (totalSeconds < 65) return 1000;
  if (totalSeconds < 77) return 1200;
  if (totalSeconds < 89) return 1400;
  if (totalSeconds < 101) return 1600;
  if (totalSeconds < 115) return 1800;
  if (totalSeconds < 127) return 2000;
  if (totalSeconds < 140) return 2200;
  if (totalSeconds < 155) return 2400;
  if (totalSeconds < 170) return 2600;
  if (totalSeconds < 185) return 3000;
  if (totalSeconds < 220) return 3200;
  return 3600;
}

function finishToScore(rank) {
  if (!rank || rank <= 0) return 0;
  if (rank === 1) return 100;
  if (rank === 2) return 85;
  if (rank === 3) return 70;
  if (rank <= 5) return 55;
  if (rank <= 8) return 35;
  return 15;
}

export function calcFormTrend(recentRaces) {
  if (!recentRaces || recentRaces.length === 0) return 0;
  const races = recentRaces.slice(0, 5);
  const weights = [1.0, 0.8, 0.6, 0.4, 0.2];
  let trend = 0, totalWeight = 0;
  for (let i = 0; i < races.length; i++) {
    const rank = races[i].rank || races[i].finish;
    if (rank && rank > 0) {
      trend += finishToScore(rank) * weights[i];
      totalWeight += weights[i];
    }
  }
  if (totalWeight === 0) return 0;
  return (trend / totalWeight) - 50;
}

export function calcSpeedIndex(recentRaces) {
  if (!recentRaces || recentRaces.length === 0) return 50;
  const races = recentRaces.slice(0, 3);
  let score = 50;
  for (const r of races) {
    const f3 = parseFloat(r.last3f || r.final3F || '0');
    if (f3 > 0) {
      if (f3 < 34) score += 20;
      else if (f3 < 35) score += 15;
      else if (f3 < 36) score += 10;
      else if (f3 < 37) score += 5;
      else if (f3 > 39) score -= 5;
    }
    const rank = r.rank || r.finish;
    if (rank === 1) score += 10;
    else if (rank === 2) score += 5;
    else if (rank === 3) score += 2;
  }
  return Math.min(100, Math.max(20, score));
}

export function calcStaminaRating(recentRaces) {
  if (!recentRaces || recentRaces.length === 0) return 50;
  const races = recentRaces.slice(0, 4);
  let score = 50;
  for (const r of races) {
    if (r.paceType === 'H' || r.paceType === 'Ｈ') {
      const rank = r.rank || r.finish;
      if (rank && rank <= 3) score += 12;
      else if (rank && rank <= 5) score += 5;
    }
    const f3 = parseFloat(r.last3f || r.final3F || '0');
    if (f3 > 42) score -= 8;
    else if (f3 > 40) score -= 3;
    else if (f3 < 37 && f3 > 0) score += 5;
  }
  return Math.min(100, Math.max(20, score));
}

/**
 * JRA racebook 近走の venue 形式（"4東10.18"）から場名略称1文字を抽出し、
 * 正式名称に展開するマップ。中 → 中山/中京 は曖昧なため両方をマッチ対象とする。
 */
const VENUE_ABBREV_MAP = {
  '東': '東京', '京': '京都', '阪': '阪神',
  '小': '小倉', '新': '新潟', '福': '福島', '札': '札幌', '函': '函館',
  // '中' → 中山 or 中京（曖昧）。extractVenueName で 1文字 "中" を返し、比較側で先頭一致
  // 南関・地方
  '大': '大井', '川': '川崎', '船': '船橋', '浦': '浦和',
  '門': '門別', '盛': '盛岡', '水': '水沢', '金': '金沢',
  '笠': '笠松', '名': '名古屋', '園': '園田', '姫': '姫路',
  '高': '高知', '佐': '佐賀', '帯': '帯広',
};

/**
 * 近走venueから場名を抽出する
 * - "大井 3.24" → "大井"     (南関テキスト形式: スペース区切り)
 * - "4東10.18"  → "東京"     (JRA XML形式: 回次+場名1字+日付)
 * - "東京"      → "東京"     (そのまま)
 */
function extractVenueName(rawVenue) {
  if (!rawVenue) return '';
  // 南関テキスト形式: "大井 3.24" → スペース前を取得
  if (/\s/.test(rawVenue)) return rawVenue.split(/\s+/)[0];
  // JRA XML形式: "4東10.18" → 数字+漢字1文字+数字... のパターン
  const jraMatch = rawVenue.match(/^\d([^\d])/);
  if (jraMatch) {
    const abbrev = jraMatch[1];
    // "中" は中山/中京で曖昧 → そのまま返す（比較側で先頭一致を使う）
    return VENUE_ABBREV_MAP[abbrev] || abbrev;
  }
  // その他: そのまま返す
  return rawVenue;
}

export function calcTrackCompatibility(recentRaces, currentVenue) {
  if (!recentRaces || recentRaces.length === 0) return 50;
  // currentVenue: "大井", "東京競馬", "福島" etc. → 比較用に"競馬"を除去
  const normalizedCurrentVenue = (currentVenue || '').replace('競馬', '');
  if (!normalizedCurrentVenue) return 50;
  let sameVenue = 0, sameVenueGood = 0;
  for (const r of recentRaces) {
    const trackName = extractVenueName(r.venue || '');
    if (!trackName) continue;
    // "中" の曖昧対応: "中山" の先頭1文字 "中" で比較、
    // または trackName="東京" と currentVenue="東京" の完全一致/包含
    const isMatch = trackName.includes(normalizedCurrentVenue)
      || normalizedCurrentVenue.includes(trackName)
      || (trackName.length === 1 && normalizedCurrentVenue.startsWith(trackName));
    if (isMatch) {
      sameVenue++;
      const rank = r.rank || r.finish;
      if (rank && rank <= 3) sameVenueGood++;
    }
  }
  if (sameVenue === 0) return 50;
  return Math.min(100, Math.max(20, 50 + (sameVenueGood / sameVenue) * 40));
}

export function calcDistanceFitness(recentRaces, currentDistance) {
  if (!recentRaces || recentRaces.length === 0) return 50;
  const distMatch = String(currentDistance || '').match(/(\d{3,4})/);
  const targetDist = distMatch ? parseInt(distMatch[1]) : 0;
  if (!targetDist) return 50;

  let sameDist = 0, sameDistGood = 0;
  for (const r of recentRaces) {
    // distance(文字列) から抽出、空なら time から推定（JRA近走は distance が空のため必須）
    const rDist = (r.distance ? parseInt(String(r.distance).match(/(\d{3,4})/)?.[1] || '0') : 0) || estimateDistanceFromTime(r.time);
    if (rDist && Math.abs(rDist - targetDist) <= 200) {
      sameDist++;
      const rank = r.rank || r.finish;
      if (rank && rank <= 3) sameDistGood++;
      else if (rank && rank <= 5) sameDistGood += 0.5;
    }
  }
  if (sameDist === 0) return 50;
  return Math.min(100, Math.max(20, 50 + (sameDistGood / sameDist) * 40));
}

export function calcJockeyFactor(horse, allHorses) {
  const roleScores = { '本命': 90, '対抗': 80, '単穴': 70, '連下最上位': 60, '連下': 50, '補欠': 40, '無': 35 };
  let base = roleScores[horse.role] || 50;
  const maxPt = Math.max(...allHorses.map(h => h.pt));
  if (maxPt > 0) base += (horse.pt / maxPt) * 10;
  return Math.min(100, Math.max(30, base));
}

/**
 * 全特徴量を算出してメトリクスオブジェクトを返す
 */
export function generateAdvancedMetrics(horse, allHorses, raceInfo) {
  const pt = horse.pt;
  const maxPt = Math.max(...allHorses.map(h => h.pt));
  const minPt = Math.min(...allHorses.map(h => h.pt));
  const ptRange = maxPt - minPt || 1;
  const normalizedPt = (pt - minPt) / ptRange;

  const recent = horse.recentRaces || [];
  const venue = raceInfo?.venue || '';
  const distance = raceInfo?.distance || '';

  const formTrendRaw = calcFormTrend(recent);
  const speedIndex = calcSpeedIndex(recent);
  const staminaRating = calcStaminaRating(recent);
  const trackCompatibility = calcTrackCompatibility(recent, venue);
  const distanceFitness = calcDistanceFitness(recent, distance);
  const jockeyFactor = calcJockeyFactor(horse, allHorses);

  const featureAvg = (speedIndex * 0.25 + (formTrendRaw + 50) * 0.3 + staminaRating * 0.15 +
    trackCompatibility * 0.1 + distanceFitness * 0.1 + jockeyFactor * 0.1) / 100 * 40;
  const winProbability = Math.min(45, Math.max(2, featureAvg + normalizedPt * 10));

  const placeProb = Math.min(85, winProbability * 2.1);

  const dataRichness = Math.min(1, recent.length / 4);
  const modelCertainty = Math.min(0.95, Math.max(0.60, 0.65 + dataRichness * 0.25 + normalizedPt * 0.05));

  // 推定オッズ: predictedOddsがあればそれを使用、なければ勝率から逆算
  let estimatedOdds;
  if (horse.predictedOdds && Number(horse.predictedOdds) > 0) {
    estimatedOdds = Number(horse.predictedOdds);
  } else {
    // 勝率から推定オッズを算出（控除率25%想定）
    estimatedOdds = winProbability > 0 ? Math.max(1.2, (75 / winProbability)) : 50.0;
  }
  // 期待値 = (オッズ × 勝率) - 1
  const expectedValue = (estimatedOdds * (winProbability / 100)) - 1;

  const riskScore = 100 - (modelCertainty * 100);
  let riskLevel = 'Low';
  if (riskScore > 35) riskLevel = 'Medium';
  if (riskScore > 60) riskLevel = 'High';

  const confidenceInterval = {
    lower: Math.max(0, winProbability - (100 - modelCertainty * 100) * 0.3),
    upper: Math.min(100, winProbability + (100 - modelCertainty * 100) * 0.3)
  };

  return {
    winProbability: winProbability.toFixed(2),
    placeProb: placeProb.toFixed(2),
    speedIndex: speedIndex.toFixed(1),
    staminaRating: staminaRating.toFixed(1),
    formTrend: formTrendRaw >= 0 ? `+${formTrendRaw.toFixed(1)}` : formTrendRaw.toFixed(1),
    trackCompatibility: trackCompatibility.toFixed(1),
    distanceFitness: distanceFitness.toFixed(1),
    jockeyFactor: jockeyFactor.toFixed(1),
    modelCertainty: (modelCertainty * 100).toFixed(1),
    expectedValue: expectedValue >= 0 ? `+${(expectedValue * 100).toFixed(1)}%` : `${(expectedValue * 100).toFixed(1)}%`,
    riskLevel,
    riskScore: riskScore.toFixed(1),
    estimatedOdds: estimatedOdds.toFixed(1),
    confidenceInterval
  };
}
