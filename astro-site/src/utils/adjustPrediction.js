/**
 * adjustPrediction.js — analytics-keiba 独自スコアリング
 *
 * 詳細仕様: astro-site/docs/PREDICTION_LOGIC.md
 *
 * 役割決定方針 (2026-05-16 大幅刷新):
 *
 *   【不変条件 (verify:jra:roles で必ず検証)】
 *     1. 本命 pt >= 対抗 pt
 *     2. 対抗 pt >= 単穴 pt
 *     3. 単穴 pt >= 連下最上位 pt
 *     4. 連下最上位 pt >= max(連下 pt)
 *     5. max(連下 pt) >= max(補欠/抑え pt)
 *     6. 本命・対抗・単穴・連下最上位 はそれぞれ 1 頭
 *
 *   【役割割当】
 *     - 全馬を「正規スコア (= displayScore)」降順でソート
 *       タイブレーク: sourceComputerIndex(or computerIndex) 降順 → 馬番昇順
 *     - 1位: 本命 / 2位: 対抗 / 3位: 単穴 / 4位: 連下最上位
 *     - 5-7位: 連下 (最大3頭)
 *     - 8位以降: 補欠 (後段の isOsaeCandidate で 抑え/不要馬 に分類)
 *
 *   【旧仕様 (削除)】
 *     - analyticsScore (ci×0.5 + feature×0.3 + mark×0.2) で role を決めていた
 *     - 差別化ルール (close-call-prefer-computer / computer-top-mismatch)
 *     - 印1◎ 固定 fallback
 *   旧仕様は role と pt が異なる式から導出されるため必ず順序矛盾を起こす。
 *   2026-05-16 検証で JRA 36R 中 31R が role/pt 逆転していたため strict 化。
 *   南関 (264R) は元から 0 件で、新ロジックでも結果不変。
 *   analyticsScore / featureScore / markScore は診断用に計算は残す。
 *
 * フォールバック:
 *   - 全馬 rawScore=0 かつ既存 role が付いている → preserveRoles (旧データ互換)
 *   - 全馬 rawScore=0 かつ role なし → 役割不付与 (displayScore で並べ替え不能のため)
 *
 * 共通ルール:
 *   - displayScore = rawScore + 70 (0点は0のまま、UI 互換性のため維持)
 *   - 表示用印 (◎/○/▲/△/×) を割り当て
 */

import { calcSpeedIndex, calcFormTrend, calcStaminaRating } from './featureScores.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// analytics-keiba 差別化パラメータ（★ keiba-intelligence と共通化禁止 ★）
//
// AK の pt(displayScore) は computerIndex を主軸に、race-data-importer 由来の
// 過去走(featureScore) と 印(markScore) を「補助シグナル」として加点する。
// これにより pt 自体が keiba-intelligence（pt = computerIndex + 70）と構造的に分岐し、
// 役割(本命/対抗/単穴) と 買い目 も連動して差別化される（PREDICTION_LOGIC.md 参照）。
//
// 設計上の不変条件:
//   - featureScore は 0–100（過去走が無い馬は中立 50）、markScore は 0–100（印が無い馬は 0）。
//   - よって補助シグナルが無い馬は nudge=0 となり pt = rawScore + 70（従来値）に一致する
//     （後方互換・既存テスト不変）。
//   - 値を 0 にすると KI と同一 pt に戻る（＝同一化バグの再発）。変更時は必ず両サイト比較で検証。
const FEATURE_NUDGE_WEIGHT = 0.6; // (featureScore − 50) への係数: 概ね ±30 点の範囲で pt を前後
const MARK_NUDGE_WEIGHT = 0.4;    // markScore への係数: 印が濃いほど最大 +40 点

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
 * 印1〜印4 を marks フィールドから抽出する。
 * raw racebook の marks は配列形式（位置で 印1, 印2, ... に対応）。
 * 一部の正規化済みデータでは {印1:'◎', 印2:'○', ...} の dict 形式もあり得る。
 */
function getMark(marks, idx) {
  if (Array.isArray(marks)) return marks[idx];
  if (marks && typeof marks === 'object') return marks[`印${idx + 1}`];
  return undefined;
}

/**
 * 印スコア計算（印1〜4の重み付け合計 → 0–100 に正規化）
 * 旧仕様: 印1×4 + 印2×3 + 印3×2 + 印4×1、最大30。
 * analytics 独自式では全体の 20% の重みで使用する。
 */
