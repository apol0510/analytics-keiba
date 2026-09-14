/**
 * cron-marketing-dispatch.js — **積まれたマーケ配信を、人を挟まずに送り切る運転手**
 *
 * ── なぜ要るか（2026-09-14 の本番障害）────────────────────────────────
 * キュー登録（`cron-campaign-sequence`）と実送信（`marketing-campaign-dispatch`）は
 * 別々に動く部品で、**その 2 つを繋ぐ自動経路が無かった**。
 * 送信を起動していたのは `cron-marketing-rollout` だけで、しかも
 * **自分が積んだジョブ（`pendingJobIds`）しか起動しない**。
 *
 * そのため割引キャンペーン（`campaign-discount-*`）は
 * 「10 分ごとに積まれ続けるが 1 通も送られない」状態になった。本番実測:
 *
 *   PENDING 4,307 件 / 宛先スロット 179,250 / 送信 0 通（2026-09-09〜09-14）
 *
 * この Function が欠けていた輪を埋める。**キュー登録はしない**（積むのは sequence 側）。
 *
 * ── 経路を増やさない（重要）────────────────────────────────────────
 * 実送信は従来どおり `marketing-campaign-dispatch`（同期版の dry-run）と
 * `marketing-campaign-dispatch-background`（実送信）だけ。
 * ここが持つのは **「どのジョブを、いくつ、どの順で起動するか」** だけ。
 * 除外・冪等性・二重送信防止・送信直前再検証は**一切変更しない**。
 *
 * ── ゲート ─────────────────────────────────────────────────────────
 *   `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` … 実送信の許可（既定 OFF）
 *
 * ⚠️ **これは「毎回開け閉めするスイッチ」ではない**（2026-09-14 MK 確定）。
 *    通常運用では開けたままにする。止めるのは異常時だけで、
 *    そのときは `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を落とすか、
 *    問題のジョブを `cancelJob` する（**例外運用**であって通常状態ではない）。
 * ⚠️ **Customers を 1 バイトも書かない**（会員・課金・特典・期限を変更しない）。
 */

import {
  planAutoDispatch, resolveMaxJobsPerTick, summarizeAutoDispatch, readWillSend, DEFAULT_COOLDOWN_MS,
} from '../../src/lib/marketing/autoDispatchPlan.js';
import { isMarketingDispatchEnabled, MARKETING_JOB_ID_PREFIX } from '../../src/lib/marketing/marketingDispatchGate.js';
import { handler as dispatchHandler, resolveDispatchSecret } from './marketing-campaign-dispatch.js';
import { makeRedisCmd, makeRedisPipeline } from '../../src/lib/marketing/deliveryKeyStore.js';
import {
  createDispatchLock, TICK_LOCK_ROOT, LOCK_FAIL, isSafeJobId,
} from '../../src/lib/marketing/dispatchLock.js';

const SCHEDULED_TABLE = 'ScheduledEmails';
/**
 * 1 tick で**見る**ジョブ数（起動数の上限とは別。古い順に並べて取る）。
 *
 * ⚠️ 送れないまま溜まった古いジョブが大量にあると、この窓が全部それで埋まり
 *    **新しいジョブが起動されない**（行列の先頭詰まり）。冷却で飛ばしつつ、
 *    窓自体も十分に広く取る。それでも足りない規模の滞留は**掃除が要る**（運用側の判断）。
 */
const CANDIDATE_LIMIT = 500;
/** tick 鍵の寿命（この Function の実行時間より十分長く、次の tick より短く） */
const TICK_LOCK_TTL_SEC = 240;
/** 「送る相手 0 人」だったジョブを覚えておく Redis 鍵の接頭辞 */
const COOLDOWN_ROOT = 'ak:marketing-dispatch:nothing:';

export const DISPATCH_LOG_TAG = '[marketing-dispatch-cron]';

const log = (o) => {
  try { console.log(`${DISPATCH_LOG_TAG} ${JSON.stringify(o)}`); } catch { /* 観測で止めない */ }
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/**
 * 送信待ちのマーケジョブを**古い順に**取る。
 *
 * ⚠️ `maxRecords` + `sort` を使う（ページ打ち切りに当たらないため）。
 *    本番では PENDING が 4,000 件を超えており、全件読みは構造的に失敗する。
 * ⚠️ マーケ以外のジョブ（newsletter / expiry 等）は**引かない**。
 */
async function fetchPendingMarketingJobs({ KEY, BASE, limit }) {
  const formula = "AND({Status}='PENDING',OR({CreatedBy}='admin-marketing',"
    + `LEFT({TargetPlan},9)='campaign:',LEFT({JobId},${MARKETING_JOB_ID_PREFIX.length})='${MARKETING_JOB_ID_PREFIX}'))`;
  const res = await fetch(
    `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(SCHEDULED_TABLE)}/listRecords`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterByFormula: formula,
        pageSize: 100,
        maxRecords: limit,
        sort: [{ field: 'ScheduledFor', direction: 'asc' }],
        fields: ['JobId', 'Status', 'SentCount', 'ScheduledFor', 'TargetPlan', 'CreatedBy', 'Notes'],
      }),
    },
  );
  if (!res.ok) throw new Error(`scheduled_fetch_${res.status}`);
  const data = await res.json();
  return data.records || [];
}

