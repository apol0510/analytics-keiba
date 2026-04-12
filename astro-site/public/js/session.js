// セッション管理ユーティリティ
export class SessionManager {
  constructor() {
    this.sessionKey = 'nankan_session';
    this.maxAge = 24 * 60 * 60 * 1000; // 24時間
  }
  
  // セッション保存
  saveSession(customerData) {
    const session = {
      customer: customerData,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.maxAge
    };
    
    try {
      localStorage.setItem(this.sessionKey, JSON.stringify(session));
      console.log('✅ セッション保存完了');
      return true;
    } catch (error) {
      console.error('セッション保存エラー:', error);
      return false;
    }
  }
  
  // セッション取得
  getSession() {
    try {
      const sessionData = localStorage.getItem(this.sessionKey);
      if (!sessionData) return null;
      
      const session = JSON.parse(sessionData);
      
      // 有効期限チェック
      if (Date.now() > session.expiresAt) {
        this.clearSession();
        return null;
      }
      
      return session;
    } catch (error) {
      console.error('セッション取得エラー:', error);
      this.clearSession();
      return null;
    }
  }
  
  // セッション削除
  clearSession() {
    try {
      localStorage.removeItem(this.sessionKey);
      console.log('✅ セッション削除完了');
    } catch (error) {
      console.error('セッション削除エラー:', error);
    }
  }
  
  // ログイン状態確認
  isAuthenticated() {
    const session = this.getSession();
    return session !== null;
  }
  
  // 顧客データ取得
  getCustomer() {
    const session = this.getSession();
    return session ? session.customer : null;
  }
  
  // セッション更新（アクセス時に延長）
  refreshSession() {
    const session = this.getSession();
    if (session) {
      session.timestamp = Date.now();
      session.expiresAt = Date.now() + this.maxAge;
      try {
        localStorage.setItem(this.sessionKey, JSON.stringify(session));
        return true;
      } catch (error) {
        console.error('セッション更新エラー:', error);
        return false;
      }
    }
    return false;
  }
}

// マジックリンク認証処理
export async function authenticateWithMagicLink(token, email) {
  try {
    const response = await fetch('/.netlify/functions/verify-magic-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token, email })
    });
    
    const data = await response.json();
    
    if (data.success) {
      const sessionManager = new SessionManager();
      sessionManager.saveSession(data.customer);
      return { success: true, customer: data.customer };
    } else {
      return { success: false, error: data.error };
    }
    
  } catch (error) {
    console.error('認証エラー:', error);
    return { success: false, error: '認証に失敗しました' };
  }
}

// ログアウト処理
export function logout() {
  const sessionManager = new SessionManager();
  sessionManager.clearSession();
  
  // ダッシュボードからホームにリダイレクト
  if (window.location.pathname === '/dashboard') {
    window.location.href = '/';
  }
}