// 共有予想ロジック - 古いデータ参照問題対応＆統一システム
import { dataManager } from './integrated-data-manager.js';
// 抑え / 不要馬 判定は依存ゼロの単一源 osaeClassification.js に集約。
// 本ファイルは表示側（astro ページ）向けに同名で再エクスポートする薄いラッパー。
import {
  HANDLED_ROLES,
  OSAE_LIKE_ROLES,
  MIN_OSAE_CI,
  getOsaeCi,
  isOsaeCandidate,
  isIneligibleHorse,
  sortOsaeCandidates,
  selectOsaeNumbers,
} from '../utils/osaeClassification.js';
export {
  HANDLED_ROLES,
  OSAE_LIKE_ROLES,
  MIN_OSAE_CI,
  getOsaeCi,
  isOsaeCandidate,
  isIneligibleHorse,
  sortOsaeCandidates,
  selectOsaeNumbers,
};

// 印に基づく統一信頼度計算関数（多重印対応・累積加算式）
export function calculateMarkBasedConfidence(horse) {
    const baseConfidence = 62;

    // multiMarkがある場合はそれを優先使用
    const targetMark = horse.multiMark || horse.mark;
    
    // 多重印対応: スペース区切りの複数印を累積加算
    if (typeof targetMark === 'string' && targetMark.includes(' ')) {
        // スペースで分割して複数印を処理
        const marks = targetMark.split(' ').filter(m => m.trim());
        const totalValue = marks.reduce((sum, m) => {
            switch (m.trim()) {
                case '◎': return sum + 7;
                case '○': return sum + 6;
                case '▲': return sum + 5;
                case '△': return sum + 4;
                default: return sum;
            }
        }, 0);

        return baseConfidence + totalValue;
    }
    
    // 単一印の場合
    switch (targetMark) {
        case '◎': return baseConfidence + 7; // 69
        case '○': return baseConfidence + 6; // 68
        case '▲': return baseConfidence + 5; // 67
        case '△': return baseConfidence + 4; // 66
        default: return baseConfidence; // 62
    }
}

// 馬の実際の累積スコアを取得する関数（multiMark最優先）
export function getHorseConfidenceFromMark(horse) {
    if (!horse) return 62;

    // 🔧 復活防止対策: JSONデータの累積スコアを最優先使用
    // factors内の累積スコアがある場合は最優先で使用（実際のデータ）
    if (horse.factors && Array.isArray(horse.factors)) {
        const scoreText = horse.factors.find(factor =>
            factor.text && factor.text.includes('累積スコア')
        );
        if (scoreText) {
            const match = scoreText.text.match(/(\d+)pt/);
            if (match) {
                return parseInt(match[1]);
            }
        }
    }

    // multiMarkがある場合は動的計算（JSONスコアがない場合のみ）
    if (horse.multiMark) {
        console.log(`⚠️ 動的計算使用(multiMark): ${horse.name || '名前不明'}`);
        return calculateMarkBasedConfidence(horse);
    }

    // 単一印の場合は動的計算（JSONスコアがない場合のみ）
    if (horse.mark) {
        console.log(`⚠️ 動的計算使用(mark): ${horse.name || '名前不明'}`);
        return calculateMarkBasedConfidence(horse);
    }

    return 62; // デフォルト
}

// レース全体の信頼度を主力馬の平均で計算する関数
export function getRaceConfidence(horses) {
    const mainHorses = horses.filter(horse => 
        horse.type === '本命' || horse.type === '対抗' || horse.type === '単穴'
    );
    if (mainHorses.length === 0) return 62;
    
    const totalConfidence = mainHorses.reduce((sum, horse) => 
        sum + getHorseConfidenceFromMark(horse), 0);
    return Math.round(totalConfidence / mainHorses.length);
}

// 星評価システム — horseEnrichment.js の getStarRating と同一の role-aware ロジック
//
//   本命 / 対抗:        pt>=150 → ★★★★、それ未満 → ★★★
//   単穴 / 連下最上位 / 連下: 一律 ★★★
//   押さえ / 抑え / 補欠:  pt>70 → ★★★、pt<=70 → ★★
//   無 / 未指定:         pt>0 → ★★、pt<=0 → ★
//
// 2026-05-14: 累積スコアだけで判定する旧仕様は補欠まで★★★★が並んで
// 「★★★★の価値が薄まる」問題があったため、role × pt で判定する設計に変更。
export function convertToStarRating(text, horseType, score) {
    if (typeof score !== 'number' && typeof score !== 'string') {
        return text;
    }
    const numScore = typeof score === 'string' ? parseInt(score) : score;
    if (isNaN(numScore)) {
        return text;
    }
    let stars;
    switch (horseType) {
        case '本命':
        case '対抗':
            stars = numScore >= 150 ? '★★★★' : '★★★';
            break;
        case '単穴':
        case '連下最上位':
        case '連下':
            stars = '★★★';
            break;
        case '押さえ':
        case '抑え':
        case '補欠':
            stars = numScore > 70 ? '★★★' : '★★';
            break;
        default:
            stars = numScore > 0 ? '★★' : '★';
    }
    return `総合評価:${stars}`;
}

// 動的リスク計算システム（累積スコアベース）
export function calculateDynamicRisk(strategyType, mainHorseScore, subHorseScore = null) {
    let baseRisk;
    let targetScore;
    
    // 戦略別ベースリスク設定
    switch (strategyType) {
        case 'A': // 少点数的中型
            baseRisk = 45; // ベースリスク45%
            targetScore = mainHorseScore; // 本命のみで判定
            break;
        case 'B': // バランス型
            baseRisk = 35; // ベースリスク35%
            targetScore = subHorseScore ? (mainHorseScore + subHorseScore) / 2 : mainHorseScore;
            break;
        case 'C': // 高配当追求型
            baseRisk = 65; // ベースリスク65%
            targetScore = subHorseScore ? (mainHorseScore + subHorseScore) / 2 : mainHorseScore;
            break;
        default:
            baseRisk = 50;
            targetScore = mainHorseScore;
    }
    
    // スコアに応じてリスク調整
    if (targetScore >= 89) {
        // 4つ星：リスク下げる
        return Math.max(baseRisk - 15, 20); // 最低20%
    } else {
        // 3つ星：リスク上げる  
        return Math.min(baseRisk + 15, 80); // 最高80%
    }
}

