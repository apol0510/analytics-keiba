/**
 * sequence-canary-background.js — prospect canary の**重い処理はここだけが実行する**
 *   （Background / 最大 15 分）
 *
 * ── なぜ Background なのか（2026-09-15 本番実測）──────────────────
 *
 * canary を同期 Function（`admin-marketing`）から走らせたら **HTTP 504（31 秒）**。
 * 関数の完了ログすら出ず、打ち切られていた。書き込みは 1 件も起きていない
 * （SentCount / FailedCount / EmailBlacklist / prospect 予約・delivered すべて不変）。
 *
 * 原因は単純で、`runSequenceTick` が
 *   配信台帳の走査 ＋ prospect 索引 11,971 件の読み込み ＋ 送信元の停止リスト照合
 * を行うため、同期 Function の制限時間に収まらない。
 *
 * **これは #529 が DRM の入口で解決済みの問題と同型**（`drm-entry-background`）。
 * 同じ形に揃える。
 *
 * ── ここがやること ────────────────────────────────────────────
 *
 * **既存の `runSequenceTick()` を呼ぶだけ。** 送信ループも安全判定も新しく作らない。
 *
 *   受け付け判定        `sequenceCanaryPolicy.checkCanaryRequest`（①と同じ単一源）
 *   多重起動の防止      定期 tick と**同じ鍵**（`tick:campaign-sequence`）
 *   出所の混入          `runSequenceTick` の `audience_source_mixed`（予約より手前）
 *   件数のズレ          `runSequenceTick` の `expected_count_mismatch`（予約より手前）
 *   除外 / 二重送信     `runSequenceTick`（購入・停止・blacklist・既送信・`DeliveryKey`）
 *
 * ⚠️ **呼び出し側から「誰に送るか」を受け取らない。** payload は
 *    `campaignId` / `sourceFilter` / `maxPerTick` / `expectedCount` / `confirm` /
 *    `apply` / `runId` だけで、アドレスも recordId も含まない。
 *    対象はここで読み直すので、送信直前の再検証が短絡しない。
 * ⚠️ **①を信用しない。** 公開 URL なので直接叩かれ得る。判定をここでもう一度やる。
 * ⚠️ 公開 URL なので **`x-admin-secret` を必須**にする。
 * ⚠️ **202 即返し。** 結果は返さない。`ScheduledEmails` / `prospectSequenceCheck` /
 *    このログで確認する。
 * ⚠️ 開けるのは**スケジューラ判定 1 つだけ**。停止用のゲート
 *    （`MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED`）はそのまま渡す＝
 *    閉じていれば `gates_closed` で止まる。
 */

import {
  runSequenceTick, SEQUENCE_TICK_LOCK_ID, SEQUENCE_TICK_LOCK_TTL_SEC,
} from './cron-campaign-sequence.js';
import { checkCanaryRequest } from '../../src/lib/marketing/sequenceCanaryPolicy.js';
import { SEQUENCE_ENV } from '../../src/lib/marketing/sequenceAutomation.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { createDispatchLock, TICK_LOCK_ROOT, LOCK_FAIL } from '../../src/lib/marketing/dispatchLock.js';

export const CANARY_BG_LOG_TAG = '[sequence-canary-bg]';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});
const log = (payload) => {
  try { console.log(`${CANARY_BG_LOG_TAG} ${JSON.stringify(payload)}`); } catch { /* 観測失敗で止めない */ }
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') return json(200, {});
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // 🛡️ 公開 URL への直接 POST を弾く
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  if (request.headers.get('x-admin-secret') !== SECRET) return json(403, { error: 'Forbidden' });

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const runId = String(body.runId || '').trim();

  // ⚠️ ①の判定を信用せず、**同じ単一源でもう一度**確かめる
  const checked = checkCanaryRequest(body);
  if (!checked.ok) {
    log({ event: 'refused', runId, refuse: checked.refuse });
    return json(202, { accepted: false, runId, refuse: checked.refuse });
  }

  log({
    event: 'start', runId,
    campaignId: checked.campaignId, sourceFilter: checked.sourceFilter,
    maxPerTick: checked.maxPerTick, expectedCount: checked.expectedCount,
  });

  /**
   * 定期 tick と**同じ鍵**を取る。取れなければ何もしない
   *   （定期 tick と同時に走ると、上限も期待件数も意味を失う）。
   * ⚠️ `acquire` が返すのは `{ ok, token }`。生のトークンではない。
   */
  let lock = null;
  let token = null;
  try {
    lock = createDispatchLock({ cmd: makeRedisCmd(process.env), root: TICK_LOCK_ROOT });
    const got = await lock.acquire({
      jobId: SEQUENCE_TICK_LOCK_ID, ttlSec: SEQUENCE_TICK_LOCK_TTL_SEC,
    });
    if (!got.ok) {
      const reason = got.reason === LOCK_FAIL.BUSY ? 'tick_busy' : 'tick_lock_unavailable';
      log({ event: 'skip', runId, reason, sideEffects: 'none' });
      return json(202, { accepted: false, runId, reason });
    }
    token = got.token;
  } catch {
    // 鍵を用意できないときは**走らせない**（多重起動を防げない状態で送らない）
    log({ event: 'skip', runId, reason: 'tick_lock_unavailable', sideEffects: 'none' });
    return json(202, { accepted: false, runId, reason: 'tick_lock_unavailable' });
  }

  let out;
  try {
    out = await runSequenceTick({
      // スケジューラ判定だけを**この呼び出しの中で**開ける。production env は触らない
      env: { ...process.env, [SEQUENCE_ENV.SCHEDULER]: 'true' },
      now: Date.now(),
      campaignId: checked.campaignId,
      sourceFilter: checked.sourceFilter,
      expectedCount: checked.expectedCount,
      maxRecipientsOverride: checked.maxPerTick,
    });
  } catch (e) {
    log({ event: 'error', runId, error: String((e && e.message) || 'unknown') });
    return json(202, { accepted: true, runId });
  } finally {
    if (lock && token) {
      try { await lock.release({ jobId: SEQUENCE_TICK_LOCK_ID, token }); } catch { /* TTL で切れる */ }
    }
  }

  // ⚠️ 値・アドレスは出さない。件数と理由コードだけ
  log({
    event: 'done', runId,
    campaignId: checked.campaignId,
    ok: out && out.ok !== false,
    abort: (out && out.abort) || null,
    step: (out && out.step) ?? null,
    enqueued: (out && out.enqueued) ?? null,
    failed: (out && out.failed) ?? null,
    sideEffects: (out && out.sideEffects) || null,
  });

  // Background は結果を返さない契約。台帳とログで確認する
  return json(202, { accepted: true, runId });
}
