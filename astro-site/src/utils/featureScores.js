/**
 * featureScores.js
 *
 * racebook/pastRaces由来の実データから特徴量を算出するルールベースロジック
 * 全予想ページ共通で使用
 */

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

export function calcTrackCompatibility(recentRaces, currentVenue) {
  if (!recentRaces || recentRaces.length === 0) return 50;
  let sameVenue = 0, sameVenueGood = 0;
  for (const r of recentRaces) {
    const venue = r.venue || '';
    if (currentVenue && venue.includes(currentVenue.replace('競馬', ''))) {
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
    const rDist = r.distance ? parseInt(String(r.distance).match(/(\d{3,4})/)?.[1] || '0') : 0;
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
