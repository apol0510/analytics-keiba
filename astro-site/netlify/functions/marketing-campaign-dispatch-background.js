/**
 * marketing-campaign-dispatch-background.js — 大きいジョブを**最後まで**送る（Background Function）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 同期の `marketing-campaign-dispatch` は Netlify の上限 26 秒で kill される。
 * 1 通ごとに SendGrid 送信 + Airtable PATCH を行うので、
 * **100 通を超えるジョブは 1 回で終わらない**（2026-08-15 の設計監査）。
 *
 * Background Function は最大 15 分動けるので、
 * 「時間予算で切る → 続きから再開」を**関数の中で繰り返して**完走させる。
 * これは `execute-scheduled-emails-background.js` が 2026-05-22 に採った形と同じで、
 * 実績のあるパターンをそのまま使う（新しい仕組みを増やさない）。
 *
 * ── 送信経路は増やさない ──────────────────────────────────────
 * 実際に送るのは**同期版と同じ `dispatch()`**（`marketing-campaign-dispatch.js` の
 * `runDispatch` を import する）。ここがやるのは
 *   ① 排他を取る ② 予算内で送る ③ 残りがあれば繰り返す ④ 解放する
 * だけで、送信条件の再検証・除外・冪等性は 1 行も持たない。
 *
 * ── 呼び出し方 ────────────────────────────────────────────────
 *   POST /.netlify/functions/marketing-campaign-dispatch-background
 *   { "jobId": "mkt-...", "expectedWillSend": 500 }
 *   → **202 即返し**。結果は Airtable（ScheduledEmails / CampaignDeliveries）で確認する。
 *
 * ⚠️ Background Function は結果を返せない。**送信件数は台帳が正本**。
 * ⚠️ dryRun はこの経路を使わない（同期版で確認する）。
 */

import { runDispatch, resolveDispatchSecret } from './marketing-campaign-dispatch.js';
// ⚠️ ゲート判定は**専用モジュールの単一源**を使う（同期版と同じ関数）
import { isMarketingDispatchEnabled } from '../../src/lib/marketing/marketingDispatchGate.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import {
  createDispatchLock, DISPATCH_LOCK_BACKGROUND_TTL_SEC, assertBackgroundTtlCovers,
  LOCK_FAIL, DispatchLockError,
} from '../../src/lib/marketing/dispatchLock.js';
import { DEFAULT_BACKGROUND_BUDGET_MS } from '../../src/lib/marketing/sendBudget.js';

/** 1 回の起動で回すチャンクの上限（無限ループの backstop） */
const MAX_CHUNKS = 50;

/** 1 チャンクあたりの予算。合計が Background の上限（15 分）を超えないようにする */
const CHUNK_BUDGET_MS = 60_000;

