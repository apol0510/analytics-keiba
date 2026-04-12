// ブラウザ用Supabaseクライアント
import { createClient } from '@supabase/supabase-js'

// 環境変数を取得（ブラウザ環境では直接値を使用）
const supabaseUrl = 'https://qysycsrhaatudnksbpqe.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5c3ljc3JoYWF0dWRua3NicHFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU5MzM3MjcsImV4cCI6MjA3MTUwOTcyN30.UDWi7FYqpJNpMhvMMaZoGMXwuD1R2PNH4Tk6Xs1u1pU'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

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