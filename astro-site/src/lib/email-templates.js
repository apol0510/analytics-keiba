// NANKANアナリティクス HTMLメールテンプレート集
// 南関競馬予想配信用のプロフェッショナルテンプレート

export const emailTemplates = {
  // 1. 基本のニュースレターテンプレート
  newsletter: {
    name: '📧 基本ニュースレター',
    description: 'シンプルで読みやすい基本テンプレート',
    template: `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NANKANアナリティクス</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background: linear-gradient(135deg, #3b82f6 0%, #1e40af 100%); padding: 30px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; }
        .header p { color: #e0e7ff; margin: 5px 0 0 0; font-size: 14px; }
        .content { padding: 30px 20px; }
        .content h2 { color: #1f2937; font-size: 20px; margin: 0 0 15px 0; }
        .content p { color: #4b5563; line-height: 1.6; margin: 0 0 15px 0; }
        .footer { background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb; }
        .footer p { color: #6b7280; font-size: 12px; margin: 0; }
        .btn { display: inline-block; padding: 12px 24px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 10px 0; }
        .highlight { background-color: #eff6ff; padding: 15px; border-left: 4px solid #3b82f6; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🏇 NANKANアナリティクス</h1>
            <p>AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム</p>
        </div>
        <div class="content">
            {CONTENT}
        </div>
        <div class="footer">
            <p>© 2025 NANKANアナリティクス | <a href="https://nankan-analytics.keiba.link/pricing" style="color: #3b82f6;">プラン変更</a> | <a href="#" style="color: #6b7280;">配信停止</a></p>
        </div>
    </div>
</body>
</html>`
  },

  // 2. 予想配信専用テンプレート
  prediction: {
    name: '🎯 予想配信テンプレート',
    description: '競馬予想に特化したレイアウト',
    template: `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>南関競馬予想 - NANKANアナリティクス</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #0f172a; color: #e2e8f0; }
        .container { max-width: 650px; margin: 0 auto; background-color: #1e293b; }
        .header { background: linear-gradient(135deg, #059669 0%, #047857 100%); padding: 25px 20px; text-align: center; position: relative; }
        .header::before { content: '🏇'; font-size: 40px; position: absolute; top: 15px; left: 20px; }
        .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; }
        .header .date { color: #a7f3d0; font-size: 14px; margin: 5px 0 0 0; }
        .race-card { background-color: #334155; margin: 20px; border-radius: 12px; overflow: hidden; }
        .race-header { background-color: #475569; padding: 15px 20px; border-bottom: 2px solid #059669; }
        .race-title { color: #ffffff; font-size: 18px; font-weight: 700; margin: 0; }
        .race-info { color: #94a3b8; font-size: 13px; margin: 5px 0 0 0; }
        .prediction-content { padding: 20px; }
        .horse { display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #475569; }
        .horse:last-child { border-bottom: none; }
        .horse-mark { font-size: 24px; width: 40px; text-align: center; }
        .horse-info { flex: 1; margin-left: 15px; }
        .horse-name { color: #ffffff; font-size: 16px; font-weight: 600; margin: 0; }
        .horse-comment { color: #94a3b8; font-size: 13px; margin: 3px 0 0 0; }
        .confidence { background-color: #059669; color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
        .strategy-box { background-color: #065f46; padding: 15px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #10b981; }
        .btn-race { display: inline-block; padding: 12px 20px; background-color: #10b981; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 15px 0; }
        .footer { background-color: #0f172a; padding: 20px; text-align: center; border-top: 1px solid #334155; }
        .footer p { color: #64748b; font-size: 12px; margin: 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>南関競馬 AI予想</h1>
            <div class="date">{DATE}</div>
        </div>
        {CONTENT}
        <div style="padding: 20px; text-align: center;">
            <a href="https://nankan-analytics.keiba.link/premium-predictions" class="btn-race">📊 詳細予想を見る</a>
        </div>
        <div class="footer">
            <p>🤖 AI信頼度: {CONFIDENCE}% | 📈 予想精度向上中 | <a href="https://nankan-analytics.keiba.link" style="color: #10b981;">NANKANアナリティクス</a></p>
        </div>
    </div>
</body>
</html>`
  },

  // 3. プロモーション用テンプレート
  promotion: {
    name: '🎉 プロモーション',
    description: 'キャンペーンや特別オファー用',
    template: `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>特別オファー - NANKANアナリティクス</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 20px; text-align: center; position: relative; overflow: hidden; }
        .header::before { content: '✨'; font-size: 60px; position: absolute; top: -10px; right: -10px; opacity: 0.3; }
        .header h1 { color: #ffffff; margin: 0; font-size: 28px; font-weight: 800; text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
        .header .subtitle { color: #fef3c7; font-size: 16px; margin: 10px 0 0 0; font-weight: 600; }
        .offer-banner { background: linear-gradient(90deg, #ef4444 0%, #dc2626 100%); color: #ffffff; text-align: center; padding: 15px; font-size: 18px; font-weight: 700; }
        .content { padding: 30px 20px; }
        .highlight-box { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center; border: 2px solid #f59e0b; }
        .highlight-box h2 { color: #92400e; margin: 0 0 10px 0; font-size: 24px; }
        .price { font-size: 36px; color: #dc2626; font-weight: 800; margin: 10px 0; }
        .old-price { text-decoration: line-through; color: #6b7280; font-size: 18px; margin-right: 10px; }
        .btn-cta { display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 18px; margin: 20px 0; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4); }
        .features { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
        .feature { background-color: #f8fafc; padding: 15px; border-radius: 8px; text-align: center; }
        .feature-icon { font-size: 24px; margin-bottom: 8px; }
        .footer { background-color: #1f2937; padding: 25px 20px; text-align: center; }
        .footer p { color: #9ca3af; font-size: 12px; margin: 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎊 特別キャンペーン</h1>
            <div class="subtitle">期間限定オファー実施中！</div>
        </div>
        <div class="offer-banner">
            ⏰ 残り{DAYS}日間限定！
        </div>
        <div class="content">
            {CONTENT}
            <div class="highlight-box">
                <h2>💎 Premium会員</h2>
                <div>
                    <span class="old-price">¥9,980/月</span>
                    <div class="price">¥{PRICE}/月</div>
                </div>
                <p style="color: #059669; font-weight: 600; margin: 0;">🎯 初月{DISCOUNT}%OFF!</p>
            </div>
            <div style="text-align: center;">
                <a href="https://nankan-analytics.keiba.link/pricing" class="btn-cta">今すぐ始める 🚀</a>
            </div>
            <div class="features">
                <div class="feature">
                    <div class="feature-icon">🤖</div>
                    <strong>AI予想</strong><br>高精度アルゴリズム
                </div>
                <div class="feature">
                    <div class="feature-icon">📊</div>
                    <strong>詳細分析</strong><br>データ完全公開
                </div>
                <div class="feature">
                    <div class="feature-icon">💰</div>
                    <strong>投資戦略</strong><br>リスク管理完璧
                </div>
                <div class="feature">
                    <div class="feature-icon">📱</div>
                    <strong>リアルタイム</strong><br>即座に情報配信
                </div>
            </div>
        </div>
        <div class="footer">
            <p>🏆 信頼のAI予想で勝利を掴もう | <a href="https://nankan-analytics.keiba.link" style="color: #60a5fa;">NANKANアナリティクス</a></p>
        </div>
    </div>
</body>
</html>`
  },

  // 4. ウェルカムメール用テンプレート
  welcome: {
    name: '👋 ウェルカムメール',
    description: '新規登録者向けの歓迎メール',
    template: `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ようこそ - NANKANアナリティクス</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f0f9ff; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); padding: 40px 20px; text-align: center; }
        .welcome-icon { font-size: 60px; margin-bottom: 15px; }
        .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 700; }
        .header p { color: #bae6fd; margin: 8px 0 0 0; font-size: 16px; }
        .content { padding: 30px 20px; }
        .welcome-message { text-align: center; margin-bottom: 30px; }
        .welcome-message h2 { color: #0c4a6e; font-size: 22px; margin: 0 0 15px 0; }
        .steps { counter-reset: step-counter; margin: 30px 0; }
        .step { counter-increment: step-counter; background-color: #f8fafc; padding: 20px; margin: 15px 0; border-radius: 10px; border-left: 4px solid #0ea5e9; position: relative; }
        .step::before { content: counter(step-counter); position: absolute; left: -12px; top: 15px; background-color: #0ea5e9; color: #ffffff; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; }
        .step h3 { color: #0c4a6e; margin: 0 0 8px 0; font-size: 16px; }
        .step p { color: #475569; margin: 0; line-height: 1.5; }
        .benefit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 25px 0; }
        .benefit { background-color: #eff6ff; padding: 15px; border-radius: 8px; text-align: center; }
        .benefit-icon { font-size: 30px; margin-bottom: 8px; }
        .btn-start { display: inline-block; padding: 16px 30px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; margin: 20px 0; }
        .footer { background-color: #f1f5f9; padding: 25px 20px; text-align: center; }
        .footer p { color: #64748b; font-size: 13px; margin: 0; }
        .footer a { color: #0ea5e9; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="welcome-icon">🎉</div>
            <h1>NANKANアナリティクスへようこそ！</h1>
            <p>AI競馬予想の世界へようこそ</p>
        </div>
        <div class="content">
            <div class="welcome-message">
                <h2>👋 {USER_NAME}さん、登録ありがとうございます！</h2>
                <p>これからAI・機械学習の力で南関競馬を攻略していきましょう。<br>まずは以下のステップで始めてみてください。</p>
            </div>
            
            <div class="steps">
                <div class="step">
                    <h3>🔍 無料予想をチェック</h3>
                    <p>全レースの予想・分析を無料公開中。買い目は有料会員のみ表示されます。まずはAI予想の精度を体感してください！</p>
                </div>
                <div class="step">
                    <h3>📊 予想の見方を学習</h3>
                    <p>信頼度、戦略、投資金額の見方を理解して、効率的な馬券購入を目指しましょう。</p>
                </div>
                <div class="step">
                    <h3>💎 有料プランを検討</h3>
                    <p>より詳細な分析と全レース予想で、本格的な競馬投資を始めてみませんか？</p>
                </div>
            </div>

            <div class="benefit-grid">
                <div class="benefit">
                    <div class="benefit-icon">🤖</div>
                    <strong>AI予想</strong><br>
                    <small>機械学習による高精度予想</small>
                </div>
                <div class="benefit">
                    <div class="benefit-icon">📱</div>
                    <strong>リアルタイム</strong><br>
                    <small>レース直前まで更新</small>
                </div>
                <div class="benefit">
                    <div class="benefit-icon">💰</div>
                    <strong>投資戦略</strong><br>
                    <small>リスク管理も完璧</small>
                </div>
                <div class="benefit">
                    <div class="benefit-icon">📊</div>
                    <strong>透明性</strong><br>
                    <small>予想根拠を完全公開</small>
                </div>
            </div>

            <div style="text-align: center;">
                <a href="https://nankan-analytics.keiba.link/free-prediction" class="btn-start">🎯 無料予想を見る</a>
            </div>

            {CONTENT}
        </div>
        <div class="footer">
            <p>何かご質問がございましたら、<a href="mailto:info@keiba.link">info@keiba.link</a> までお気軽にお問い合わせください。</p>
            <p>📧 配信設定の変更は<a href="https://nankan-analytics.keiba.link/dashboard">こちら</a> | <a href="#">配信停止</a></p>
        </div>
    </div>
</body>
</html>`
  },

  // 5. シンプルなお知らせ用テンプレート
  announcement: {
    name: '📢 お知らせ',
    description: 'システム更新やお知らせ用のシンプルテンプレート',
    template: `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>お知らせ - NANKANアナリティクス</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #fafafa; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .header { background-color: #6366f1; padding: 25px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 600; }
        .content { padding: 30px 25px; }
        .content h2 { color: #1f2937; font-size: 20px; margin: 0 0 15px 0; }
        .content p { color: #4b5563; line-height: 1.7; margin: 0 0 15px 0; }
        .info-box { background-color: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 15px 20px; margin: 20px 0; border-radius: 4px; }
        .info-box h3 { color: #0c4a6e; margin: 0 0 10px 0; font-size: 16px; }
        .info-box p { color: #0369a1; margin: 0; }
        .date-stamp { background-color: #f3f4f6; padding: 10px 15px; border-radius: 6px; color: #6b7280; font-size: 14px; text-align: center; margin: 20px 0; }
        .footer { background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb; }
        .footer p { color: #6b7280; font-size: 12px; margin: 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📢 NANKANアナリティクス お知らせ</h1>
        </div>
        <div class="content">
            {CONTENT}
            <div class="date-stamp">
                📅 発信日: {DATE}
            </div>
        </div>
        <div class="footer">
            <p>今後ともNANKANアナリティクスをよろしくお願いいたします。</p>
            <p><a href="https://nankan-analytics.keiba.link" style="color: #6366f1;">NANKANアナリティクス</a> | <a href="#" style="color: #6b7280;">配信停止</a></p>
        </div>
    </div>
</body>
</html>`
  }
};