// 期待度レベル文字列変換（ポジティブ表現）
export function getRiskLevelText(riskPercentage) {
    // リスクの逆数をポジティブな期待度に変換
    if (riskPercentage <= 30) return "最高";
    if (riskPercentage <= 50) return "高";
    if (riskPercentage <= 70) return "良";
    return "標準";
}

// 推奨度計算（リスクの逆数ベース + 文字列グレード対応）
export function getRecommendationStars(riskPercentage) {
    // 文字列グレード（"A+", "B+"など）の場合
    if (typeof riskPercentage === 'string') {
        const grade = riskPercentage.toUpperCase();
        if (grade === 'A+' || grade === 'A') return "★★★★★";
        if (grade === 'B+' || grade === 'B') return "★★★★☆";
        if (grade === 'C+' || grade === 'C') return "★★★☆☆";
        if (grade === 'D+' || grade === 'D') return "★★☆☆☆";
        return "★☆☆☆☆";
    }

    // 数値の場合（従来の処理）
    if (riskPercentage <= 25) return "★★★★★";
    if (riskPercentage <= 35) return "★★★★☆";
    if (riskPercentage <= 50) return "★★★☆☆";
    if (riskPercentage <= 70) return "★★☆☆☆";
    return "★☆☆☆☆";
}

// 推奨度の数値計算（★の個数を返す）
export function getRecommendationCount(riskPercentage) {
    // 文字列グレード（"A+", "B+"など）の場合
    if (typeof riskPercentage === 'string') {
        const grade = riskPercentage.toUpperCase();
        if (grade === 'A+' || grade === 'A') return 5;
        if (grade === 'B+' || grade === 'B') return 4;
        if (grade === 'C+' || grade === 'C') return 3;
        if (grade === 'D+' || grade === 'D') return 2;
        return 1;
    }

    // 数値の場合（従来の処理）
    if (riskPercentage <= 25) return 5;
    if (riskPercentage <= 35) return 4;
    if (riskPercentage <= 50) return 3;
    if (riskPercentage <= 70) return 2;
    return 1;
}

// 標準化買い目生成システム（完全修正版）
export function generateStandardizedBets(horses, strategyType) {
    const { main, sub, sub1, sub2, allHorses } = horses;

    // 実際の馬番号を取得 - 確実な番号取得
    const mainNumber = main?.number || 9;
    const subNumber = sub?.number || 11;
    const sub1Number = sub1?.number || 5;
    const sub2Number = sub2?.number || 6;

    console.log(`🐎 Strategy ${strategyType} - 修正版:`);
    console.log(`   本命: ${mainNumber}番, 対抗: ${subNumber}番, 単穴1: ${sub1Number}番, 単穴2: ${sub2Number}番`);

    // allHorsesから連下・押さえ候補を正確に抽出
    let renkaCandidates = [];
    let osaeCandidates = [];

    if (allHorses && Array.isArray(allHorses)) {
        // 連下候補: type === "連下" の馬を抽出
        renkaCandidates = allHorses
            .filter(h => h.type === '連下')
            .map(h => h.number)
            .filter(n => n);

        // 押さえ候補: type === "押さえ" の馬を抽出
        osaeCandidates = allHorses
            .filter(h => h.type === '押さえ')
            .map(h => h.number)
            .filter(n => n);

        console.log(`🔍 JSON解析結果: 連下=${renkaCandidates.join(',')}番, 押さえ=${osaeCandidates.join(',')}番`);
    }

    // フォールバック: JSONデータがない場合のみ固定番号使用
    if (renkaCandidates.length === 0) {
        console.warn(`⚠️ 連下候補が見つからないため固定値を使用`);
        renkaCandidates = [4, 10, 13, 14].filter(n => ![mainNumber, subNumber, sub1Number, sub2Number].includes(n));
    }
    if (osaeCandidates.length === 0) {
        console.warn(`⚠️ 押さえ候補が見つからないため固定値を使用`);
        osaeCandidates = [2, 7, 12].filter(n => ![mainNumber, subNumber, sub1Number, sub2Number].includes(n));
    }

    console.log(`   連下候補: ${renkaCandidates.join(',')}番`);
    console.log(`   押さえ候補: ${osaeCandidates.join(',')}番`);

    let bets = [];

    switch (strategyType) {
        case 'A': // 少点数的中型モデル - 本命→{対抗,単穴2,単穴1} (マコちゃん仕様)
            const targetsA = [subNumber, sub2Number, sub1Number].filter(n => n); // 対抗,単穴2,単穴1の順序
            bets = [`馬単 ${mainNumber} → ${targetsA.join(',')}`];
            console.log(`🎯 戦略A: ${mainNumber} → ${targetsA.join(',')} (${targetsA.length}点)`);
            break;

        case 'B': // バランス型モデル - マコちゃん仕様: 複数軸からの馬単組み合わせ
            // {単穴2,単穴1,対抗} → 本命（正しい順序）
            const fromHorsesB = [sub2Number, sub1Number, subNumber].filter(n => n); // 単穴2,単穴1,対抗
            bets.push(`馬単 ${fromHorsesB.join(',')} → ${mainNumber}`);

            // 本命⇔連下候補馬
            if (renkaCandidates.length > 0) {
                bets.push(`馬単 ${mainNumber} ⇔ ${renkaCandidates.join(',')}`);
            }

            // 対抗→{単穴2,単穴1}
            const subTargetsB = [sub2Number, sub1Number].filter(n => n); // 単穴2,単穴1
            if (subTargetsB.length > 0) {
                bets.push(`馬単 ${subNumber} → ${subTargetsB.join(',')}`);
            }
            console.log(`⚖️ 戦略B: ${fromHorsesB.join(',')} → ${mainNumber} + ${mainNumber} ⇔ ${renkaCandidates.join(',')} + ${subNumber} → ${subTargetsB.join(',')}`);
            break;

        case 'C': // 高配当追求型モデル - マコちゃん仕様: 本命→押さえ + 対抗⇔大きな範囲
            // 本命→押さえ候補馬
            if (osaeCandidates.length > 0) {
                bets.push(`馬単 ${mainNumber} → ${osaeCandidates.join(',')}`);
            }

            // 対抗⇔{押さえ候補馬+連下候補馬}
            const allCNumbers = [...osaeCandidates, ...renkaCandidates];
            if (allCNumbers.length > 0) {
                bets.push(`馬単 ${subNumber} ⇔ ${allCNumbers.join(',')}`);
            }
            console.log(`🚀 戦略C: ${mainNumber} → ${osaeCandidates.join(',')} + ${subNumber} ⇔ ${allCNumbers.join(',')}`);
            break;
    }

    // 最終確認
    if (bets.length === 0) {
        console.warn(`⚠️ 緊急フォールバック: ${strategyType}`);
        return [`馬単 ${mainNumber} → ${subNumber}`];
    }

    console.log(`✅ 戦略${strategyType}買い目完成:`, bets);
    return bets;
}

