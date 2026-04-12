// src/lib/billing/plan.ts
export type Plan = 'standard' | 'premium';

function getEnv(key: string): string {
  const v = import.meta.env[key];
  console.log(`[plan.ts] ENV ${key}:`, v || 'UNDEFINED');
  return typeof v === 'string' ? v : '';
}

// 動的に価格IDを取得する関数
export function getPrice(plan: Plan): string {
  const mode = (import.meta.env.STRIPE_MODE ?? 'test').toLowerCase();
  console.log('[plan.ts] Mode:', mode, 'Plan:', plan);
  
  const key = plan === 'standard' 
    ? (mode === 'live' ? 'STRIPE_STANDARD_PRICE_ID_LIVE' : 'STRIPE_STANDARD_PRICE_ID_TEST')
    : (mode === 'live' ? 'STRIPE_PREMIUM_PRICE_ID_LIVE' : 'STRIPE_PREMIUM_PRICE_ID_TEST');
  
  const priceId = getEnv(key);
  console.log('[plan.ts] Final price ID:', priceId);
  return priceId;
}

// 互換性のため
export const PRICE: Record<Plan, string> = {
  get standard() { return getPrice('standard'); },
  get premium() { return getPrice('premium'); }
};

export function planFromPriceId(priceId: string): Plan {
  if (priceId === PRICE.standard) return 'standard';
  if (priceId === PRICE.premium) return 'premium';
  throw new Error(`Unknown priceId: ${priceId}`);
}