/**
 * cron-marketing-rollout.js — 展開の**運転手**（付与 → Step1 登録 → 送信起動を自分で進める）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 部品は揃っていたが、**繋がっていなかった**。
 *   - `cron-light-trial-grant` は付与しかしない（キュー登録も送信もしない）
 *   - キュー登録は管理画面から人が押す（dry-run → 確認 → 登録）
 *   - 送信起動も人が叩く
 * 14,479 名を 100 名ずつ配ると、**この 3 手 × 145 回 = 435 操作**を人がやることになる。
 * さらに `LIGHT_TRIAL_AUTOGRANT_ARMED` は「今日の日付」を要求するので、
 * **毎日 env を書き換えて redeploy** する必要があった。これでは運用にならない。
 *
 * この Function は 1 tick ごとに **1 段階だけ**進める:
 *   ① 展開状態を読む（Redis / 正本）
 *   ② 緊急停止・段階・1 日上限・関所を判定（`rolloutOrchestrator`）
 *   ③ 決まった 1 手を実行する（付与 / queue / 送信起動）
 *   ④ 結果を CAS で書き戻す → 次の tick が続きから進む
 *
 * ── 経路を増やさない（重要）───────────────────────────────────
 * **新しい書き込み経路を 1 本も作らない。** 実際に書くのは既存の 1 本ずつ:
 *   付与        … `runLightTrialGrant`（Customers を書く唯一の経路）
 *   queue 登録  … `admin-marketing` の `dryRun` → `send`（人が押すのと同じ関数）
 *   送信        … `marketing-campaign-dispatch-background`（同期版と同じ `runDispatch`）
 * ここが持つのは**順番と再開の判断だけ**。除外・冪等・二重送信防止は既存のまま。
 *
 * ── 日付 env をやめた（人手を消す本体）────────────────────────
 * 「今日ぶんの武装」は**残す**が、置き場所を env から**展開状態（Redis）**へ移す。
 *   - `stage` が `paused` でない、かつ `killed` でない、かつ `alwaysArmed`（または今日の `armedFor`）
 *   - このときだけ、付与 Function へ渡す env に当日日付を差し込む
 * 停止・再開・1 日上限・段階変更は**管理画面から即時**（redeploy 不要）。
 * ただし `COMEBACK_GRANT_FIELDS_READY` / `COMEBACK_GRANT_ENABLED` /
 * `LIGHT_TRIAL_AUTOGRANT_ENABLED` / `MARKETING_ROLLOUT_ENABLED` は**env のまま**。
 * 「自動化のための抜け道」を作らないため、人間の許可は env に残す。
 *
 * ⚠️ 既定は全部閉じている。env を開けない限り、この Function は**何も書かない**。
 */

import {
  tickRollout, settleTick, describeTick, isRolloutComplete, TICK_ACTION, TICK_BLOCK,
} from '../../src/lib/marketing/rolloutOrchestrator.js';
import {
  createRolloutStore, isRolloutEnabled, RolloutStoreError,
} from '../../src/lib/marketing/rolloutStore.js';
import {
  normalizeRolloutState, jstDay, ROLLOUT_BLOCK, resolveObservationWindow,
} from '../../src/lib/marketing/rolloutPlan.js';
import { createRolloutMetrics } from '../../src/lib/marketing/rolloutMetrics.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { loadAndPlanLightTrial } from '../../src/lib/comeback/lightTrialPlanLoader.js';
import { readAutoGrantGates, GRANT_OPERATION_MAX } from '../../src/lib/comeback/lightTrialAutoGrant.js';
import {
  classifyGrantOutcome, describeGrantOutcome, GRANT_OUTCOME,
} from '../../src/lib/marketing/grantOutcome.js';
import {
  pauseWithRetry, completeWithRetry, describePauseResult, PAUSE_CONFLICT,
} from '../../src/lib/marketing/rolloutPauseGuard.js';
import { readStageGates, canRunStage, describeBlocked, ROLLOUT_STAGE_GATE } from '../../src/lib/marketing/rolloutGates.js';
import { toTouch, JOURNEY_PHASES, MAX_TOUCHES } from '../../src/lib/marketing/journeyModel.js';
import { buildJourneyTotals, toMetricsTotals } from '../../src/lib/marketing/journeyTotals.js';
import { canStartNextBatch, describeBatchHealth } from '../../src/lib/marketing/batchHealth.js';
import {
  captureOutcomeSnapshot, diffOutcomeSnapshot, hasOutcomeBaseline, toStoredOutcome,
} from '../../src/lib/marketing/batchOutcomeSignals.js';
import { readEventWindow } from '../../src/lib/marketing/eventWindowReader.js';
import { readBatchDeliveryKeys } from '../../src/lib/marketing/batchDeliveryKeys.js';
import { runLightTrialGrant } from './cron-light-trial-grant.js';
import { handler as adminMarketingHandler } from './admin-marketing.js';
import { handler as dispatchHandler, resolveDispatchSecret } from './marketing-campaign-dispatch.js';

/**
 * この展開が対象とする道のり。**2 キャンペーンで 1 本**（合計 24 接点）。
 *   体験中     `light-trial-to-premium-sequence`   Step1〜6   → 接点 1〜6
 *   体験終了後 `light-trial-post-expiry-sequence`  Step1〜18  → 接点 7〜24
 * 通し番号の変換は `journeyModel.js` が単一源。
 */
export const ROLLOUT_CAMPAIGN_ID = 'light-trial-to-premium-sequence';
export const POST_EXPIRY_CAMPAIGN_ID = 'light-trial-post-expiry-sequence';
/** 展開状態・集計の鍵は**道のり単位**（キャンペーンが分かれても 1 本として追う） */
const STATE_KEY = ROLLOUT_CAMPAIGN_ID;

/** 付与直後に積むのは必ず 1 通目 */
const STEP1 = 1;

const log = (o) => { try { console.log('🚚 [marketing-rollout]', JSON.stringify(o)); } catch { /* 観測で止めない */ } };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/**
 * 展開状態が「今日動かしてよい」と言っているか。
 *
 * ⚠️ ここが true でも**付与 Function 側の env ゲート**（列の実在・実行許可）は別に要る。
 *    自動化は「日付の置き直し」だけを肩代わりする。
 */
export function isArmedByState(state, nowMs) {
  const s = normalizeRolloutState(state);
  if (s.killed) return false;
  if (s.stage === 'paused') return false;
  return s.alwaysArmed === true || s.armedFor === jstDay(nowMs);
}

/**
 * 付与 Function へ渡す env。**当日日付だけ**を差し込む（他は一切変えない）。
 * 展開状態が武装していなければ**何も差し込まない**（＝付与側で閉じたまま）。
 */
export function armEnvForTick(env, state, nowMs) {
  if (!isArmedByState(state, nowMs)) return env;
  return { ...env, LIGHT_TRIAL_AUTOGRANT_ARMED: jstDay(nowMs) };
}