// 買い目の点数を計算する関数
export function calculateBetPoints(betString) {
    if (!betString) return 1;

    // ⇔記法の場合は双方向なので2倍
    if (betString.includes('⇔')) {
        const targets = betString.split('⇔')[1].split(',').length;
        return targets * 2; // 双方向なので2倍
    }

    // →記法の場合は単方向
    if (betString.includes('→')) {
        const targets = betString.split('→')[1].split(',').length;
        return targets;
    }

    return 1;
}

// 的中率・期待回収率計算（ポジティブな数値表現）
export function calculateHitRateAndReturn(strategyType, riskPercentage) {
    let hitRate, returnRate;

    // 全体的に高めの数値でポジティブ表現
    switch (strategyType) {
        case 'A': // 少点数的中型
            // 的中率を高めに設定（55-72%）
            hitRate = Math.max(55, Math.min(72, 65 + (riskPercentage <= 30 ? 7 : riskPercentage <= 50 ? 0 : -8)));
            returnRate = Math.max(115, Math.min(155, 135 + (riskPercentage <= 30 ? 15 : riskPercentage <= 50 ? 0 : -10)));
            break;
        case 'B': // バランス型
            // バランス良く高めの数値（42-60%）
            hitRate = Math.max(42, Math.min(60, 48 + (riskPercentage <= 30 ? 8 : riskPercentage <= 50 ? 2 : -5)));
            returnRate = Math.max(140, Math.min(195, 165 + (riskPercentage <= 30 ? 20 : riskPercentage <= 50 ? 5 : -10)));
            break;
        case 'C': // 高配当追求型
            // 高配当を強調（28-42%）
            hitRate = Math.max(28, Math.min(42, 35 + (riskPercentage <= 30 ? 6 : riskPercentage <= 50 ? 2 : -3)));
            returnRate = Math.max(220, Math.min(350, 280 + (riskPercentage <= 30 ? 40 : riskPercentage <= 50 ? 15 : -20)));
            break;
        default:
            hitRate = 45;
            returnRate = 160;
    }

    return {
        hitRate: Math.round(hitRate * 10) / 10,  // 小数点第1位まで
        returnRate: Math.round(returnRate)       // 整数
    };
}

// 累積ポイントベースの動的数値計算（完全新規システム）
export function calculateScoreBasedStats(strategyType, cumulativeScore) {
    // 戦略別基本範囲設定
    const baseRanges = {
        'A': { hitRate: [55, 72], returnRate: [115, 155] },  // 少点数的中型
        'B': { hitRate: [42, 60], returnRate: [140, 195] },  // バランス型
        'C': { hitRate: [28, 42], returnRate: [220, 350] }   // 高配当追求型
    };

    // 累積ポイント69-90ptを0-100%の範囲にマッピング
    const minScore = 69;  // 最低スコア
    const maxScore = 90;  // 最高スコア
    const scorePercent = Math.max(0, Math.min(100, (cumulativeScore - minScore) / (maxScore - minScore) * 100));

    // 高得点ほど数値が上がる仕組み
    const strategy = baseRanges[strategyType] || baseRanges['A'];

    const hitRate = strategy.hitRate[0] +
        (strategy.hitRate[1] - strategy.hitRate[0]) * (scorePercent / 100);

    const returnRate = strategy.returnRate[0] +
        (strategy.returnRate[1] - strategy.returnRate[0]) * (scorePercent / 100);

    return {
        hitRate: Math.round(hitRate * 10) / 10,    // 小数点第1位
        returnRate: Math.round(returnRate)         // 整数
    };
}

// 共通のデータ処理ロジック
// 統合データ管理システムによる検証済みデータ取得
export async function getValidatedRaceData() {
    try {
        // 統合データマネージャーから最新データを取得
        const validatedData = await dataManager.getPredictionData();

        // データ健全性を確認
        const healthReport = dataManager.validateDataHealth(validatedData);
        console.log(`🔍 Data Health: ${healthReport.percentage}% (${healthReport.score}/${healthReport.maxScore})`);

        // 健全性が低い場合は強制更新を試行
        if (healthReport.percentage < 80) {
            console.warn('⚠️ Data health below threshold, attempting refresh...');
            const refreshedData = await dataManager.forceDataUpdate();
            console.log(`🔄 Refreshed data version: ${refreshedData.raceDate}`);
            return refreshedData;
        }

        console.log(`✅ Using validated data version: ${validatedData.raceDate}`);
        return validatedData;
    } catch (error) {
        console.error('❌ Error getting validated data:', error);
        // フォールバックとして基本データを返す
        return dataManager.versionManager.generateFallbackData();
    }
}