/**
 * 「送る相手が 0 人」だったジョブの再開時刻を読む（読めなければ空＝普通に見る）。
 *
 * ⚠️ 候補は最大 `CANDIDATE_LIMIT` 件あるので、**1 リクエストにまとめる**（pipeline）。
 *    1 件ずつ GET すると tick あたり数百往復になる。
 * ⚠️ 読めないときは「冷却なし」として扱う。冷却は**順番の都合**でしかなく、
 *    読めなくても送信可否・冪等性には影響しない（dry-run が最終判断）。
 */
async function readCooldowns({ pipeline, cmd, jobIds }) {
  const out = new Map();
  const ids = jobIds.filter(Boolean);
  if (ids.length === 0) return out;
  const take = (raw, jobId) => {
    const until = Number(raw && typeof raw === 'object' ? raw.result : raw);
    if (Number.isFinite(until)) out.set(jobId, until);
  };
  if (typeof pipeline === 'function') {
    try {
      const res = await pipeline(ids.map((jobId) => ['GET', `${COOLDOWN_ROOT}${jobId}`]));
      const rows = Array.isArray(res) ? res : [];
      ids.forEach((jobId, i) => take(rows[i], jobId));
      return out;
    } catch { /* pipeline が使えなければ 1 件ずつへ落とす */ }
  }
  if (!cmd) return out;
  for (const jobId of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop -- pipeline が使えないときの退避経路
      const v = await cmd(['GET', `${COOLDOWN_ROOT}${jobId}`]);
      take(v, jobId);
    } catch { /* 読めなければ「冷却なし」 */ }
  }
  return out;
}

/** 「送る相手が 0 人」だったことを覚える（先頭詰まりを避けるためだけの記録） */
async function rememberNothingToSend({ cmd, jobId, nowMs }) {
  if (!cmd) return;
  const until = nowMs + DEFAULT_COOLDOWN_MS;
  try {
    await cmd(['SET', `${COOLDOWN_ROOT}${jobId}`, String(until), 'EX', String(Math.ceil(DEFAULT_COOLDOWN_MS / 1000))]);
  } catch { /* 覚えられなくても動く（次 tick で同じ判断をするだけ） */ }
}

/** 同期 dispatcher を**同じプロセス内で**呼ぶ（read-only の下見だけに使う） */
async function callDispatchDryRun({ jobId }) {
  const secret = resolveDispatchSecret(process.env);
  if (!secret) return { statusCode: 503, body: { error: 'dispatch secret 未設定' } };
  const res = await dispatchHandler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': secret },
    body: JSON.stringify({ dryRun: true, jobId }),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch { parsed = {}; }
  return { statusCode: res.statusCode, body: parsed };
}

/**
 * 1 tick。**テストからはここを呼ぶ**（HTTP の器を挟まない）。
 */
