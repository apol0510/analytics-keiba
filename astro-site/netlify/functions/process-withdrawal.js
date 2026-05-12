// 退会申請処理 - Airtable連携 + SendGrid通知
// 2025-10-10新規実装
// 2025-10-10 v1.3: メール文言最終版（銀行振込記述削除）

export const handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { email, reason } = JSON.parse(event.body);

        // バリデーション
        if (!email) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'メールアドレスが必要です' })
            };
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: '有効なメールアドレスを入力してください' })
            };
        }

        const timestamp = new Date().toLocaleString('ja-JP');
        const withdrawalReason = reason || '理由未記入';

        // 1. Airtableから顧客情報を取得
        const customerRecord = await findCustomerByEmail(email);

        if (!customerRecord) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: '該当する会員情報が見つかりませんでした' })
            };
        }

        // 2. Airtableで退会フラグを設定 + 有効期限設定
        // 既存の有効期限を取得（日本語フィールド「有効期限」優先、互換性のためValidUntil/ExpiryDateも確認）
        const existingValidUntil = customerRecord.fields['有効期限'] || customerRecord.fields.ValidUntil || customerRecord.fields.ExpiryDate;

        // 有効期限が未設定の場合、登録日から30日後を計算（正しい有効期限）
        let validUntil = existingValidUntil;
        if (!validUntil) {
            const createdAt = customerRecord.fields.CreatedAt;
            if (createdAt) {
                // 登録日から30日後を計算
                const registrationDate = new Date(createdAt);
                registrationDate.setDate(registrationDate.getDate() + 30);
                validUntil = registrationDate.toISOString().split('T')[0];
                console.log(`📅 有効期限を登録日から計算: ${createdAt} → ${validUntil}`);
            } else {
                // CreatedAtが無い場合のフォールバック（本来あり得ない）
                const thirtyDaysLater = new Date();
                thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);
                validUntil = thirtyDaysLater.toISOString().split('T')[0];
                console.log(`⚠️ 登録日不明のため退会日から30日後を設定: ${validUntil}`);
            }
        } else {
            console.log(`📅 既存の有効期限を維持: ${validUntil}`);
        }

        await updateCustomerWithdrawalStatus(customerRecord.id, {
            withdrawalRequested: true,
            withdrawalDate: new Date().toISOString().split('T')[0],
            withdrawalReason: withdrawalReason,
            validUntil: validUntil
        });

        // 3. 管理者向け退会通知メール
        const adminEmailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #ef4444;">🚨 退会申請通知</h2>

                <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
                    <p><strong>受信日時:</strong> ${timestamp}</p>
                    <p><strong>メールアドレス:</strong> ${email}</p>
                    <p><strong>現在のプラン:</strong> ${customerRecord.fields['プラン'] || customerRecord.fields.Plan || '不明'}</p>
                    <p><strong>登録日:</strong> ${customerRecord.fields.CreatedAt || '不明'}</p>
                </div>

                <div style="background: #fff; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; margin: 20px 0;">
                    <h3>退会理由:</h3>
                    <p style="white-space: pre-wrap; background: #f9fafb; padding: 15px; border-radius: 4px;">${withdrawalReason}</p>
                </div>

                <div style="background: #fffbeb; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>⚠️ 対応が必要です:</strong></p>
                    <ul>
                        <li>Airtableで退会処理を完了させてください</li>
                        <li>Stripe定期支払いの停止確認</li>
                        <li>必要に応じて顧客へフォローアップ</li>
                    </ul>
                </div>

                <hr style="margin: 30px 0;">
                <p style="font-size: 12px; color: #666;">
                    NANKANアナリティクス - 退会管理システム
                </p>
            </div>
        `;

        await sendEmailViaSendGrid({
            to: 'nankan.analytics@gmail.com',
            subject: `【退会申請】${email} - ${customerRecord.fields['プラン'] || customerRecord.fields.Plan || '会員'}`,
            html: adminEmailHtml,
            replyTo: email,  // 🔧 既に設定済み（管理者向けメール）
            fromName: 'NANKANアナリティクス 退会管理'
        });

        // 4. 会員向け退会受付確認メール
        const userEmailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #3b82f6;">🏇 NANKANアナリティクス</h2>

                <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3>退会申請を受け付けました</h3>
                    <p>この度は退会のご申請をいただき、ありがとうございます。</p>
                    <p>以下の内容で退会申請を承りました。</p>
                </div>

                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>受付日時:</strong> ${timestamp}</p>
                    <p><strong>メールアドレス:</strong> ${email}</p>
                    <p><strong>現在のプラン:</strong> ${customerRecord.fields['プラン'] || customerRecord.fields.Plan || '不明'}</p>
                    <p><strong>退会理由:</strong></p>
                    <p style="white-space: pre-wrap; background: #fff; padding: 15px; border-radius: 4px;">${withdrawalReason}</p>
                </div>

                <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>⚠️ 今後の流れ:</strong></p>
                    <ul>
                        <li>Stripe定期支払いの停止処理を行います</li>
                        <li>現在のご契約期間終了までプレミアムコンテンツをご利用いただけます</li>
                        <li>※契約期間終了後は自動的にFreeプランに切り替わります</li>
                    </ul>
                </div>

                <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p>今後ともNANKANアナリティクスをご利用いただける日を心よりお待ちしております。</p>
                    <p>ご不明な点がございましたら、お気軽にお問い合わせください。</p>

                    <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
                    <p style="font-size: 14px; color: #6b7280;">
                        <strong>📧 メルマガについて：</strong><br>
                        メルマガは引き続き配信されます。<br>
                        配信停止をご希望の場合は、
                        <a href="https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${email}"
                           style="color: #dc2626; text-decoration: underline;">
                            こちらから配信停止手続き
                        </a>
                        を行ってください。
                    </p>
                </div>

                <hr style="margin: 30px 0;">
                <p style="font-size: 12px; color: #666;">
                    NANKANアナリティクス<br>
                    AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム<br>
                    ※このメールは自動送信されています
                </p>
                <p style="font-size:0.9rem;color:#64748b;margin-top:20px;">
                    このメールは退会申請フォームにご入力いただいた内容の控えとして自動送信されています。<br>
                    心当たりがない場合は、このメールを破棄してください。
                </p>
            </div>
        `;

        await sendEmailViaSendGrid({
            to: email,
            subject: '【退会申請受付】NANKANアナリティクス',
            html: userEmailHtml,
            replyTo: 'nankan.analytics@gmail.com',  // 🔧 2025-11-26追加: サポート窓口への返信設定
            fromName: 'NANKANアナリティクス サポート'
        });

        console.log(`✅ 退会申請処理完了: ${email}`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: '退会申請を受け付けました。確認メールをお送りしましたのでご確認ください。'
            })
        };

    } catch (error) {
        console.error('退会申請処理エラー:', error);

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: '退会申請の処理に失敗しました',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            })
        };
    }
};

