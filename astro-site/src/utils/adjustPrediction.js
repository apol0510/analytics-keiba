/**
 * adjustPrediction.js
 *
 * 正規化された予想データに対して調整ルールを適用
 * 南関競馬・中央競馬（JRA）共通のロジック
 *
 * 【独自ロジック】
 * 1. 印1◎の馬を必ず本命または対抗に固定
 * 2. 独自スコアリング（印1×4 + 印2×3 + 印3×2 + 印4×1）
 * 3. 独自スコア順で役割を決定
 * 4. 著作権回避のため、印1の複製ではなく複数の印を総合評価
 *
 * 調整内容:
 * 1. 独自スコア計算（印1〜4の重み付け合計）
 * 2. displayScore計算（rawScore + 70、0点は0のまま）
 * 3. 印1◎固定 + 独自スコア順で役割決定
 * 4. 連下3頭制限（連下最上位1頭維持 + 連下最大3頭、残りは補欠）
 * 5. 表示用印の割り当て
 */

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
 * 独自スコア計算（印1〜4の重み付け合計）
 *
 * @param {Object} horse - 馬データ
 * @returns {number} 独自スコア
 */
function calculateCustomScore(horse) {
  const markPoints = {
    '◎': 4,
    '○': 3,
    '▲': 2,
    '△': 1,
    '-': 0,
    'svg': 0,
    '無': 0
  };

  const marks = horse.marks || {};

  const score =
    (markPoints[marks['印1']] || 0) * 4 +
    (markPoints[marks['印2']] || 0) * 3 +
    (markPoints[marks['印3']] || 0) * 2 +
    (markPoints[marks['印4']] || 0) * 1;

  return score;
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
    // Step 2: 独自スコア計算（印1×4 + 印2×3 + 印3×2 + 印4×1）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const horse of race.horses) {
      horse.customScore = calculateCustomScore(horse);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: 印1◎固定 + 独自スコア順で役割決定
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // 印1◎の馬を特定
    const honmeiMarkHorse = race.horses.find(h => h.marks && h.marks['印1'] === '◎');

    // 全馬のcustomScoreが0の場合（computer/形式など）、rawScoreでソート
    const hasCustomScore = race.horses.some(h => h.customScore > 0);

    // スコアのある馬のみ対象（customScore=0 かつ rawScore=0 は「無」のまま）
    const activeHorses = race.horses.filter(h => h.customScore > 0 || h.rawScore > 0);

    // 独自スコアで降順ソート（customScoreがない場合はrawScoreでソート）
    const sortedHorses = hasCustomScore
      ? [...activeHorses].sort((a, b) => b.customScore - a.customScore)
      : [...activeHorses].sort((a, b) => b.rawScore - a.rawScore);

    // customScoreがない場合（computer/形式など）で、既に役割が割り当てられている場合は維持
    const hasExistingRoles = race.horses.some(h => h.role !== '無');
    if (!hasCustomScore && hasExistingRoles) {
      // 既存の役割を維持（adjustPredictionでの再割り当てをスキップ）
      // Step 4（連下3頭制限）以降の処理は実行
    } else {
      // 全馬の役割をリセット
      for (const horse of race.horses) {
        horse.role = '無';
      }

      // 印1◎の順位を確認
      let honmeiRank = -1;
      if (honmeiMarkHorse) {
        honmeiRank = sortedHorses.indexOf(honmeiMarkHorse);
      }

      if (honmeiMarkHorse && honmeiRank === 0) {
      // 印1◎が1位 → 本命
      sortedHorses[0].role = '本命';
      if (sortedHorses[1]) sortedHorses[1].role = '対抗';
      if (sortedHorses[2]) sortedHorses[2].role = '単穴';
      if (sortedHorses[3]) sortedHorses[3].role = '連下最上位';

      // 4位以降は連下
      for (let i = 4; i < sortedHorses.length; i++) {
        sortedHorses[i].role = '連下';
      }

    } else if (honmeiMarkHorse && honmeiRank > 0) {
      // 印1◎が2位以下 → 1位を本命、印1◎を対抗に固定
      sortedHorses[0].role = '本命';
      honmeiMarkHorse.role = '対抗';

      // 単穴: 印1◎を除いた2位
      let tananaCandidateIndex = 1;
      while (tananaCandidateIndex < sortedHorses.length &&
             sortedHorses[tananaCandidateIndex] === honmeiMarkHorse) {
        tananaCandidateIndex++;
      }
      if (tananaCandidateIndex < sortedHorses.length) {
        sortedHorses[tananaCandidateIndex].role = '単穴';
      }

      // 連下最上位: 印1◎を除いた3位
      let renkaTopCandidateIndex = tananaCandidateIndex + 1;
      while (renkaTopCandidateIndex < sortedHorses.length &&
             sortedHorses[renkaTopCandidateIndex] === honmeiMarkHorse) {
        renkaTopCandidateIndex++;
      }
      if (renkaTopCandidateIndex < sortedHorses.length) {
        sortedHorses[renkaTopCandidateIndex].role = '連下最上位';
      }

      // 残りは連下
      for (let i = 0; i < sortedHorses.length; i++) {
        if (sortedHorses[i].role === '無' && sortedHorses[i] !== honmeiMarkHorse) {
          sortedHorses[i].role = '連下';
        }
      }

    } else {
      // 印1◎がない場合（まれ）→ 独自スコア順で機械的に決定
      if (sortedHorses[0]) sortedHorses[0].role = '本命';
      if (sortedHorses[1]) sortedHorses[1].role = '対抗';
      if (sortedHorses[2]) sortedHorses[2].role = '単穴';
      if (sortedHorses[3]) sortedHorses[3].role = '連下最上位';

        for (let i = 4; i < sortedHorses.length; i++) {
          sortedHorses[i].role = '連下';
        }
      }
    } // hasExistingRoles のelse終了

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 4: 連下3頭制限（連下最上位は保持）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // 連下最上位は1頭固定・変更なし（そのまま維持）
    const renkaTop = race.horses.find(h => h.role === '連下最上位');

    // 連下を抽出（連下最上位は除外）
    const renkaList = race.horses.filter(h => h.role === '連下');

    // customScoreで降順ソート
    renkaList.sort((a, b) => b.customScore - a.customScore);

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