// 共有のデータ処理ロジック（バージョンチェック付き）
export function processRaceData(allRacesData) {
    // データの健全性チェック
    if (!allRacesData || !allRacesData.races) {
        console.error('❌ Invalid race data structure');
        return { mainRace: null, race12R: null, sortedRaces: [] };
    }

    // データの日付チェック
    if (allRacesData.raceDate) {
        const dataDate = new Date(allRacesData.raceDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (dataDate < today) {
            console.warn(`⚠️ Data is outdated: ${allRacesData.raceDate}`);
        }
    }

    // メインレース（11R）のデータを取得 - 防御的プログラミング
    const mainRace = (allRacesData && Array.isArray(allRacesData.races))
        ? allRacesData.races.find(race => race.isMainRace === true)
        : null;
    const race12R = (allRacesData && Array.isArray(allRacesData.races))
        ? allRacesData.races.find(r => r.raceNumber === '12R')
        : null;

    // 全レースデータを表示順でソート - 防御的プログラミング
    const sortedRaces = (allRacesData && Array.isArray(allRacesData.races))
        ? allRacesData.races.sort((a, b) => a.displayOrder - b.displayOrder)
        : [];

    return {
        mainRace,
        race12R,
        sortedRaces,
        dataVersion: allRacesData.raceDate,
        lastUpdated: allRacesData.lastUpdated || new Date().toISOString()
    };
}

// 統一レース処理関数：全予想ページで同じ処理を保証
export function processUnifiedRaceData(raceData) {
    if (!raceData || !raceData.horses) {
        return null;
    }

    const { horses, allHorses } = raceData;

    // 累積スコア取得（multiMark最優先）
    const mainScore = getHorseConfidenceFromMark(horses.main);
    const subScore = getHorseConfidenceFromMark(horses.sub);

    // 星評価システム適用
    const mainStars = convertToStarRating("総合評価", "本命", mainScore);
    const subStars = convertToStarRating("総合評価", "対抗", subScore);

    // 特徴量重要度（バリエーション付き）
    const mainImportance = [
        {label: "安定性", value: Math.round((mainScore + 3 + Math.random() * 4 - 2)) / 100},
        {label: "能力上位性", value: Math.round((mainScore + 3 + Math.random() * 4 - 2)) / 100},
        {label: "展開利", value: Math.round((mainScore - 6 + Math.random() * 4 - 2)) / 100}
    ];

    const subImportance = [
        {label: "安定性", value: Math.round((subScore + 3 + Math.random() * 4 - 2)) / 100},
        {label: "能力上位性", value: Math.round((subScore + 3 + Math.random() * 4 - 2)) / 100},
        {label: "展開利", value: Math.round((subScore - 6 + Math.random() * 4 - 2)) / 100}
    ];

    // 動的リスクシステム適用（allHorsesを含めてgenerateStandardizedBetsに渡す）
    const strategyA = {
        riskPercent: calculateDynamicRisk('A', mainScore),
        riskText: getRiskLevelText(calculateDynamicRisk('A', mainScore)),
        hitRate: calculateHitRateAndReturn('A', calculateDynamicRisk('A', mainScore)).hitRate,
        returnRate: calculateHitRateAndReturn('A', calculateDynamicRisk('A', mainScore)).returnRate,
        bets: generateStandardizedBets({ ...horses, allHorses }, 'A'),
        progressBar: calculateProgressBarConfidence('A', mainScore)
    };

    // バリデーション: 戦略Aの買い目点数確認
    if (strategyA.bets.length !== 3) {
        console.error(`🚨 Strategy A validation failed: ${strategyA.bets.length} bets instead of 3`);
    }

    const strategyB = {
        riskPercent: calculateDynamicRisk('B', mainScore, subScore),
        riskText: getRiskLevelText(calculateDynamicRisk('B', mainScore, subScore)),
        hitRate: calculateHitRateAndReturn('B', calculateDynamicRisk('B', mainScore, subScore)).hitRate,
        returnRate: calculateHitRateAndReturn('B', calculateDynamicRisk('B', mainScore, subScore)).returnRate,
        bets: generateStandardizedBets({ ...horses, allHorses }, 'B'),
        progressBar: calculateProgressBarConfidence('B', mainScore, subScore)
    };

    // バリデーション: 戦略Bの買い目点数確認
    if (strategyB.bets.length !== 11) {
        console.error(`🚨 Strategy B validation failed: ${strategyB.bets.length} bets instead of 11`);
    }

    const strategyC = {
        riskPercent: calculateDynamicRisk('C', mainScore, subScore),
        riskText: getRiskLevelText(calculateDynamicRisk('C', mainScore, subScore)),
        hitRate: calculateHitRateAndReturn('C', calculateDynamicRisk('C', mainScore, subScore)).hitRate,
        returnRate: calculateHitRateAndReturn('C', calculateDynamicRisk('C', mainScore, subScore)).returnRate,
        bets: generateStandardizedBets({ ...horses, allHorses }, 'C'),
        progressBar: calculateProgressBarConfidence('C', mainScore, subScore)
    };

    // バリデーション: 戦略Cの買い目点数確認
    if (strategyC.bets.length !== 14) {
        console.error(`🚨 Strategy C validation failed: ${strategyC.bets.length} bets instead of 14`);
    }

    // デバッグログ: JSONデータ保護状況
    if (raceData.strategies?.balance?.bets) {
        console.log(`🛡️ Race ${raceData.raceNumber}: JSONの買い目データを保護中 - balance: ${raceData.strategies.balance.bets[0]?.horses}`);
    } else {
        console.log(`⚠️ Race ${raceData.raceNumber}: 動的生成買い目を使用 - balance: ${strategyB.bets[0]}`);
    }

    // 統一データ形式で返す（既存データを優先し、不足分のみ補完）
    return {
        ...raceData,
        horses: {
            main: {
                ...horses.main,
                score: mainScore,
                factors: [
                    {icon: "★", text: mainStars},
                    {icon: "★", text: `累積スコア: ${mainScore}pt`}
                ],
                importance: horses.main?.importance || mainImportance
            },
            sub: {
                ...horses.sub,
                score: subScore,
                factors: [
                    {icon: "★", text: subStars},
                    {icon: "★", text: `累積スコア: ${subScore}pt`}
                ],
                importance: horses.sub?.importance || subImportance
            },
            sub1: horses.sub1,
            sub2: horses.sub2
        },
        strategies: {
            combinationTip: {
                title: '的中率向上テクニック',
                icon: '💡',
                message: 'オッズを確認し、🔔 少点数的中型と⚖️ バランス型モデルを組み合わせることで的中率が大幅に向上します。',
                description: 'レース展開や馬場状態に応じて2つの戦略の買い目を併用することで、リスク分散と収益機会の最大化を実現できます。'
            },
            safe: {
                title: '🎯 少点数的中型モデル',
                recommendation: '★★',  // 固定値
                hitRate: strategyA.hitRate,
                returnRate: strategyA.returnRate,
                riskLevel: strategyA.riskText,
                // 🛡️ JSONデータ最優先保護: 既存の買い目データがある場合は保護
                bets: raceData.strategies?.safe?.bets || strategyA.bets.map(bet => ({ type: '馬単', numbers: bet, odds: '3-6倍' })),
                expectedPayout: '3-6倍',
                payoutType: '堅実決着想定',
                progressBar: strategyA.progressBar
            },
            balance: {
                title: '⚖️ バランス型モデル',
                recommendation: '★★★',  // 固定値
                hitRate: strategyB.hitRate,
                returnRate: strategyB.returnRate,
                riskLevel: strategyB.riskText,
                // 🛡️ JSONデータ最優先保護: 既存の買い目データがある場合は保護
                bets: raceData.strategies?.balance?.bets || strategyB.bets.map(bet => ({ type: '馬単', numbers: bet, odds: '6-12倍' })),
                expectedPayout: '6-12倍',
                payoutType: '中穴配当想定',
                progressBar: strategyB.progressBar
            },
            aggressive: {
                title: '🚀 高配当追求型モデル',
                recommendation: '★★',  // 固定値
                hitRate: strategyC.hitRate,
                returnRate: strategyC.returnRate,
                riskLevel: strategyC.riskText,
                // 🛡️ JSONデータ最優先保護: 既存の買い目データがある場合は保護
                bets: raceData.strategies?.aggressive?.bets || strategyC.bets.map(bet => ({ type: '馬単', numbers: bet, odds: '12倍以上' })),
                expectedPayout: '12倍以上',
                payoutType: '大穴視野',
                progressBar: strategyC.progressBar
            }
        }
    };
}

// ===============================
// 20年運営対応: データ正規化システム
// ===============================

// 役割表示設定（デザイン100%保持）
const ROLE_DISPLAY_CONFIG = {
    "本命": {
        markClass: "horse-mark-main",
        typeClass: "horse-type",
        style: "margin-left: 10px; color: #10b981; font-weight: 600;",
        priority: 1,
        defaultMark: "◎"
    },
    "対抗": {
        markClass: "horse-mark-sub",
        typeClass: "horse-type",
        style: "margin-left: 10px; color: #3b82f6; font-weight: 600;",
        priority: 2,
        defaultMark: "○"
    },
    "単穴": {
        markClass: "horse-mark-sub",
        typeClass: "horse-type",
        style: "margin-left: 10px; color: #8b5cf6; font-weight: 600;",
        priority: 3,
        defaultMark: "▲"
    },
    "連下": {
        markClass: "horse-mark-other",
        typeClass: "horse-type",
        style: "margin-left: 10px; color: #f59e0b; font-weight: 600;",
        priority: 4,
        defaultMark: "△"
    },
    "押さえ": {
        markClass: "horse-mark-other",
        typeClass: "horse-type",
        style: "margin-left: 10px; color: #6b7280; font-weight: 600;",
        priority: 5,
        defaultMark: "×"
    }
};

// データ正規化関数（Single Source of Truth実現）
export function normalizeHorseData(raceData) {
    const { horses, allHorses } = raceData;
    const normalizedHorses = [];

    // Phase 1: main/subを最優先で追加（役割確定）
    if (horses.main) {
        const mainHorse = {
            ...horses.main,
            role: "本命",
            displayMark: horses.main.mark || ROLE_DISPLAY_CONFIG["本命"].defaultMark,
            priority: ROLE_DISPLAY_CONFIG["本命"].priority
        };
        normalizedHorses.push(mainHorse);
    }

    if (horses.sub) {
        const subHorse = {
            ...horses.sub,
            role: "対抗",
            displayMark: horses.sub.mark || ROLE_DISPLAY_CONFIG["対抗"].defaultMark,
            priority: ROLE_DISPLAY_CONFIG["対抗"].priority
        };
        normalizedHorses.push(subHorse);
    }

    // Phase 2: hole1とhole2を追加（単穴）
    if (horses.hole1) {
        const hole1Horse = {
            ...horses.hole1,
            role: "単穴",
            displayMark: horses.hole1.mark || ROLE_DISPLAY_CONFIG["単穴"].defaultMark,
            priority: ROLE_DISPLAY_CONFIG["単穴"].priority
        };
        normalizedHorses.push(hole1Horse);
    }

    if (horses.hole2) {
        const hole2Horse = {
            ...horses.hole2,
            role: "単穴",
            displayMark: horses.hole2.mark || ROLE_DISPLAY_CONFIG["単穴"].defaultMark,
            priority: ROLE_DISPLAY_CONFIG["単穴"].priority
        };
        normalizedHorses.push(hole2Horse);
    }

    // Phase 3: connectとreserveの馬を追加
    if (horses.connect && Array.isArray(horses.connect)) {
        horses.connect.forEach(horse => {
            const connectHorse = {
                ...horse,
                role: "連下",
                displayMark: horse.mark || ROLE_DISPLAY_CONFIG["連下"].defaultMark,
                priority: ROLE_DISPLAY_CONFIG["連下"].priority
            };
            normalizedHorses.push(connectHorse);
        });
    }

    if (horses.reserve && Array.isArray(horses.reserve)) {
        horses.reserve.forEach(horse => {
            const reserveHorse = {
                ...horse,
                role: "押さえ",
                displayMark: horse.mark || ROLE_DISPLAY_CONFIG["押さえ"].defaultMark,
                priority: ROLE_DISPLAY_CONFIG["押さえ"].priority
            };
            normalizedHorses.push(reserveHorse);
        });
    }

    // Phase 4: allHorsesの馬も追加（互換性のため）
    if (allHorses && Array.isArray(allHorses)) {
        allHorses.forEach(horse => {
            // 既に追加済みの馬と重複しないものを追加
            const existingNumbers = normalizedHorses.map(h => h.number);
            if (!existingNumbers.includes(horse.number)) {
                const role = horse.type || "連下"; // 既存typeをroleとして使用
                const config = ROLE_DISPLAY_CONFIG[role] || ROLE_DISPLAY_CONFIG["連下"];

                const normalizedHorse = {
                    ...horse,
                    role: role,
                    displayMark: horse.mark || config.defaultMark,
                    priority: config.priority
                };
                normalizedHorses.push(normalizedHorse);
            }
        });
    }

    // 優先度順でソート（本命→対抗→単穴→連下→押さえ）
    normalizedHorses.sort((a, b) => a.priority - b.priority);

    return normalizedHorses;
}

// 役割表示設定取得
export function getRoleDisplayConfig(role) {
    return ROLE_DISPLAY_CONFIG[role] || ROLE_DISPLAY_CONFIG["連下"];
}

// 抑え / 不要馬 判定（isOsaeCandidate / isIneligibleHorse / getOsaeCi /
// sortOsaeCandidates / selectOsaeNumbers / HANDLED_ROLES / OSAE_LIKE_ROLES /
// MIN_OSAE_CI）は src/utils/osaeClassification.js に集約し、上部で再エクスポート済み。
// 表示・買い目・三連複・import がすべて同じ判定を参照する単一源。

/**
 * 【表示用コンピ指数】外部由来の元指数（racebook 系 computerIndex / sourceComputerIndex）を
 * 画面表示用に必ず -1 した値に変換する。著作権・表示上の安全対策のための恒久ルール。
 *
 * 重要:
 *   - 内部計算（pt / analyticsScore / 役割分類 / isOsaeCandidate / isIneligibleHorse / 買い目生成）には
 *     これを使わず、raw computerIndex を使うこと。
 *   - ユーザーに見える指数表示は必ずこの関数を通すこと（個別ページで horse.computerIndex を直接 JSX に
 *     埋めるのは禁止）。
 *   - null / undefined / 数値化不能 → null（表示側で '-' などにフォールバック）
 *   - 0 以下にはならないよう Math.max(0, n - 1) で下限保護。
 *
 * @param {number|string|null|undefined} rawIndex - 元指数
 * @returns {number|null} 表示用指数（raw - 1）。数値化不能なら null。
 */
export function getDisplayComputerIndex(rawIndex) {
    const n = Number(rawIndex);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, n - 1);
}

