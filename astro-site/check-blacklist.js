#!/usr/bin/env node

import { config } from 'dotenv';
config();

async function checkBlacklist() {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    console.log('📊 EmailBlacklist現在の内容:');

    try {
        const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`\n合計レコード数: ${data.records.length}`);

            data.records.forEach((record, index) => {
                console.log(`\n${index + 1}. ${record.fields.Email}`);
                console.log(`   Status: ${record.fields.Status}`);
                console.log(`   BounceType: ${record.fields.BounceType || 'N/A'}`);
                console.log(`   AddedAt: ${record.fields.AddedAt}`);
            });

            // futabachanymail.ne.jpを検索
            console.log('\n🔍 futabachanymail.ne.jpの検索:');
            const futaba = data.records.find(r => r.fields.Email === 'futabachanymail.ne.jp');
            if (futaba) {
                console.log('✅ 見つかりました:', futaba.fields);
            } else {
                console.log('❌ EmailBlacklistに存在しません');
                console.log('\n⚠️ 理由: SendGridは@なしのアドレスを即座にエラーにしない可能性があります');
            }

        } else {
            console.error('❌ 取得失敗:', response.status);
        }
    } catch (error) {
        console.error('❌ エラー:', error.message);
    }
}

checkBlacklist();