const log = (o) => console.log('📣 [marketing-dispatch-bg]', o);

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };

  const SECRET = resolveDispatchSecret(process.env);
  if (!SECRET) { log({ ok: false, error: 'secret_missing' }); return { statusCode: 202, body: '' }; }
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) { log({ ok: false, error: 'forbidden' }); return { statusCode: 202, body: '' }; }

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { req = {}; }

  // 🛡️ 実送信ゲートは同期版と同じ。**既定 OFF**
  if (!isMarketingDispatchEnabled(process.env)) {
    log({ ok: false, error: 'dispatch_disabled' });
    return { statusCode: 202, body: '' };
  }
  const jobId = req.jobId ? String(req.jobId) : null;
  if (!jobId) { log({ ok: false, error: 'job_id_required' }); return { statusCode: 202, body: '' }; }
  const expectedWillSend = Number(req.expectedWillSend);
  if (!Number.isFinite(expectedWillSend)) {
    log({ ok: false, error: 'expected_will_send_required' });
    return { statusCode: 202, body: '' };
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  const SG = process.env.SENDGRID_API_KEY;
  if (!KEY || !BASE || !SG) { log({ ok: false, error: 'credentials_missing' }); return { statusCode: 202, body: '' }; }

  // ── 排他（同期版と同じ鍵。**同じジョブを 2 本走らせない**）──────────
  let lock;
  try {
    lock = createDispatchLock({ cmd: makeRedisCmd(process.env) });
  } catch {
    log({ ok: false, error: LOCK_FAIL.UNAVAILABLE, jobId });
    return { statusCode: 202, body: '' };
  }
  // ⚠️ **同期用の TTL を流用しない。** Background は最大 8 分動くので、
  //    300 秒だと送信の途中で排他が切れ、別実行が同じジョブを取れてしまう。
  //    起動前に「TTL が 予算 + 1 チャンク + 後片付け を覆っているか」を確かめる。
  const ttlCheck = assertBackgroundTtlCovers({
    ttlSec: DISPATCH_LOCK_BACKGROUND_TTL_SEC,
    budgetMs: DEFAULT_BACKGROUND_BUDGET_MS,
    chunkMs: CHUNK_BUDGET_MS,
  });
  if (!ttlCheck.ok) {
    log({ ok: false, error: 'lock_ttl_too_short', needMs: ttlCheck.needMs, haveMs: ttlCheck.haveMs, jobId });
    return { statusCode: 202, body: '' };
  }

  let token = null;
  try {
    const got = await lock.acquire({ jobId, ttlSec: DISPATCH_LOCK_BACKGROUND_TTL_SEC });
    if (!got.ok) { log({ ok: false, error: LOCK_FAIL.BUSY, jobId }); return { statusCode: 202, body: '' }; }
    token = got.token;
  } catch (e) {
    log({ ok: false, error: (e instanceof DispatchLockError && e.code) || LOCK_FAIL.UNAVAILABLE, jobId });
    return { statusCode: 202, body: '' };
  }

  const startedAt = Date.now();
  let chunks = 0;
  let sent = 0;
  let failed = 0;
  let remaining = null;
  let lockLost = false;
  try {
    // ② 予算内で送る → ③ 残りがあれば繰り返す
    while (chunks < MAX_CHUNKS) {
      if (Date.now() - startedAt > DEFAULT_BACKGROUND_BUDGET_MS) break;
      chunks += 1;
      // 🛡️ **各チャンクの開始前に、鍵がまだ自分のものか確かめて延長する。**
      //    失っていたら（TTL 切れ・奪取）**即停止し、以後 1 通も送らない**。
      // eslint-disable-next-line no-await-in-loop
      const held = await lock.renew({ jobId, token, ttlSec: DISPATCH_LOCK_BACKGROUND_TTL_SEC })
        .catch((e) => ({ ok: false, reason: (e && e.code) || LOCK_FAIL.UNAVAILABLE }));
      if (!held.ok) {
        lockLost = true;
        log({ ok: false, error: 'lock_lost', reason: held.reason, jobId, chunks, sent });
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- チャンクは順に処理する
      const res = await runDispatch({
        KEY, BASE, SG, dryRun: false, jobIdFilter: jobId,
        // 1 チャンク目だけ人数を確認する（2 回目以降は既送信ぶん減っているのが正常）
        expectedWillSend: chunks === 1 ? expectedWillSend : null,
        lock, lockToken: token,
        budgetMs: CHUNK_BUDGET_MS, startedAtMs: Date.now(),
      });
      let body;
      try { body = JSON.parse(res.body || '{}'); } catch { body = {}; }
      if (res.statusCode !== 200) {
        log({ ok: false, error: body.error || `http_${res.statusCode}`, code: body.code || null, jobId, chunks });
        break;
      }
      sent += Number(body.sent) || 0;
      failed += Number(body.failed) || 0;
      remaining = Number.isFinite(Number(body.remaining)) ? Number(body.remaining) : 0;
      // 送るものが無くなった / 進まなくなった なら終わり
      if (!remaining || remaining <= 0) break;
      if ((Number(body.sent) || 0) === 0) {
        log({ ok: false, error: 'no_progress', jobId, chunks, remaining });
        break;
      }
    }
  } catch (e) {
    log({ ok: false, error: 'chunk_failed', detail: String((e && e.message) || 'unknown'), jobId, chunks });
  } finally {
    // ④ 解放。**失敗しても送信結果は台帳が正本**なので、理由コードだけ残す。
    //    ⚠️ 鍵を失っている場合は解放しない（**他実行が取った鍵を消さない**）。
    if (lockLost) {
      log({ ok: false, error: 'lock_release_skipped', reason: 'not_owner', jobId });
    } else {
      try {
        const rel = await lock.release({ jobId, token });
        if (!rel.ok) log({ ok: false, error: 'lock_release_failed', reason: rel.reason, jobId });
      } catch (e) {
        log({ ok: false, error: 'lock_release_failed', reason: (e && e.code) || LOCK_FAIL.UNAVAILABLE, jobId });
      }
    }
  }

  // ⚠️ アドレスは 1 つも出さない（件数と jobId だけ）
  log({
    ok: !lockLost, jobId, chunks, sent, failed, remaining,
    elapsedMs: Date.now() - startedAt,
    complete: !lockLost && remaining === 0,
    lockLost,
  });
  return { statusCode: 202, body: '' };
};

export default handler;