/**
 * 表示用コンピ指数を文字列で返す（テンプレ用）。
 * null/undefined/数値化不能なら '-' を返す。
 */
export function formatDisplayComputerIndex(rawIndex) {
    const display = getDisplayComputerIndex(rawIndex);
    return display == null ? '-' : String(display);
}

// データ整合性チェック
export function validateDataIntegrity(raceData) {
    const errors = [];

    // 基本構造チェック
    if (!raceData.horses) errors.push("horses object missing");
    if (!raceData.horses.main) errors.push("main horse missing");
    if (!raceData.horses.sub) errors.push("sub horse missing");
    if (!raceData.allHorses || !Array.isArray(raceData.allHorses)) {
        errors.push("allHorses array missing or invalid");
    }

    // 重複チェック
    if (raceData.allHorses) {
        const numbers = raceData.allHorses.map(h => h.number);
        const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
        if (duplicates.length > 0) errors.push(`duplicate numbers: ${duplicates.join(',')}`);
    }

    // main/sub整合性チェック
    if (raceData.horses.main && raceData.allHorses) {
        const mainInAll = raceData.allHorses.find(h => h.number === raceData.horses.main.number);
        if (!mainInAll) errors.push("main horse not found in allHorses");
    }

    return errors;
}

// ===============================
// 三連複買い目生成システム（2025-10-30新規実装）
// ===============================