/**
 * いまの事実を数える。**1 つでも読めなければ null**（推測で進めない）。
 *
 * `grantedPendingQueue` の決め方:
 *   送信待ちジョブが 1 つでもあるなら **0** とする。
 *   その人たちは「付与済みだが Step1 未着」ではあるが、**もう queue には載っている**。
 *   ここを outstanding のまま返すと、同じ人へ二重にジョブを積むことになる
 *   （DeliveryKey で最終的には止まるが、無駄なジョブと混乱が残る）。
 */
export function deriveFacts({
  barrier, moreAvailable, pendingJobs, cohortObserved, candidatesObserved,
  followUpStep, followUpDue,
}) {
  // ⚠️ `Number(null) === 0`。素で Number() に通すと**「読めない」が「0 件」になる**。
  //    0 件と不明は運用上まったく違う（不明で進めると二重付与・二重送信になりうる）。
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const outstanding = barrier ? count(barrier.outstanding) : null;
  const jobs = count(pendingJobs);
  if (outstanding === null || jobs === null) {
    return {
      remainingCandidates: null, remainingIsLowerBound: false,
      grantedPendingQueue: null, pendingJobs: null, outstandingStep1: null,
      followUpStep: null, followUpDue: null,
    };
  }
  // 残数は全件走査しないと確定しないので、**観測できた「配れる人」の数**を使う。
  // ⚠️ 観測は bounded（観測窓ぶんしか取らない）。`moreAvailable === true` のときの
  //    件数は「少なくともこれだけいる」という **下限**であって、全残数ではない。
  //    その旨を `remainingIsLowerBound` で持ち回り、**残日数の断定に使わせない**。
  // ⚠️ `moreAvailable` が分からない場合は **null**（0 と書かない）。
  const observed = count(candidatesObserved) ?? count(cohortObserved);
  let remaining;
  let lowerBound = false;
  if (moreAvailable === false) {
    // 窓の先にはもう居ない。**窓の中で拾えた分は配り切る**（端数を取りこぼさない）。
    // 数えられていなければ 0（先に居ないうえに拾えた数も無い＝配る相手が居ない）
    remaining = observed ?? 0;
  } else if (moreAvailable === true && observed !== null) {
    remaining = Math.max(observed, 1);
    lowerBound = true;
  } else {
    remaining = null;
  }
  return {
    remainingCandidates: remaining,
    remainingIsLowerBound: lowerBound,
    grantedPendingQueue: jobs > 0 ? 0 : outstanding,
    pendingJobs: jobs,
    outstandingStep1: outstanding,
    // ⚠️ 期日は**既存の単一源**が決めた結果をそのまま運ぶ（ここで数え直さない）
    followUpStep: count(followUpStep),
    followUpDue: count(followUpDue),
  };
}

/** admin-marketing を**同じプロセス内で**呼ぶ（人が管理画面から押すのと同じ関数） */
async function callAdminMarketing(body) {
  const secret = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!secret) return { statusCode: 503, body: { error: 'admin secret 未設定' } };
  const res = await adminMarketingHandler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': secret },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch { parsed = {}; }
  return { statusCode: res.statusCode, body: parsed };
}

/**
 * この campaign のジョブを 1 回だけ読む。**fail closed**（読めなければ null）。
 * 送信待ちの数と、状態を追いかけているジョブの結果をここから作る。
 */
async function loadJobs() {
  const res = await callAdminMarketing({ action: 'jobs' });
  if (res.statusCode !== 200 || !res.body || !Array.isArray(res.body.jobs)) return null;
  // **両フェーズ**のジョブを拾う（キャンペーンが分かれても送信の面倒は 1 か所で見る）
  const ours = new Set(JOURNEY_PHASES.map((p) => p.campaignId));
  const mine = res.body.jobs.filter((j) => j && ours.has(String(j.campaignId || '')));
  const pending = mine.filter((j) => j.status === 'PENDING');
  return {
    count: pending.length,
    jobIds: pending.map((j) => String(j.jobId || '')).filter(Boolean),
    byId: new Map(mine.map((j) => [String(j.jobId || ''), j])),
  };
}

/**
 * 終わったジョブの実績を集計へ入れる（**画面のためだけ**）。
 *
 * ⚠️ 送信件数の正本は台帳（`ScheduledEmails` / `CampaignDeliveries`）。
 *    ここは「台帳に出た数を写す」だけで、送信経路には 1 行も触らない。
 *    写し終えたジョブは `pendingJobIds` から外すので、**二重に数えない**。
 */
export function collectFinishedJobs({ pendingJobIds, byId, jobSteps }) {
  const finished = [];
  const stillRunning = [];
  for (const jobId of pendingJobIds || []) {
    const job = byId && byId.get ? byId.get(jobId) : null;
    if (!job) { stillRunning.push(jobId); continue; }      // 見えない = 判断しない
    if (job.status === 'PENDING') { stillRunning.push(jobId); continue; }
    const step = Number((jobSteps || {})[jobId]);
    finished.push({
      jobId,
      // ⚠️ 何通目かが分からないジョブは Step 別集計へ入れない（Step1 に混ぜない）
      step: Number.isFinite(step) && step >= 1 ? step : null,
      sent: Number(job.sentCount) || 0,
      failed: Number(job.failedCount) || 0,
    });
  }
  const sent = finished.reduce((a, j) => a + j.sent, 0);
  const failed = finished.reduce((a, j) => a + j.failed, 0);
  // Step 別の増分（集計へそのまま渡せる形）
  const byStep = {};
  for (const j of finished) {
    if (j.step === null) continue;
    const cur = byStep[j.step] || { sent: 0, failed: 0 };
    byStep[j.step] = { sent: cur.sent + j.sent, failed: cur.failed + j.failed };
  }
  return { finished, stillRunning, sent, failed, byStep };
}

/**
 * 1 通ぶんを積む（**dry-run で対象と文面を確定 → 同じ指紋で登録**）。
 *
 * Step1 は付与の引き継ぎ（`grantOperationId`）、Step2〜24 は
 * 既存の進行判定が選んだ `recordIds` を渡す。**どちらも同じ安全経路**を通る:
 *   dry-run（対象・文面・組み立て版の確定）→ 指紋を持ったまま登録
 */
async function queueStep({ campaignId = ROLLOUT_CAMPAIGN_ID, step, grantOperationId = null, recordIds = null }) {
  const target = grantOperationId ? { grantOperationId } : { recordIds };
  const dry = await callAdminMarketing({
    action: 'dryRun', campaignId, step, ...target,
  });
  if (dry.statusCode !== 200) {
    return { ok: false, stage: 'dryRun', step, status: dry.statusCode, error: dry.body?.error || null };
  }
  const recipients = Number(dry.body?.recipients ?? dry.body?.willSend ?? 0);
  if (!recipients) return { ok: false, stage: 'dryRun', step, error: '対象 0 件', recipients: 0 };

  // ⚠️ dry-run で確認した**そのもの**を積む（指紋・文面・組み立て版を全部持ち回る）
  const live = await callAdminMarketing({
    action: 'send', campaignId, step, ...target,
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  });
  if (live.statusCode !== 200) {
    return { ok: false, stage: 'send', step, status: live.statusCode, error: live.body?.error || null };
  }
  return {
    ok: true,
    // 送信経路が「もう届けた」として弾いた数 = **二重送信の試み**（正常は 0）
    duplicates: Number(live.body?.skippedByReason?.already_delivered
      ?? live.body?.byReason?.already_delivered ?? 0),
    step,
    campaignId,
    /** 通し番号（1〜24）。集計と画面はこちらで数える */
    touch: toTouch(campaignId, step),
    queued: Number(live.body?.queued || 0),
    jobIds: (live.body?.jobs || []).map((j) => String(j.jobId || '')).filter(Boolean),
  };
}

