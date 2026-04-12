// SendGrid統一メール送信システム（軽量版）
import sgMail from '@sendgrid/mail';

// SendGrid初期化
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// メールアドレスバリデーション
function validateEmail(email) {
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    return emailRegex.test(email?.trim() || '');
}

// 統一メール送信関数
export async function sendEmail({ to, subject, html, replyTo, fromName = "NANKANアナリティクス" }) {
    if (!process.env.SENDGRID_API_KEY) {
        return { success: false, error: 'メール送信設定が不完全です' };
    }

    try {
        const mailOptions = {
            to,
            from: { email: 'support@keiba.link', name: fromName },
            subject,
            html,
            trackingSettings: { clickTracking: { enable: false } }
        };

        if (replyTo && validateEmail(replyTo)) {
            mailOptions.replyTo = { email: replyTo };
        }

        await sgMail.send(mailOptions);
        return { success: true };
    } catch (error) {
        console.error('SendGrid送信エラー:', error?.response?.body || error);
        return { success: false, error: 'メール送信に失敗しました' };
    }
}

// お問い合わせメール送信（軽量版）
export async function sendContactEmail({ name, email, subject, message }) {
    if (!validateEmail(email)) {
        return { success: false, error: '有効なメールアドレスを入力してください' };
    }

    try {
        // 管理者向けメール
        const adminResult = await sendEmail({
            to: 'nankan.analytics@gmail.com',
            subject: `【お問い合わせ】${subject}`,
            replyTo: email,
            fromName: 'NANKANアナリティクス システム',
            html: `
                <h2>新しいお問い合わせ</h2>
                <div style="background: #f5f5f5; padding: 20px; border-radius: 8px;">
                    <p><strong>お名前:</strong> ${name || '(未入力)'}</p>
                    <p><strong>メール:</strong> ${email}</p>
                    <p><strong>件名:</strong> ${subject}</p>
                </div>
                <div style="margin-top: 20px;">
                    <h3>お問い合わせ内容:</h3>
                    <pre style="white-space: pre-wrap;">${message}</pre>
                </div>
            `
        });

        // 自動返信メール
        const userResult = await sendEmail({
            to: email,
            subject: '【自動返信】お問い合わせを受け付けました',
            replyTo: 'nankan.analytics@gmail.com',
            fromName: 'NANKANアナリティクス',
            html: `
                <h2>お問い合わせありがとうございます</h2>
                <p>${name || 'お客様'} 様</p>
                <p>お問い合わせを受け付けました。2営業日以内にご返信いたします。</p>
                <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>件名:</strong> ${subject}</p>
                    <pre style="white-space: pre-wrap;">${message}</pre>
                </div>
            `
        });

        return {
            success: adminResult.success && userResult.success,
            adminResult,
            userResult
        };
    } catch (error) {
        console.error('お問い合わせメール送信エラー:', error);
        return {
            success: false,
            error: 'メール送信に失敗しました',
            adminResult: { success: false, error: error.message },
            userResult: { success: false, error: 'Failed to send auto-reply' }
        };
    }
}

// ウェルカムメール送信（軽量版）
export async function sendWelcomeEmail(userEmail) {
    return await sendEmail({
        to: userEmail,
        subject: '🤖 NANKANアナリティクスへようこそ！',
        replyTo: 'nankan.analytics@gmail.com',
        html: `
            <div style="max-width: 600px; margin: 0 auto; font-family: sans-serif;">
                <div style="background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; text-align: center; padding: 40px;">
                    <h1>🤖 NANKANアナリティクス</h1>
                    <p>AI技術で競馬予想を科学する</p>
                </div>
                <div style="padding: 30px;">
                    <h2>ようこそ、${userEmail}さん！</h2>
                    <p>NANKANアナリティクスにご登録いただき、ありがとうございます。</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="https://nankan-analytics.keiba.link/dashboard" 
                           style="display: inline-block; background: #3b82f6; color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px;">
                            🏇 ダッシュボードを見る
                        </a>
                    </div>
                </div>
            </div>
        `
    });
}