// テンプレート処理用のヘルパー関数
export function processTemplate(templateKey, content, variables = {}) {
  const template = emailTemplates[templateKey];
  if (!template) {
    throw new Error(`Template "${templateKey}" not found`);
  }

  let processedHtml = template.template.replace('{CONTENT}', content);
  
  // 変数の置換
  Object.keys(variables).forEach(key => {
    const placeholder = `{${key.toUpperCase()}}`;
    processedHtml = processedHtml.replace(new RegExp(placeholder, 'g'), variables[key]);
  });
  
  // デフォルト値の設定
  const defaults = {
    '{DATE}': new Date().toLocaleDateString('ja-JP'),
    '{CONFIDENCE}': '85',
    '{USER_NAME}': '会員',
    '{DAYS}': '7',
    '{PRICE}': '4,990',
    '{DISCOUNT}': '50'
  };
  
  Object.keys(defaults).forEach(placeholder => {
    processedHtml = processedHtml.replace(new RegExp(placeholder, 'g'), defaults[placeholder]);
  });
  
  return processedHtml;
}

// テンプレート一覧取得
export function getTemplateList() {
  return Object.keys(emailTemplates).map(key => ({
    key,
    name: emailTemplates[key].name,
    description: emailTemplates[key].description
  }));
}

// プリセットコンテンツ例
export const presetContents = {
  prediction: `
<div class="race-card">
    <div class="race-header">
        <h2 class="race-title">🏇 川崎12R サラ系3歳以上</h2>
        <div class="race-info">📅 2025年9月11日 | ⏰ 20:45発走 | 🏃 1400m | 💰 賞金500万円</div>
    </div>
    <div class="prediction-content">
        <div class="horse">
            <div class="horse-mark">◎</div>
            <div class="horse-info">
                <h3 class="horse-name">8番 キチョウ</h3>
                <p class="horse-comment">前走好内容。今回も上位期待。</p>
            </div>
            <div class="confidence">信頼度 91%</div>
        </div>
        <div class="horse">
            <div class="horse-mark">○</div>
            <div class="horse-info">
                <h3 class="horse-name">6番 マイボンド</h3>
                <p class="horse-comment">安定した実績。穴狙いでも。</p>
            </div>
            <div class="confidence">信頼度 85%</div>
        </div>
        <div class="strategy-box">
            <h3>💡 推奨投資戦略</h3>
            <p><strong>馬単:</strong> 8→6 (1,000円)<br>
            <strong>3連複:</strong> 6-8-2 (500円)<br>
            <strong>期待収益:</strong> +2,400円 (240%)</p>
        </div>
    </div>
</div>`,
  
  newsletter: `
<h2>🎯 今週の予想実績</h2>
<p>先週は6戦4勝の好成績！的中率66.7%を記録しました。</p>

<div class="highlight">
<h3>📊 週間ハイライト</h3>
<ul>
<li><strong>川崎11R:</strong> 3連複 ¥8,460的中 (推奨¥500 → 利益¥3,730)</li>
<li><strong>大井10R:</strong> 馬単 ¥3,280的中 (推奨¥1,000 → 利益¥2,280)</li>
<li><strong>浦和12R:</strong> 3連単 ¥15,890的中 (推奨¥200 → 利益¥2,978)</li>
</ul>
</div>

<h2>🚀 来週の注目レース</h2>
<p>来週は<strong>川崎記念</strong>の前哨戦が開催予定。重賞候補の動向に注目です。</p>

<p style="text-align: center;">
<a href="https://nankan-analytics.keiba.link/premium-predictions" class="btn">📈 詳細予想を見る</a>
</p>`,

  welcome: `
<h2>🎁 登録特典のご案内</h2>
<p>ご登録いただいた記念として、以下の特典をご用意いたします：</p>

<div class="highlight">
<ul>
<li>🎯 <strong>無料予想</strong>: 全レースの予想・分析</li>
<li>📊 <strong>戦略ガイド</strong>: 効率的な馬券購入方法</li>
<li>💰 <strong>投資管理</strong>: リスク管理の基本</li>
</ul>
</div>

<p>まずは無料予想から始めて、AI予想の実力を体感してください！</p>`
};