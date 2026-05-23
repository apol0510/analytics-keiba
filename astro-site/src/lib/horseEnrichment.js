/**
 * 馬データ表示用の共通ユーティリティ。
 * nankan / jra の予想ページで「総合評価」「特徴量重要度」「評価ポイント」「基本情報」を
 * 統一的に算出するために使う。
 *
 * 入力は最低限 { pt, role, age?, weight?, jockey?, trainer?, sire?, recentRaces? }。
 * 元のキー名は予想スキーマごとに異なるため、各ページで正規化してから呼ぶ。
 */

/**
 * 過去走 (recentRaces) の venue 文字列を判読性の高い表記に整形する。
 *
 * JRA 形式: "2中3.15" → "2回中山 3/15"
 *   - 先頭の数字: 開催回（その年の N 回目の開催節）
 *   - 次の漢字: 競馬場略号（京=京都 / 阪=阪神 / 東=東京 / 中=中山-中京 / 新=新潟 / 福=福島 / 小=小倉 / 札=札幌 / 函=函館）
 *   - 末尾の "M.D": 月.日
 *
 * 「中」は元データで中山/中京の区別が無いため、開催月で推定：
 *   - 5月・7月 → 中京（その月の中山開催は無い）
 *   - 8月・10月・11月 → 中山（その月の中京開催は無い）
 *   - それ以外（1/3/9/12月など両方ありえる月）→ "中山/中京" と並記
 *
 * パターン一致しない場合は元文字列をそのまま返す。
 *
 * @param {string} s venue 文字列
 * @returns {string} 整形済み venue 文字列
 */
