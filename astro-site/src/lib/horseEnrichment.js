/**
 * 馬データ表示用の共通ユーティリティ。
 * nankan / jra の予想ページで「総合評価」「特徴量重要度」「評価ポイント」「基本情報」を
 * 統一的に算出するために使う。
 *
 * 入力は最低限 { pt, role, age?, weight?, jockey?, trainer?, sire?, recentRaces? }。
 * 元のキー名は予想スキーマごとに異なるため、各ページで正規化してから呼ぶ。
 */

// pt スコアを 0-100 に正規化（旧 nankan-analytics の総合評価レンジに合わせる）
export function computeOverallScore(pt) {
  const v = Number(pt) || 0;
  return Math.min(99, Math.max(50, Math.round(50 + v * 0.3)));
}

// 総合評価の星
export function getStarRating(score) {
  if (score >= 90) return '★★★★';
  if (score >= 80) return '★★★';
  if (score >= 70) return '★★';
  return '★';
}

// 信頼度（圧縮スコア）— 整数のみ、星より差を抑えて違和感のないレンジに
export function computeConfidence(pt) {
  const v = Number(pt) || 0;
  return Math.round(50 + Math.min(42, v * 0.28));
}

// "牝6" / "牡4" / "騸5" / "セ5" → { gender, ageNum }
export function parseSexAge(s) {
  if (!s || typeof s !== 'string') return { gender: '', ageNum: null };
  const m = s.match(/^([牡牝騸セ])\s*(\d+)/);
  if (!m) return { gender: '', ageNum: null };
  return { gender: m[1], ageNum: parseInt(m[2], 10) };
}

