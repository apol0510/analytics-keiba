/**
 * adjustPrediction.js — analytics-keiba 独自スコアリング
 *
 * データ主導AI（コンピ指数 + 特徴量重視）の方針で役割を決定する。
 * 詳細仕様: astro-site/docs/PREDICTION_LOGIC.md
 *
 * スコア式:
 *   analyticsScore = computerIndex × 0.5 + featureScore × 0.3 + markScore × 0.2
 *   （各項は 0–100 に正規化）
 *
 * 役割決定:
 *   - analyticsScore 降順で決定
 *   - keiba-intelligence とは異なり「印1◎ 固定」は行わない
 *   - 差別化ルール（意図的に keiba-intelligence と別結果を作る）:
 *       a) 上位2頭の analyticsScore 差 < 3% → computerIndex 最大の馬を本命に
 *       b) analyticsScore 最大 ≠ computerIndex 最大 → computerIndex 最大の馬を本命に
 *
 * 共通ルール:
 *   - displayScore = rawScore + 70（0点は0のまま、UI 互換性のため維持）
 *   - 連下は 3 頭まで、残りは補欠（変更なし）
 *   - 表示用印（◎/○/▲/△/×）を割り当て
 */

import { calcSpeedIndex, calcFormTrend, calcStaminaRating } from './featureScores.js';

/**
 * 役割名から表示用印記号に変換
 *
 * @param {string} role - 役割名
 * @returns {string} 印記号
 */
function getRoleMark(role) {
  const markMap = {
    '本命': '◎',
    '対抗': '○',
    '単穴': '▲',
    '連下最上位': '△',
    '連下': '△',
    '補欠': '×',
    '無': '-'
  };

  return markMap[role] || '-';
}

/**
 * 印スコア計算（印1〜4の重み付け合計 → 0–100 に正規化）
 * 旧仕様: 印1×4 + 印2×3 + 印3×2 + 印4×1、最大30。
 * analytics 独自式では全体の 20% の重みで使用する。
 */
function calculateMarkScore(horse) {
  const markPoints = { '◎': 4, '○': 3, '▲': 2, '△': 1, '-': 0, 'svg': 0, '無': 0 };
  const marks = horse.marks || {};
  const raw =
    (markPoints[marks['印1']] || 0) * 4 +
    (markPoints[marks['印2']] || 0) * 3 +
    (markPoints[marks['印3']] || 0) * 2 +
    (markPoints[marks['印4']] || 0) * 1;
  // 理論最大 30 を 100 に正規化（超えた分はクリップ）
  return Math.max(0, Math.min(100, (raw / 30) * 100));
}

/**
 * 特徴量スコア計算（0–100 に正規化）
 * calcSpeedIndex / calcFormTrend / calcStaminaRating の加重平均。
 * 過去走データ（_pastRaces）が無い馬は featureScore=50（中立）扱い。
 */
function calculateFeatureScore(horse) {
  const recent = horse._pastRaces || horse.recentRaces || [];
  if (recent.length === 0) return 50;
  const speed = Math.max(0, Math.min(100, calcSpeedIndex(recent)));
  const formNorm = Math.max(0, Math.min(100, calcFormTrend(recent) + 50)); // -50..+50 → 0..100
  const stamina = Math.max(0, Math.min(100, calcStaminaRating(recent)));
  // 重み: スピード 0.4 / 展開利(form) 0.4 / スタミナ 0.2
  return speed * 0.4 + formNorm * 0.4 + stamina * 0.2;
}

/**
 * コンピ指数を 0–100 に正規化（実運用では 40–99 の範囲に収まる）
 */
function normalizeComputer(horse) {
  const ci = Number(horse.computerIndex || 0);
  return Math.max(0, Math.min(100, ci));
}

/**
 * analytics-keiba 総合スコア
 *   = computerIndex × 0.5 + featureScore × 0.3 + markScore × 0.2
 */
function calculateAnalyticsScore(horse) {
  const c = normalizeComputer(horse);
  const f = calculateFeatureScore(horse);
  const m = calculateMarkScore(horse);
  return c * 0.5 + f * 0.3 + m * 0.2;
}

/**
 * 正規化された予想データに調整ルールを適用
 * 南関競馬・中央競馬（JRA）共通のロジック
 *
 * @param {Object} normalized - 正規化済み予想データ
 * @returns {Object} 調整済み予想データ
 */
