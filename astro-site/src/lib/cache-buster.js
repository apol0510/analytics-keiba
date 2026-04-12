// キャッシュバスターシステム
export class CacheBuster {
    constructor() {
        this.cacheVersion = this.generateCacheVersion();
    }

    // キャッシュバージョン生成
    generateCacheVersion() {
        const now = new Date();
        const timestamp = now.getTime();
        const dateStr = now.toISOString().split('T')[0];
        return `${dateStr}_${timestamp}`;
    }

    // URLにキャッシュバスターを追加
    addCacheBuster(url) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}v=${this.cacheVersion}`;
    }

    // ローカルストレージのキャッシュクリア
    clearLocalStorageCache(prefix = 'nankan_') {
        try {
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith(prefix)) {
                    localStorage.removeItem(key);
                }
            });
            console.log('✅ Local storage cache cleared');
        } catch (error) {
            console.error('Error clearing local storage:', error);
        }
    }

    // ブラウザキャッシュを強制リフレッシュ
    forceCacheRefresh() {
        if (typeof window !== 'undefined') {
            // Service Worker キャッシュクリア
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(registrations => {
                    registrations.forEach(registration => {
                        registration.update();
                    });
                });
            }

            // ローカルストレージクリア
            this.clearLocalStorageCache();

            // メタタグでキャッシュ無効化
            this.addNoCacheHeaders();
        }
    }

    // キャッシュ無効化メタタグ追加
    addNoCacheHeaders() {
        if (typeof document !== 'undefined') {
            // 既存のキャッシュ制御メタタグを削除
            const existingMetas = document.querySelectorAll('meta[http-equiv="Cache-Control"], meta[http-equiv="Expires"], meta[http-equiv="Pragma"]');
            existingMetas.forEach(meta => meta.remove());

            // 新しいキャッシュ制御メタタグを追加
            const metaTags = [
                { httpEquiv: 'Cache-Control', content: 'no-cache, no-store, must-revalidate' },
                { httpEquiv: 'Pragma', content: 'no-cache' },
                { httpEquiv: 'Expires', content: '0' }
            ];

            metaTags.forEach(tag => {
                const meta = document.createElement('meta');
                meta.httpEquiv = tag.httpEquiv;
                meta.content = tag.content;
                document.head.appendChild(meta);
            });
        }
    }

    // データの最終更新時刻を保存
    setLastDataUpdate(dataType, timestamp = null) {
        const updateTime = timestamp || new Date().toISOString();
        localStorage.setItem(`nankan_last_update_${dataType}`, updateTime);
    }

    // データの最終更新時刻を取得
    getLastDataUpdate(dataType) {
        return localStorage.getItem(`nankan_last_update_${dataType}`);
    }

    // データが古いかチェック（時間ベース）
    isDataStale(dataType, maxAgeHours = 24) {
        const lastUpdate = this.getLastDataUpdate(dataType);
        if (!lastUpdate) return true;

        const lastUpdateTime = new Date(lastUpdate).getTime();
        const now = new Date().getTime();
        const ageHours = (now - lastUpdateTime) / (1000 * 60 * 60);

        return ageHours > maxAgeHours;
    }
}

// キャッシュバスター初期化関数
export function initCacheBuster() {
    const cacheBuster = new CacheBuster();

    // ページロード時にキャッシュチェック
    if (typeof window !== 'undefined') {
        window.addEventListener('load', () => {
            // 古いデータをチェックして必要に応じてクリア
            if (cacheBuster.isDataStale('predictions', 6)) { // 6時間で無効
                console.log('🔄 Data is stale, clearing cache...');
                cacheBuster.forceCacheRefresh();
                cacheBuster.setLastDataUpdate('predictions');
            }
        });
    }

    return cacheBuster;
}

// シングルトンインスタンス
export const cacheBuster = new CacheBuster();