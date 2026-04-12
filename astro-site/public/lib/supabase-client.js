// ブラウザ用Supabaseクライアント設定
import { createClient } from 'https://cdn.skypack.dev/@supabase/supabase-js@2'

// 環境変数（本番環境の値を直接設定）
const supabaseUrl = 'https://rkqsoxitqjdvqqdexuhm.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcXNveGl0cWpkdnFxZGV4dWhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzI0MjM4NjgsImV4cCI6MjA0ODAwMDA2OH0.eAGqEZ5-PGHxBQxFz1AqI3ZyA0vfTrNqJD3uBp1zKXE'

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase URL and Anon Key must be provided')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
})

// 認証関連のヘルパー関数
export const auth = {
  // サインアップ
  async signUp(email, password) {
    return await supabase.auth.signUp({
      email,
      password,
    })
  },

  // サインイン
  async signIn(email, password) {
    return await supabase.auth.signInWithPassword({
      email,
      password,
    })
  },

  // サインアウト
  async signOut() {
    return await supabase.auth.signOut()
  },

  // 現在のユーザー取得
  async getUser() {
    return await supabase.auth.getUser()
  },

  // パスワードリセットメール送信
  async resetPassword(email) {
    return await supabase.auth.resetPasswordForEmail(email)
  },

  // 認証状態の変化をリッスン
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback)
  }
}

// プロフィール関連
export const profiles = {
  // プロフィール取得
  async getProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    
    // プロファイルが存在しない場合は作成
    if (!data && !error) {
      const { data: newProfile, error: createError } = await supabase
        .from('profiles')
        .insert([{ id: userId }])
        .select()
        .single()
      
      return { data: newProfile, error: createError }
    }
    
    return { data, error }
  },

  // プロフィール更新
  async updateProfile(userId, updates) {
    return await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
  },

  // サブスクリプション状態取得
  async getSubscription(userId) {
    return await supabase
      .from('profiles')
      .select('subscription_status, subscription_plan, subscription_end_date')
      .eq('id', userId)
      .single()
  }
}