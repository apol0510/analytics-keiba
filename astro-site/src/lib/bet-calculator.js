// 馬単買い目の点数計算ユーティリティ
// 今後のバグ防止のため、一箇所で管理する

/**
 * 馬単の買い目文字列から正確な点数を計算する
 * @param {string} betStr - 買い目文字列 (例: "6 ⇔ 1,2,3,4,5,7,8,10,12　18点")
 * @returns {number} 計算された点数
 */
export function calculateBetPoints(betStr) {
    if (!betStr || typeof betStr !== 'string') return 1;

    // 既に点数が含まれている場合は除去
    const cleanBet = betStr.replace(/\s*\d+点\s*$/, '').trim();

    if (cleanBet.includes('⇔')) {
        // 双方向の場合: 軸馬と相手馬の組み合わせ × 2
        const parts = cleanBet.split('⇔');
        if (parts.length !== 2) return 1;

        const leftHorses = parts[0].trim().split(',').filter(h => h.trim());
        const rightHorses = parts[1].trim().split(/[,、]/).filter(h => h.trim());

        // 左側の馬数 × 右側の馬数 × 2（双方向）
        return leftHorses.length * rightHorses.length * 2;
    } else if (cleanBet.includes('→')) {
        // 単方向の場合: 軸馬から相手馬への組み合わせ
        const parts = cleanBet.split('→');
        if (parts.length !== 2) return 1;

        const leftHorses = parts[0].trim().split(',').filter(h => h.trim());
        const rightHorses = parts[1].trim().split(/[,、]/).filter(h => h.trim());

        // 左側の馬数 × 右側の馬数
        return leftHorses.length * rightHorses.length;
    }

    return 1; // デフォルト
}

/**
 * 買い目文字列に正しい点数を追加する
 * @param {string} betStr - 買い目文字列
 * @returns {string} 点数付きの買い目文字列
 */
export function addPointsToBet(betStr) {
    if (!betStr || typeof betStr !== 'string') return betStr;

    // 既存の点数表記を削除
    const cleanBet = betStr.replace(/\s*\d+点\s*$/, '').trim();

    // 正しい点数を計算
    const points = calculateBetPoints(cleanBet);

    // 点数を追加して返す
    return `${cleanBet}　${points}点`;
}

/**
 * 買い目文字列の点数が正しいか検証する
 * @param {string} betStr - 買い目文字列
 * @returns {object} {isValid: boolean, expected: number, actual: number|null}
 */
export function validateBetPoints(betStr) {
    if (!betStr || typeof betStr !== 'string') {
        return { isValid: false, expected: 1, actual: null };
    }

    // 既存の点数を抽出
    const pointMatch = betStr.match(/(\d+)点/);
    const actualPoints = pointMatch ? parseInt(pointMatch[1]) : null;

    // 期待される点数を計算
    const expectedPoints = calculateBetPoints(betStr);

    return {
        isValid: actualPoints === expectedPoints,
        expected: expectedPoints,
        actual: actualPoints
    };
}

/**
 * 買い目配列内の全ての点数を検証・修正する
 * @param {Array} bets - 買い目配列
 * @returns {Array} 修正された買い目配列
 */
export function fixAllBetPoints(bets) {
    if (!Array.isArray(bets)) return bets;

    return bets.map(bet => {
        if (typeof bet === 'string') {
            // 文字列の場合はそのまま修正
            return addPointsToBet(bet);
        } else if (bet && typeof bet === 'object' && bet.numbers) {
            // オブジェクトの場合はnumbersフィールドを修正
            return {
                ...bet,
                numbers: addPointsToBet(bet.numbers)
            };
        }
        return bet;
    });
}

/**
 * デバッグ用: 買い目の詳細情報を出力
 * @param {string} betStr - 買い目文字列
 */
export function debugBet(betStr) {
    console.log('=== 買い目デバッグ情報 ===');
    console.log('入力:', betStr);

    const validation = validateBetPoints(betStr);
    console.log('検証結果:', validation);

    if (!validation.isValid) {
        console.log('⚠️ 点数が間違っています！');
        console.log('修正後:', addPointsToBet(betStr));
    } else {
        console.log('✅ 点数は正しいです');
    }

    console.log('========================');
}