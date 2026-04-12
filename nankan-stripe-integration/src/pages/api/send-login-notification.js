import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.SUPABASE_URL || 'https://qysycsrhaatudnksbpqe.supabase.co';
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.SUPABASE_ANON_KEY;

export async function POST({ request }) {
  try {
    const { email, timestamp, device } = await request.json();
    
    if (!email) {
      return new Response(JSON.stringify({ error: 'Email is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Supabaseクライアントを作成（サービスロールキーを使用）
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ログイン通知の内容を作成
    const loginTime = new Date(timestamp).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const deviceInfo = device ? device.substring(0, 100) : 'Unknown Device';
    
    // メール送信（Supabase Auth経由）
    // 注: 実際のメール送信にはSupabase側でSMTP設定が必要
    const emailContent = `
NANKANアナリティクスへのログインが検出されました。

ログイン日時: ${loginTime}
デバイス情報: ${deviceInfo}

このログインに心当たりがない場合は、すぐにパスワードを変更してください。
    `;

    // ログイン履歴をデータベースに記録
    const { error: logError } = await supabase
      .from('login_history')
      .insert({
        email: email,
        login_at: timestamp,
        device_info: deviceInfo,
        notification_sent: true
      });

    if (logError) {
      console.error('Failed to record login history:', logError);
    }

    // 簡易的なログ出力（実際のメール送信はSMTP設定後に実装）
    console.log(`Login notification for ${email}:`, emailContent);

    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Login notification processed'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Login notification error:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to process login notification' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}