// レース番組距離（"ダ1600" や数値）から距離 m を抽出
export function parseDistanceMeters(d) {
  if (d == null) return null;
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  if (typeof d === 'string') {
    const m = d.match(/(\d{3,4})/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// 1走分の通過順 (e.g. "1-1-1-1" / "5-5-3-1") から脚質を判定する。
// 戻り値: 'nige' | 'senko' | 'sashi' | 'oikomi' | null
//   nige   : 序盤から先頭付近（平均1番手前後）
//   senko  : 序盤2-4番手で運ぶ
//   oikomi : 序盤後方→終盤前へ大きく順位を上げる
//   sashi  : 序盤後方で運び、終盤も中位以下から伸びるタイプ
//   null   : 通過順が無い、または判定不能
export function parseRunningStyleFromPassingOrder(passingOrder) {
  if (typeof passingOrder !== 'string') return null;
  const positions = passingOrder
    .split(/[-－―ー\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (positions.length === 0) return null;
  const half = Math.max(1, Math.floor(positions.length / 2));
  const early = positions.slice(0, half);
  const late = positions.slice(-half);
  const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const earlyAvg = avg(early);
  const lateAvg = avg(late);
  if (earlyAvg <= 1.5) return 'nige';
  if (earlyAvg <= 4) return 'senko';
  if (earlyAvg - lateAvg >= 3) return 'oikomi';
  if (earlyAvg >= 5) return 'sashi';
  return null;
}

// 直近 recentRaces を多数決で集約して脚質を返す（不明なら null）
export function detectRecentRunningStyle(recentRaces) {
  if (!Array.isArray(recentRaces)) return null;
  const counts = { nige: 0, senko: 0, sashi: 0, oikomi: 0 };
  for (const r of recentRaces) {
    const style = parseRunningStyleFromPassingOrder(r && r.passingOrder);
    if (style && counts[style] != null) counts[style] += 1;
  }
  const ranked = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return ranked.length > 0 ? ranked[0][0] : null;
}

// 評価ポイント（根拠タグ）を recentRaces / role / pt から導出
export function computeEvalPoints(h, allRaceHorses, raceDistance) {
  const points = [];
  const recent = Array.isArray(h.recentRaces) ? h.recentRaces : [];
  const role = h.role;
  const pt = Number(h.pt) || 0;

  // 能力上位 — レース内で pt が上位
  const ptList = (Array.isArray(allRaceHorses) ? allRaceHorses : [])
    .map(x => Number(x && x.pt) || 0)
    .filter(n => n > 0);
  if (ptList.length > 0) {
    const sorted = [...ptList].sort((a, b) => b - a);
    const rank = sorted.indexOf(pt) + 1;
    if (rank > 0 && rank <= 2) points.push('能力上位');
  } else if (role === '本命' || role === '対抗') {
    points.push('能力上位');
  }

  // 近走安定 — 直近の3着内率（rank が数値の走のみ）
  const validRanks = recent
    .map(r => Number(r && r.rank))
    .filter(n => Number.isFinite(n) && n > 0);
  if (validRanks.length >= 3) {
    const top3 = validRanks.filter(r => r <= 3).length;
    if (top3 / validRanks.length >= 0.6) points.push('近走安定');
  }

  // 連勝中 — 直近2走が両方1〜2着
  if (validRanks.length >= 2) {
    const last2 = validRanks.slice(0, 2);
    if (last2.every(r => r <= 2)) points.push('好走続き');
  }

  // 距離適性 — 同距離±100m での3着内実績
  const targetD = parseDistanceMeters(raceDistance);
  if (targetD) {
    const sameDistTop3 = recent.filter(r => {
      const d = parseDistanceMeters(r && r.distance);
      const rk = Number(r && r.rank);
      return d != null && Math.abs(d - targetD) <= 100 && Number.isFinite(rk) && rk <= 3;
    }).length;
    if (sameDistTop3 >= 1) points.push('距離適性あり');
  }

  // 上がり3F評価 — 直近の上がり3F平均から、脚質に応じた表現でタグ付け。
  //   差し / 追込: 「末脚優秀」（差し馬・追い込み馬の表現）avg < 40.5
  //   逃げ:       「終いの持続力」                          avg < 40.5
  //   先行:       「上がり3F安定」                          avg < 40.5
  //   不明:       原則タグなし。例外として極めて優秀な場合のみ
  //               「上がり3F評価」を控えめに付与（avg < 39.0）。
  // 「終い安定」は脚質不明馬への乱発防止のため廃止。
  const last3fs = recent
    .map(r => parseFloat(r && r.last3f))
    .filter(n => Number.isFinite(n));
  if (last3fs.length >= 2) {
    const avg = last3fs.reduce((a, b) => a + b, 0) / last3fs.length;
    const style = detectRecentRunningStyle(recent);
    if (style === 'sashi' || style === 'oikomi') {
      if (avg < 40.5) points.push('末脚優秀');
    } else if (style === 'nige') {
      if (avg < 40.5) points.push('終いの持続力');
    } else if (style === 'senko') {
      if (avg < 40.5) points.push('上がり3F安定');
    } else {
      // 脚質不明: 安易にタグ付けしない。極めて優秀な場合のみ控えめに評価。
      if (avg < 39.0) points.push('上がり3F評価');
    }
  }

  // 馬体重安定 — 直近の馬体重の振れ幅が小さい
  const bws = recent
    .map(r => Number(r && r.bodyWeight))
    .filter(n => Number.isFinite(n) && n > 0);
  if (bws.length >= 3) {
    const max = Math.max(...bws);
    const min = Math.min(...bws);
    if (max - min <= 10) points.push('馬体安定');
  }

  return points;
}

// 特徴量重要度（安定性 / 能力上位性 / 展開利）を recentRaces と pt から導出
export function computeImportance(h, allRaceHorses) {
  const pt = Number(h.pt) || 0;
  const recent = Array.isArray(h.recentRaces) ? h.recentRaces : [];

  // 安定性
  const ranks = recent
    .map(r => Number(r && r.rank))
    .filter(n => Number.isFinite(n) && n > 0);
  let stability;
  if (ranks.length > 0) {
    const top3Rate = ranks.filter(r => r <= 3).length / ranks.length;
    stability = 0.55 + top3Rate * 0.4;
  } else {
    stability = 0.55 + Math.min(0.4, pt / 400);
  }

  // 能力上位性
  const ptList = (Array.isArray(allRaceHorses) ? allRaceHorses : [])
    .map(x => Number(x && x.pt) || 0)
    .filter(n => n > 0);
  const maxPt = ptList.length ? Math.max(...ptList) : Math.max(pt, 1);
  let ability = pt > 0 ? 0.5 + (pt / maxPt) * 0.45 : 0.55;

  // 展開利
  const last3fs = recent
    .map(r => parseFloat(r && r.last3f))
    .filter(n => Number.isFinite(n));
  let pace;
  if (last3fs.length > 0) {
    const avg = last3fs.reduce((a, b) => a + b, 0) / last3fs.length;
    const norm = Math.max(0, Math.min(1, (43 - avg) / 5));
    pace = 0.6 + norm * 0.35;
  } else {
    pace = 0.55 + Math.min(0.4, pt / 450);
  }

  const clamp = (v) => Math.max(0.55, Math.min(0.97, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  return [
    { label: '安定性',     value: round2(clamp(stability)) },
    { label: '能力上位性', value: round2(clamp(ability)) },
    { label: '展開利',     value: round2(clamp(pace)) },
  ];
}

// 馬1頭分の表示用拡張データ。元データは破壊しない。
export function enrichHorse(h, allRaceHorses, raceDistance) {
  const pt = Number(h.pt || 0);
  const overallScore = computeOverallScore(pt);
  const stars = getStarRating(overallScore);
  const confidence = computeConfidence(pt);
  const importance = computeImportance(h, allRaceHorses);
  const evalPoints = computeEvalPoints(h, allRaceHorses, raceDistance);
  const { gender, ageNum } = parseSexAge(h.age);
  return {
    pt,
    overallScore,
    stars,
    confidence,
    importance,
    evalPoints,
    gender,
    ageNum,
  };
}
