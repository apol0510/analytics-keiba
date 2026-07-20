/**
 * payment-email-dispatcher.js — pending 送信ディスパッチャ（B1・Netlify Scheduled Function 専用）。
 *
 * ロジック本体は src/lib/payments/paymentEmailDispatcher.js（テスト済み）。ここは実 deps 配線と
 * gate/pause/A2 の fail-closed 判定、30 秒上限に対する deadline 計算のみ。
 *
 * 起動経路（Netlify 公式仕様）:
 * - **Scheduled 実行のみ**（`export const config.schedule`）。5 分毎。Netlify が内部起動する。
 * - **公開 URL から直接呼び出せない**（プラットフォームが遮断）。手動確認は Netlify UI の
 *   Functions 画面 →「Run now」。→ よって URL POST 用の認証分岐は持たない。
 *
 * fail-closed（送信を開始する絶対条件。1 つでも欠ければ 0 件で終了）:
 * - `validateEmailGates()` の mode が **v2-worker / v2-full** であること。
 *   このモードは構造的に flow=v2 ∧ workerSend ∧ pause=false ∧ a2DisabledConfirmed=true を含む。
 *   → legacy / paused / v2-dry-run では**送信を一切開始しない**（A2 未停止・pause 時も同様）。
 * - 各レコードの送信可否（送信元契約 / SENDGRID / schema preflight / IdempotencyKey / eligible /
 *   lock+fencing）は runWorkerOnce が個別に fail-closed 判定する。dispatcher はそれを起動するだけ。
 *
 * 30 秒上限対応:
 * - **1 実行最大 3 件**（MAX_RECORDS）。1 件の最悪経路は Airtable GET/PATCH/read-back +
 *   schema preflight + Upstash lock + SendGrid POST + 結果 PATCH + lock 解放 で ~8 往復。
 *   3 件でも安全マージン内。超過分は次回スケジュールへ。
 * - **deadline guard**（DEADLINE_MS = 25s）。開始から 25 秒に達したら新規レコードの処理を開始しない。
 *   処理途中で強制終了しても、record 単位 lock/fencing/state machine が二重送信を防ぐ
 *   （lease 期限切れ / unknown_after_attempt は reconciler が確定）。
 *
 * PII 非出力: 応答・ログには status/reason の**件数集計だけ**。recordId / Email / secret を出さない。
 */

import { dispatchPendingBatch } from '../../src/lib/payments/paymentEmailDispatcher.js';
import { parseGatesFromEnv, validateEmailGates } from '../../src/lib/payments/paymentEmailState.js';
import { makeDispatcherDeps } from '../../src/lib/payments/paymentEmailDeps.js';

// 1 実行あたりの最大処理件数（30 秒上限に安全に収める。超過は次回スケジュールへ）。
const MAX_RECORDS = 3;
// deadline: 実行開始から 25 秒（30 秒上限に対する安全マージン）。
const DEADLINE_MS = 25_000;

export default async function handler() {
  // gate fail-closed。v2-worker / v2-full 以外は送信を開始しない。
  const gate = validateEmailGates(parseGatesFromEnv(process.env));
  if (!gate.ok || (gate.mode !== 'v2-worker' && gate.mode !== 'v2-full')) {
    return json(200, { dispatched: false, mode: gate.mode, reason: 'not_sending_mode' });
  }

  const now = Date.now();
  try {
    const result = await dispatchPendingBatch({
      now,
      maxRecords: MAX_RECORDS,
      deadlineAt: now + DEADLINE_MS,
      deps: makeDispatcherDeps(),
    });
    // result は非機密（listed/processed/byOutcome/errors/deadlineStopped のみ）。
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
// 公開 URL からは呼べない。手動確認は Netlify UI の「Run now」。
export const config = {
  schedule: '*/5 * * * *',
};
