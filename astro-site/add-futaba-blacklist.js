#!/usr/bin/env node

import { config } from 'dotenv';
config();

async function addFutabaToBlacklist() {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    const invalidEmail = 'futabachanymail.ne.jp';

    console.log(`📝 ${invalidEmail} をEmailBlacklistに追加`);

    const recordData = {
        fields: {
            Email: invalidEmail,
            BounceCount: 1,
            BounceType: 'hard',
            Status: 'HARD_BOUNCE',
            AddedAt: new Date().toISOString().split('T')[0],
            Notes: '@記号なしの無効なメールアドレス形式'
        }
    };

    try {
        const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(recordData)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ EmailBlacklistへの追加成功!');
            console.log('📋 レコードID:', result.id);
            console.log('📧 ブロック対象:', result.fields.Email);
            console.log('🚫 ステータス:', result.fields.Status);
            console.log('\n今後、このアドレスへの送信は自動的にブロックされます。');
        } else {
            const error = await response.text();
            console.error('❌ 追加失敗:', error);
        }

    } catch (error) {
        console.error('❌ エラー:', error.message);
    }
}

addFutabaToBlacklist();