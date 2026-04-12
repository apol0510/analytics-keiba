#!/usr/bin/env node
/**
 * NANKANアナリティクス 自動バックアップスクリプト
 * 定期実行でデータベースのバックアップを取る
 */

import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import path from 'path';

const config = {
    siteUrl: process.env.PUBLIC_SITE_URL || 'https://nankan-analytics.keiba.link',
    adminApiKey: process.env.ADMIN_API_KEY,
    backupDir: process.env.BACKUP_DIR || './backups',
};

class AutoBackup {
    constructor() {
        this.timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.backupTypes = ['users', 'predictions', 'full'];
    }

    async initialize() {
        // バックアップディレクトリの作成
        try {
            await fs.mkdir(config.backupDir, { recursive: true });
            console.log(`📁 バックアップディレクトリ準備完了: ${config.backupDir}`);
        } catch (error) {
            throw new Error(`バックアップディレクトリ作成失敗: ${error.message}`);
        }
    }

    async createBackup(type = 'full') {
        if (!this.backupTypes.includes(type)) {
            throw new Error(`無効なバックアップタイプ: ${type}`);
        }

        console.log(`🔄 ${type}バックアップ開始...`);

        const response = await fetch(`${config.siteUrl}/api/admin/backup`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.adminApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ type })
        });

        if (!response.ok) {
            throw new Error(`バックアップAPI呼び出し失敗: ${response.status} ${response.statusText}`);
        }

        const backupData = await response.json();
        
        // ファイル保存
        const filename = `nankan_backup_${type}_${this.timestamp}.json`;
        const filepath = path.join(config.backupDir, filename);
        
        await fs.writeFile(filepath, JSON.stringify(backupData, null, 2));
        
        console.log(`✅ ${type}バックアップ完了: ${filename}`);
        console.log(`📊 データサイズ: ${(backupData.size / 1024).toFixed(2)} KB`);
        
        return {
            type,
            filename,
            filepath,
            size: backupData.size,
            timestamp: backupData.timestamp
        };
    }

    async runDailyBackup() {
        const results = [];
        
        try {
            await this.initialize();
            
            // 毎日: フルバックアップ
            const fullBackup = await this.createBackup('full');
            results.push(fullBackup);
            
            // 古いバックアップの清理（7日以上前）
            await this.cleanupOldBackups(7);
            
            console.log('🎉 日次バックアップ完了');
            return results;
            
        } catch (error) {
            console.error('💥 バックアップエラー:', error.message);
            throw error;
        }
    }

    async runWeeklyBackup() {
        const results = [];
        
        try {
            await this.initialize();
            
            // 週次: フルバックアップ + 個別バックアップ
            for (const type of ['full', 'users', 'predictions']) {
                const backup = await this.createBackup(type);
                results.push(backup);
            }
            
            // 古いバックアップの清理（30日以上前）
            await this.cleanupOldBackups(30);
            
            console.log('🎉 週次バックアップ完了');
            return results;
            
        } catch (error) {
            console.error('💥 週次バックアップエラー:', error.message);
            throw error;
        }
    }

    async cleanupOldBackups(daysToKeep) {
        try {
            const files = await fs.readdir(config.backupDir);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
            
            let deletedCount = 0;
            
            for (const file of files) {
                if (!file.startsWith('nankan_backup_')) continue;
                
                const filePath = path.join(config.backupDir, file);
                const stats = await fs.stat(filePath);
                
                if (stats.mtime < cutoffDate) {
                    await fs.unlink(filePath);
                    deletedCount++;
                    console.log(`🗑️  古いバックアップを削除: ${file}`);
                }
            }
            
            console.log(`📋 ${deletedCount}個の古いバックアップを削除しました`);
            
        } catch (error) {
            console.warn('⚠️  バックアップ清理中にエラー:', error.message);
        }
    }

    async getBackupHistory() {
        try {
            const response = await fetch(`${config.siteUrl}/api/admin/backup`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.adminApiKey}`,
                }
            });

            if (!response.ok) {
                throw new Error(`バックアップ履歴取得失敗: ${response.status}`);
            }

            const history = await response.json();
            console.log('📚 バックアップ履歴:');
            
            history.backups?.slice(0, 10).forEach(backup => {
                const date = new Date(backup.created_at).toLocaleString('ja-JP');
                const status = backup.status === 'completed' ? '✅' : '❌';
                console.log(`${status} ${backup.backup_type} - ${date} (${(backup.backup_size / 1024).toFixed(2)} KB)`);
            });

            return history;
            
        } catch (error) {
            console.error('💥 バックアップ履歴取得エラー:', error.message);
            return null;
        }
    }

    async sendNotification(results, type = 'success') {
        // 実際の運用では、メール通知やSlack通知を送信
        if (type === 'success') {
            console.log(`📧 バックアップ成功通知を送信 (${results.length}件)`);
        } else {
            console.log(`🚨 バックアップ失敗通知を送信`);
        }
    }
}

// CLI実行
async function main() {
    const backup = new AutoBackup();
    const args = process.argv.slice(2);
    const command = args[0] || 'daily';
    
    try {
        let results = [];
        
        switch (command) {
            case 'daily':
                results = await backup.runDailyBackup();
                break;
                
            case 'weekly':
                results = await backup.runWeeklyBackup();
                break;
                
            case 'history':
                await backup.getBackupHistory();
                return;
                
            case 'cleanup':
                const days = parseInt(args[1]) || 7;
                await backup.cleanupOldBackups(days);
                return;
                
            default:
                console.log('使用法: node auto-backup.js [daily|weekly|history|cleanup]');
                process.exit(1);
        }
        
        await backup.sendNotification(results, 'success');
        console.log('🎯 バックアップタスク完了');
        
    } catch (error) {
        console.error('💥 バックアップ実行エラー:', error);
        await backup.sendNotification([], 'error');
        process.exit(1);
    }
}

// CLI実行時
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export default AutoBackup;
