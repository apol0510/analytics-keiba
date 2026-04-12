// データバージョン管理システム
export class DataVersionManager {
    constructor() {
        this.currentVersion = this.getCurrentVersion();
        this.dataCache = new Map();
    }

    // 現在の日付ベースのバージョンを取得
    getCurrentVersion() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // データが最新かチェック
    isDataCurrent(dataDate) {
        const today = this.getCurrentVersion();
        return dataDate === today;
    }

    // データの有効期限をチェック（競馬は当日のみ有効）
    isDataExpired(dataDate) {
        const dataTimestamp = new Date(dataDate).getTime();
        const todayTimestamp = new Date().setHours(0, 0, 0, 0);
        return dataTimestamp < todayTimestamp;
    }

    // キャッシュキーを生成
    getCacheKey(dataType, date = null) {
        const targetDate = date || this.currentVersion;
        return `${dataType}_${targetDate}`;
    }

    // データを検証
    validateData(data) {
        if (!data || !data.raceDate) {
            throw new Error('Invalid data structure: missing raceDate');
        }

        if (this.isDataExpired(data.raceDate)) {
            console.warn(`⚠️  Data is expired: ${data.raceDate} (current: ${this.currentVersion})`);
            return false;
        }

        if (!this.isDataCurrent(data.raceDate)) {
            console.warn(`⚠️  Data is not current: ${data.raceDate} (expected: ${this.currentVersion})`);
            return false;
        }

        return true;
    }

    // データを取得（バージョンチェック付き）
    async getValidatedData(dataPath, fallbackData = null) {
        try {
            // 動的importでデータを取得
            const dataModule = await import(dataPath);
            const data = dataModule.default;

            if (this.validateData(data)) {
                console.log(`✅ Data is current: ${data.raceDate}`);
                return data;
            } else {
                console.log(`⚠️  Using fallback data due to version mismatch`);
                return fallbackData || this.generateFallbackData();
            }
        } catch (error) {
            console.error('Error loading data:', error);
            return fallbackData || this.generateFallbackData();
        }
    }

    // フォールバックデータ生成
    generateFallbackData() {
        return {
            raceDate: this.currentVersion,
            track: "川崎競馬",
            totalRaces: 12,
            races: [],
            lastUpdated: new Date().toISOString(),
            fallback: true,
            message: "最新データを準備中です。しばらくお待ちください。"
        };
    }
}

// シングルトンインスタンス
export const dataVersionManager = new DataVersionManager();