/**
 * 三連複買い目生成関数
 * マコさん仕様: 本命・対抗・単穴・連下・抑えから買い目を自動生成
 *
 * @param {Object} horses - { main, sub, hole1, hole2, allHorses }
 * @returns {Object} { narrowed: [], compact: {}, total: Number }
 */
export function generateSanrenpukuBets(horses) {
    const { main, sub, hole1, hole2, allHorses, connect, reserve } = horses;

    // 馬番号を取得
    const mainNumber = main?.number || null;
    const subNumber = sub?.number || null;
    const hole1Number = hole1?.number || null;
    const hole2Number = hole2?.number || null;

    console.log(`🐎 三連複生成開始:`);
    console.log(`   本命: ${mainNumber}番, 対抗: ${subNumber}番, 単穴1: ${hole1Number}番, 単穴2: ${hole2Number}番`);

    // 連下・抑え候補を抽出
    let renkaCandidates = [];
    let osaeCandidates = [];
    let allHorsesArray = allHorses;

    // allHorsesが存在しない場合は、connectとreserveから構築
    if (!allHorsesArray && (connect || reserve)) {
        allHorsesArray = [
            ...(connect || []),
            ...(reserve || [])
        ];
        console.log(`📋 allHorses構築: connect=${connect?.length || 0}頭, reserve=${reserve?.length || 0}頭`);
    }

    if (allHorsesArray && Array.isArray(allHorsesArray)) {
        // 連下候補: type === "連下" の馬を抽出
        renkaCandidates = allHorsesArray
            .filter(h => h.type === '連下')
            .map(h => h.number)
            .filter(n => n);

        // 押さえ候補: type === "押さえ" の馬を抽出
        osaeCandidates = allHorsesArray
            .filter(h => h.type === '押さえ')
            .map(h => h.number)
            .filter(n => n);

        console.log(`🔍 JSON解析結果: 連下=${renkaCandidates.join(',')}番, 抑え=${osaeCandidates.join(',')}番`);
    }

    // 絞り込み買い目（10点）
    const narrowedBets = [];

    // 1段目: 本命-対抗-(単穴1,単穴2,連下全頭)
    if (mainNumber && subNumber) {
        // 3頭目候補: 単穴1, 単穴2, 連下全頭（本命・対抗を除く、番号順ソート）
        const targets = [...new Set([hole1Number, hole2Number, ...renkaCandidates])]
            .filter(n => n && n !== mainNumber && n !== subNumber)
            .sort((a, b) => a - b)
            .join(',');
        if (targets) {
            narrowedBets.push(`${mainNumber}-${subNumber}-${targets}`);
        }
    }

    // 2段目: 本命-単穴1-(対抗,単穴2,連下全頭)
    if (mainNumber && hole1Number) {
        // 3頭目候補: 対抗, 単穴2, 連下全頭（本命・単穴1を除く、番号順ソート）
        const targets = [...new Set([subNumber, hole2Number, ...renkaCandidates])]
            .filter(n => n && n !== mainNumber && n !== hole1Number)
            .sort((a, b) => a - b)
            .join(',');
        if (targets) {
            narrowedBets.push(`${mainNumber}-${hole1Number}-${targets}`);
        }
    }

    console.log(`✅ 絞り込み買い目: ${narrowedBets.join(' / ')}`);

    // 連下最上位の馬を特定（スコアが最も高い連下馬）
    let renkaTopHorse = null;
    let renkaTopScore = 0;

    if (renkaCandidates.length > 0 && allHorsesArray && Array.isArray(allHorsesArray)) {
        renkaCandidates.forEach(num => {
            const horse = allHorsesArray.find(h => h.number === num && h.type === '連下');
            if (horse) {
                const score = getHorseConfidenceFromMark(horse);
                if (score > renkaTopScore) {
                    renkaTopScore = score;
                    renkaTopHorse = num;
                }
            }
        });
        console.log(`🏆 連下最上位: ${renkaTopHorse}番（スコア: ${renkaTopScore}pt）`);
    }

    // コンパクト表示用データ生成（2パターン：本命軸・対抗軸）

    // 1段目のtargets生成（連下+軸候補、抑えを除く、重複除去、番号順ソート）
    const mainTargets = [...new Set([...renkaCandidates, subNumber, hole1Number, hole2Number])]
        .filter(n => n && n !== mainNumber)
        .sort((a, b) => a - b);

    // 2段目のtargets生成（連下+軸候補、抑え・本命・対抗を除く、重複除去、番号順ソート）
    const subTargets = [...new Set([...renkaCandidates, hole1Number, renkaTopHorse, hole2Number])]
        .filter(n => n && n !== mainNumber && n !== subNumber)
        .sort((a, b) => a - b);

    const compactDisplay = {
        // 1段目：本命を軸にした買い目
        main: {
            number: mainNumber,
            label: '本命',
            // 🔄 2025-10-31修正: 連下最上位を2段目に追加（マコさん要望）
            // 変更前: 対抗・単穴1・単穴2のみ
            // 変更後: 対抗・単穴1・連下最上位・単穴2（連下最上位を追加）
            axis: [subNumber, hole1Number, renkaTopHorse, hole2Number].filter(n => n && n !== mainNumber).sort((a, b) => a - b).join('.'),
            targets: mainTargets.join('.'),  // 連下+軸候補（重複除去、番号順）
            osaeNumbers: osaeCandidates
        },
        // 2段目：対抗（subNumber）を軸にした買い目（連下最上位が繰り上がる）
        sub: subNumber && renkaTopHorse ? {
            number: subNumber,  // 対抗の11番を2段目の軸にする
            label: '対抗',
            axis: [hole1Number, renkaTopHorse, hole2Number].filter(n => n && n !== subNumber).sort((a, b) => a - b).join('.'),  // 単穴1・連下最上位・単穴2（番号順）
            targets: subTargets.join('.'),  // 連下+軸候補（本命・対抗を除く、重複除去、番号順）
            osaeNumbers: osaeCandidates
        } : null
    };

    // 合計点数計算（実際の三連複買い目点数）
    let totalPoints = 0;

    // 1段目: 本命-対抗-(単穴1,単穴2,連下全頭)
    if (mainNumber && subNumber) {
        const thirdCount = [...new Set([hole1Number, hole2Number, ...renkaCandidates])]
            .filter(n => n && n !== mainNumber && n !== subNumber).length;
        totalPoints += thirdCount;
        console.log(`📊 1段目点数: ${thirdCount}点（本命${mainNumber}-対抗${subNumber}-第3頭${thirdCount}頭）`);
    }

    // 2段目: 本命-単穴1-(対抗,単穴2,連下全頭)
    if (mainNumber && hole1Number) {
        const thirdCount = [...new Set([subNumber, hole2Number, ...renkaCandidates])]
            .filter(n => n && n !== mainNumber && n !== hole1Number).length;
        totalPoints += thirdCount;
        console.log(`📊 2段目点数: ${thirdCount}点（本命${mainNumber}-単穴1 ${hole1Number}-第3頭${thirdCount}頭）`);
    }

    console.log(`📊 合計点数: ${totalPoints}点`);

    return {
        narrowed: narrowedBets,        // 絞り込み買い目（10点表示用）
        compact: compactDisplay,        // コンパクト表示用
        total: totalPoints              // 実際の合計点数
    };
}

