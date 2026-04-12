import sgMail from '@sendgrid/mail';

export async function POST({ request }) {
    try {
        const { name, email, subject, message } = await request.json();

        // 入力値の検証
        if (!name || !email || !subject || !message) {
            return new Response(
                JSON.stringify({ error: '必須項目を入力してください' }),
                { 
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // メールアドレスの形式チェック
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return new Response(
                JSON.stringify({ error: '有効なメールアドレスを入力してください' }),
                { 
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // SendGrid APIキーの確認
        if (!process.env.SMTP_PASS || !process.env.SMTP_PASS.startsWith('SG.')) {
            console.error('SendGrid APIキーが設定されていません');
            return new Response(
                JSON.stringify({ 
                    error: 'メール送信設定が不完全です',
                    debug: 'SendGrid APIキーが必要です'
                }),
                { 
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // SendGrid設定
        sgMail.setApiKey(process.env.SMTP_PASS);

        // 管理者向けメール
        const adminMsg = {
            to: 'support@keiba.link',
            from: {
                email: 'support@keiba.link',
                name: 'NANKANアナリティクス システム'
            },
            subject: `【お問い合わせ】${subject}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
                    <h2 style="color: #333; border-bottom: 2px solid #3b82f6; padding-bottom: 10px;">
                        新しいお問い合わせ
                    </h2>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0; color: #333;">お客様情報</h3>
                        <p><strong>お名前:</strong> ${name}</p>
                        <p><strong>メールアドレス:</strong> ${email}</p>
                        <p><strong>件名:</strong> ${subject}</p>
                    </div>
                    
                    <div style="background: white; padding: 20px; border: 1px solid #dee2e6; border-radius: 8px;">
                        <h3 style="margin-top: 0; color: #333;">お問い合わせ内容</h3>
                        <div style="white-space: pre-wrap; color: #555;">${message}</div>
                    </div>
                    
                    <div style="margin-top: 30px; padding: 15px; background: #e3f2fd; border-radius: 8px; font-size: 14px; color: #666;">
                        このメールはNANKANアナリティクスのお問い合わせフォームから自動送信されました。<br>
                        送信日時: ${new Date().toLocaleString('ja-JP')}
                    </div>
                </div>
            `
        };

        // ユーザー向け自動返信メール
        const userMsg = {
            to: email,
            from: {
                email: 'support@keiba.link',
                name: 'NANKANアナリティクス サポート'
            },
            subject: '【NANKANアナリティクス】お問い合わせありがとうございます',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
                    <h2 style="color: #333; border-bottom: 2px solid #3b82f6; padding-bottom: 10px;">
                        お問い合わせありがとうございます
                    </h2>
                    
                    <p>
                        <strong>${name}</strong> 様
                    </p>
                    
                    <p>
                        この度は、NANKANアナリティクスにお問い合わせいただき、誠にありがとうございます。<br>
                        以下の内容でお問い合わせを承りました。
                    </p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0; color: #333;">お問い合わせ内容</h3>
                        <p><strong>件名:</strong> ${subject}</p>
                        <div style="background: white; padding: 15px; border-radius: 4px; margin-top: 10px;">
                            <div style="white-space: pre-wrap; color: #555;">${message}</div>
                        </div>
                    </div>
                    
                    <div style="background: #fff3cd; padding: 15px; border-radius: 8px; border-left: 4px solid #ffc107;">
                        <p style="margin: 0; color: #856404;">
                            <strong>📞 ご対応について</strong><br>
                            担当者より2営業日以内にご返信いたします。<br>
                            お急ぎの場合は、直接メールでお問い合わせください。
                        </p>
                    </div>
                    
                    <div style="margin-top: 30px; padding: 20px; background: #f1f3f5; border-radius: 8px;">
                        <h3 style="margin-top: 0; color: #333;">お問い合わせ先</h3>
                        <p style="margin: 5px 0;"><strong>NANKANアナリティクス カスタマーサポート</strong></p>
                        <p style="margin: 5px 0;">📧 メール: support@keiba.link</p>
                        <p style="margin: 5px 0;">🕐 営業時間: 平日 10:00 - 18:00</p>
                        <p style="margin: 5px 0; color: #666; font-size: 14px;">土日祝日は休業日です</p>
                    </div>
                    
                    <div style="margin-top: 30px; padding: 10px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #dee2e6;">
                        ※このメールは自動送信されています。このメールに返信いただいても対応できません。<br>
                        ご質問等は上記のサポートメールアドレスまでお願いいたします。
                    </div>
                </div>
            `
        };

        console.log('SendGrid Web API経由でメール送信開始');
        
        // 管理者向けメール送信
        let adminSuccess = false;
        let userSuccess = false;
        let errors = [];

        try {
            console.log('管理者向けメール送信中...');
            const adminResult = await sgMail.send(adminMsg);
            console.log('管理者向けメール送信成功:', {
                statusCode: adminResult[0].statusCode,
                messageId: adminResult[0].headers['x-message-id']
            });
            adminSuccess = true;
        } catch (adminError) {
            console.error('管理者向けメール送信エラー:', adminError);
            errors.push(`管理者向けメール: ${adminError.message}`);
            
            // 管理者向けメールが失敗した場合の詳細ログ
            if (adminError.response && adminError.response.body) {
                console.error('管理者向けメール詳細エラー:', adminError.response.body);
                errors.push(`管理者向け詳細: ${JSON.stringify(adminError.response.body)}`);
            }
        }

        // ユーザー向けメール送信（管理者向けが成功した場合のみ）
        if (adminSuccess) {
            try {
                console.log('ユーザー向けメール送信中...');
                const userResult = await sgMail.send(userMsg);
                console.log('ユーザー向けメール送信成功:', {
                    statusCode: userResult[0].statusCode,
                    messageId: userResult[0].headers['x-message-id']
                });
                userSuccess = true;
            } catch (userError) {
                console.error('ユーザー向けメール送信エラー:', userError);
                errors.push(`ユーザー向けメール: ${userError.message}`);
                
                if (userError.response && userError.response.body) {
                    console.error('ユーザー向けメール詳細エラー:', userError.response.body);
                    errors.push(`ユーザー向け詳細: ${JSON.stringify(userError.response.body)}`);
                }
                // ユーザー向けが失敗しても管理者には届いているので継続
            }
        }

        // 結果の評価
        if (!adminSuccess && !userSuccess) {
            throw new Error('すべてのメール送信に失敗しました: ' + errors.join(', '));
        }

        return new Response(
            JSON.stringify({ 
                success: true, 
                message: 'お問い合わせを受け付けました。ご返信をお待ちください。',
                debug: {
                    adminSuccess,
                    userSuccess,
                    errors: errors.length > 0 ? errors : undefined,
                    timestamp: new Date().toISOString()
                }
            }),
            { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('SendGrid API エラー:', error);
        
        // SendGridのエラー詳細を取得
        let errorMessage = 'メール送信中にエラーが発生しました';
        let errorDetails = error.message;
        
        if (error.response && error.response.body) {
            errorDetails = JSON.stringify(error.response.body);
            console.error('SendGrid エラー詳細:', error.response.body);
        }

        return new Response(
            JSON.stringify({
                error: errorMessage,
                details: errorDetails,
                timestamp: new Date().toISOString()
            }),
            { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

export function GET() {
    return new Response(
        JSON.stringify({ 
            message: 'SendGrid Web API 対応のお問い合わせエンドポイント',
            version: '1.0',
            method: 'POST のみサポート'
        }),
        { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }
    );
}