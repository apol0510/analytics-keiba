// シンプルなプラン管理システム（LocalStorage使用）
// プラン情報の正本は Airtable。ここではブラウザ表示用にキャッシュするだけ。

export const PlanStorage = {
  // プラン情報を取得
  getPlan() {
    try {
      const userData = localStorage.getItem('userData');
      if (userData) {
        const data = JSON.parse(userData);
        // 有効期限チェック
        if (data.expiresAt && new Date() > new Date(data.expiresAt)) {
          this.clearPlan();
          return 'free';
        }
        return data.plan || 'free';
      }
      
      // 旧形式との互換性
      const plan = localStorage.getItem('userPlan') || 'free';
      const expiry = localStorage.getItem('planExpiry');
      
      if (expiry && new Date() > new Date(expiry)) {
        this.clearPlan();
        return 'free';
      }
      
      return plan;
    } catch (e) {
      console.error('プラン取得エラー:', e);
      return 'free';
    }
  },

  // プラン情報を保存（Stripe決済後に使用）
  setPlan(plan, sessionId = null, daysValid = 30) {
    const userData = {
      plan: plan.toLowerCase(),
      sessionId: sessionId,
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString()
    };
    
    localStorage.setItem('userData', JSON.stringify(userData));
    localStorage.setItem('userPlan', plan.toLowerCase()); // 互換性のため
    localStorage.setItem('planExpiry', userData.expiresAt); // 互換性のため
  },

  // プラン情報をクリア
  clearPlan() {
    localStorage.removeItem('userData');
    localStorage.removeItem('userPlan');
    localStorage.removeItem('planExpiry');
  },

  // プランアクセス権限チェック
  hasAccess(requiredPlan) {
    const currentPlan = this.getPlan();
    
    // プランレベル定義
    const planLevels = {
      'free': 0,
      'standard': 1,
      'premium': 2
    };
    
    return planLevels[currentPlan] >= planLevels[requiredPlan];
  },

  // レースアクセス権限チェック（12レース開催時）
  canAccessRace(raceNumber) {
    const plan = this.getPlan();
    
    switch(plan) {
      case 'premium':
        return true; // 全レース（1R-12R）
      case 'standard':
        return [10, 11, 12].includes(raceNumber); // 後半3レース
      case 'free':
      default:
        return raceNumber === 11; // メインレース（11R）のみ
    }
  },

  // ユーザー情報取得
  getUserData() {
    try {
      const userData = localStorage.getItem('userData');
      return userData ? JSON.parse(userData) : null;
    } catch (e) {
      return null;
    }
  },

  // デモモード設定（テスト用）
  setDemoMode(plan) {
    console.log(`🎯 デモモード: ${plan}会員として設定`);
    this.setPlan(plan, 'demo-session', 1); // 1日有効
  }
};

// グローバルに公開（ブラウザコンソールからテスト可能）
if (typeof window !== 'undefined') {
  window.PlanStorage = PlanStorage;
}