// 戦略別プログレスバー信頼値計算システム（新規）
export function calculateProgressBarConfidence(strategyType, mainHorseScore, subHorseScore = null) {
    let baseScore;
    let reduction;

    // 戦略別の基本スコアと固定減算値
    switch (strategyType) {
        case 'A': // 少点数的中型
            baseScore = mainHorseScore; // 軸馬のみ
            reduction = 25; // 固定で-25
            break;
        case 'B': // バランス型
            baseScore = subHorseScore ? (mainHorseScore + subHorseScore) / 2 : mainHorseScore;
            reduction = 25; // 固定で-25
            break;
        case 'C': // 高配当追求型
            baseScore = subHorseScore ? (mainHorseScore + subHorseScore) / 2 : mainHorseScore;
            reduction = 45; // 固定で-45
            break;
        default:
            baseScore = mainHorseScore;
            reduction = 25;
    }

    // プログレスバー信頼値 = 基本スコア - 固定減算値
    const progressConfidence = Math.max(baseScore - reduction, 10); // 最低10%保証

    return {
        baseScore: Math.round(baseScore),
        reduction: reduction,
        progressConfidence: Math.round(progressConfidence),
        strategyType: strategyType
    };
}

// 統一システムで戦略データを生成
export function getPredictionDataWithStrategies(horses) {
    if (!horses) {
        return {
            strategies: [
                {
                    title: '🎯 少点数的中型モデル',
                    recommendation: 2,
                    hitRate: 60,
                    returnRate: 120,
                    riskLevel: '低リスク',
                    bets: ['馬単 本命→対抗 3点']
                },
                {
                    title: '⚖️ バランス型モデル',
                    recommendation: 3,
                    hitRate: 45,
                    returnRate: 150,
                    riskLevel: '中リスク',
                    bets: ['馬単 本命⇔対抗 11点']
                },
                {
                    title: '🚀 高配当追求型モデル',
                    recommendation: 2,
                    hitRate: 30,
                    returnRate: 200,
                    riskLevel: '高リスク',
                    bets: ['馬単 高配当狙い 14点']
                }
            ]
        };
    }

    const mainHorseScore = getHorseConfidenceFromMark(horses.main);
    const subHorseScore = getHorseConfidenceFromMark(horses.sub);

    // 戦略A: 少点数的中型
    const strategyA = {
        type: 'A',
        title: '🎯 少点数的中型モデル',
        risk: calculateDynamicRisk('A', mainHorseScore),
        bets: generateStandardizedBets({ ...horses, allHorses: horses.allHorses || [] }, 'A')
    };
    strategyA.riskText = getRiskLevelText(strategyA.risk);
    strategyA.recommendation = getRecommendationCount(strategyA.risk);
    const { hitRate: hitRateA, returnRate: returnRateA } = calculateHitRateAndReturn('A', strategyA.risk);
    strategyA.hitRate = hitRateA;
    strategyA.returnRate = returnRateA;

    // 戦略B: バランス型
    const strategyB = {
        type: 'B',
        title: '⚖️ バランス型モデル',
        risk: calculateDynamicRisk('B', mainHorseScore, subHorseScore),
        bets: generateStandardizedBets({ ...horses, allHorses: horses.allHorses || [] }, 'B')
    };
    strategyB.riskText = getRiskLevelText(strategyB.risk);
    strategyB.recommendation = getRecommendationCount(strategyB.risk);
    const { hitRate: hitRateB, returnRate: returnRateB } = calculateHitRateAndReturn('B', strategyB.risk);
    strategyB.hitRate = hitRateB;
    strategyB.returnRate = returnRateB;

    // 戦略C: 高配当追求型
    const strategyC = {
        type: 'C',
        title: '🚀 高配当追求型モデル',
        risk: calculateDynamicRisk('C', mainHorseScore, subHorseScore),
        bets: generateStandardizedBets({ ...horses, allHorses: horses.allHorses || [] }, 'C')
    };
    strategyC.riskText = getRiskLevelText(strategyC.risk);
    strategyC.recommendation = getRecommendationCount(strategyC.risk);
    const { hitRate: hitRateC, returnRate: returnRateC } = calculateHitRateAndReturn('C', strategyC.risk);
    strategyC.hitRate = hitRateC;
    strategyC.returnRate = returnRateC;

    // 統一された戦略データ形式に変換
    const strategies = [
        {
            title: strategyA.title,
            recommendation: strategyA.recommendation,
            hitRate: strategyA.hitRate,
            returnRate: strategyA.returnRate,
            riskLevel: strategyA.riskText,
            bets: strategyA.bets.map(bet => ({ type: '馬単', horses: bet, points: '3点' }))
        },
        {
            title: strategyB.title,
            recommendation: strategyB.recommendation,
            hitRate: strategyB.hitRate,
            returnRate: strategyB.returnRate,
            riskLevel: strategyB.riskText,
            bets: strategyB.bets.map(bet => ({ type: '馬単', horses: bet, points: '11点' }))
        },
        {
            title: strategyC.title,
            recommendation: strategyC.recommendation,
            hitRate: strategyC.hitRate,
            returnRate: strategyC.returnRate,
            riskLevel: strategyC.riskText,
            bets: strategyC.bets.map(bet => ({ type: '馬単', horses: bet, points: '14点' }))
        }
    ];

    return {
        strategies: strategies,
        combinationTip: {
            title: '的中率向上テクニック',
            icon: '💡',
            message: 'オッズを確認し、🔔 少点数的中型と⚖️ バランス型モデルを組み合わせることで的中率が大幅に向上します。',
            description: 'レース展開や馬場状態に応じて2つの戦略の買い目を併用することで、リスク分散と収益機会の最大化を実現できます。'
        }
    };
}