/**
 * 次に流せる Step と対象を**既存の単一源から**受け取る。
 *
 * ⚠️ ここで「送信済み + 1」のような独自判定を持たない。
 *    `action=sequence` は `buildSequenceProgress` / `selectNextDueStep` を通り、
 *    購入・配信停止・ハードバウンス・苦情・provider suppression・対象外・
 *    間隔・頻度上限まで見たうえで「いま流してよい人」だけを返す。
 *    独自に数えると、**止めるべき人へ送る**事故になる。
 */
async function readPhaseDue(campaignId) {
  const res = await callAdminMarketing({ action: 'sequence', campaignId });
  if (res.statusCode !== 200 || !res.body || !res.body.next) return null; // fail closed
  const step = Number(res.body.next.step);
  const recordIds = Array.isArray(res.body.next.recordIds) ? res.body.next.recordIds.map(String) : [];
  return {
    campaignId,
    step: Number.isFinite(step) ? step : null,
    recordIds,
    due: recordIds.length,
    truncated: res.body.next.truncated === true,
    summary: res.body.summary || null,
    nextScheduledAt: res.body.nextScheduledAt || null,
  };
}

/**
 * **両フェーズ**の期日を見て、次に積むものを 1 つ決める。
 *
 * ⚠️ 体験中フェーズを先に見る。期限が切れる直前の人には、
 *    終了後の案内より先に体験中の案内を届けたい。
 * ⚠️ どちらかが**読めなければ null**（fail closed）。片方だけで判断すると、
 *    もう片方の期日を取りこぼしたまま「やることなし」と誤認する。
 */
async function readNextDueStep() {
  const phases = [];
  for (const p of JOURNEY_PHASES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await readPhaseDue(p.campaignId).catch(() => null);
    if (!r) return null;
    phases.push(r);
  }
  const pick = phases.find((r) => r.step && r.due > 0) || phases[0];
  const nextAt = phases
    .map((r) => r.nextScheduledAt).filter(Boolean)
    .sort()[0] || null;
  return { ...pick, phases, nextScheduledAt: pick.nextScheduledAt || nextAt };
}

/** 同期 dispatcher を**同じプロセス内で**呼ぶ（read-only の再確認に使う） */
async function callDispatch(body) {
  const secret = resolveDispatchSecret(process.env);
  if (!secret) return { statusCode: 503, body: { error: 'dispatch secret 未設定' } };
  const res = await dispatchHandler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': secret },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch { parsed = {}; }
  return { statusCode: res.statusCode, body: parsed };
}

/**
 * dry-run の結果から、そのジョブの**いま送る人数**を取り出す。
 *
 * ⚠️ `RecipientCount`（ジョブ作成時の人数）から推測しない。
 *    作成後に配信停止・バウンス・購入・既送信が起きていれば実際の対象は減っており、
 *    古い数を `expectedWillSend` に使うと**送信直前ガードで 409** になって 1 通も出ない。
 *    分からないときは **null**（起動しない）。
 */
export function readWillSend(dryBody, jobId) {
  const results = (dryBody && Array.isArray(dryBody.jobResults)) ? dryBody.jobResults : null;
  if (!results) return { ok: false, reason: 'dry_run_shape_unknown' };
  const row = results.find((r) => r && String(r.jobId) === String(jobId));
  if (!row) return { ok: false, reason: 'job_not_in_dry_run' };
  const n = row.willSend;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: 'will_send_unknown' };
  return {
    ok: true,
    willSend: n,
    willSkip: typeof row.willSkip === 'number' ? row.willSkip : null,
    alreadySent: typeof row.alreadySent === 'number' ? row.alreadySent : null,
    skipByReason: row.skipByReason && typeof row.skipByReason === 'object' ? row.skipByReason : {},
  };
}

/**
 * 送信を起動する。**起動直前に必ず read-only の dry-run を通す。**
 *
 * Background は `expectedWillSend` が無ければ 202 を返して**何も送らない**（安全策）。
 * その安全策は外さず、こちら側が「いま何人へ送るのか」を**そのつど数えて**渡す。
 *
 * ⚠️ **202 は「送れた」ではない。** Background は結果を返せないので、
 *    送信の事実は台帳（ScheduledEmails / CampaignDeliveries）でしか確かめられない。
 *    起動時の送信済み件数を控えておき、次の tick で**台帳が進んだか**を見る。
 */
async function startDispatch({ jobIds, byId }) {
  const secret = process.env.MARKETING_DISPATCH_SECRET
    || process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const site = String(process.env.URL || process.env.DEPLOY_URL || '').replace(/\/$/, '');
  if (!secret || !site) return { ok: false, error: 'dispatch_not_configured', started: 0, skipped: [] };

  let started = 0;
  const skipped = [];
  const watch = {};
  for (const jobId of jobIds) {
    // ① 起動直前の read-only 再確認（**ここが expectedWillSend の出どころ**）
    // eslint-disable-next-line no-await-in-loop
    const dry = await callDispatch({ dryRun: true, jobId }).catch(() => null);
    if (!dry || dry.statusCode !== 200) {
      skipped.push({ jobId, reason: 'dry_run_failed', status: dry ? dry.statusCode : null });
      continue; // 分からないまま起動しない
    }
    const w = readWillSend(dry.body, jobId);
    if (!w.ok) { skipped.push({ jobId, reason: w.reason }); continue; }
    if (w.willSend === 0) {
      // 0 名は異常ではない（全員が既送信・配信停止・バウンス等）。**理由ごと記録して起動しない**
      skipped.push({ jobId, reason: 'will_send_zero', skipByReason: w.skipByReason, alreadySent: w.alreadySent });
      continue;
    }
    // ② 起動（202 即返し）。送信済み件数を控えて、次 tick で台帳の進みを見る
    const before = byId && byId.get ? Number((byId.get(jobId) || {}).sentCount) || 0 : 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${site}/.netlify/functions/marketing-campaign-dispatch-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ jobId, expectedWillSend: w.willSend }),
      });
      if (res.status === 202 || res.ok) {
        started += 1;
        watch[jobId] = before;
      } else {
        skipped.push({ jobId, reason: `http_${res.status}` });
      }
    } catch {
      skipped.push({ jobId, reason: 'start_failed' }); // 次 tick が同じ判断で拾う
    }
  }
  return { ok: started > 0, started, requested: jobIds.length, skipped, watch };
}

