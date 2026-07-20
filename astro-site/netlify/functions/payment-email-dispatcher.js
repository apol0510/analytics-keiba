/**
 * payment-email-dispatcher.js — pending 送信ディスパッチャ（B1・Scheduled + 手動 POST）。
 *
 * ロジック本体は src/lib/payments/paymentEmailDispatcher.js（テスト済み）。ここは実 deps 配線と
 * gate/pause/A2 の fail-closed 判定のみ。
 *
 * 起動経路:
 * - **Scheduled**（`export const config.schedule`）— 5 分毎。Netlify が内部起動する。
 * - **手動 POST** — `x-worker-secret` ヘッダ一致で管理者が強制実行できる（任意）。
 *
 * fail-closed（送信を開始する絶対条件。1 つでも欠ければ 0 件で終了）:
 * - `validateEmailGates()` の mode が **v2-worker / v2-full** であること。
 *   このモードは構造的に flow=v2 ∧ workerSend ∧ pause=false ∧ a2DisabledConfirmed=true を含む。
 *   → legacy / paused / v2-dry-run では**送信を一切開始しない**（A2 未停止・pause 時も同様）。
 * - 各レコードの送信可否（送信元契約 / SENDGRID / schema preflight / IdempotencyKey / eligible /
 *   lock+fencing）は runWorkerOnce が個別に fail-closed 判定する。dispatcher はそれを起動するだけ。
 *
 * PII 非出力: 応答・ログには status/reason の**件数集計だけ**。recordId / Email / secret を出さない。
 */

import { dispatchPendingBatch } from '../../src/lib/payments/paymentEmailDispatcher.js';
import { parseGatesFromEnv, validateEmailGates } from '../../src/lib/payments/paymentEmailState.js';
import { makeDispatcherDeps } from '../../src/lib/payments/paymentEmailDeps.js';

// 1 実行あたりの最大処理件数（小さく固定。超過分は次回スケジュールへ）。
const MAX_RECORDS = 10;

export default async function handler(request) {
  const method = request.method || 'GET';

  // 手動 POST は secret 必須。Scheduled 起動（secret ヘッダ無し）は許可するが、
  // 実際に送信するかどうかは下の gate 判定が唯一の防御（legacy では常に 0 件）。
  const configuredSecret = process.env.PAYMENT_EMAIL_WORKER_SECRET;
  const provided = request.headers.get('x-worker-secret');
  const isManual = provided != null;
  if (isManual && (!configuredSecret || provided !== configuredSecret)) {
    return json(403, { error: 'Forbidden' });
  }
  if (method !== 'POST' && method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // gate fail-closed。v2-worker / v2-full 以外は送信を開始しない。
  const gate = validateEmailGates(parseGatesFromEnv(process.env));
  if (!gate.ok || (gate.mode !== 'v2-worker' && gate.mode !== 'v2-full')) {
    return json(200, { dispatched: false, mode: gate.mode, reason: 'not_sending_mode' });
  }

  try {
    const result = await dispatchPendingBatch({ now: Date.now(), maxRecords: MAX_RECORDS, deps: makeDispatcherDeps() });
    // result は非機密（listed/processed/byOutcome/errors のみ）。
    return json(200, { dispatched: true, mode: gate.mode, ...result });
  } catch (e) {
    // 例外本文に Airtable 応答等が混じらないよう message のみ。
    console.error('[payment-email-dispatcher] error:', String(e && e.message));
    return json(500, { error: 'dispatch_failed' });
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Netlify Scheduled Functions 設定（5 分毎）。cron は docs（PAYMENT_EMAIL_V2.md）に明記。
export const config = {
  schedule: '*/5 * * * *',
};
