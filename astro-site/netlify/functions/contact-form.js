// お問い合わせフォーム処理 - SendGrid統合版
// 2026-08-31: 管理者宛先・返信先・送信元を単一源 config/email-config.js へ統一
//   （旧サイト名残の Gmail アドレスのハードコードを撤去）

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'contact-form' });
import { SUPPORT_EMAIL, ADMIN_EMAIL } from './config/email-config.js';
import { formatJst } from '../../src/lib/datetime/jstTimestamp.js';
import { normalizeContactInput, escapeHtml } from '../../src/lib/contact/contactForm.js';

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
        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch {
            return { statusCode: 400, headers, body: JSON.stringify({ error: '送信内容を読み取れませんでした' }) };
        }

        // 検査・整形は単一源 src/lib/contact/contactForm.js（お名前は任意・種類は閉じた語彙）
        const parsed = normalizeContactInput(body);
        if (!parsed.ok) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: parsed.error }) };
        }
        if (parsed.spam) {
            // 機械投稿（人に見えない欄が埋まっている）。成功に見せて何も送らない。
            console.log('[contact-form] honeypot');
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'お問い合わせを送信しました' }) };
        }
        const v = parsed.value;
        // HTML へ入れる値はすべて無害化する（自動返信は入力されたアドレスへ届くため）
        const h = {
            name: escapeHtml(v.name),
            email: escapeHtml(v.email),
            topic: escapeHtml(v.topicLabel),
            message: escapeHtml(v.message),
        };

        const timestamp = formatJst();

        // 管理者向けメール
        const adminEmailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #3b82f6;">📩 新規お問い合わせ</h2>

                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>受信日時:</strong> ${timestamp}</p>
                    <p><strong>お名前:</strong> ${h.name}</p>
                    <p><strong>メールアドレス:</strong> ${h.email}</p>
                    <p><strong>種類:</strong> ${h.topic}</p>
                </div>

                <div style="background: #fff; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; margin: 20px 0;">
                    <h3>メッセージ内容:</h3>
                    <p style="white-space: pre-wrap;">${escapeHtml(v.message)}</p>
                </div>

                <hr style="margin: 30px 0;">
                <p style="font-size: 12px; color: #666;">
                    KEIBA Analytics - お問い合わせ管理システム
                </p>
            </div>
        `;

        await sendEmailViaSendGrid({
            to: ADMIN_EMAIL,
            subject: `【お問い合わせ】${v.topicLabel}`,
            html: adminEmailHtml,
            replyTo: v.email,
            fromName: 'KEIBA Analytics お問い合わせ'
        });

        // 自動返信メール
        const autoReplyHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #3b82f6;">🏇 KEIBA Analytics</h2>

                <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3>お問い合わせを受け付けました</h3>
                    <p>${h.name} 様</p>
                    <p>この度はKEIBA Analyticsへお問い合わせいただき、誠にありがとうございます。</p>
                    <p>以下の内容でお問い合わせを承りました。</p>
                </div>

                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>受付日時:</strong> ${timestamp}</p>
                    <p><strong>種類:</strong> ${h.topic}</p>
                    <p><strong>お問い合わせ内容:</strong></p>
                    <p style="white-space: pre-wrap; background: #fff; padding: 15px; border-radius: 4px;">${h.message}</p>
                </div>

                <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p>通常 2 営業日以内に、support@keiba.link からご返信します。</p>
                    <p>届かない場合は迷惑メールフォルダもご確認ください。</p>
                </div>

                <hr style="margin: 30px 0;">
                <p style="font-size: 12px; color: #666;">
                    KEIBA Analytics<br>
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
            to: v.email,
            subject: '【自動返信】お問い合わせを受け付けました - KEIBA Analytics',
            html: autoReplyHtml,
            replyTo: SUPPORT_EMAIL,  // サポート窓口への返信設定（単一源）
            fromName: 'KEIBA Analytics サポート'
        });

        // 件数を後から数えられるように残す（個人情報は出さない・種類だけ）
        console.log('[contact-form] accepted', { topic: v.topic });

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
            name: fromName || "KEIBA Analytics サポート",
            email: SUPPORT_EMAIL  // 迷惑メール対策で 2025-11-26 に support へ変更（noreply へ戻さない）
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