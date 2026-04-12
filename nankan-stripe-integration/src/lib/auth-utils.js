import { supabase } from './supabase.js';

// ユーザー情報とプランを取得
export async function getUserWithPlan() {
    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        
        if (authError || !user) {
            return { user: null, plan: 'free' };
        }

        // デモモードのローカルストレージをチェック
        const demoSubscription = localStorage.getItem('demo_subscription_' + user.id);
        
        if (demoSubscription) {
            const demoData = JSON.parse(demoSubscription);
            console.log('Demo subscription found in auth-utils:', demoData);
            return { user, plan: demoData.planType.toLowerCase() };
        }

        // プロフィールからプラン情報を取得
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('subscription_status, subscription_plan')
            .eq('id', user.id)
            .single();

        if (profileError || !profile || profile.subscription_status !== 'active') {
            return { user, plan: 'free' };
        }

        // プラン名の正規化
        const planName = profile.subscription_plan?.toLowerCase();
        if (planName?.includes('premium')) {
            return { user, plan: 'premium' };
        } else if (planName?.includes('standard')) {
            return { user, plan: 'standard' };
        }

        return { user, plan: 'free' };
    } catch (error) {
        console.error('Error getting user with plan:', error);
        return { user: null, plan: 'free' };
    }
}

// プラン別アクセス権限チェック
export function canAccessContent(userPlan, requiredPlan) {
    const planHierarchy = {
        'free': 0,
        'standard': 1,
        'premium': 2
    };

    const userLevel = planHierarchy[userPlan] || 0;
    const requiredLevel = planHierarchy[requiredPlan] || 0;

    return userLevel >= requiredLevel;
}

// レース別アクセス権限チェック
export function canAccessRace(userPlan, raceNumber) {
    const raceNum = typeof raceNumber === 'string' 
        ? parseInt(raceNumber.replace('R', '')) 
        : raceNumber;

    switch(userPlan) {
        case 'premium':
            // プレミアム会員は全レース（1R-12R）アクセス可能
            return true;
        case 'standard':
            // スタンダード会員は後半3レース（10R-12R）のみ
            return raceNum >= 10;
        case 'free':
        default:
            // 無料会員はメインレース（11R）のみ
            return raceNum === 11;
    }
}

// プラン表示名を取得
export function getPlanDisplayName(plan) {
    const displayNames = {
        'free': '無料会員',
        'standard': 'スタンダード会員',
        'premium': 'プレミアム会員'
    };
    return displayNames[plan] || '無料会員';
}

// プランのカラーテーマを取得
export function getPlanColor(plan) {
    const colors = {
        'free': '#94a3b8',      // グレー
        'standard': '#10b981',   // グリーン
        'premium': '#f59e0b'     // ゴールド
    };
    return colors[plan] || colors.free;
}

// プランのアイコンを取得
export function getPlanIcon(plan) {
    const icons = {
        'free': '🎯',
        'standard': '⭐',
        'premium': '👑'
    };
    return icons[plan] || icons.free;
}