// AI ラボ → KEIBA LIVE（2026-10-29 MK）。転送先と、マイページ入口の行き先の単一源
const KEIBA_LIVE = 'https://keiba-live.com/';
const utm = (campaign) => `${KEIBA_LIVE}?utm_source=analytics-keiba&utm_medium=referral&utm_campaign=${campaign}`;

/** /ai-lab/ の転送先（301） */
export const AI_LAB_REDIRECT_URL = utm('ai_lab_redirect');
/** マイページの入口（新しいタブ） */
export const MYPAGE_KEIBA_LIVE_URL = utm('mypage_ai_live');