/**
 * 前回起動したジョブで**台帳が進んだか**を見る。
 * 進んでいなければ「送信済み」とは扱わず、事実として `stalled` を返す
 *（次 tick は同じ経路をもう一度 dry-run から通す）。
 */
export function checkDispatchProgress({ watch, byId }) {
  const stalled = [];
  const advanced = [];
  for (const [jobId, before] of Object.entries(watch || {})) {
    const job = byId && byId.get ? byId.get(jobId) : null;
    if (!job) continue;                       // 見えない = 判断しない
    const now = Number(job.sentCount) || 0;
    if (now > Number(before)) advanced.push({ jobId, sent: now });
    else if (job.status === 'PENDING') stalled.push({ jobId, sentBefore: Number(before) || 0 });
  }
  return { stalled, advanced };
}

/**
 * 1 tick。**テストからはここを呼ぶ**（I/O は依存注入で差し替えられる）。
 */
export async function runRolloutTick({ env = process.env, now = Date.now(), dryRun = false } = {}) {
  // ── ゲート（既定は全部閉じている）──────────────────────────
  if (!isRolloutEnabled(env)) {
    return { ok: false, abort: 'rollout_disabled', sideEffects: 'none' };
  }
  let redisCmd;
  try { redisCmd = makeRedisCmd(env); } catch { redisCmd = null; }
  if (!redisCmd) return { ok: false, abort: 'redis_not_configured', sideEffects: 'none' };

  const store = createRolloutStore({ cmd: redisCmd });
  let loaded;
  try {
    loaded = await store.load(STATE_KEY);
  } catch (e) {
    // ⚠️ 状態が読めないなら**何もしない**（止まっているつもりで動くのが一番危ない）
    const code = e instanceof RolloutStoreError ? e.code : 'unreachable';
    log({ ok: false, abort: 'state_unreadable', code });
    return { ok: false, abort: 'state_unreadable', code, sideEffects: 'none' };
  }
  const state = normalizeRolloutState(loaded.state);

  // ── 緊急停止（**読み込んだ直後に見る**）────────────────────────
  //    ⚠️ 事実の収集より前に返す。ここから先は集計の書き込み（Redis）や
  //       送信の起動が混ざるので、`killed` のときは**何も書かずに戻る**。
  //    ⚠️ 既に起動済みの Background 送信は取り消せない（走り切る）。
  //       送信経路そのものを閉じる最終手段は
  //       `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を外して redeploy すること。
  if (state.killed === true) {
    const killed = {
      ok: true,
      action: TICK_ACTION.SKIP,
      reason: ROLLOUT_BLOCK.KILLED,
      campaignId: ROLLOUT_CAMPAIGN_ID,
      sideEffects: 'none',
      notice: '緊急停止中です。付与・キュー登録・送信起動をすべて行いません'
        + '（起動済みの送信は走り切ることがあります）。',
    };
    log(killed);
    return killed;
  }

  // ⚠️ **一時停止でも tick は止めない。** 止めるのは新規付与だけで、
  //    積み残しの queue 登録・送信は進める（`planRolloutTick` が付与を断る）。
  //    2026-08-18: ここで早期に抜けていたため、自動停止したときに
  //    **queue 済み 197 通が送信されないまま滞留**した。

  // ── 事実を数える ──────────────────────────────────────────
  const grantGates = readAutoGrantGates(armEnvForTick(env, state, now), now);
  /**
   * ⚠️ **観測窓は展開状態（`batchSize` / 今日の残り枠）に必ず合わせる。**
   *    ここを既定値のままにすると、`batchSize=500` を設定しても付与側の既定
   *    （100 名）でしか候補を見ず、`remainingCandidates` が 100 になり、
   *    **エラーを出さずに** allowance が 100 へ縮む（2026-08-17 の事故）。
   *    窓が 0（今日の残り枠なし・停止中など）のときは既定のまま読むだけ
   *    （どのみち `planRolloutTick` が配らせない）。
   *
   * ⚠️ `perCallMax` は**付与 1 回で実際に扱える上限**（`GRANT_OPERATION_MAX`
   *    = `min(HARD_MAX_BATCH_SIZE 500, MAX_GRANT_RECORDS 200)` = **200**）。
   *    どちらも既存仕様で、**低い方が勝つ**。`batchSize` にこれを超える値
   *    （500 / 1000 など）を設定しても**断らない**。1 回あたりをこの単位で刻み、
   *    残りは次の tick が続きを拾う（`dayGrantedCount` が積み上がるので
   *    `dailyLimit` の意味は変わらない）。
   *    ⚠️ **既定値 100 へ落とすことはしない**（それが 2026-08-17 午前の事故）。
   *    ⚠️ 200 を超えて依頼すると `buildComebackPlan` が計画を作らず
   *       `too_many_records:N>200` で 0 件になる（2026-08-17 午後の事故）。
   */
  const observationWindow = resolveObservationWindow(state, now, {
    perCallMax: GRANT_OPERATION_MAX,
  });
  const planLoad = await loadAndPlanLightTrial({
    env,
    nowMs: now,
    gates: grantGates,
    batchSizeOverride: observationWindow > 0 ? observationWindow : null,
  }).catch(() => null);
  const jobs = await loadJobs().catch(() => null);
  // Step2〜24 の期日は**既存の単一源**（`action=sequence`）に聞く
  const due = await readNextDueStep().catch(() => null);
  const facts = deriveFacts({
    barrier: planLoad?.planned?.barrier || null,
    moreAvailable: planLoad?.fetch ? planLoad.fetch.moreAvailable : null,
    pendingJobs: jobs ? jobs.count : null,
    // ⚠️ 残数は**実際に配れる候補の数**で数える。`cohort.inCohort` は
    //    「読んだ Airtable の行数」なので、除外された人まで数えてしまう。
    candidatesObserved: planLoad?.planned?.counts?.candidates ?? null,
    cohortObserved: planLoad?.planned?.cohort?.inCohort ?? null,
    followUpStep: due ? due.step : null,
    followUpDue: due ? due.due : null,
  });

  // ── 終わったジョブの実績を集計へ写す（画面のためだけ・正本は台帳）──
  //    決断より前にやる。ここを後回しにすると「送ったのに 0 通」と見える時間が伸びる。
  const settledJobs = jobs
    ? collectFinishedJobs({ pendingJobIds: state.pendingJobIds, byId: jobs.byId, jobSteps: state.jobSteps })
    : { finished: [], stillRunning: state.pendingJobIds, sent: 0, failed: 0, byStep: {} };

  // ⚠️ **202 は送信成功ではない。** 前回起動したジョブで台帳が進んだかを確かめる。
  const progress = jobs
    ? checkDispatchProgress({ watch: state.dispatchWatch, byId: jobs.byId })
    : { stalled: [], advanced: [] };

  // ── 何をするか決める ──────────────────────────────────────
  const decision = tickRollout({
    state, nowMs: now, envEnabled: isArmedByState(state, now), facts, env,
  });
  const stageGates = readStageGates(env);
  const view = {
    ...describeTick({ ...decision, gates: stageGates }), facts, campaignId: ROLLOUT_CAMPAIGN_ID,
    settled: { jobs: settledJobs.finished.length, sent: settledJobs.sent, failed: settledJobs.failed },
    /** 起動したのに台帳が進んでいないジョブ（送信済みとは扱わない） */
    dispatchStalled: progress.stalled.map((x) => x.jobId),
    nextDue: due ? {
      campaignId: due.campaignId,
      step: due.step,
      touch: toTouch(due.campaignId, due.step),
      recipients: due.due,
      at: due.nextScheduledAt,
      maxTouches: MAX_TOUCHES,
    } : null,
    blocked: describeBlocked(env),
  };

  if (dryRun) {
    return { ok: true, mode: 'dry-run', sideEffects: 'none', ...view, state };
  }

  const metrics = createRolloutMetrics({ cmd: redisCmd });
  // 集計は**画面のためだけ**。ここが失敗しても運用は止めない（正本は台帳）
  const bumpTotals = async (delta) => {
    try { await metrics.bumpTotals({ campaignId: STATE_KEY, delta, nowMs: now }); } catch { /* 表示だけ */ }
  };
  const bumpSteps = async (delta) => {
    try { await metrics.bumpSteps({ campaignId: STATE_KEY, delta, nowMs: now }); } catch { /* 表示だけ */ }
  };
  /** CAS で書き戻す。競合したら**書かない**（次 tick が読み直して続きから進む） */
  const saveState = async (next) => {
    try {
      await store.save({
        campaignId: STATE_KEY, state: next,
        expectedVersion: loaded.exists ? state.version : null,
      });
      return true;
    } catch (e) {
      log({ ok: false, stage: 'state_write', code: (e && e.code) || 'unknown' });
      return false;
    }
  };

  // ── 進行の内訳を集計へ同期する（**画面が正本を読まなくて済むように**）──
  //    `action=sequence` は既に受信対象だけを名指しで読んでいる。
  //    その結果をここで写しておけば、管理画面は Redis の 2 GET で開ける。
  //    ⚠️ 人を二重に数えないよう、まとめ方は `journeyTotals.js` が単一源。
  if (due && Array.isArray(due.phases)) {
    const active = due.phases.find((p) => p.campaignId === ROLLOUT_CAMPAIGN_ID);
    const post = due.phases.find((p) => p.campaignId === POST_EXPIRY_CAMPAIGN_ID);
    const built = buildJourneyTotals({
      active: active ? active.summary : null,
      postExpiry: post ? post.summary : null,
    });
    if (built.ok) {
      try {
        // ⚠️ **人数だけ**を同期する（Step 別の実績は積み上げたまま残す）
        await metrics.reconcileTotals({
          campaignId: STATE_KEY,
          totals: toMetricsTotals({ totals: built.totals, granted: state.totalGranted }),
          nowMs: now,
        });
      } catch { /* 表示だけ。運用は止めない */ }
    } else {
      log({ ok: false, warn: 'journey_totals_unavailable', reason: built.reason });
    }
  }

  // 集計へ写す（失敗しても運用は止めない）。写した ぶんは追跡対象から外す
  if (settledJobs.finished.length > 0) {
    if (Object.keys(settledJobs.byStep).length > 0) await bumpSteps(settledJobs.byStep);
    state.pendingJobIds = settledJobs.stillRunning;
    // 終わったジョブは対応表からも外す（状態を無限に太らせない）
    for (const j of settledJobs.finished) {
      delete state.jobSteps[j.jobId];
      delete state.dispatchWatch[j.jobId];
    }
    log({ settled: settledJobs.finished.length, sent: settledJobs.sent, failed: settledJobs.failed });
  }
  // 進んだジョブは監視から外す。**進んでいないものは残す**（次 tick で再評価する）
  for (const a of progress.advanced) delete state.dispatchWatch[a.jobId];
  if (progress.stalled.length > 0) {
    log({ ok: false, warn: 'dispatch_no_progress', jobIds: progress.stalled.map((x) => x.jobId) });
  }

  // ── 終端に入る（配る相手が居なくなった）────────────────────────
  //    ⚠️ 候補 0 だけでは終わらせない。関所・queue 待ち・送信待ち・期日待ちが
  //       全部片付いていること（`isRolloutComplete`）を確かめてから入る。
  //    ⚠️ 入れなければ「終わった」と報告しない（次の tick が改めて入れる）。
  const finished = isRolloutComplete({ facts });
  if (finished.done && state.stage !== 'completed') {
    const done = await completeWithRetry({
      store, campaignId: STATE_KEY, nowMs: now, note: 'completed: cohort exhausted',
    });
    const body = {
      ok: done.ok, ...view,
      action: TICK_ACTION.SKIP,
      completed: done.ok,
      abort: done.ok ? null : (done.code || PAUSE_CONFLICT),
      sideEffects: done.ok && done.alreadyCompleted !== true ? 'state_only' : 'none',
      notice: done.ok
        ? '**展開が完了しました**（配る相手がもういません）。以後の tick は何もしません。'
        : '完了の記録が競合しました。まだ完了とは扱いません（次の tick でやり直します）。',
    };
    log(body);
    return body;
  }

  // ⚠️ 実績の写しは**進めない tick でも行う**。
  //    送信を起動した次の tick は普通「今日はもう配った」で skip する。
  //    ここで先に return すると、送ったのに画面が 0 通のまま何日も残る。
  if (decision.action === TICK_ACTION.SKIP) {
    const touched = settledJobs.finished.length > 0 || progress.advanced.length > 0;
    if (touched) await saveState({ ...state });
    log({ ...view, sideEffects: touched ? 'metrics_only' : 'none' });
    return { ok: true, ...view, sideEffects: touched ? 'metrics_only' : 'none' };
  }

  // ⚠️ 判定に使った env と、**実際に実行する env（process.env）**が食い違わないか確かめる。
  //    Function を跨ぐと dispatcher / admin は `process.env` を読むので、
  //    渡された env だけで判断すると「開いているつもりで閉じている」ことが起きる。
  const runtimeBlocked = (stage) => !canRunStage(process.env, stage);

  // ── ① 送信起動（積んだメールを出す。**起動直前に dry-run で人数を確定**）──
  if (decision.action === TICK_ACTION.DISPATCH) {
    if (runtimeBlocked(ROLLOUT_STAGE_GATE.DISPATCH)) {
      return { ok: false, ...view, abort: 'gate_closed_dispatch', sideEffects: 'none' };
    }
    const jobIds = (jobs && jobs.jobIds.length ? jobs.jobIds : state.pendingJobIds) || [];
    if (jobIds.length === 0) {
      return { ok: false, ...view, abort: 'no_job_ids', sideEffects: 'none' };
    }
    const res = await startDispatch({ jobIds, byId: jobs ? jobs.byId : null });
    if (res && res.ok === false && Number(res.started || 0) === 0) {
      // ⚠️ **送信が 1 件も起動できないのは異常**。放置すると queue だけ溜まり続ける
      const paused = await pauseWithRetry({
        store, campaignId: STATE_KEY, nowMs: now,
        note: 'auto-stop: dispatch_failed', reason: 'dispatch_failed',
      });
      const body = {
        ok: false, ...view, abort: 'dispatch_failed',
        autoStopped: paused.ok, pause: describePauseResult(paused),
        dispatch: res, sideEffects: 'none',
        notice: '送信を起動できなかったため**新規付与を止めました**（人が直すまで再開しません）。',
      };
      log(body);
      return body;
    }
    // 起動したジョブだけ「送信済み件数の起点」を控える（次 tick で進みを見る）
    await saveState({ ...state, dispatchWatch: { ...state.dispatchWatch, ...(res.watch || {}) } });
    // ⚠️ 送った件数は**ここでは分からない**（Background は結果を返せない）。台帳が正本。
    log({
      ...view, started: res.started, requested: res.requested,
      skipped: res.skipped, sideEffects: res.started > 0 ? 'dispatch_started' : 'none',
    });
    return {
      ok: res.ok, ...view, dispatch: res,
      sideEffects: res.started > 0 ? 'dispatch_started' : 'none',
      notice: '起動しただけです。**送信できたかは台帳（ScheduledEmails / CampaignDeliveries）で確認します**。',
    };
  }

  // ── ② Step1 を積む（付与の引き継ぎ）──────────────────────────
  if (decision.action === TICK_ACTION.QUEUE) {
    if (runtimeBlocked(ROLLOUT_STAGE_GATE.QUEUE)) {
      return { ok: false, ...view, abort: 'gate_closed_queue', sideEffects: 'none' };
    }
    const opIds = Array.isArray(state.pendingHandoffOps) && state.pendingHandoffOps.length > 0
      ? state.pendingHandoffOps
      : (state.pendingHandoffOp ? [state.pendingHandoffOp] : []);
    const opId = opIds[0] || null;
    // ⚠️ 引き継ぎの記録が無いことは起こりうる（cron が付与の直後に落ちた / 人が手で付与した）。
    //    ここで諦めると、**権利はあるのに案内が一生届かない人**が残る。
    //    その場合は既存の進行判定（`action=sequence`）が「Step1 が期日」と言う人だけを積む。
    //    判定はあくまで単一源に任せるので、止めるべき人へ送ることはない。
    if (!opId) {
      // ⚠️ 救済で積んでよいのは**体験中フェーズの 1 通目**だけ。
      //    終了後フェーズの期日をここで積むと、付与の引き継ぎとは別の相手になる。
      if (!due || due.campaignId !== ROLLOUT_CAMPAIGN_ID
        || due.step !== STEP1 || due.recordIds.length === 0) {
        log({ ...view, skipped: 'no_handoff', sideEffects: 'none' });
        return { ok: false, ...view, abort: 'no_handoff', sideEffects: 'none' };
      }
      const rescue = await queueStep({
        campaignId: ROLLOUT_CAMPAIGN_ID, step: STEP1, recordIds: due.recordIds,
      });
      if (!rescue.ok) {
        log({ ...view, ok: false, stage: rescue.stage, error: rescue.error, sideEffects: 'none' });
        return { ok: false, ...view, abort: 'queue_failed', detail: rescue, sideEffects: 'none' };
      }
      await saveState({
        ...state,
        pendingJobIds: [...state.pendingJobIds, ...rescue.jobIds],
        jobSteps: { ...state.jobSteps, ...Object.fromEntries(rescue.jobIds.map((id) => [id, rescue.touch])) },
      });
      await bumpSteps({ [rescue.touch]: { queued: rescue.queued } });
      log({ ...view, queued: rescue.queued, via: 'sequence', sideEffects: 'queued_only' });
      return { ok: true, ...view, queued: rescue.queued, jobs: rescue.jobIds, sideEffects: 'queued_only' };
    }
    // ⚠️ 論理バッチぶん（最大 3 回の付与）をまとめて積む。**1 tick 1 段階**は保つ
    //    （段階は「queue」のまま。相手が 3 回ぶんに分かれているだけ）。
    const queued = { jobIds: [], count: 0, touch: null, done: [] };
    for (const id of opIds) {
      // eslint-disable-next-line no-await-in-loop -- 付与 op ごとに既存の 1 本を通す
      const one = await queueStep({ campaignId: ROLLOUT_CAMPAIGN_ID, step: STEP1, grantOperationId: id });
      if (!one.ok) {
        // ⚠️ **queue の失敗は自動停止**（放置すると権利だけ付いて案内が届かない）。
        //    済んだぶんは状態へ残し、残りの引き継ぎは次に持ち越す。
        const rest = opIds.filter((x) => !queued.done.includes(x));
        await saveState({
          ...state,
          pendingHandoffOps: rest,
          pendingHandoffOp: null,
          pendingJobIds: [...state.pendingJobIds, ...queued.jobIds],
          jobSteps: { ...state.jobSteps, ...Object.fromEntries(queued.jobIds.map((j) => [j, queued.touch])) },
        });
        const paused = await pauseWithRetry({
          store, campaignId: STATE_KEY, nowMs: now,
          note: `auto-stop: queue_failed:${one.stage || 'unknown'}`, reason: 'queue_failed',
        });
        const body = {
          ok: false, ...view, abort: 'queue_failed',
          autoStopped: paused.ok, pause: describePauseResult(paused),
          queued: queued.count, sideEffects: queued.count > 0 ? 'queued_only' : 'none',
          notice: 'キュー登録に失敗したため**新規付与を止めました**（人が直すまで再開しません）。',
        };
        log(body);
        return body;
      }
      queued.jobIds.push(...one.jobIds);
      queued.count += one.queued;
      queued.touch = one.touch;
      queued.done.push(id);
    }
    const res = { ok: true, jobIds: queued.jobIds, queued: queued.count, touch: queued.touch };
    await saveState({
      ...state, pendingHandoffOp: null, pendingHandoffOps: [],
      pendingJobIds: [...state.pendingJobIds, ...res.jobIds],
      jobSteps: { ...state.jobSteps, ...Object.fromEntries(res.jobIds.map((id) => [id, res.touch])) },
      // ⚠️ 送信経路が `already_delivered` として弾いた数 = **二重送信の試み**。
      //    0 件が正常（DeliveryKey が構造的に防ぐ）。累計で持ち、健全性は差分で見る
      batchDuplicates: Number(state.batchDuplicates || 0) + Number(res.duplicates || 0),
      // ⚠️ **このバッチのジョブ**を控える。健全性のイベントを
      //    「このバッチの通（DeliveryKey）」だけへ絞るための唯一の手掛かり
      lastBatchJobIds: res.jobIds,
    });
    await bumpSteps({ [res.touch]: { queued: res.queued } });
    log({ ...view, queued: res.queued, jobs: res.jobIds.length, sideEffects: 'queued_only' });
    return { ok: true, ...view, queued: res.queued, jobs: res.jobIds, sideEffects: 'queued_only' };
  }

  // ── ③ Step2〜24 を積む（**期日が来た人だけ**）────────────────────
  if (decision.action === TICK_ACTION.FOLLOW_UP) {
    if (runtimeBlocked(ROLLOUT_STAGE_GATE.QUEUE)) {
      return { ok: false, ...view, abort: 'gate_closed_queue', sideEffects: 'none' };
    }
    if (!due || !due.step || due.recordIds.length === 0) {
      // 事実が変わった（誰かが購入・配信停止した等）。**この tick では積まない**
      return { ok: false, ...view, abort: 'no_due_recipients', sideEffects: 'none' };
    }
    const res = await queueStep({
      campaignId: due.campaignId, step: due.step, recordIds: due.recordIds,
    });
    if (!res.ok) {
      log({ ...view, ok: false, stage: res.stage, step: due.step, error: res.error, sideEffects: 'none' });
      return { ok: false, ...view, abort: 'queue_failed', detail: res, sideEffects: 'none' };
    }
    await saveState({
      ...state,
      pendingJobIds: [...state.pendingJobIds, ...res.jobIds],
      jobSteps: { ...state.jobSteps, ...Object.fromEntries(res.jobIds.map((id) => [id, res.touch])) },
    });
    await bumpSteps({ [res.touch]: { queued: res.queued } });
    log({
      ...view, step: due.step, touch: res.touch, campaignId: due.campaignId,
      queued: res.queued, jobs: res.jobIds.length, sideEffects: 'queued_only',
    });
    return {
      ok: true, ...view, step: due.step, touch: res.touch, campaignId: due.campaignId,
      queued: res.queued, jobs: res.jobIds, sideEffects: 'queued_only',
    };
  }

  // ── ④ 付与 ───────────────────────────────────────────────
  if (decision.action === TICK_ACTION.GRANT) {
    if (runtimeBlocked(ROLLOUT_STAGE_GATE.GRANT)) {
      return { ok: false, ...view, abort: 'gate_closed_grant', sideEffects: 'none' };
    }

    // ⚠️ **2 バッチ目以降は、前のバッチの結果を確かめてから始める。**
    //    「1 日 1 回」をやめた代わりに、ここが人の目の役割をする。
    //    数えられない値が 1 つでもあれば進まない（0 件として通さない）。
    const seq = Number(decision.plan && decision.plan.batchSeq) || 1;
    /**
     * ⚠️ 健全性は**累積値ではなく増分**で見る。
     *    `byStopReason.provider_suppressed` は「候補を除外した理由」で、
     *    コホートに元から居る停止リスト該当者がそのまま数えられる。
     *    それを苦情（0 件許容）として渡すと**永久に開始できない**
     *    （2026-08-17: 全コホート開始の 1 tick 目で `complaints_detected` 誤検知）。
     */
    /**
     * ⚠️ 健全性の件数は**前バッチで起きたイベント**だけを、**1 イベント 1 件**で数える。
     *    正本は配信イベント台帳（Blob の NDJSON。Event Webhook が書く）。
     *    - `byStopReason`（いま候補を除外する理由）は使わない
     *      … 母集団が 1 バッチ 500 名増えるだけで増える（2026-08-17 に 2 度誤停止）
     *    - `EmailBlacklist` も使わない
     *      … アドレス 1 行の upsert 台帳で、既存行は `BounceCount+1` の PATCH。
     *        `AddedAt` が古いまま＝**古い登録者の新イベントを取り逃がす**
     *    窓は「このバッチを始めた時刻 → いま」。campaign で絞り、providerEventId で重複を除く。
     */
    /**
     * ⚠️ **直前バッチの通だけ**を見る。campaign と時刻の窓だけでは、
     *    同じ campaign の別バッチ（遅れて届いたイベント）や
     *    別 touch（Step2〜24 の定期便）が混ざる。
     *    バッチの jobIds → `CampaignDeliveries` → DeliveryKey 集合で厳密に絞る。
     * ⚠️ 集合を取り切れなければ `null` のまま渡さず、**イベントも数えない**（fail closed）。
     */
    const batchKeys = await readBatchDeliveryKeys({
      apiKey: process.env.AIRTABLE_API_KEY,
      baseId: process.env.AIRTABLE_BASE_ID,
      jobIds: state.lastBatchJobIds,
    }).catch(() => null);
    const eventWindow = batchKeys && state.healthBaseline && Number(state.healthBaseline.atMs)
      ? await readEventWindow({
        sinceMs: Number(state.healthBaseline.atMs),
        untilMs: now,
        campaignId: ROLLOUT_CAMPAIGN_ID,
        deliveryKeys: batchKeys,
      }).catch(() => null)
      : null;
    const snapshot = captureOutcomeSnapshot({
      jobsSent: jobs
        ? [...jobs.byId.values()]
          .filter((j) => j && j.status !== 'PENDING')
          .reduce((a, j) => a + (Number(j.sentCount) || 0), 0)
        : null,
      jobsFailed: jobs
        ? [...jobs.byId.values()].reduce((a, j) => a + (Number(j.failedCount) || 0), 0)
        : null,
      // 二重送信は DeliveryKey が構造的に防ぐ。送信経路が弾いた数を状態から受け取る
      duplicates: Number(state.batchDuplicates || 0),
      events: eventWindow,
    });
    const baseline = state.healthBaseline;
    // 最初のバッチ（比較相手が無い）は健全性判定を行わない。関所・1 日上限・kill が守る
    if (seq > 1 && hasOutcomeBaseline(baseline)) {
      const delta = diffOutcomeSnapshot(baseline, snapshot);
      const health = canStartNextBatch({
        sent: delta.counts.sent,
        failed: delta.counts.failed,
        // 二重は「同じ人へ同じ touch」が無いこと。台帳の集計が単一源
        duplicates: delta.counts.duplicates,
        bounces: delta.counts.bounces,
        complaints: delta.counts.complaints,
        unsubscribes: delta.counts.unsubscribes,
        previousOutstanding: facts.outstandingStep1,
        suppressionReadable: !!(due && due.summary),
      });
      if (!health.ok) {
        // **自分で止まる**（新規付与だけ止め、積み残しの queue / 送信は進む）
        // ⚠️ 保存が CAS で競合したら「止めた」と報告しない（`pauseWithRetry` が確定させる）
        const paused = await pauseWithRetry({
          store, campaignId: STATE_KEY, nowMs: now, note: `auto-stop: ${health.reason}`,
        });
        const body = paused.ok ? {
          ok: false, ...view, abort: 'batch_health_stop',
          autoStopped: true,
          batchHealth: describeBatchHealth(health),
          pause: describePauseResult(paused),
          sideEffects: 'state_only',
          notice: '前のバッチの結果に問題があったため、新規付与を止めました'
            + '（積み残しのキュー登録・送信は続きます）。',
        } : {
          ok: false, ...view, abort: PAUSE_CONFLICT,
          autoStopped: false,
          batchHealth: describeBatchHealth(health),
          pause: describePauseResult(paused),
          sideEffects: 'none',
          notice: '**停止を確定できませんでした**（展開状態の書き込みが競合）。'
            + '止まったとは報告しません。付与もキュー登録も送信も行っていません。',
        };
        log(body);
        return body;
      }
    }

    const out = await runLightTrialGrant({
      env: armEnvForTick(env, state, now),
      now,
      batchSeq: seq,
      batchSizeOverride: decision.plan ? decision.plan.allowance : null,
    });
    const granted = Number(out?.granted || 0);
    const opId = String(out?.operationId || planLoad?.planned?.operationId || '');

    /**
     * ⚠️ **配る予定があったのに 0 件だったら「実行した」ことにしない。**
     *    2026-08-17 の本番: `too_many_records:400>200` で毎 tick 0 件のまま
     *    `settleTick` が走り、`batchSeq` だけ進んで 14 回空回りした。
     *    - `settle: false` → `batchSeq` も `dayGrantedCount` も `lastRunCount` も動かさない
     *    - `pause: true`  → 人が直すまで新規付与を止める（積み残しの queue / 送信は続く）
     *    - 候補 0（正常な終わり）は**止めない**（`idle`）
     */
    const verdict = classifyGrantOutcome({
      requested: Number(decision.plan?.allowance || 0),
      granted,
      failed: Number(out?.failed || 0),
      abort: out?.abort || null,
    });

    if (verdict.outcome === GRANT_OUTCOME.FAILED) {
      // ⚠️ **「止めた」と言うからには本当に止まっていること。**
      //    CAS 競合で保存できていないのに autoStopped を返さない（読み直して上限つきで再試行）。
      //    どちらの結果でも `settleTick` は呼ばない = batchSeq / dayGrantedCount /
      //    lastRunCount は動かない。Customers への再付与も行わない。
      const paused = await pauseWithRetry({
        store, campaignId: STATE_KEY, nowMs: now,
        note: `auto-stop: ${verdict.detail || verdict.reason}`,
      });
      const body = paused.ok ? {
        ok: false, ...view, abort: verdict.reason,
        autoStopped: true,
        grantOutcome: describeGrantOutcome(verdict),
        pause: describePauseResult(paused),
        granted: 0, failed: Number(out?.failed || 0),
        sideEffects: 'state_only',
        notice: '付与を予定しましたが 1 件も書けませんでした。**空回りを避けるため新規付与を止めます**'
          + '（バッチ番号も日次集計も進めていません。積み残しのキュー登録・送信は続きます）。',
      } : {
        ok: false, ...view, abort: PAUSE_CONFLICT,
        autoStopped: false,
        grantOutcome: describeGrantOutcome(verdict),
        pause: describePauseResult(paused),
        granted: 0, failed: Number(out?.failed || 0),
        sideEffects: 'none',
        notice: '付与は 1 件もできず、**停止も確定できませんでした**（展開状態の書き込みが競合）。'
          + '止まったとは報告しません。次の tick で改めて止めます。',
      };
      log(body);
      return body;
    }

    if (verdict.outcome === GRANT_OUTCOME.IDLE) {
      // 配る相手が居ないだけ。**状態を汚さない**（記録も停止もしない）
      const body = {
        ok: true, ...view, granted: 0,
        grantOutcome: describeGrantOutcome(verdict),
        sideEffects: 'none',
      };
      log(body);
      return body;
    }

    // ⚠️ **付与した数だけ**を刻む（queue が落ちても同じ日に二重に配らない）
    const next = settleTick({
      state, nowMs: now, granted, batchSeq: seq,
      startsNewBatch: decision.plan ? decision.plan.startsNewBatch === true : false,
      // ⚠️ 頼んだ人数に届かなかった = **いま配れる候補が尽きた**。
      //    バッチを閉じて queue → 送信へ進む（埋まるまで待つと先へ行けない）。
      requested: Number(decision.plan?.allowance || 0),
    });
    // ⚠️ 論理バッチ 500 名は付与 3 回（200 + 200 + 100）に分かれる。
    //    **1 回ぶんで上書きせず積む**（上書きすると先の 400 名が queue されない）。
    const handoffs = granted > 0 && opId
      ? [...new Set([...(state.pendingHandoffOps || []), opId])].slice(-10)
      : (state.pendingHandoffOps || []);
    // ⚠️ 新しいバッチを始めたときだけ基準点を置き直す（このバッチの「起点」）。
    //    バッチ途中（200 → 400 → 500）で置き直すと、そのバッチ自身の結果が消える。
    const nextBaseline = decision.plan && decision.plan.startsNewBatch === true
      ? toStoredOutcome(snapshot, now)
      : (state.healthBaseline || toStoredOutcome(snapshot, now));
    await saveState({
      ...next, pendingHandoffOps: handoffs, pendingHandoffOp: null,
      healthBaseline: nextBaseline,
    });
    if (granted > 0) await bumpTotals({ granted });
    log({ ...view, granted, failed: Number(out?.failed || 0), sideEffects: 'granted_only' });
    return { ok: true, ...view, granted, failed: Number(out?.failed || 0), sideEffects: 'granted_only' };
  }

  return { ok: true, ...view, sideEffects: 'none' };
}

