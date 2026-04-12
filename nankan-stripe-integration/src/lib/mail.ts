// SendGrid email utilities (unified and simplified)
import sgMail from '@sendgrid/mail';

// Initialize SendGrid
const apiKey = import.meta.env.SENDGRID_API_KEY;
if (apiKey) {
    sgMail.setApiKey(apiKey);
}

export interface EmailOptions {
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    fromName?: string;
}

export interface EmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

// Unified email sending function
export async function sendEmail({
    to,
    subject,
    html,
    text,
    replyTo = 'support@nankan-analytics.keiba.link',
    fromName = 'NANKANアナリティクス'
}: EmailOptions): Promise<EmailResult> {
    if (!apiKey) {
        console.error('SendGrid API key not configured');
        return { success: false, error: 'メール送信設定が不完全です' };
    }

    const fromEmail = 'noreply@nankan-analytics.keiba.link';
    
    const msg = {
        to,
        from: {
            email: fromEmail,
            name: fromName
        },
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML for text version
        replyTo
    };

    try {
        const [response] = await sgMail.send(msg);
        console.log(`Email sent successfully to ${to}: ${response.statusCode}`);
        
        return {
            success: true,
            messageId: response.headers['x-message-id']
        };
    } catch (error: any) {
        console.error('SendGrid error:', error);
        return {
            success: false,
            error: error.message || 'メール送信に失敗しました'
        };
    }
}

// Welcome email template
export async function sendWelcomeEmail(to: string, planName: string = 'standard'): Promise<EmailResult> {
    const subject = '🎉 NANKANアナリティクスへようこそ！ご登録ありがとうございます';
    
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #3b82f6;">🏇 NANKANアナリティクスへようこそ！</h1>
        
        <p>この度は<strong>${planName === 'standard' ? 'スタンダード' : 'プレミアム'}プラン</strong>にご登録いただき、誠にありがとうございます。</p>
        
        <h2 style="color: #1f2937;">🚀 ご利用開始の準備が整いました</h2>
        
        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>✨ ${planName === 'standard' ? 'スタンダード' : 'プレミアム'}プランの特典</h3>
            <ul>
                ${planName === 'standard' ? `
                    <li>後半3レース（10R、11R、12R）の予想</li>
                    <li>AI予想の詳細分析</li>
                    <li>投資戦略の提案</li>
                ` : `
                    <li>全レース（1R〜12R）の予想</li>
                    <li>高精度AI予想</li>
                    <li>詳細な投資戦略</li>
                    <li>優先サポート</li>
                `}
                <li>メール通知</li>
            </ul>
        </div>
        
        <p style="margin: 30px 0;">
            <a href="${import.meta.env.SITE_URL}/dashboard" 
               style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                🎯 ダッシュボードを見る
            </a>
        </p>
        
        <h3>📋 サブスクリプション管理について</h3>
        <p>プランの変更や請求情報の更新は、<a href="${import.meta.env.SITE_URL}/billing">課金ポータル</a>からいつでも行えます。</p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
        
        <p style="color: #6b7280; font-size: 14px;">
            ご質問やサポートが必要な場合は、このメールに返信してください。<br>
            今後ともNANKANアナリティクスをよろしくお願いいたします。
        </p>
        
        <p style="color: #6b7280; font-size: 14px;">
            NANKANアナリティクス運営チーム<br>
            <a href="${import.meta.env.SITE_URL}">${import.meta.env.SITE_URL}</a>
        </p>
    </div>
    `;

    return await sendEmail({
        to,
        subject,
        html,
        replyTo: 'support@nankan-analytics.keiba.link'
    });
}

// Payment failed email
export async function sendPaymentFailedEmail(to: string): Promise<EmailResult> {
    const subject = '⚠️ お支払いに関するお知らせ - NANKANアナリティクス';
    
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #ef4444;">⚠️ お支払いの問題が発生しています</h1>
        
        <p>いつもNANKANアナリティクスをご利用いただき、ありがとうございます。</p>
        
        <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #dc2626; margin-top: 0;">お支払いが完了できませんでした</h3>
            <p>最新の請求に対するお支払いが確認できませんでした。以下の原因が考えられます：</p>
            <ul>
                <li>クレジットカードの有効期限切れ</li>
                <li>残高不足</li>
                <li>カード会社による承認拒否</li>
            </ul>
        </div>
        
        <h3>🛠️ 解決方法</h3>
        <p>以下のリンクから課金ポータルにアクセスして、お支払い情報を更新してください：</p>
        
        <p style="margin: 30px 0;">
            <a href="${import.meta.env.SITE_URL}/billing" 
               style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                💳 お支払い情報を更新する
            </a>
        </p>
        
        <p style="color: #6b7280;">
            お支払いが完了するまで、一部の機能がご利用いただけない場合があります。<br>
            ご不便をおかけして申し訳ございません。
        </p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
        
        <p style="color: #6b7280; font-size: 14px;">
            ご質問やサポートが必要な場合は、このメールに返信してください。<br>
            NANKANアナリティクス運営チーム
        </p>
    </div>
    `;

    return await sendEmail({
        to,
        subject,
        html
    });
}

// Subscription cancelled email
export async function sendSubscriptionCancelledEmail(to: string): Promise<EmailResult> {
    const subject = '😢 サブスクリプションがキャンセルされました - NANKANアナリティクス';
    
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #6b7280;">😢 サブスクリプションがキャンセルされました</h1>
        
        <p>NANKANアナリティクスをご利用いただき、ありがとうございました。</p>
        
        <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>サブスクリプションが正常にキャンセルされました。</strong></p>
            <p>現在の課金期間終了後、自動的に無料プランに移行します。</p>
        </div>
        
        <h3>📱 無料プランでできること</h3>
        <ul>
            <li>メインレース（11R）の予想</li>
            <li>基本的な競馬情報</li>
            <li>予想結果の確認</li>
        </ul>
        
        <p>いつでも再度ご登録いただくことができます。</p>
        
        <p style="margin: 30px 0;">
            <a href="${import.meta.env.SITE_URL}/pricing" 
               style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                🚀 プランを見る
            </a>
        </p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
        
        <p style="color: #6b7280; font-size: 14px;">
            ご質問がございましたら、このメールに返信してください。<br>
            また機会がございましたら、ぜひご利用ください。
        </p>
    </div>
    `;

    return await sendEmail({
        to,
        subject,
        html
    });
}