// Airtableから顧客を検索
async function findCustomerByEmail(email) {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !BASE_ID) {
        throw new Error('Airtable credentials not configured');
    }

    const url = `https://api.airtable.com/v0/${BASE_ID}/Customers?filterByFormula={Email}='${email}'`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`
        }
    });

    if (!response.ok) {
        throw new Error(`Airtable API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.records && data.records.length > 0) {
        return data.records[0];
    }

    return null;
}

// Airtableで退会ステータスを更新
async function updateCustomerWithdrawalStatus(recordId, updateData) {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !BASE_ID) {
        throw new Error('Airtable credentials not configured');
    }

    const url = `https://api.airtable.com/v0/${BASE_ID}/Customers/${recordId}`;

    const response = await fetch(url, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fields: {
                WithdrawalRequested: updateData.withdrawalRequested,
                WithdrawalDate: updateData.withdrawalDate,
                WithdrawalReason: updateData.withdrawalReason,
                '有効期限': updateData.validUntil
            }
        })
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Airtable update error: ${response.status} ${errorData}`);
    }

    return await response.json();
}

// SendGridでメール送信
async function sendEmailViaSendGrid({ to, subject, html, replyTo, fromName }) {
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

    if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key not configured');
    }

    const emailData = {
        personalizations: [
            {
                to: [{ email: to }],
                subject: subject
            }
        ],
        from: {
            name: fromName || "NANKANアナリティクス サポート",
            email: "support@keiba.link"  // 🔧 2025-11-26変更: 迷惑メール対策でsupportに変更
        },
        content: [
            {
                type: "text/html",
                value: html
            }
        ],
        // SendGrid追跡機能完全無効化（復活防止対策）
        tracking_settings: {
            click_tracking: {
                enable: false,
                enable_text: false
            },
            open_tracking: {
                enable: false,
                substitution_tag: null
            },
            subscription_tracking: {
                enable: false
            },
            ganalytics: {
                enable: false
            }
        },
        mail_settings: {
            bypass_list_management: {
                enable: false
            },
            footer: {
                enable: false
            },
            sandbox_mode: {
                enable: false
            }
        }
    };

    // Reply-Toが指定されている場合は設定
    if (replyTo) {
        emailData.reply_to = {
            email: replyTo
        };
    }

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SENDGRID_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`SendGrid API error: ${response.status} ${errorData}`);
    }

    return true;
}
