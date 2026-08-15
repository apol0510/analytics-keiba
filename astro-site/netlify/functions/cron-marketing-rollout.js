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
  tickRollout, settleTick, describeTick, TICK_ACTION, TICK_BLOCK,
} from '../../src/lib/marketing/rolloutOrchestrator.js';
import {
  createRolloutStore, isRolloutEnabled, RolloutStoreError,
} from '../../src/lib/marketing/rolloutStore.js';
import { normalizeRolloutState, jstDay } from '../../src/lib/marketing/rolloutPlan.js';
import { createRolloutMetrics } from '../../src/lib/marketing/rolloutMetrics.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { loadAndPlanLightTrial } from '../../src/lib/comeback/lightTrialPlanLoader.js';
import { readAutoGrantGates } from '../../src/lib/comeback/lightTrialAutoGrant.js';
import { readStageGates, canRunStage, describeBlocked, ROLLOUT_STAGE_GATE } from '../../src/lib/marketing/rolloutGates.js';
import { runLightTrialGrant } from './cron-light-trial-grant.js';
import { handler as adminMarketingHandler } from './admin-marketing.js';
import { handler as dispatchHandler, resolveDispatchSecret } from './marketing-campaign-dispatch.js';

/** この展開が対象とするキャンペーン（連続配信 24 通） */
export const ROLLOUT_CAMPAIGN_ID = 'light-trial-to-premium-sequence';

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
export function deriveFacts({ barrier, moreAvailable, pendingJobs, cohortObserved, followUpStep, followUpDue }) {
  // ⚠️ `Number(null) === 0`。素で Number() に通すと**「読めない」が「0 件」になる**。
  //    0 件と不明は運用上まったく違う（不明で進めると二重付与・二重送信になりうる）。
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const outstanding = barrier ? count(barrier.outstanding) : null;
  const jobs = count(pendingJobs);
  if (outstanding === null || jobs === null) {
    return {
      remainingCandidates: null, grantedPendingQueue: null, pendingJobs: null, outstandingStep1: null,
      followUpStep: null, followUpDue: null,
    };
  }
  // 残数は全件走査しないと確定しないので、「まだ候補がある」を件数の代わりに使う。
  // ⚠️ `moreAvailable` が分からない場合は **null**（0 と書かない）。
  let remaining;
  if (moreAvailable === true) remaining = Number(cohortObserved) || 1;
  else if (moreAvailable === false) remaining = 0;
  else remaining = null;
  return {
    remainingCandidates: remaining,
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
  const mine = res.body.jobs.filter((j) => j && String(j.campaignId || '') === ROLLOUT_CAMPAIGN_ID);
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
async function queueStep({ step, grantOperationId = null, recordIds = null }) {
  const target = grantOperationId ? { grantOperationId } : { recordIds };
  const dry = await callAdminMarketing({
    action: 'dryRun', campaignId: ROLLOUT_CAMPAIGN_ID, step, ...target,
  });
  if (dry.statusCode !== 200) {
    return { ok: false, stage: 'dryRun', step, status: dry.statusCode, error: dry.body?.error || null };
  }
  const recipients = Number(dry.body?.recipients ?? dry.body?.willSend ?? 0);
  if (!recipients) return { ok: false, stage: 'dryRun', step, error: '対象 0 件', recipients: 0 };

  // ⚠️ dry-run で確認した**そのもの**を積む（指紋・文面・組み立て版を全部持ち回る）
  const live = await callAdminMarketing({
    action: 'send', campaignId: ROLLOUT_CAMPAIGN_ID, step, ...target,
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  });
  if (live.statusCode !== 200) {
    return { ok: false, stage: 'send', step, status: live.statusCode, error: live.body?.error || null };
  }
  return {
    ok: true,
    step,
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
async function readNextDueStep() {
  const res = await callAdminMarketing({ action: 'sequence', campaignId: ROLLOUT_CAMPAIGN_ID });
  if (res.statusCode !== 200 || !res.body || !res.body.next) return null; // fail closed
  const step = Number(res.body.next.step);
  const recordIds = Array.isArray(res.body.next.recordIds) ? res.body.next.recordIds.map(String) : [];
  return {
    step: Number.isFinite(step) ? step : null,
    recordIds,
    due: recordIds.length,
    truncated: res.body.next.truncated === true,
    summary: res.body.summary || null,
    nextScheduledAt: res.body.nextScheduledAt || null,
  };
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
    loaded = await store.load(ROLLOUT_CAMPAIGN_ID);
  } catch (e) {
    // ⚠️ 状態が読めないなら**何もしない**（止まっているつもりで動くのが一番危ない）
    const code = e instanceof RolloutStoreError ? e.code : 'unreachable';
    log({ ok: false, abort: 'state_unreadable', code });
    return { ok: false, abort: 'state_unreadable', code, sideEffects: 'none' };
  }
  const state = normalizeRolloutState(loaded.state);

  // ── 事実を数える ──────────────────────────────────────────
  const grantGates = readAutoGrantGates(armEnvForTick(env, state, now), now);
  const planLoad = await loadAndPlanLightTrial({ env, nowMs: now, gates: grantGates }).catch(() => null);
  const jobs = await loadJobs().catch(() => null);
  // Step2〜24 の期日は**既存の単一源**（`action=sequence`）に聞く
  const due = await readNextDueStep().catch(() => null);
  const facts = deriveFacts({
    barrier: planLoad?.planned?.barrier || null,
    moreAvailable: planLoad?.fetch ? planLoad.fetch.moreAvailable : null,
    pendingJobs: jobs ? jobs.count : null,
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
    nextDue: due ? { step: due.step, recipients: due.due, at: due.nextScheduledAt } : null,
    blocked: describeBlocked(env),
  };

  if (dryRun) {
    return { ok: true, mode: 'dry-run', sideEffects: 'none', ...view, state };
  }

  const metrics = createRolloutMetrics({ cmd: redisCmd });
  // 集計は**画面のためだけ**。ここが失敗しても運用は止めない（正本は台帳）
  const bumpTotals = async (delta) => {
    try { await metrics.bumpTotals({ campaignId: ROLLOUT_CAMPAIGN_ID, delta, nowMs: now }); } catch { /* 表示だけ */ }
  };
  const bumpSteps = async (delta) => {
    try { await metrics.bumpSteps({ campaignId: ROLLOUT_CAMPAIGN_ID, delta, nowMs: now }); } catch { /* 表示だけ */ }
  };
  /** CAS で書き戻す。競合したら**書かない**（次 tick が読み直して続きから進む） */
  const saveState = async (next) => {
    try {
      await store.save({
        campaignId: ROLLOUT_CAMPAIGN_ID, state: next,
        expectedVersion: loaded.exists ? state.version : null,
      });
      return true;
    } catch (e) {
      log({ ok: false, stage: 'state_write', code: (e && e.code) || 'unknown' });
      return false;
    }
  };

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
    const opId = state.pendingHandoffOp;
    // ⚠️ 引き継ぎの記録が無いことは起こりうる（cron が付与の直後に落ちた / 人が手で付与した）。
    //    ここで諦めると、**権利はあるのに案内が一生届かない人**が残る。
    //    その場合は既存の進行判定（`action=sequence`）が「Step1 が期日」と言う人だけを積む。
    //    判定はあくまで単一源に任せるので、止めるべき人へ送ることはない。
    if (!opId) {
      if (!due || due.step !== STEP1 || due.recordIds.length === 0) {
        log({ ...view, skipped: 'no_handoff', sideEffects: 'none' });
        return { ok: false, ...view, abort: 'no_handoff', sideEffects: 'none' };
      }
      const rescue = await queueStep({ step: STEP1, recordIds: due.recordIds });
      if (!rescue.ok) {
        log({ ...view, ok: false, stage: rescue.stage, error: rescue.error, sideEffects: 'none' });
        return { ok: false, ...view, abort: 'queue_failed', detail: rescue, sideEffects: 'none' };
      }
      await saveState({
        ...state,
        pendingJobIds: [...state.pendingJobIds, ...rescue.jobIds],
        jobSteps: { ...state.jobSteps, ...Object.fromEntries(rescue.jobIds.map((id) => [id, STEP1])) },
      });
      await bumpSteps({ [STEP1]: { queued: rescue.queued } });
      log({ ...view, queued: rescue.queued, via: 'sequence', sideEffects: 'queued_only' });
      return { ok: true, ...view, queued: rescue.queued, jobs: rescue.jobIds, sideEffects: 'queued_only' };
    }
    const res = await queueStep({ step: STEP1, grantOperationId: opId });
    if (!res.ok) {
      log({ ...view, ok: false, stage: res.stage, error: res.error, sideEffects: 'none' });
      return { ok: false, ...view, abort: 'queue_failed', detail: res, sideEffects: 'none' };
    }
    await saveState({
      ...state, pendingHandoffOp: null,
      pendingJobIds: [...state.pendingJobIds, ...res.jobIds],
      jobSteps: { ...state.jobSteps, ...Object.fromEntries(res.jobIds.map((id) => [id, STEP1])) },
    });
    await bumpSteps({ [STEP1]: { queued: res.queued } });
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
    const res = await queueStep({ step: due.step, recordIds: due.recordIds });
    if (!res.ok) {
      log({ ...view, ok: false, stage: res.stage, step: due.step, error: res.error, sideEffects: 'none' });
      return { ok: false, ...view, abort: 'queue_failed', detail: res, sideEffects: 'none' };
    }
    await saveState({
      ...state,
      pendingJobIds: [...state.pendingJobIds, ...res.jobIds],
      jobSteps: { ...state.jobSteps, ...Object.fromEntries(res.jobIds.map((id) => [id, due.step])) },
    });
    await bumpSteps({ [due.step]: { queued: res.queued } });
    log({ ...view, step: due.step, queued: res.queued, jobs: res.jobIds.length, sideEffects: 'queued_only' });
    return { ok: true, ...view, step: due.step, queued: res.queued, jobs: res.jobIds, sideEffects: 'queued_only' };
  }

  // ── ④ 付与 ───────────────────────────────────────────────
  if (decision.action === TICK_ACTION.GRANT) {
    if (runtimeBlocked(ROLLOUT_STAGE_GATE.GRANT)) {
      return { ok: false, ...view, abort: 'gate_closed_grant', sideEffects: 'none' };
    }
    const out = await runLightTrialGrant({ env: armEnvForTick(env, state, now), now });
    const granted = Number(out?.granted || 0);
    const opId = String(out?.operationId || planLoad?.planned?.operationId || '');
    // ⚠️ **付与した数だけ**を刻む（queue が落ちても同じ日に二重に配らない）
    const next = settleTick({ state, nowMs: now, granted });
    await saveState({ ...next, pendingHandoffOp: granted > 0 ? opId : null });
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
 * 1 時間ごと。**1 tick 1 段階**なので、付与 → queue → 送信起動は
 * 同じ日の 3 回の tick で進む（途中で落ちても次の tick が続きを拾う）。
 * ゲートが閉じていれば接続前に終わる（副作用ゼロ）。
 */
export const config = {
  schedule: '10 * * * *',
};
