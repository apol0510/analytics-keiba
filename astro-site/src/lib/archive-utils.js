/**
 * アーカイブデータユーティリティ
 * archiveResults.jsonから最新の的中結果データを取得
 */

import archiveResults from '../data/archiveResults.json';
import archiveResultsJra from '../data/archiveResultsJra.json';
import archiveSanrenpukuResults from '../data/archiveSanrenpukuResults.json';
import archiveSanrenpukuResultsJra from '../data/archiveSanrenpukuResultsJra.json';

/**
 * archiveResults.jsonから最新日のデータを取得
 * 2026-04-17 以降: 配列形式 ({date:"YYYY-MM-DD", ...} が unshift 順) に統一
 * @returns {Object|null} 最新日のデータ（year, month, day, venue, races等を含む）
 */
export function getLatestDayData() {
    if (!Array.isArray(archiveResults) || archiveResults.length === 0) return null;

    // 先頭が最新 (importResults.js で unshift 保存)
    const latest = archiveResults[0];
    if (!latest || !latest.date) return null;

    const [year, month, day] = latest.date.split('-');
    return {
        year,
        month,
        day,
        ...latest,
    };
}

/**
 * 最新日データをstandard-predictions用のyesterdayResults形式に変換
 * @returns {Object|null} yesterdayResults形式のオブジェクト
 */
export function convertToYesterdayResults() {
    const latestData = getLatestDayData();
    if (!latestData) return null;

    // 新フォーマット (配列形式 / importResults.js v2+):
    //   race.bettingPoints / race.isHit / race.umatan.payout
    //   latestData.returnRate (旧 recoveryRate 相当)
    const races = Array.isArray(latestData.races) ? latestData.races : [];

    // 🔴 回収率: JSONの returnRate を優先。無ければ betPoints 相当から逆算 (フォールバック)
    let recoveryRate = latestData.returnRate ?? latestData.recoveryRate ?? 0;
    const totalBetPoints = races.reduce((sum, race) => sum + (race.bettingPoints || race.betPoints || 0), 0);

    if (totalBetPoints > 0 && !latestData.returnRate && !latestData.recoveryRate) {
        const totalInvestment = totalBetPoints * 100; // 1点=100円
        recoveryRate = Math.round((latestData.totalPayout / totalInvestment) * 100);
    }

    const hitRate = latestData.totalRaces > 0 ? Math.round((latestData.hitRaces / latestData.totalRaces) * 100) : 0;

    const results = races.map(race => ({
        race: race.raceNumber,
        result: (race.isHit ?? race.hit) ? 'win' : 'loss',
        payout: race.umatan?.payout ?? race.payout ?? 0,
    }));

    return {
        date: `${latestData.month}/${latestData.day}`,
        track: `${latestData.venue}競馬`,
        hitRate,
        hitCount: latestData.hitRaces,
        totalCount: latestData.totalRaces,
        totalPayout: latestData.totalPayout,
        recoveryRate,
        totalBetPoints,
        results,
    };
}

/**
 * archiveResultsJra.jsonから最新日のデータを取得
 * JRA 版（archiveResultsJra.json）: 配列形式 ({date:"YYYY-MM-DD", venues:[], races:[], ...})
 * @returns {Object|null} 最新日のデータ
 */
export function getLatestDayDataJra() {
    if (!Array.isArray(archiveResultsJra) || archiveResultsJra.length === 0) return null;

    const latest = archiveResultsJra[0];
    if (!latest || !latest.date) return null;

    const [year, month, day] = latest.date.split('-');
    return {
        year,
        month,
        day,
        ...latest,
    };
}

/**
 * JRA 最新日データを yesterdayResults 形式に変換
 * @returns {Object|null} yesterdayResults 形式のオブジェクト
 */
