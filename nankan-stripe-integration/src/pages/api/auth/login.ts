export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase.js';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { email, password } = body;

    // バリデーション
    if (!email || !password) {
      return new Response(JSON.stringify({ 
        error: 'メールアドレスとパスワードを入力してください。' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Supabaseでログイン
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error('Login error:', error);
      
      let errorMessage = 'ログインに失敗しました。';
      if (error.message === 'Invalid login credentials') {
        errorMessage = 'メールアドレスまたはパスワードが間違っています。';
      } else if (error.message.includes('Email not confirmed')) {
        errorMessage = 'メールアドレスが確認されていません。確認メール内のリンクをクリックしてください。';
      } else if (error.message.includes('Too many requests')) {
        errorMessage = 'ログイン試行回数が多すぎます。しばらく待ってから再度お試しください。';
      }
      
      return new Response(JSON.stringify({ 
        error: errorMessage 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (data?.user && data?.session) {
      return new Response(JSON.stringify({ 
        success: true,
        message: 'ログインが完了しました。',
        user: {
          id: data.user.id,
          email: data.user.email,
          display_name: data.user.user_metadata?.display_name
        },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token
        }
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': `sb-access-token=${data.session.access_token}; HttpOnly; Path=/; Max-Age=3600; SameSite=Strict`
        }
      });
    }

    return new Response(JSON.stringify({ 
      error: '予期しないエラーが発生しました。' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('API error:', error);
    return new Response(JSON.stringify({ 
      error: 'サーバーエラーが発生しました。' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}