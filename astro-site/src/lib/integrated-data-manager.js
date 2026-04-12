// 統合データ管理システム - 古いデータ参照問題の根本解決
import { dataVersionManager } from './data-version-manager.js';
import { cacheBuster } from './cache-buster.js';

export class IntegratedDataManager {
    constructor() {
        this.versionManager = dataVersionManager;
        this.cacheBuster = cacheBuster;
        this.dataPath = '../data/allRacesPrediction.json';
    }

    // メインのデータ取得関数
    async getPredictionData() {
        try {
            // 1. キャッシュステータスをチェック
            if (this.cacheBuster.isDataStale('predictions', 6)) {
                console.log('🔄 Cache is stale, refreshing...');
                this.cacheBuster.forceCacheRefresh();
            }

            // 2. データをバージョンチェック付きで取得
            const data = await this.versionManager.getValidatedData(this.dataPath);

            // 3. データが有効な場合、キャッシュ更新時刻を記録
            if (!data.fallback) {
                this.cacheBuster.setLastDataUpdate('predictions');
            }

            // 4. データ統合処理
            return this.processData(data);

        } catch (error) {
            console.error('❌ Error in getPredictionData:', error);
            return this.versionManager.generateFallbackData();
        }
    }

    // データ処理・統合
    processData(rawData) {
        // データの整合性を再確認
        if (!rawData.races || rawData.races.length === 0) {
            console.warn('⚠️  No races found in data');
            return this.versionManager.generateFallbackData();
        }

        // 現在時刻での動的データ更新
        const processedData = {
            ...rawData,
            lastProcessed: new Date().toISOString(),
            version: this.versionManager.currentVersion,
            cacheVersion: this.cacheBuster.cacheVersion
        };

        // レースデータの動的更新
        processedData.races = rawData.races.map(race => ({
            ...race,
            lastUpdated: new Date().toISOString(),
            status: this.getRaceStatus(race)
        }));

        return processedData;
    }

    // レースステータス取得
    getRaceStatus(race) {
        const now = new Date();
        const raceDate = new Date(race.raceDate || this.versionManager.currentVersion);

        if (raceDate < now.setHours(0, 0, 0, 0)) {
            return 'expired';
        } else if (raceDate.toDateString() === now.toDateString()) {
            return 'current';
        } else {
            return 'future';
        }
    }

    // データの強制更新
    async forceDataUpdate() {
        console.log('🔄 Forcing data update...');

        // キャッシュクリア
        this.cacheBuster.forceCacheRefresh();

        // バージョン更新
        this.versionManager.currentVersion = this.versionManager.getCurrentVersion();

        // 新しいデータ取得
        return await this.getPredictionData();
    }

    // データ健全性チェック
    validateDataHealth(data) {
        const checks = {
            hasValidDate: data.raceDate && !this.versionManager.isDataExpired(data.raceDate),
            hasRaces: data.races && data.races.length > 0,
            hasValidRaces: data.races && data.races.every(race => race.raceNumber && race.raceName),
            isNotFallback: !data.fallback
        };

        const healthScore = Object.values(checks).filter(Boolean).length;
        const maxScore = Object.keys(checks).length;

        return {
            score: healthScore,
            maxScore,
            percentage: Math.round((healthScore / maxScore) * 100),
            checks,
            isHealthy: healthScore === maxScore
        };
    }

    // 管理画面用のデータステータス
    getDataStatus() {
        return {
            currentVersion: this.versionManager.currentVersion,
            cacheVersion: this.cacheBuster.cacheVersion,
            lastPredictionsUpdate: this.cacheBuster.getLastDataUpdate('predictions'),
            isDataStale: this.cacheBuster.isDataStale('predictions', 6)
        };
    }

    // 自動データ更新スケジューラー
    startAutoUpdateScheduler(intervalMinutes = 30) {
        if (typeof window !== 'undefined') {
            setInterval(async () => {
                if (this.cacheBuster.isDataStale('predictions', 1)) { // 1時間で自動更新
                    console.log('⏰ Auto-updating data...');
                    await this.forceDataUpdate();
                }
            }, intervalMinutes * 60 * 1000);
        }
    }
}

// デフォルトエクスポート
export const dataManager = new IntegratedDataManager();

// shared-prediction-logic.jsとの統合関数
export async function getValidatedPredictionData() {
    return await dataManager.getPredictionData();
}