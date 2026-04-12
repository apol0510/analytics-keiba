#!/usr/bin/env node
/**
 * NANKANアナリティクス システムヘルスチェックスクリプト
 * 定期実行でシステム監視を行う
 */

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const config = {
    siteUrl: process.env.PUBLIC_SITE_URL || 'https://nankan-analytics.keiba.link',
    supabaseUrl: process.env.PUBLIC_SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    adminApiKey: process.env.ADMIN_API_KEY,
};

class HealthMonitor {
    constructor() {
        this.results = {
            timestamp: new Date().toISOString(),
            checks: {},
            overall: 'unknown'
        };
    }

    async runAllChecks() {
        console.log('🔍 システムヘルスチェック開始...');
        
        const checks = [
            { name: 'website', fn: this.checkWebsite },
            { name: 'database', fn: this.checkDatabase },
            { name: 'api', fn: this.checkAdminAPI },
            { name: 'email', fn: this.checkEmailService },
        ];

        for (const check of checks) {
            try {
                const result = await check.fn.call(this);
                this.results.checks[check.name] = {
                    status: 'ok',
                    ...result
                };
                console.log(`✅ ${check.name}: OK`);
            } catch (error) {
                this.results.checks[check.name] = {
                    status: 'error',
                    error: error.message,
                    timestamp: new Date().toISOString()
                };
                console.error(`❌ ${check.name}: ${error.message}`);
            }
        }

        this.calculateOverallHealth();
        return this.results;
    }

    async checkWebsite() {
        const response = await fetch(config.siteUrl, { 
            timeout: 10000,
            headers: { 'User-Agent': 'NANKAN-Health-Monitor/1.0' }
        });
        
        if (!response.ok) {
            throw new Error(`Website returned ${response.status}`);
        }

        const responseTime = response.headers.get('x-response-time') || 'unknown';
        return { responseTime, statusCode: response.status };
    }

    async checkDatabase() {
        if (!config.supabaseUrl || !config.supabaseKey) {
            throw new Error('Supabase configuration missing');
        }

        const supabase = createClient(config.supabaseUrl, config.supabaseKey);
        
        const start = Date.now();
        const { data, error } = await supabase
            .from('profiles')
            .select('count', { count: 'exact', head: true });

        if (error) {
            throw new Error(`Database error: ${error.message}`);
        }

        const responseTime = Date.now() - start;
        return { responseTime: `${responseTime}ms`, recordCount: data?.length || 0 };
    }

    async checkAdminAPI() {
        if (!config.adminApiKey) {
            throw new Error('Admin API key not configured');
        }

        const response = await fetch(`${config.siteUrl}/api/admin/system-status`, {
            headers: {
                'Authorization': `Bearer ${config.adminApiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (!response.ok) {
            throw new Error(`Admin API returned ${response.status}`);
        }

        const data = await response.json();
        return { apiStatus: 'accessible', systemChecks: data };
    }

    async checkEmailService() {
        if (!process.env.RESEND_API_KEY) {
            return { status: 'not_configured', warning: 'Email service not configured' };
        }

        const response = await fetch('https://api.resend.com/domains', {
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            },
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`Email service API returned ${response.status}`);
        }

        return { status: 'accessible', provider: 'Resend' };
    }

    calculateOverallHealth() {
        const checks = Object.values(this.results.checks);
        const errorCount = checks.filter(check => check.status === 'error').length;
        const warningCount = checks.filter(check => check.warning).length;

        if (errorCount > 0) {
            this.results.overall = 'critical';
        } else if (warningCount > 0) {
            this.results.overall = 'warning';
        } else {
            this.results.overall = 'healthy';
        }
    }

    async sendAlert(results) {
        if (results.overall === 'critical') {
            console.log('🚨 CRITICAL: システムに重大な問題があります');
            // 実際の運用では、メール通知やSlack通知を送信
        } else if (results.overall === 'warning') {
            console.log('⚠️  WARNING: システムに軽微な問題があります');
        } else {
            console.log('✅ HEALTHY: すべてのシステムが正常に動作しています');
        }
    }

    generateReport() {
        console.log('\n📊 ヘルスチェック結果:');
        console.log('=' .repeat(50));
        console.log(`時刻: ${this.results.timestamp}`);
        console.log(`総合状態: ${this.results.overall.toUpperCase()}`);
        console.log('\n個別チェック結果:');
        
        Object.entries(this.results.checks).forEach(([name, result]) => {
            const status = result.status === 'ok' ? '✅' : '❌';
            console.log(`${status} ${name.padEnd(15)}: ${result.status}`);
            
            if (result.error) {
                console.log(`    エラー: ${result.error}`);
            }
            
            if (result.responseTime) {
                console.log(`    応答時間: ${result.responseTime}`);
            }
        });
        
        console.log('=' .repeat(50));
    }
}

// メイン実行
async function main() {
    const monitor = new HealthMonitor();
    
    try {
        const results = await monitor.runAllChecks();
        await monitor.sendAlert(results);
        monitor.generateReport();
        
        // 結果をJSONファイルに保存
        const fs = await import('fs/promises');
        await fs.writeFile(
            'health-check-results.json', 
            JSON.stringify(results, null, 2)
        );
        
        // 正常終了
        process.exit(results.overall === 'critical' ? 1 : 0);
        
    } catch (error) {
        console.error('💥 ヘルスチェック実行エラー:', error);
        process.exit(2);
    }
}

// CLI実行時
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export default HealthMonitor;
