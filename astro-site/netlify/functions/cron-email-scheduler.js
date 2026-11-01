// 自作メールスケジューラー - Cron実行トリガー
// Netlify Scheduled Functionsで定期実行される

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'cron-email-scheduler' });
import { isCronTickRequest, directInvocationNotFound } from '../../src/lib/ops/cronTick.js';
export default async function handler(request, context) {
  // 起動は cron-tick だけ（schedule は cron-tick へ移した・公開 URL からは 404・src/lib/ops/cronTick.js）
  if (!isCronTickRequest(request)) return directInvocationNotFound();
  const headers = {
    'Content-Type': 'application/json'
  };

  console.log('🕐 Cron実行開始:', new Date().toISOString());

  // 🛡️ 止血ガード（2026-05-14 追加）
  // 過去にテスト時の重複配信が発生したため、Scheduled Function による自動配信は
  // NEWSLETTER_AUTOMATION_ENABLED === 'true' でない限り完全に無効化する。
  // ここで早期 return することで、execute-scheduled-emails / SendGrid に一切到達しない。
  // 本番配信を再開する際は、設計・dry-run・test を整備してから明示的にフラグを立てる。
  if (process.env.NEWSLETTER_AUTOMATION_ENABLED !== 'true') {
    console.log('🛡️ newsletter automation disabled (NEWSLETTER_AUTOMATION_ENABLED !== "true") - cron is a no-op');
    return new Response(
      JSON.stringify({
        success: true,
        skipped: true,
        reason: 'newsletter automation disabled',
        flag: 'NEWSLETTER_AUTOMATION_ENABLED',
        flagValue: process.env.NEWSLETTER_AUTOMATION_ENABLED ?? null,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );
  }

  try {
    // スケジュールされたメールを実行
    // 2026-05-22: 実行エンジンを Background Function 化（execute-scheduled-emails-background）。
    // Background Function は 202 Accepted を即返しし body を返さない（非同期で最大15分実行）。
    // そのため response.json() は行わず、起動の成否のみ status で判定する。
    const baseUrl = process.env.URL || 'https://analytics.keiba.link';
    const executorUrl = `${baseUrl}/.netlify/functions/execute-scheduled-emails-background`;

    console.log('📧 スケジューラー起動URL(background):', executorUrl);

    const response = await fetch(executorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Background Function は 202 即返し。2xx 以外のみ失敗扱い。
    if (!response.ok && response.status !== 202) {
      throw new Error(`スケジューラー起動失敗: ${response.status}`);
    }

    console.log(`✅ Cron: background executor 起動 (status=${response.status})`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Background executor triggered',
        executorStatus: response.status,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ Cron実行エラー:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }),
      { status: 500, headers }
    );
  }
}

// Netlify Scheduled Functions設定
// schedule は cron-tick へ移した（同じ間隔・2026-11-01・src/lib/ops/cronTick.js）。ここに config.schedule を戻すと二重に起動する