/** Netlify Functions v2 のエントリ（下見だけ手動で叩ける） */
export default async function handler(req) {
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const dryRun = body && body.dryRun === true;
  if (dryRun) {
    const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
    const provided = req.headers.get('x-admin-secret');
    if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
    if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  }
  try {
    return json(200, await runRolloutTick({ env: process.env, now: Date.now(), dryRun }));
  } catch (e) {
    log({ ok: false, error: String((e && e.message) || 'unknown') });
    return json(200, { ok: false, error: 'tick_failed', sideEffects: 'unknown' });
  }
}

/**
 * **5 分ごと**。1 tick 1 段階なので、1 バッチは 付与 → queue → 送信起動 の 3 tick で進む。
 *
 * ── なぜ 1 時間ではだめか ────────────────────────────────────
 * 約 15,000 件を 500 名ずつ配ると 30 バッチ = 90 tick。
 * 毎時 1 tick では 90 時間（約 4 日）かかり、「必要なら 1 日で配り切る」に届かない。
 * 5 分間隔なら 90 tick ≈ **7.5 時間**（1000 名ずつなら 45 tick ≈ 3.75 時間）で、
 * 同じ日のうちに完走できる。
 *
 * ⚠️ 速さの上限を決めているのは cron の間隔ではなく**関所**。
 *    前のバッチの Step1 が送り終わるまで次のバッチは始まらないので、
 *    送信基盤が詰まればその分だけ自然に遅くなる。
 * ⚠️ ゲートが閉じていれば接続前に終わる（副作用ゼロ）。空振りの tick は安い。
 */
/**
 * **2 分間隔**。1 tick 1 段階なので、論理バッチ 500 名は
 * 付与 3 回（200 + 200 + 100）+ queue 1 回 + 送信起動 1 回 = **5 tick**で進む。
 * 15,000 名 = 30 バッチ = 150 tick ≈ **5 時間**（5 分間隔だと 12.5 時間で同日に届かない）。
 * ⚠️ 止まっている / 終わっている tick は台帳を読む前に抜けるので、空振りは安い。
 */
export const config = {
  schedule: '*/2 * * * *',
};
