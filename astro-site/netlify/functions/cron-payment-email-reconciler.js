/**
 * cron-payment-email-reconciler.js — reconciler の Scheduled 配線（B2）。
 *
 * 既存の手動 POST 経路 `payment-email-reconciler.js` は**変更しない**。Scheduled 実行を
 * この別ファイルに分離し、同じコア（reconcileUnknownBatch）を**同一プロセスで**呼ぶ。
 *
 * 15 分毎。unknown_after_attempt を SendGrid Activity で照合する。
 *
 * fail-closed / 書込み可否:
 * - mode が **v2-dry-run / v2-worker / v2-full** 以外なら何もしない（legacy では 0 件）。
 * - **書込みは mode=v2-full かつ reconcilerWrite=true のときだけ**（それ以外は dryRun=true = no-op）。
 * - 0 件判定は Activity が **HTTP 200 かつ messages=[]** のときだけ（4xx/5xx/timeout/parse 失敗は unknown 維持）。
 *   判定は reconciler コア（classifyActivityResult / decideReconcile）に集約。
 *
 * dispatcher（pending 対象）とは**対象 status が異なる**（reconciler=unknown_after_attempt）ため、
 * 同一レコードを競合処理しない。重複起動防止に reconcile 単位ロックを取る。
 *
 * PII 非出力: 応答・ログは集計（count / byAction / dryRun）のみ。recordId / Email を出さない。
 */

import { reconcileUnknownBatch } from '../../src/lib/payments/paymentEmailReconciler.js';
import { parseGatesFromEnv, validateEmailGates } from '../../src/lib/payments/paymentEmailState.js';
import { makeReconcilerDeps, makeSchedulerLockDeps } from '../../src/lib/payments/paymentEmailDeps.js';

const RECONCILE_LOCK_KEY = 'payemail:reconcile';

export default async function handler() {
  const gate = validateEmailGates(parseGatesFromEnv(process.env));
  if (!gate.ok || (gate.mode !== 'v2-dry-run' && gate.mode !== 'v2-worker' && gate.mode !== 'v2-full')) {
    return json(200, { reconciled: false, mode: gate.mode, reason: 'not_reconcile_mode' });
  }
  // 書込みは v2-full のときだけ。それ以外は dry-run（no-op で「何を書くか」だけ算出）。
  const dryRun = gate.mode !== 'v2-full';

  // reconcile 単位ロック（重複起動・並行 Scheduled を防ぐ）。
  const { acquireLock, releaseLock } = makeSchedulerLockDeps();
  const lock = await acquireLock(RECONCILE_LOCK_KEY);
  if (!lock || !lock.ok) return json(200, { reconciled: false, skipped: 'reconcile_locked' });

  try {
    const { count, byAction } = await reconcileUnknownBatch({ now: Date.now(), dryRun, deps: makeReconcilerDeps() });
    // per-record の id は返さない（集計のみ）。
    return json(200, { reconciled: true, mode: gate.mode, dryRun, count, byAction });
  } catch (e) {
    console.error('[cron-payment-email-reconciler] error:', String(e && e.message));
    return json(500, { error: 'reconcile_failed' });
  } finally {
    await releaseLock(RECONCILE_LOCK_KEY, lock.token);
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Netlify Scheduled Functions 設定（15 分毎）。cron は docs（PAYMENT_EMAIL_V2.md）に明記。
export const config = {
  schedule: '*/15 * * * *',
};
