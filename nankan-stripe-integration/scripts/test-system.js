#!/usr/bin/env node
/**
 * システム動作テストスクリプト
 * 修正された機能が正常に動作するかテストする
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:4321';
const TEST_TIMEOUT = 10000;

class SystemTester {
    constructor() {
        this.results = [];
        this.passed = 0;
        this.failed = 0;
    }

    async runTest(name, testFn) {
        process.stdout.write(`🧪 ${name}... `);
        
        try {
            const startTime = Date.now();
            await Promise.race([
                testFn(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), TEST_TIMEOUT)
                )
            ]);
            
            const duration = Date.now() - startTime;
            console.log(`✅ (${duration}ms)`);
            
            this.results.push({ name, status: 'PASS', duration });
            this.passed++;
            
        } catch (error) {
            console.log(`❌ ${error.message}`);
            
            this.results.push({ 
                name, 
                status: 'FAIL', 
                error: error.message 
            });
            this.failed++;
        }
    }

    async testWebsiteAccess() {
        const response = await fetch(`${BASE_URL}/`);
        if (!response.ok) {
            throw new Error(`Website returned ${response.status}`);
        }
        
        const html = await response.text();
        if (!html.includes('NANKANアナリティクス')) {
            throw new Error('Website content verification failed');
        }
    }

    async testWebManifest() {
        const response = await fetch(`${BASE_URL}/site.webmanifest`);
        if (!response.ok) {
            throw new Error(`Manifest returned ${response.status}`);
        }
        
        const manifest = await response.json();
        if (!manifest.name || !manifest.name.includes('NANKAN')) {
            throw new Error('Manifest content verification failed');
        }
    }

    async testServiceWorker() {
        const response = await fetch(`${BASE_URL}/sw.js`);
        if (!response.ok) {
            throw new Error(`Service worker returned ${response.status}`);
        }
        
        const content = await response.text();
        if (!content.includes('nankan-analytics')) {
            throw new Error('Service worker content verification failed');
        }
    }

    async testAPIEndpointStructure() {
        // APIエンドポイントの構造をテスト（認証なしでステータスコードのみチェック）
        const endpoints = [
            '/api/create-checkout-session',
            '/api/create-customer-portal',
            '/api/send-newsletter',
            '/api/stripe-webhook'
        ];

        for (const endpoint of endpoints) {
            const response = await fetch(`${BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            // 400または401が返れば、エンドポイントが存在し、正常に処理されている
            if (![400, 401, 405].includes(response.status)) {
                throw new Error(`Endpoint ${endpoint} returned unexpected status: ${response.status}`);
            }
        }
    }

    async testStaticAssets() {
        const assets = [
            '/favicon.svg',
            '/icon-192.svg',
            '/icon-512.svg'
        ];

        for (const asset of assets) {
            const response = await fetch(`${BASE_URL}${asset}`);
            if (!response.ok) {
                throw new Error(`Asset ${asset} returned ${response.status}`);
            }
        }
    }

    async testPageAccess() {
        const pages = [
            '/',
            '/auth/login',
            '/pricing',
            '/account',
            '/dashboard',
            '/premium-predictions',
            '/standard-predictions'
        ];

        for (const page of pages) {
            const response = await fetch(`${BASE_URL}${page}`);
            if (!response.ok) {
                throw new Error(`Page ${page} returned ${response.status}`);
            }
        }
    }

    generateReport() {
        console.log('\n📊 テスト結果レポート:');
        console.log('=' .repeat(50));
        console.log(`✅ 成功: ${this.passed}`);
        console.log(`❌ 失敗: ${this.failed}`);
        console.log(`📊 成功率: ${((this.passed / (this.passed + this.failed)) * 100).toFixed(1)}%`);
        
        if (this.failed > 0) {
            console.log('\n❌ 失敗したテスト:');
            this.results
                .filter(result => result.status === 'FAIL')
                .forEach(result => {
                    console.log(`  - ${result.name}: ${result.error}`);
                });
        }

        console.log('\n🎯 全テスト詳細:');
        this.results.forEach(result => {
            const status = result.status === 'PASS' ? '✅' : '❌';
            const duration = result.duration ? ` (${result.duration}ms)` : '';
            console.log(`  ${status} ${result.name}${duration}`);
        });
        
        console.log('=' .repeat(50));
    }

    async runAllTests() {
        console.log('🚀 NANKANアナリティクス システムテスト開始\n');

        await this.runTest(
            'ウェブサイトアクセステスト',
            () => this.testWebsiteAccess()
        );

        await this.runTest(
            'WebManifestテスト',
            () => this.testWebManifest()
        );

        await this.runTest(
            'Service Workerテスト',
            () => this.testServiceWorker()
        );

        await this.runTest(
            'APIエンドポイント構造テスト',
            () => this.testAPIEndpointStructure()
        );

        await this.runTest(
            '静的アセットテスト',
            () => this.testStaticAssets()
        );

        await this.runTest(
            'ページアクセステスト',
            () => this.testPageAccess()
        );

        this.generateReport();
        
        // 失敗があった場合は非ゼロで終了
        process.exit(this.failed > 0 ? 1 : 0);
    }
}

// メイン実行
async function main() {
    const tester = new SystemTester();
    
    try {
        await tester.runAllTests();
    } catch (error) {
        console.error('\n💥 テスト実行エラー:', error.message);
        process.exit(2);
    }
}

// CLI実行時
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export default SystemTester;