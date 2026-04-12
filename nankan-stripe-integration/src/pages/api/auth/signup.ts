export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase.js';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { displayName, email, password } = body;

    // バリデーション
    if (!displayName || !email || !password) {
      return new Response(JSON.stringify({ 
        error: 'すべての項目を入力してください。' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ 
        error: 'パスワードは6文字以上で入力してください。' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Supabaseでユーザー登録
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName
        }
      }
    });

    if (error) {
      console.error('Signup error:', error);
      
      let errorMessage = '登録に失敗しました。';
      if (error.message.includes('User already registered')) {
        errorMessage = 'このメールアドレスは既に登録済みです。';
      } else if (error.message.includes('Password should be')) {
        errorMessage = 'パスワードは6文字以上で入力してください。';
      } else if (error.message.includes('Invalid email')) {
        errorMessage = '有効なメールアドレスを入力してください。';
      }
      
      return new Response(JSON.stringify({ 
        error: errorMessage 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (data?.user) {
      return new Response(JSON.stringify({ 
        success: true,
        message: '登録が完了しました！確認メールをお送りしましたので、メール内のリンクをクリックしてアカウントを有効化してください。',
        user: {
          id: data.user.id,
          email: data.user.email
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
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