export async function runAutoDispatchTick({ env = process.env, now = Date.now() } = {}) {
  // ── ゲート（既定は閉じている。閉じていれば Airtable にも触らない）──────────
  if (!isMarketingDispatchEnabled(env)) {
    return { ok: false, abort: 'dispatch_disabled', sideEffects: 'none' };
  }
  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { ok: false, abort: 'airtable_not_configured', sideEffects: 'none' };
  const site = String(env.URL || env.DEPLOY_URL || '').replace(/\/$/, '');
  const secret = env.MARKETING_DISPATCH_SECRET || env.MARKETING_ADMIN_SECRET
    || env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!site || !secret) return { ok: false, abort: 'dispatch_not_configured', sideEffects: 'none' };

  let rows;
  try {
    rows = await fetchPendingMarketingJobs({ KEY, BASE, limit: CANDIDATE_LIMIT });
  } catch (e) {
    // ⚠️ 読めないときは**何も起動しない**（分からないまま送らない）
    return { ok: false, abort: 'jobs_unreadable', detail: String((e && e.message) || 'unknown'), sideEffects: 'none' };
  }

  let cmd = null;
  let pipeline = null;
  try { cmd = makeRedisCmd(env); } catch { cmd = null; }
  try { pipeline = makeRedisPipeline(env); } catch { pipeline = null; }
  const cooldownUntilByJobId = await readCooldowns({
    pipeline, cmd, jobIds: rows.map((r) => String(((r && r.fields) || {}).JobId || '')).filter(Boolean),
  });

  const plan = planAutoDispatch({
    jobs: rows, maxJobs: resolveMaxJobsPerTick(env), cooldownUntilByJobId, nowMs: now,
  });

  let started = 0;
  let nothingToSend = 0;
  const failures = [];
  for (const job of plan.start) {
    // ① 起動直前の read-only 下見（**ここが `expectedWillSend` の出どころ**）
    // eslint-disable-next-line no-await-in-loop
    const dry = await callDispatchDryRun({ jobId: job.jobId }).catch(() => null);
    if (!dry || dry.statusCode !== 200) {
      failures.push({ jobId: job.jobId, reason: 'dry_run_failed', status: dry ? dry.statusCode : null });
      continue;
    }
    const w = readWillSend(dry.body, job.jobId);
    if (!w.ok) { failures.push({ jobId: job.jobId, reason: w.reason }); continue; }
    if (w.willSend === 0) {
      /**
       * 送る相手が 0 人。**異常ではない**（全員が既送信・配信停止・バウンス等）。
       * ただし PENDING のまま残るので、**しばらく飛ばす**ようにしておかないと
       * 行列の先頭で詰まって後ろのジョブが永久に進まない。
       * ⚠️ ここでジョブを取り消さない。取り消すと配信行が `queued` のまま残り、
       *    その人たちが「送ったことになって届かない」状態になる。
       */
      nothingToSend += 1;
      // eslint-disable-next-line no-await-in-loop
      await rememberNothingToSend({ cmd, jobId: job.jobId, nowMs: now });
      continue;
    }
    // ② 起動（202 即返し）。実際に送れたかは台帳（ScheduledEmails / CampaignDeliveries）で確かめる
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${site}/.netlify/functions/marketing-campaign-dispatch-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ jobId: job.jobId, expectedWillSend: w.willSend }),
      });
      if (res.status === 202 || res.ok) started += 1;
      else failures.push({ jobId: job.jobId, reason: `http_${res.status}` });
    } catch {
      failures.push({ jobId: job.jobId, reason: 'start_failed' });   // 次 tick が同じ判断で拾う
    }
  }

  const summary = summarizeAutoDispatch({
    planned: plan.start.length, started, skipped: plan.skipped.length, nothingToSend,
  });
  if (failures.length > 0) summary['起動失敗'] = failures.length;
  log({ ...summary, 候補: plan.candidates, 見送り内訳: plan.skippedByReason });

  return {
    ok: true,
    candidates: plan.candidates,
    planned: plan.start.length,
    started,
    nothingToSend,
    skipped: plan.skipped.length,
    skippedByReason: plan.skippedByReason,
    failures,
    sideEffects: started > 0 ? 'dispatch_started' : 'none',
    note: 'ジョブの起動だけを行う。誰に送るかは dispatcher の送信直前再検証が決める。',
  };
}

/** Netlify Functions **v2** のエントリ（`export const config` が効くのはこの形式だけ） */
export default async function handler() {
  /**
   * ⚠️ **同じ tick を重ねて走らせない。** 同じジョブへ並行して dispatch を起動すると、
   *    `alreadySent` は「起動時点のスナップショット」なので**二重送信の余地**ができる。
   *    鍵が取れなければ何もせずに終わる（副作用ゼロ）。
   */
  let lock = null;
  let token = null;
  const lockId = 'tick:auto-dispatch';
  if (isSafeJobId(lockId)) {
    try {
      lock = createDispatchLock({ cmd: makeRedisCmd(process.env), root: TICK_LOCK_ROOT });
      const got = await lock.acquire({ jobId: lockId, ttlSec: TICK_LOCK_TTL_SEC });
      if (!got.ok) {
        const reason = got.reason === LOCK_FAIL.BUSY ? 'tick_busy' : 'tick_lock_unavailable';
        log({ ok: true, action: 'skip', reason, sideEffects: 'none' });
        return json(200, { ok: true, action: 'skip', reason, sideEffects: 'none' });
      }
      token = got.token;
    } catch {
      log({ ok: true, action: 'skip', reason: 'tick_lock_unavailable', sideEffects: 'none' });
      return json(200, { ok: true, action: 'skip', reason: 'tick_lock_unavailable', sideEffects: 'none' });
    }
  }
  try {
    return json(200, await runAutoDispatchTick({ env: process.env, now: Date.now() }));
  } catch (e) {
    log({ ok: false, error: String((e && e.message) || 'unknown') });
    return json(200, { ok: false, error: 'tick_failed', sideEffects: 'unknown' });
  } finally {
    if (lock && token) {
      try { await lock.release({ jobId: lockId, token }); } catch { /* TTL で切れる */ }
    }
  }
}

/**
 * **5 分ごと**。送るものが無ければ 1 件も書かずに終わる（空振りは無害）。
 *
 * ⚠️ キュー登録（`cron-campaign-sequence`）は 10 分ごと。送信側を**それより短く**して、
 *    積まれたぶんが翌 tick までに捌ける形にする。
 */
export const config = {
  schedule: '*/5 * * * *',
};
