import { sendContactEmail } from '../../lib/sendgrid-utils.js';

export async function POST({ request }) {
    try {
        const { name, email, subject, message } = await request.json();

        // 入力バリデーション（最低限）
        if (!email || !subject || !message) {
            return new Response(
                JSON.stringify({ ok: false, error: 'Missing required fields' }),
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
                JSON.stringify({ ok: false, error: '有効なメールアドレスを入力してください' }),
                { 
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        console.log('お問い合わせメール送信開始:', { name, email, subject });

        // 共通ユーティリティでメール送信（Reply-To統一ポリシー適用）
        const result = await sendContactEmail({ name, email, subject, message });

        if (!result.success) {
            return new Response(
                JSON.stringify({ 
                    ok: false, 
                    error: result.adminResult?.error || result.userResult?.error || 'メール送信に失敗しました' 
                }),
                { 
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        return new Response(
            JSON.stringify({ ok: true, message: 'お問い合わせを送信しました' }),
            { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (err) {
        console.error('SendGrid error', err?.response?.body || err);
        return new Response(
            JSON.stringify({ 
                ok: false, 
                error: 'Internal Server Error',
                details: process.env.NODE_ENV === 'development' ? err.message : undefined
            }),
            { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// その他のHTTPメソッドは許可しない
export function GET() {
    return new Response(
        JSON.stringify({ ok: false, error: 'Method not allowed' }),
        { 
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        }
    );
}