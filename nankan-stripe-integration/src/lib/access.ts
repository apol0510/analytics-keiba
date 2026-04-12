// Access control utilities
import type { PlanType } from './billing/plan';
import { canAccessRace } from './billing/plan';

export interface UserAccess {
  plan: PlanType;
  status: string;
  canAccessRace: (raceNumber: number) => boolean;
  canAccessFeature: (feature: string) => boolean;
  isActive: boolean;
}

// Feature access definitions
const FEATURE_ACCESS: Record<PlanType, string[]> = {
  free: [
    'basic_predictions',
    'race_results',
    'basic_analytics'
  ],
  standard: [
    'basic_predictions',
    'race_results',
    'basic_analytics',
    'detailed_analysis',
    'investment_strategy',
    'email_notifications',
    'backend_3_races'
  ],
  premium: [
    'basic_predictions',
    'race_results',
    'basic_analytics',
    'detailed_analysis',
    'investment_strategy',
    'email_notifications',
    'backend_3_races',
    'all_races',
    'priority_support',
    'data_export',
    'advanced_analytics'
  ]
};

// Active subscription statuses
const ACTIVE_STATUSES = ['active', 'trialing'];

export function createUserAccess(plan: PlanType, status: string, totalRaces: number = 12): UserAccess {
  return {
    plan,
    status,
    isActive: ACTIVE_STATUSES.includes(status),
    canAccessRace: (raceNumber: number) => {
      // If subscription is not active, only free content
      if (!ACTIVE_STATUSES.includes(status)) {
        return canAccessRace('free', raceNumber, totalRaces);
      }
      return canAccessRace(plan, raceNumber, totalRaces);
    },
    canAccessFeature: (feature: string) => {
      // If subscription is not active, only free features
      if (!ACTIVE_STATUSES.includes(status)) {
        return FEATURE_ACCESS.free.includes(feature);
      }
      return FEATURE_ACCESS[plan].includes(feature);
    }
  };
}

// Race tier mapping (for UI display)
export function getRaceTier(raceNumber: number, totalRaces: number = 12): 'free' | 'standard' | 'premium' {
  const mainRace = totalRaces - 1; // メインレース
  
  if (raceNumber === mainRace) {
    return 'free';
  }
  
  // 後半3レース範囲内でメインレース以外
  if (raceNumber >= totalRaces - 2) {
    return 'standard';
  }
  
  // その他は premium
  return 'premium';
}

// UI access check helpers
export function shouldShowRaceContent(userAccess: UserAccess, raceNumber: number): boolean {
  return userAccess.canAccessRace(raceNumber);
}

export function shouldShowUpgradePrompt(userAccess: UserAccess, requiredFeature: string): boolean {
  return !userAccess.canAccessFeature(requiredFeature);
}

export function getRequiredPlanForRace(raceNumber: number, totalRaces: number = 12): PlanType {
  return getRaceTier(raceNumber, totalRaces);
}

export function getRequiredPlanForFeature(feature: string): PlanType | null {
  for (const [plan, features] of Object.entries(FEATURE_ACCESS)) {
    if (features.includes(feature)) {
      return plan as PlanType;
    }
  }
  return null;
}

// Access control error messages
export const ACCESS_MESSAGES = {
  RACE_LOCKED: (requiredPlan: PlanType) => 
    `このレースは${requiredPlan === 'standard' ? 'スタンダード' : 'プレミアム'}プラン以上で閲覧できます。`,
  FEATURE_LOCKED: (feature: string, requiredPlan: PlanType) =>
    `この機能は${requiredPlan === 'standard' ? 'スタンダード' : 'プレミアム'}プラン以上で利用できます。`,
  SUBSCRIPTION_INACTIVE: 'サブスクリプションが有効ではありません。',
  SUBSCRIPTION_PAST_DUE: 'お支払いが確認できていません。請求書をご確認ください。'
};

export function getAccessMessage(userAccess: UserAccess, requiredFeature?: string): string {
  if (userAccess.status === 'past_due') {
    return ACCESS_MESSAGES.SUBSCRIPTION_PAST_DUE;
  }
  
  if (!userAccess.isActive) {
    return ACCESS_MESSAGES.SUBSCRIPTION_INACTIVE;
  }
  
  if (requiredFeature) {
    const requiredPlan = getRequiredPlanForFeature(requiredFeature);
    if (requiredPlan) {
      return ACCESS_MESSAGES.FEATURE_LOCKED(requiredFeature, requiredPlan);
    }
  }
  
  return ''; // No message needed
}