export function formatRecentVenue(s, baseDate) {
  if (!s || typeof s !== 'string') return s || '';
  const m = s.match(/^(\d+)([^\d]+?)(\d+)\.(\d+)$/);
  if (!m) return s;
  // m[1] (開催回) は判読の妨げになるため非表示
  const abbr = m[2];
  const mo = parseInt(m[3], 10);
  const day = parseInt(m[4], 10);
  const map = {
    '京': '京都', '阪': '阪神', '東': '東京', '新': '新潟',
    '福': '福島', '小': '小倉', '札': '札幌', '函': '函館',
  };
  let full;
  if (map[abbr]) {
    full = map[abbr];
  } else if (abbr === '中') {
    // JRA 中山開催月: 1, 3, 4, 9, 12 / 中京開催月: 1, 3, 5, 7, 9, 12
    // 確実に区別できる月のみ展開、それ以外は安全側で並記表示。
    if (mo === 5 || mo === 7) full = '中京';
    else if (mo === 4) full = '中山';
    else full = '中山/中京';
  } else {
    full = abbr;
  }
  // 年推定: ベース日付（省略時=現在）と比較し、月日が未来側なら前年とみなす。
  const today = baseDate instanceof Date ? baseDate : new Date();
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  const year = (mo > tm || (mo === tm && day > td)) ? ty - 1 : ty;
  const yy = String(year).slice(-2);
  const mm = String(mo).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${full} ${yy}/${mm}/${dd}`;
}

// pt スコアを 0-100 に正規化（旧 nankan-analytics の総合評価レンジに合わせる）
// 注: 星評価判定には使わない（getStarRating は pt を直接見る）。
// この関数は overallScore の数値表示や confidence と独立した参考値用途として残置。
export function computeOverallScore(pt) {
  const v = Number(pt) || 0;
  return Math.min(99, Math.max(50, Math.round(50 + v * 0.3)));
}

/**
 * 総合評価の星 — role を加味した役割別評価
 *
 * 2026-05-14 修正:
 *   sourceComputerIndex 導入で累積スコアが 70〜160 帯に拡張された結果、
 *   全頭が★★★★に張り付き「★★★★の価値が薄まる」問題が発生したため、
 *   role × pt の組合せで星を決める設計に変更。
 *
 *   本命 / 対抗:
 *     pt >= 150 → ★★★★    (高評価本命級のみ)
 *     pt <  150 → ★★★
 *
 *   単穴 / 連下最上位 / 連下:
 *     → 一律 ★★★         (買い目候補の主帯)
 *
 *   押さえ / 抑え / 補欠:
 *     pt >  70 → ★★★      (sourceComputerIndex >=45 で救済された馬)
 *     pt <= 70 → ★★       (フロア・不要馬境界)
 *
 *   無 / 不明 / undefined:
 *     pt >  0  → ★★
 *     pt <= 0  → ★         (異常値)
 *
 * @param {number|string} pt 累積スコア
 * @param {string} [role]   馬の役割（本命/対抗/単穴/連下/連下最上位/押さえ/抑え/補欠/無）
 * @returns {string} 「★」の連続文字列
 */
export function getStarRating(pt, role) {
  const v = Number(pt) || 0;
  switch (role) {
    case '本命':
    case '対抗':
      return v >= 150 ? '★★★★' : '★★★';
    case '単穴':
    case '連下最上位':
    case '連下':
      return '★★★';
    case '押さえ':
    case '抑え':
    case '補欠':
      return v > 70 ? '★★★' : '★★';
    default:
      // role が未指定 or '無' などは pt のみで判定（フォールバック）
      if (v > 0) return '★★';
      return '★';
  }
}

// 星数別の confidence レンジ。
// 2026-05-16: getStarRating と完全連動させ「★★★ 85 と ★★★★ 85 が並ぶ」矛盾を解消。
//   星数が増えるほど confidence の上限も上がる単調な対応にする。
const STAR_CONFIDENCE_RANGE = {
  4: [82, 85], // ★★★★ 高評価帯
  3: [75, 81], // ★★★   中評価帯
  2: [65, 74], // ★★    控えめ評価帯
  1: [50, 64], // ★     最低評価帯
};

/**
 * 総合評価カッコ内に表示する 0-85 帯の信頼度スコア。
 *
 * 星数（getStarRating の結果）と完全連動させる。
 *   - ★★★★ → 82-85
 *   - ★★★  → 75-81
 *   - ★★   → 65-74
 *   - ★    → 50-64
 *
 * 各帯の中での具体値は pt の相対位置で線形補間。
 *   ratio = clamp((pt - 70) / 90, 0, 1)
 *   confidence = round(base + ratio * (cap - base))
 *
 * 2026-05-14: 旧仕様は (50 + min(42, pt * 0.28)) で pt=156 → 92 を返していた。
 *   「総合評価★★★★（92）」が過大表記との指摘により、85 点上限に再設計。
 * 2026-05-16: role 別レンジから「星数別レンジ」へ切替。
 *   旧仕様では本命 pt=148 が ★★★(85) / 本命 pt=150 が ★★★★(85) のように
 *   星数が増えても confidence が変わらない並びが発生していたため、
 *   星数を一次キーにして単調連動するレンジに変更。
 *
 * @param {number|string} pt 累積スコア
 * @param {string} [role]   馬の役割
 */
export function computeConfidence(pt, role) {
  const v = Number(pt) || 0;
  if (v <= 0) return 50;
  const stars = getStarRating(v, role).length;
  const [base, cap] = STAR_CONFIDENCE_RANGE[stars] || [60, 70];
  const ratio = Math.max(0, Math.min(1, (v - 70) / 90));
  return Math.round(base + ratio * (cap - base));
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

// 連下 / 押さえ / 見送り馬向けの短評を、本命との pt 差から決定的に生成する。
// 同じ役割・差レンジなら毎回同じ文言になるよう、ランダム性は持たせない。
export function generateMinorHorseComment(role, gapFromHonmei) {
  const gap = Number(gapFromHonmei) || 0;
  if (role === '連下' || role === '連下最上位') {
    if (gap <= 10) return '上位評価馬との差は小さく、馬券圏内まで十分浮上可能な一頭。';
    if (gap <= 20) return '上位評価馬との差はあるが、相手候補として残せる能力値。';
    return '能力上位性に支えられた連下評価。展開次第で浮上余地あり。';
  }
  if (role === '押さえ' || role === '抑え' || role === '補欠') {
    if (gap <= 25) return '本線評価までは届かないが、展開が向けば押さえ候補。';
    if (gap <= 40) return 'スコアは控えめながら、上位崩れの際に浮上余地あり。';
    return '上位勢崩れの大穴候補として残す価値あり。';
  }
  // 不要 / 無印 / その他（A〜Cいずれにも入らなかった馬）
  if (gap <= 40) return '上位比較で評価を下げた一頭。今回は買い目候補からは見送り。';
  if (gap <= 60) return 'スコア面で上位候補には届かず、今回は評価を控えめに判断。';
  return '展開待ちの要素が強く、今回は買い目から外す判断。';
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

// 評価ポイント（根拠タグ）を recentRaces から導出
//
// 2026-05-24 廃止: 「能力上位」タグ
//   理由: pt ランク上位2頭に必ず付くため、本命・対抗で常に表示され
//         「評価ポイントが能力上位ばかり」状態になっていた。役割バッジ
//         （本命/対抗/単穴）で同じ情報を既に表現しているので冗長。
//         過去走由来の他タグで馬ごとの個別差を出す。
export function computeEvalPoints(h, allRaceHorses, raceDistance) {
  const points = [];
  const recent = Array.isArray(h.recentRaces) ? h.recentRaces : [];

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

// 役割別の評価材料（特徴量）上限 — 85 点満点
// 「特徴量重要度 95%」のような確率風表記を避け、評価材料の「点数」として
// 役割に応じた控えめなレンジに収める。
//
// 2026-05-24 廃止: abil（能力上位性）
//   理由: pt / maxPt の写像でしかなく、累積スコア(pt)と同じ情報を％で
//         繰り返し表示していた。本命馬は必ず 95% 付近に張り付いて
//         「特徴量重要度がデタラメ」とユーザー体感を損なっていた。
//         過去走由来の安定性 + 展開利の2軸に絞ることで個別差を出す。
const IMPORTANCE_CAP = {
  '本命':       { stab: 85, pace: 84 },
  '対抗':       { stab: 84, pace: 82 },
  '単穴':       { stab: 82, pace: 80 },
  '連下最上位': { stab: 80, pace: 78 },
  '連下':       { stab: 78, pace: 76 },
  '押さえ':     { stab: 76, pace: 74 },
  '抑え':       { stab: 76, pace: 74 },
  '補欠':       { stab: 76, pace: 74 },
};
const IMPORTANCE_FLOOR = 65;

// 0.55〜0.97 帯の比率を role 別 cap で 0-85 帯の点数に変換
function importanceValueToPoint(value, cap) {
  const norm = Math.max(0, Math.min(1, ((Number(value) || 0) - 0.55) / 0.42));
  return Math.round(IMPORTANCE_FLOOR + norm * (cap - IMPORTANCE_FLOOR));
}

// 特徴量重要度（安定性 / 展開利）を recentRaces から導出
//
// 2026-05-24: 「能力上位性」を廃止（pt との情報重複のため）
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

  // 展開利
  // 2026-05-16: JRA/南関で last3f の絶対値域が大きく異なる（JRA ~33-36, 南関 ~38-42）。
  // 従来の固定式 (43-avg)/5 は南関想定で、JRA では常に飽和して全頭展開利95%に張り付いた。
  // そのため「同レース内の last3f 中央値」を基準にした相対比較に切り替え、
  // どちらの開催種別でも自然な分布が出るようにする。
  const last3fs = recent
    .map(r => parseFloat(r && r.last3f))
    .filter(n => Number.isFinite(n) && n > 0);
  let pace;
  if (last3fs.length > 0) {
    const avg = last3fs.reduce((a, b) => a + b, 0) / last3fs.length;
    // 同レース全頭の recentRaces.last3f を集めて中央値を取る
    const all = (Array.isArray(allRaceHorses) ? allRaceHorses : [])
      .flatMap(x => Array.isArray(x && x.recentRaces) ? x.recentRaces : [])
      .map(r => parseFloat(r && r.last3f))
      .filter(n => Number.isFinite(n) && n > 0);
    if (all.length >= 4) {
      const sorted = all.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      // median ±2.0 秒の幅で 0-1 線形（速いほど高評価）
      const diff = median - avg;
      const norm = Math.max(0, Math.min(1, (diff + 2) / 4));
      pace = 0.55 + norm * 0.4;
    } else {
      // 全頭分のサンプルが少ないときの絶対値フォールバック（従来式）
      const norm = Math.max(0, Math.min(1, (43 - avg) / 5));
      pace = 0.6 + norm * 0.35;
    }
  } else {
    pace = 0.55 + Math.min(0.4, pt / 450);
  }

  const clamp = (v) => Math.max(0.55, Math.min(0.97, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  // role 別の上限を引き、value (0-1) と point (0-85) を両方返す
  const caps = IMPORTANCE_CAP[h.role] || { stab: 70, pace: 70 };
  const sV = round2(clamp(stability));
  const pV = round2(clamp(pace));
  return [
    { label: '安定性', value: sV, point: importanceValueToPoint(sV, caps.stab) },
    { label: '展開利', value: pV, point: importanceValueToPoint(pV, caps.pace) },
  ];
}

// 馬1頭分の表示用拡張データ。元データは破壊しない。
export function enrichHorse(h, allRaceHorses, raceDistance) {
  const pt = Number(h.pt || 0);
  const overallScore = computeOverallScore(pt);
  const stars = getStarRating(pt, h.role); // 2026-05-14: role-aware 星評価
  const confidence = computeConfidence(pt, h.role); // 2026-05-14: role-aware（85 点上限）
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