export function adjustPrediction(normalized) {
  // ディープコピー（元データを変更しない）
  const adjusted = JSON.parse(JSON.stringify(normalized));

  // 各レースに対して調整処理を実行
  for (const race of adjusted.races) {

    // 馬データがない場合はスキップ
    if (!race.horses || race.horses.length === 0) {
      race.hasHorseData = false;
      continue;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 1: displayScore計算
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const horse of race.horses) {
      if (horse.rawScore > 0) {
        horse.displayScore = horse.rawScore + 70;
      } else {
        horse.displayScore = 0;
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 2: analytics-keiba 総合スコア計算
    //   analyticsScore = computerIndex × 0.5 + featureScore × 0.3 + markScore × 0.2
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const horse of race.horses) {
      horse.markScore = calculateMarkScore(horse);
      horse.featureScore = calculateFeatureScore(horse);
      horse.analyticsScore = calculateAnalyticsScore(horse);
      // 旧 customScore フィールドは残しておく（UI/ログ互換）
      horse.customScore = horse.markScore;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: analyticsScore 順で役割決定（差別化ルール付き）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // スコアのある馬のみ対象
    const hasAnyScore = race.horses.some(h => h.analyticsScore > 0 || h.rawScore > 0);
    const activeHorses = race.horses.filter(h => h.analyticsScore > 0 || h.rawScore > 0);

    // analyticsScore がどの馬も 0（= 全馬 computerIndex/mark/feature 全部 0）で、
    // 既に外部から役割が割り当てられている場合はそれを維持する
    const hasExistingRoles = race.horses.some(h => h.role !== '無');
    const preserveRoles = !hasAnyScore && hasExistingRoles;

    if (preserveRoles) {
      // 既存の役割を維持（Step 4 以降のみ実行）
    } else {
      // 全馬の役割をリセット
      for (const horse of race.horses) {
        horse.role = '無';
      }

      // analyticsScore 降順ソート
      const sortedByScore = [...activeHorses].sort((a, b) => b.analyticsScore - a.analyticsScore);
      // computerIndex 降順ソート（差別化ルール用）
      const sortedByComputer = [...activeHorses].sort((a, b) => normalizeComputer(b) - normalizeComputer(a));

      // 差別化ルール判定（荒れ防止ガード付き）:
      //   (a) 上位2頭の analyticsScore 差 < 3% → computer 優先
      //   (b) analyticsScore 最大 ≠ computerIndex 最大 → computer 優先
      //   ただし、computer-top が analyticsScore 上位3位以内でない場合は swap しない
      //   （荒れすぎ防止）
      let honmei = sortedByScore[0] || null;
      const topScore = honmei ? honmei.analyticsScore : 0;
      const secondScore = sortedByScore[1] ? sortedByScore[1].analyticsScore : 0;
      const closeCall = topScore > 0 && (topScore - secondScore) / topScore < 0.03;
      const topComputer = sortedByComputer[0] || null;
      const scoreTopDiffersFromComputer =
        topComputer && honmei && topComputer !== honmei &&
        normalizeComputer(topComputer) > normalizeComputer(honmei);
      // 荒れ防止: computer-top の analyticsScore 順位が 3位以内でないと swap しない
      const computerTopRank = topComputer ? sortedByScore.indexOf(topComputer) : -1;
      const computerTopInRange = computerTopRank >= 0 && computerTopRank <= 2;

      let ruleApplied = null;
      if (honmei && topComputer && computerTopInRange && (closeCall || scoreTopDiffersFromComputer)) {
        if (topComputer !== honmei) {
          honmei = topComputer;
          ruleApplied = closeCall ? 'close-call-prefer-computer' : 'computer-top-mismatch';
        }
      }

      // 役割割当
      if (honmei) honmei.role = '本命';
      // 対抗以下は「本命を除いた analyticsScore 上位」で決定
      const remaining = sortedByScore.filter(h => h !== honmei);
      if (remaining[0]) remaining[0].role = '対抗';
      if (remaining[1]) remaining[1].role = '単穴';
      if (remaining[2]) remaining[2].role = '連下最上位';
      for (let i = 3; i < remaining.length; i++) {
        remaining[i].role = '連下';
      }

      // デバッグ情報を race に残す（PREDICTION_LOGIC.md で言及）
      race._analyticsRule = ruleApplied;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 4: 連下3頭制限（連下最上位は保持）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // 連下最上位は1頭固定・変更なし（そのまま維持）
    const renkaTop = race.horses.find(h => h.role === '連下最上位');

    // 連下を抽出（連下最上位は除外）
    const renkaList = race.horses.filter(h => h.role === '連下');

    // analyticsScore で降順ソート（フォールバックで customScore / rawScore）
    renkaList.sort((a, b) => {
      const sa = a.analyticsScore ?? a.customScore ?? a.rawScore ?? 0;
      const sb = b.analyticsScore ?? b.customScore ?? b.rawScore ?? 0;
      return sb - sa;
    });

    // 上位3頭のみ連下、残りは補欠
    for (let i = 0; i < renkaList.length; i++) {
      if (i < 3) {
        renkaList[i].role = '連下';
      } else {
        renkaList[i].role = '補欠';
      }
    }

    // 結果: 連下最上位(1頭) + 連下(最大3頭) + 補欠(残り)

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 5: 表示用印の割り当て
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const horse of race.horses) {
      horse.mark = getRoleMark(horse.role);
    }

    race.hasHorseData = true;
  }

  return adjusted;
}

/**
 * 調整ルールのテスト用ヘルパー関数
 *
 * @param {Object} race - レースデータ
 * @returns {Object} 調整結果のサマリー
 */
export function getAdjustmentSummary(race) {
  const honmei = race.horses.find(h => h.role === '本命');
  const taikou = race.horses.find(h => h.role === '対抗');
  const tanana = race.horses.filter(h => h.role === '単穴');
  const renkaTop = race.horses.find(h => h.role === '連下最上位');
  const renka = race.horses.filter(h => h.role === '連下');
  const hoseki = race.horses.filter(h => h.role === '補欠');
  const mu = race.horses.filter(h => h.role === '無');

  return {
    honmei: honmei ? `${honmei.number} ${honmei.name} (${honmei.rawScore}点)` : 'なし',
    taikou: taikou ? `${taikou.number} ${taikou.name} (${taikou.rawScore}点)` : 'なし',
    tananaCount: tanana.length,
    renkaTopCount: renkaTop ? 1 : 0,
    renkaCount: renka.length,
    hosekiCount: hoseki.length,
    muCount: mu.length,
    totalHorses: race.horses.length
  };
}
