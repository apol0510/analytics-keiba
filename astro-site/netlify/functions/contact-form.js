// お問い合わせフォーム処理 - SendGrid統合版

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
        const { name, email, subject, message } = JSON.parse(event.body);

        // バリデーション
        if (!name || !email || !subject || !message) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: '必須項目が不足しています' })
            };
        }

        // メールアドレスの簡易検証
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: '有効なメールアドレスを入力してください' })
            };
        }

        const timestamp = new Date().toLocaleString('ja-JP');

        // 管理者向けメール
        const adminEmailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #3b82f6;">📩 新規お問い合わせ</h2>

                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>受信日時:</strong> ${timestamp}</p>
                    <p><strong>お名前:</strong> ${name}</p>
                    <p><strong>メールアドレス:</strong> ${email}</p>
                    <p><strong>件名:</strong> ${subject}</p>
                </div>

                <div style="background: #fff; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; margin: 20px 0;">
                    <h3>メッセージ内容:</h3>
                    <p style="white-space: pre-wrap;">${message}</p>
                </div>

                <hr style="margin: 30px 0;">
                <p style="font-size: 12px; color: #666;">
                    NANKANアナリティクス - お問い合わせ管理システム
                </p>
            </div>
        `;

        await sendEmailViaSendGrid({
            to: 'nankan.analytics@gmail.com',
            subject: `【お問い合わせ】${subject}`,
            html: adminEmailHtml,
            replyTo: email,
            fromName: 'NANKANアナリティクス お問い合わせ'
        });

        // 自動返信メール
        const autoReplyHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #3b82f6;">🏇 NANKANアナリティクス</h2>

                <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3>お問い合わせを受け付けました</h3>
                    <p>${name} 様</p>
                    <p>この度はNANKANアナリティクスへお問い合わせいただき、誠にありがとうございます。</p>
                    <p>以下の内容でお問い合わせを承りました。</p>
                </div>

                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>受付日時:</strong> ${timestamp}</p>
                    <p><strong>件名:</strong> ${subject}</p>
                    <p><strong>お問い合わせ内容:</strong></p>
                    <p style="white-space: pre-wrap; background: #fff; padding: 15px; border-radius: 4px;">${message}</p>
                </div>

                <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p>担当者より2営業日以内にご返信させていただきます。</p>
                    <p>しばらくお待ちくださいませ。</p>
                </div>

                <hr style="margin: 30px 0;">
                <p style="font-size: 12px; color: #666;">
                    NANKANアナリティクス<br>
                    AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム<br>
                    ※このメールは自動送信されています
                </p>
                <p style="font-size:0.9rem;color:#64748b;margin-top:20px;">
                    このメールはお問い合わせフォームにご入力いただいた内容の控えとして自動送信されています。<br>
                    心当たりがない場合は、このメールを破棄してください。
                </p>
            </div>
        `;

        await sendEmailViaSendGrid({
            to: email,
            subject: '【自動返信】お問い合わせを受け付けました - NANKANアナリティクス',
            html: autoReplyHtml,
            replyTo: 'nankan.analytics@gmail.com',  // 🔧 2025-11-26追加: サポート窓口への返信設定
            fromName: 'NANKANアナリティクス サポート'
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'お問い合わせを送信しました'
            })
        };

    } catch (error) {
        console.error('お問い合わせ送信エラー:', error);

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'お問い合わせの送信に失敗しました',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            })
        };
    }
};

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
        ]
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