export function convertToYesterdayResultsJra() {
    const latestData = getLatestDayDataJra();
    if (!latestData) return null;

    const races = Array.isArray(latestData.races) ? latestData.races : [];

    // 回収率: JSON の returnRate を優先。無ければ totalBetPoints / totalInvestment / totalPayout から逆算
    let recoveryRate = latestData.returnRate ?? latestData.recoveryRate ?? 0;
    const totalBetPoints = latestData.totalBetPoints
        ?? races.reduce((sum, race) => sum + (race.bettingPoints || race.betPoints || 0), 0);

    if (totalBetPoints > 0 && !latestData.returnRate && !latestData.recoveryRate) {
        const totalInvestment = totalBetPoints * 100;
        recoveryRate = Math.round((latestData.totalPayout / totalInvestment) * 100);
    }

    const hitRate = latestData.totalRaces > 0 ? Math.round((latestData.hitRaces / latestData.totalRaces) * 100) : 0;

    // JRA は複数会場開催 (venue が "京都・新潟・東京" 形式)。表示用は venues 配列があれば全会場を列挙、
    // 無ければ venue 文字列のみ。
    const trackLabel = Array.isArray(latestData.venues) && latestData.venues.length > 0
        ? latestData.venues.join('・')
        : (latestData.venue || 'JRA');

    return {
        date: `${latestData.month}/${latestData.day}`,
        track: trackLabel,
        hitRate,
        hitCount: latestData.hitRaces,
        totalCount: latestData.totalRaces,
        totalPayout: latestData.totalPayout,
        recoveryRate,
        totalBetPoints,
        races,
    };
}

/**
 * archiveSanrenpukuResults.jsonから最新日のデータを取得
 * @returns {Object|null} 最新日のデータ（year, month, day, venue, races等を含む）
 */
export function getLatestSanrenpukuDayData() {
    const years = Object.keys(archiveSanrenpukuResults).sort().reverse();
    if (years.length === 0) return null;

    const latestYear = years[0];
    const months = Object.keys(archiveSanrenpukuResults[latestYear]).sort().reverse();
    if (months.length === 0) return null;

    const latestMonth = months[0];
    const days = Object.keys(archiveSanrenpukuResults[latestYear][latestMonth]).sort().reverse();
    if (days.length === 0) return null;

    const latestDay = days[0];
    const dayData = archiveSanrenpukuResults[latestYear][latestMonth][latestDay];

    // HTML template用に必要なプロパティを追加
    const totalBetPoints = dayData.races ? dayData.races.reduce((sum, race) => sum + (race.betPoints || 0), 0) : 0;
    const hitRate = dayData.totalRaces > 0 ? Math.round((dayData.hitRaces / dayData.totalRaces) * 100) : 0;

    // races配列にisHitプロパティを追加（hitと同じ値）
    const racesWithIsHit = dayData.races ? dayData.races.map(race => ({
        ...race,
        isHit: race.hit  // HTMLテンプレートはisHitを期待している
    })) : [];

    return {
        year: latestYear,
        month: latestMonth,
        day: latestDay,
        date: `${parseInt(latestMonth)}月${parseInt(latestDay)}日`,  // HTML template用の日付文字列（例: 11月3日）
        hitRate: hitRate,  // 的中率（%）
        totalBetPoints: totalBetPoints,  // 合計購入点数
        ...dayData,
        races: racesWithIsHit  // isHitプロパティを追加したraces配列
    };
}

/**
 * 最新日データを三連複yesterday結果形式に変換
 * @returns {Object|null} yesterdayResults形式のオブジェクト
 */
export function convertToSanrenpukuYesterdayResults() {
    const latestData = getLatestSanrenpukuDayData();
    if (!latestData) return null;

    // 🔴 回収率: JSONに保存されている値を最優先使用（2025-11-09修正）
    // 問題: betPointsがない場合、recoveryRateが0になってしまう
    // 解決: latestData.recoveryRateが存在すればそれを使用（betPoints不要）
    let recoveryRate = latestData.recoveryRate || 0;
    let totalBetPoints = latestData.races.reduce((sum, race) => sum + (race.betPoints || 0), 0);

    // ⚠️ JSONにrecoveryRateがない場合のみ、betPointsから計算（フォールバック）
    if (!latestData.recoveryRate && totalBetPoints > 0) {
        const totalInvestment = totalBetPoints * 100;
        recoveryRate = Math.round((latestData.totalPayout / totalInvestment) * 100);
    }

    // 的中率計算
    const hitRate = latestData.totalRaces > 0 ? Math.round((latestData.hitRaces / latestData.totalRaces) * 100) : 0;

    // results配列変換
    const results = latestData.races.map(race => ({
        race: race.raceNumber,
        result: race.hit ? 'win' : 'loss',
        payout: race.payout
    }));

    return {
        date: `${latestData.month}/${latestData.day}`,
        track: `${latestData.venue}競馬`,
        hitRate: hitRate,
        hitCount: latestData.hitRaces,
        totalCount: latestData.totalRaces,
        totalPayout: latestData.totalPayout,
        recoveryRate: recoveryRate,
        totalBetPoints: totalBetPoints,
        results: results
    };
}

