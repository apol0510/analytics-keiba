// 旧: 新規ユーザー通知（ウェルカムメール）の公開 Function（2025-09-24 作成）
//
// 2026-11-20: 送信をやめた。
//   この URL は認証が無く、{ email, isNewUser: true } を POST すれば誰でも任意のアドレスへ
//   KEIBA Analytics 名義のメールを送れた。唯一の呼び出し元 auth-user は
//   src/lib/membership/welcomeEmail.js の sendWelcomeEmail を直接呼ぶように変えたため、
//   この Function は何も送らずに 410 を返す（共有 secret を新設せずに済む・env 変更なし）。
//   ウェルカムメールの文面・送信元・送るタイミング（新規無料登録の直後）は変わらない。

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// 全 ESM Function 共通の計測（Airtable は呼ばないが guard の対象・docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'user-notification' });

export default async function handler(request) {
  const headers = { 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response('', { status: 204 });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }
  return new Response(JSON.stringify({ error: 'gone' }), { status: 410, headers });
}
