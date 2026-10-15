/**
 * process-withdrawal — 廃止（2026-10-15 MK 確定: 退会はマイページ「退会する」→ 確認 → 確定だけ）。
 *
 * 旧仕様はメールアドレスだけで退会フラグを書けた（本人確認なし＝他人のアドレスで他の会員を退会させられた）。
 * いまは何も読まず・何も書かず・何も送らずに 410 を返す。退会は member-withdraw（ログイン必須）へ。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable は呼ばない（計測の guard に合わせて入れているだけ）
installAirtableCallMeter({ source: 'process-withdrawal' });

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  return {
    statusCode: 410,
    headers,
    body: JSON.stringify({
      error: 'moved_to_mypage',
      message: '退会は、ログイン後のマイページの「退会する」から行えます。',
      loginUrl: '/login/',
    }),
  };
};
