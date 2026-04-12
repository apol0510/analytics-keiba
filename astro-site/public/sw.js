// Service Worker for NANKANアナリティクス
const CACHE_NAME = 'nankan-analytics-v1';
const STATIC_CACHE_NAME = 'nankan-static-v1';
const DYNAMIC_CACHE_NAME = 'nankan-dynamic-v1';

// キャッシュするリソース
const STATIC_ASSETS = [
    '/',
    '/free-prediction/',
    '/pricing/',
    '/technology/',
    '/blog/',
    // CSS and JS files will be added dynamically
];

// キャッシュしないパス
const CACHE_BLACKLIST = [
    '/api/',
    '/auth/',
    '/admin/',
    '/dashboard',
    '/account'
];

// インストールイベント
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .catch((error) => {
                console.error('[SW] Failed to cache static assets:', error);
            })
    );
    self.skipWaiting();
});

// アクティブイベント
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== STATIC_CACHE_NAME && cacheName !== DYNAMIC_CACHE_NAME) {
                            console.log('[SW] Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
    );
    self.clients.claim();
});

// フェッチイベント
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // キャッシュ対象外のパスをチェック
    const shouldNotCache = CACHE_BLACKLIST.some(path => url.pathname.startsWith(path));
    
    if (shouldNotCache || request.method !== 'GET') {
        return;
    }

    // HTML リクエストの処理
    if (request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(
            caches.open(DYNAMIC_CACHE_NAME)
                .then((cache) => {
                    return cache.match(request)
                        .then((cachedResponse) => {
                            if (cachedResponse) {
                                // バックグラウンドで更新
                                fetch(request)
                                    .then((response) => {
                                        if (response.ok) {
                                            cache.put(request, response.clone());
                                        }
                                    })
                                    .catch(() => {
                                        // ネットワークエラーは無視
                                    });
                                
                                return cachedResponse;
                            }

                            // キャッシュにない場合はネットワークから取得
                            return fetch(request)
                                .then((response) => {
                                    if (response.ok && response.status === 200) {
                                        cache.put(request, response.clone());
                                    }
                                    return response;
                                })
                                .catch(() => {
                                    // オフライン時のフォールバック
                                    return new Response(`
                                        <html>
                                            <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 50px; background: #f8fafc;">
                                                <h1 style="color: #64748b;">オフラインです</h1>
                                                <p style="color: #94a3b8;">インターネット接続を確認してください。</p>
                                                <button onclick="location.reload()" style="background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer;">再試行</button>
                                            </body>
                                        </html>
                                    `, {
                                        headers: { 'Content-Type': 'text/html' }
                                    });
                                });
                        });
                })
        );
    }
    
    // 静的リソース（CSS、JS、画像など）の処理
    else if (request.destination === 'style' || request.destination === 'script' || request.destination === 'image') {
        event.respondWith(
            caches.open(STATIC_CACHE_NAME)
                .then((cache) => {
                    return cache.match(request)
                        .then((cachedResponse) => {
                            if (cachedResponse) {
                                return cachedResponse;
                            }

                            return fetch(request)
                                .then((response) => {
                                    if (response.ok) {
                                        cache.put(request, response.clone());
                                    }
                                    return response;
                                })
                                .catch(() => {
                                    // 静的リソースが見つからない場合
                                    if (request.destination === 'image') {
                                        // 代替画像を返す（SVGプレースホルダー）
                                        return new Response(`
                                            <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
                                                <rect width="100%" height="100%" fill="#f1f5f9"/>
                                                <text x="50%" y="50%" font-family="Arial" font-size="16" fill="#64748b" text-anchor="middle" dy=".3em">画像が読み込めません</text>
                                            </svg>
                                        `, {
                                            headers: { 'Content-Type': 'image/svg+xml' }
                                        });
                                    }
                                    throw error;
                                });
                        });
                })
        );
    }
});

// バックグラウンド同期
self.addEventListener('sync', (event) => {
    if (event.tag === 'background-sync') {
        event.waitUntil(
            // バックグラウンドでデータを同期
            syncData()
        );
    }
});

// プッシュ通知
self.addEventListener('push', (event) => {
    if (event.data) {
        const data = event.data.json();
        
        const options = {
            body: data.body || '新しい予想データが利用可能です',
            icon: '/favicon.svg',
            badge: '/favicon.svg',
            data: {
                url: data.url || '/'
            },
            actions: [
                {
                    action: 'view',
                    title: '予想を見る'
                }
            ]
        };

        event.waitUntil(
            self.registration.showNotification(data.title || 'NANKANアナリティクス', options)
        );
    }
});

// 通知クリック処理
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'view' || !event.action) {
        const url = event.notification.data?.url || '/';
        
        event.waitUntil(
            self.clients.matchAll({ type: 'window' })
                .then((clientList) => {
                    // 既存のタブがあれば、そこに移動
                    for (const client of clientList) {
                        if (client.url === url && 'focus' in client) {
                            return client.focus();
                        }
                    }
                    
                    // 新しいタブを開く
                    if (self.clients.openWindow) {
                        return self.clients.openWindow(url);
                    }
                })
        );
    }
});

// データ同期関数
async function syncData() {
    try {
        // 最新の予想データを取得してキャッシュを更新
        const response = await fetch('/api/sync-predictions');
        if (response.ok) {
            console.log('[SW] Data synced successfully');
        }
    } catch (error) {
        console.error('[SW] Data sync failed:', error);
    }
}

// パフォーマンス監視
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'PERFORMANCE_MARK') {
        console.log('[SW] Performance mark:', event.data.name, event.data.time);
    }
});