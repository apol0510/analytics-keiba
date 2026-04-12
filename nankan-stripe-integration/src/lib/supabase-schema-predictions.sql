-- 予想データ管理用テーブル作成スクリプト

-- 予想コンテンツテーブル
CREATE TABLE IF NOT EXISTS prediction_content (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- 基本情報
    race_date DATE NOT NULL,
    race_track VARCHAR(50) NOT NULL, -- 大井、川崎、船橋、浦和
    race_number INTEGER NOT NULL,
    race_name VARCHAR(100),
    race_distance INTEGER,
    race_type VARCHAR(20), -- ダート、芝
    
    -- 予想データ
    prediction_data JSONB NOT NULL, -- 予想の詳細データ（馬番、評価、戦略等）
    confidence_score DECIMAL(5,2), -- 信頼度スコア（0-100）
    
    -- アクセス制御
    content_type VARCHAR(20) DEFAULT 'premium', -- free, standard, premium
    is_published BOOLEAN DEFAULT false,
    
    -- メタデータ
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

-- インデックス作成
CREATE INDEX idx_prediction_race_date ON prediction_content(race_date);
CREATE INDEX idx_prediction_track ON prediction_content(race_track);
CREATE INDEX idx_prediction_type ON prediction_content(content_type);
CREATE INDEX idx_prediction_published ON prediction_content(is_published);

-- 予想結果記録テーブル
CREATE TABLE IF NOT EXISTS prediction_results (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    prediction_id UUID REFERENCES prediction_content(id) ON DELETE CASCADE,
    
    -- 結果データ
    actual_result JSONB, -- 実際のレース結果
    hit_status VARCHAR(20), -- hit, miss
    payout_amount DECIMAL(10,2), -- 払戻金額
    
    -- メタデータ
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 今日の予想ビュー（ダッシュボード用）
CREATE OR REPLACE VIEW today_predictions AS
SELECT 
    pc.*,
    pr.hit_status,
    pr.payout_amount
FROM prediction_content pc
LEFT JOIN prediction_results pr ON pc.id = pr.prediction_id
WHERE pc.race_date = CURRENT_DATE
    AND pc.is_published = true
ORDER BY pc.race_track, pc.race_number;

-- RLS（Row Level Security）設定
ALTER TABLE prediction_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_results ENABLE ROW LEVEL SECURITY;

-- 管理者は全てのデータを読み書き可能
CREATE POLICY "Admin full access to predictions" ON prediction_content
    FOR ALL USING (
        auth.uid() IN (
            SELECT id FROM auth.users 
            WHERE raw_user_meta_data->>'role' = 'admin'
        )
    );

-- 認証済みユーザーは公開された予想を閲覧可能
CREATE POLICY "Users can view published predictions" ON prediction_content
    FOR SELECT USING (
        is_published = true AND (
            content_type = 'free' OR
            (auth.uid() IS NOT NULL AND content_type IN ('standard', 'premium'))
        )
    );

-- プレミアム会員のみプレミアムコンテンツを閲覧可能
CREATE POLICY "Premium users can view premium content" ON prediction_content
    FOR SELECT USING (
        is_published = true AND
        content_type = 'premium' AND
        auth.uid() IN (
            SELECT user_id FROM user_profiles 
            WHERE subscription_status = 'active' 
            AND subscription_plan IN ('standard', 'premium')
        )
    );

-- 結果データは誰でも閲覧可能
CREATE POLICY "Anyone can view results" ON prediction_results
    FOR SELECT USING (true);

-- 管理者のみ結果データを更新可能
CREATE POLICY "Admin can manage results" ON prediction_results
    FOR ALL USING (
        auth.uid() IN (
            SELECT id FROM auth.users 
            WHERE raw_user_meta_data->>'role' = 'admin'
        )
    );

-- 更新日時自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_prediction_updated_at
    BEFORE UPDATE ON prediction_content
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- サンプルデータ挿入（テスト用）
INSERT INTO prediction_content (
    race_date,
    race_track,
    race_number,
    race_name,
    race_distance,
    race_type,
    prediction_data,
    confidence_score,
    content_type,
    is_published
) VALUES 
(
    CURRENT_DATE,
    '大井',
    11,
    'サンプルレース',
    1600,
    'ダート',
    '{
        "horses": [
            {"number": 8, "name": "アンジュルナ", "mark": "◎", "factors": ["能力指数: 86.8", "安定性: 91.9%", "展開適性: S"]},
            {"number": 1, "name": "アムールピスケス", "mark": "○", "factors": ["スピード指数: 76.2", "先行力: 89.3%", "枠順優位性: A"]},
            {"number": 5, "name": "ロードレイジング", "mark": "▲", "factors": ["爆発力: 89.6", "ムラ係数: 高", "展開次第"]}
        ],
        "strategies": {
            "safe": {"hitRate": "78.5%", "returnRate": "132%", "bets": [{"type": "馬連", "horses": "8-1,5", "points": 2}]},
            "balance": {"hitRate": "65.2%", "returnRate": "188%", "bets": [{"type": "馬単", "horses": "8→1,5", "points": 2}]},
            "aggressive": {"hitRate": "42.1%", "returnRate": "312%", "bets": [{"type": "3連単", "horses": "8→1,5→2,3,9", "points": 6}]}
        }
    }'::jsonb,
    91.2,
    'premium',
    true
);