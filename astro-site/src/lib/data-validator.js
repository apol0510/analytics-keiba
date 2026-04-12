/**
 * データバリデーション・整合性チェックモジュール
 * JSONデータの検証と自動修正機能を提供
 */

import { getRaceTier, isMainRace } from './race-config.js';

/**
 * レース予想データ全体のバリデーション
 * @param {Object} data - 全レース予想データ
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[], fixed: Object }
 */
export function validateAllRacesPrediction(data) {
    const errors = [];
    const warnings = [];
    const fixed = JSON.parse(JSON.stringify(data)); // ディープコピー
    
    // 必須フィールドチェック
    if (!data.raceDate) {
        errors.push('raceDate（開催日）が未設定');
    } else if (!isValidDate(data.raceDate)) {
        errors.push(`無効な日付形式: ${data.raceDate}`);
    }
    
    if (!data.track) {
        errors.push('track（競馬場）が未設定');
    }
    
    if (!data.totalRaces || data.totalRaces < 1 || data.totalRaces > 12) {
        errors.push(`無効なレース数: ${data.totalRaces}`);
    }
    
    if (!Array.isArray(data.races)) {
        errors.push('racesが配列ではありません');
        return { valid: false, errors, warnings, fixed: null };
    }
    
    // 各レースのバリデーション
    data.races.forEach((race, index) => {
        const raceValidation = validateRaceData(race, index + 1, data.totalRaces);
        errors.push(...raceValidation.errors);
        warnings.push(...raceValidation.warnings);
        
        // 自動修正
        if (raceValidation.fixed) {
            fixed.races[index] = raceValidation.fixed;
        }
    });
    
    // レース番号の重複チェック
    const raceNumbers = data.races.map(r => r.raceNumber);
    const duplicates = raceNumbers.filter((num, idx) => raceNumbers.indexOf(num) !== idx);
    if (duplicates.length > 0) {
        errors.push(`重複するレース番号: ${duplicates.join(', ')}`);
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        fixed: errors.length === 0 ? fixed : null
    };
}

/**
 * 個別レースデータのバリデーション
 * @param {Object} race - レースデータ
 * @param {number} expectedNumber - 期待されるレース番号
 * @param {number} totalRaces - 総レース数
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[], fixed: Object }
 */