function calculateMarkScore(horse) {
  const markPoints = { '◎': 4, '○': 3, '▲': 2, '△': 1, '☆': 1, '-': 0, 'svg': 0, '無': 0 };
  const marks = horse.marks || {};
  const raw =
    (markPoints[getMark(marks, 0)] || 0) * 4 +
    (markPoints[getMark(marks, 1)] || 0) * 3 +
    (markPoints[getMark(marks, 2)] || 0) * 2 +
    (markPoints[getMark(marks, 3)] || 0) * 1;
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
 *
 * 2026-05-16: sourceComputerIndex を優先するように変更。
 *   - JRA: admin の computerIndex フィールドは 0–9 スケールで実運用では 0 が多く、
 *     racebook 由来の本来のコンピ指数（40–99）は sourceComputerIndex に格納される。
 *     pt（rawScore + 70）は normalizePrediction で sourceComputerIndex から計算されるため、
 *     analyticsScore も同じソースを使うことで pt と役割の順序を一致させる。
 *   - 南関: computerIndex は通常 40–99。sourceComputerIndex が無いか 10 未満なら従来通り
 *     computerIndex を使用する。
 */
function normalizeComputer(horse) {
  const sci = Number(horse.sourceComputerIndex || 0);
  const ci = Number(horse.computerIndex || 0);
  const v = sci >= 10 ? sci : (ci >= 10 ? ci : 0);
  return Math.max(0, Math.min(100, v));
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
    // Step 1: analytics-keiba 独自指標（補助シグナル）を計算
    //   markScore: race-data-importer 由来の印 → 0–100
    //   featureScore: race-data-importer 由来の過去走(recentRaces) → 0–100（中立50）
    //   analyticsScore: 診断用の総合（ci×0.5+feature×0.3+mark×0.2）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const horse of race.horses) {
      horse.markScore = calculateMarkScore(horse);
      horse.featureScore = calculateFeatureScore(horse);
      horse.analyticsScore = calculateAnalyticsScore(horse);
      // 旧 customScore フィールドは残しておく（UI/ログ互換）
      horse.customScore = horse.markScore;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 2: displayScore (= pt) 計算 ★keiba-intelligence との差別化の核心★
    //   pt = rawScore(主軸: computerIndex) + 70
    //      + (featureScore − 50) × FEATURE_NUDGE_WEIGHT   ← 過去走の補助加点
    //      + markScore × MARK_NUDGE_WEIGHT                ← 印の補助加点
    //
    //   KI は pt = computerIndex + 70 のみ。AK は pt 自体に racebook シグナルを織り込むため、
    //   pt / 役割 / 買い目 が構造的に分岐する。補助シグナルが無い馬は nudge=0 → pt=rawScore+70。
    //   役割は Step 3 で displayScore 降順 strict に決まるので pt==役割順 の不変条件は維持される。
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const horse of race.horses) {
      if (horse.rawScore > 0) {
        const featureNudge = (horse.featureScore - 50) * FEATURE_NUDGE_WEIGHT;
        const markNudge = horse.markScore * MARK_NUDGE_WEIGHT;
        horse.displayScore = Math.max(1, Math.round(horse.rawScore + 70 + featureNudge + markNudge));
      } else {
        horse.displayScore = 0;
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: 役割決定 (2026-05-16 strict-pt-desc)
    //   全馬を displayScore (= pt = rawScore + 70) 降順でソートし、
    //   1位=本命 / 2位=対抗 / 3位=単穴 / 4位=連下最上位 /
    //   5-7位=連下 (最大3頭) / 8位以降=補欠 を割当てる。
    //   タイブレーク: sourceComputerIndex (or computerIndex) 降順 → 馬番昇順。
    //   これにより role 順と pt 順の逆転は構造的に発生しない。
    //
    //   旧 analyticsScore ベース割当は ci/feature/mark の重み付け順序が pt 順と
    //   異なるため必ず矛盾を起こしていた (JRA 36R 中 31R で逆転)。
    //   analyticsScore / markScore / featureScore は診断用に計算は残す。
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    const hasAnyScore = race.horses.some(h => (h.rawScore || 0) > 0);
    const hasExistingRoles = race.horses.some(h => h.role !== '無');
    const preserveRoles = !hasAnyScore && hasExistingRoles;

    if (preserveRoles) {
      // 全馬 rawScore=0 だが既存 role がある (旧データ互換) → そのまま維持
      race._analyticsRule = 'preserve-existing-no-score';
    } else if (!hasAnyScore) {
      // 全馬 rawScore=0 かつ role なし → 並べ替え不能、役割不付与
      for (const horse of race.horses) horse.role = '無';
      race._analyticsRule = 'no-score-no-role';
    } else {
      // ━━ 通常パス: pt 降順 strict ━━
      for (const horse of race.horses) horse.role = '無';

      const activeHorses = race.horses.filter(h => (h.rawScore || 0) > 0);
      const sorted = activeHorses.slice().sort((a, b) => {
        const dsDiff = (b.displayScore || 0) - (a.displayScore || 0);
        if (dsDiff !== 0) return dsDiff;
        const aCi = normalizeComputer(a);
        const bCi = normalizeComputer(b);
        if (aCi !== bCi) return bCi - aCi;
        return (Number(a.number) || 0) - (Number(b.number) || 0);
      });

      if (sorted[0]) sorted[0].role = '本命';
      if (sorted[1]) sorted[1].role = '対抗';
      if (sorted[2]) sorted[2].role = '単穴';
      if (sorted[3]) sorted[3].role = '連下最上位';
      for (let i = 4; i < Math.min(7, sorted.length); i++) {
        sorted[i].role = '連下';
      }
      for (let i = 7; i < sorted.length; i++) {
        sorted[i].role = '補欠';
      }

      race._analyticsRule = 'strict-pt-desc';
    }

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