// ============================================================
// JRA（中央競馬）三連複 実績ヘルパ（南関版の JRA 差し替え）
// archiveSanrenpukuResultsJra.json も南関と同じネスト辞書 {YYYY}{MM}{DD} 構造。
// ============================================================

/**
 * archiveSanrenpukuResultsJra.json から最新日のデータを取得（JRA 版）
 * @returns {Object|null}
 */
export function getLatestSanrenpukuDayDataJra() {
    const years = Object.keys(archiveSanrenpukuResultsJra).sort().reverse();
    if (years.length === 0) return null;

    const latestYear = years[0];
    const months = Object.keys(archiveSanrenpukuResultsJra[latestYear]).sort().reverse();
    if (months.length === 0) return null;

    const latestMonth = months[0];
    const days = Object.keys(archiveSanrenpukuResultsJra[latestYear][latestMonth]).sort().reverse();
    if (days.length === 0) return null;

    const latestDay = days[0];
    const dayData = archiveSanrenpukuResultsJra[latestYear][latestMonth][latestDay];

    const hitRate = dayData.totalRaces > 0 ? Math.round((dayData.hitRaces / dayData.totalRaces) * 100) : 0;
    // 三連複 archive の race は settlementPoints を持つ（betPoints ではない）
    const totalBetPoints = dayData.totalBetPoints
        || (dayData.races ? dayData.races.reduce((sum, race) => sum + (race.settlementPoints || 0), 0) : 0);
    const racesWithIsHit = dayData.races ? dayData.races.map(race => ({ ...race, isHit: race.hit })) : [];

    return {
        year: latestYear,
        month: latestMonth,
        day: latestDay,
        date: `${parseInt(latestMonth)}月${parseInt(latestDay)}日`,
        hitRate,
        totalBetPoints,
        ...dayData,
        races: racesWithIsHit,
    };
}

/**
 * 最新日データを三連複 yesterday 結果形式に変換（JRA 版）
 * @returns {Object|null}
 */
export function convertToSanrenpukuYesterdayResultsJra() {
    const latestData = getLatestSanrenpukuDayDataJra();
    if (!latestData) return null;

    // 回収率は JSON 値を最優先（settlementPoints ベースで救済）
    let recoveryRate = latestData.recoveryRate || 0;
    const totalBetPoints = latestData.totalBetPoints
        || latestData.races.reduce((sum, race) => sum + (race.settlementPoints || 0), 0);
    if (!latestData.recoveryRate && totalBetPoints > 0) {
        const totalInvestment = totalBetPoints * 100;
        recoveryRate = Math.round((latestData.totalPayout / totalInvestment) * 100);
    }

    const hitRate = latestData.totalRaces > 0 ? Math.round((latestData.hitRaces / latestData.totalRaces) * 100) : 0;

    const results = latestData.races.map(race => ({
        race: race.venue ? `${race.venue}${race.raceNumber}` : race.raceNumber,
        result: race.hit ? 'win' : 'loss',
        payout: race.payout,
    }));

    const track = (latestData.venues && latestData.venues.length)
        ? latestData.venues.join('・')
        : `${latestData.venue}`;

    return {
        date: `${latestData.month}/${latestData.day}`,
        track,
        hitRate,
        hitCount: latestData.hitRaces,
        totalCount: latestData.totalRaces,
        totalPayout: latestData.totalPayout,
        recoveryRate,
        totalBetPoints,
        results,
    };
}