export function validateRaceData(race, expectedNumber, totalRaces = 12) {
    const errors = [];
    const warnings = [];
    const fixed = JSON.parse(JSON.stringify(race));
    
    // レース番号チェック
    const raceNum = parseInt(race.raceNumber);
    if (!race.raceNumber || isNaN(raceNum)) {
        errors.push(`レース${expectedNumber}: 無効なレース番号`);
    } else if (raceNum !== expectedNumber) {
        warnings.push(`レース${expectedNumber}: レース番号が期待値と異なる（${race.raceNumber}）`);
    }
    
    // tier設定の検証と自動修正
    const correctTier = getRaceTier(raceNum || expectedNumber, totalRaces);
    if (race.tier !== correctTier) {
        warnings.push(`レース${race.raceNumber}: tierを${race.tier}から${correctTier}に修正`);
        fixed.tier = correctTier;
    }
    
    // メインレースフラグの検証と自動修正
    const shouldBeMain = isMainRace(raceNum || expectedNumber, totalRaces);
    if (race.isMainRace !== shouldBeMain) {
        warnings.push(`レース${race.raceNumber}: isMainRaceを${race.isMainRace}から${shouldBeMain}に修正`);
        fixed.isMainRace = shouldBeMain;
    }
    
    // 馬データのバリデーション
    if (!race.horses) {
        errors.push(`レース${race.raceNumber}: horsesデータが未設定`);
    } else {
        const horseValidation = validateHorseData(race.horses, race.raceNumber);
        errors.push(...horseValidation.errors);
        warnings.push(...horseValidation.warnings);
        if (horseValidation.fixed) {
            fixed.horses = horseValidation.fixed;
        }
    }
    
    // raceInfoのバリデーション
    if (race.raceInfo) {
        const infoValidation = validateRaceInfo(race.raceInfo, race.raceNumber);
        errors.push(...infoValidation.errors);
        warnings.push(...infoValidation.warnings);
        if (infoValidation.fixed) {
            fixed.raceInfo = infoValidation.fixed;
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        fixed: errors.length === 0 ? fixed : null
    };
}

/**
 * 馬データのバリデーション
 * @param {Object} horses - 馬データ（main, sub, etc）
 * @param {string} raceNumber - レース番号
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[], fixed: Object }
 */
export function validateHorseData(horses, raceNumber) {
    const errors = [];
    const warnings = [];
    const fixed = JSON.parse(JSON.stringify(horses));
    
    // 本命馬チェック
    if (!horses.main) {
        errors.push(`レース${raceNumber}: 本命馬が未設定`);
    } else {
        if (!horses.main.number || horses.main.number < 1 || horses.main.number > 18) {
            errors.push(`レース${raceNumber}: 本命馬の番号が無効（${horses.main.number}）`);
        }
        if (!horses.main.name) {
            errors.push(`レース${raceNumber}: 本命馬の名前が未設定`);
        }
        // importanceの値を正規化
        if (horses.main.importance && Array.isArray(horses.main.importance)) {
            horses.main.importance.forEach((item, idx) => {
                if (typeof item.value === 'number' && item.value > 1) {
                    warnings.push(`レース${raceNumber}: 本命馬importance[${idx}]を正規化`);
                    fixed.main.importance[idx].value = item.value / 100;
                }
            });
        }
    }
    
    // 対抗馬チェック
    if (!horses.sub) {
        warnings.push(`レース${raceNumber}: 対抗馬が未設定`);
    } else {
        if (!horses.sub.number || horses.sub.number < 1 || horses.sub.number > 18) {
            errors.push(`レース${raceNumber}: 対抗馬の番号が無効（${horses.sub.number}）`);
        }
        // importanceの値を正規化
        if (horses.sub.importance && Array.isArray(horses.sub.importance)) {
            horses.sub.importance.forEach((item, idx) => {
                if (typeof item.value === 'number' && item.value > 1) {
                    warnings.push(`レース${raceNumber}: 対抗馬importance[${idx}]を正規化`);
                    fixed.sub.importance[idx].value = item.value / 100;
                }
            });
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        fixed
    };
}

/**
 * レース情報のバリデーション
 * @param {Object} raceInfo - レース情報
 * @param {string} raceNumber - レース番号
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[], fixed: Object }
 */
export function validateRaceInfo(raceInfo, raceNumber) {
    const errors = [];
    const warnings = [];
    const fixed = JSON.parse(JSON.stringify(raceInfo));
    
    // confidence値のチェック（0-100の範囲）
    if (raceInfo.confidence) {
        const confidence = parseFloat(raceInfo.confidence);
        if (isNaN(confidence)) {
            errors.push(`レース${raceNumber}: confidence値が数値ではない`);
        } else if (confidence < 0 || confidence > 100) {
            warnings.push(`レース${raceNumber}: confidence値が範囲外（${confidence}）`);
            fixed.confidence = Math.max(0, Math.min(100, confidence)).toFixed(1);
        }
    }
    
    // expectedReturn値のチェック
    if (raceInfo.expectedReturn) {
        const expectedReturn = parseFloat(raceInfo.expectedReturn);
        if (isNaN(expectedReturn)) {
            errors.push(`レース${raceNumber}: expectedReturn値が数値ではない`);
        }
    }
    
    // 距離フォーマットチェック
    if (raceInfo.distance && !/^\d{3,4}m$/.test(raceInfo.distance)) {
        warnings.push(`レース${raceNumber}: 距離フォーマットが不正（${raceInfo.distance}）`);
    }
    
    // 発走時刻フォーマットチェック
    if (raceInfo.startTime && !/^\d{1,2}:\d{2}$/.test(raceInfo.startTime)) {
        warnings.push(`レース${raceNumber}: 発走時刻フォーマットが不正（${raceInfo.startTime}）`);
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        fixed
    };
}

/**
 * 日付形式のバリデーション
 * @param {string} dateStr - 日付文字列
 * @returns {boolean} 有効な日付形式か
 */
function isValidDate(dateStr) {
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date) && 
           /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * データの自動修正
 * @param {Object} data - 修正対象データ
 * @returns {Object} 修正済みデータ
 */
export function autoFixData(data) {
    const validation = validateAllRacesPrediction(data);
    
    if (validation.fixed) {
        console.log('データ自動修正完了:');
        validation.warnings.forEach(w => console.warn(`  ⚠️ ${w}`));
        return validation.fixed;
    }
    
    console.error('データ修正不可能:');
    validation.errors.forEach(e => console.error(`  ❌ ${e}`));
    return null;
}

/**
 * バリデーション結果のサマリーを生成
 * @param {Object} validation - バリデーション結果
 * @returns {string} サマリーテキスト
 */
export function getValidationSummary(validation) {
    const lines = [];
    
    if (validation.valid) {
        lines.push('✅ データ検証成功');
    } else {
        lines.push('❌ データ検証失敗');
    }
    
    if (validation.errors.length > 0) {
        lines.push('\n【エラー】');
        validation.errors.forEach(e => lines.push(`  • ${e}`));
    }
    
    if (validation.warnings.length > 0) {
        lines.push('\n【警告】');
        validation.warnings.forEach(w => lines.push(`  • ${w}`));
    }
    
    return lines.join('\n');
}