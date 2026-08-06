/**
 * cron-marketing-automation.js — 自動配信の scheduler（**production では常時無効**）
 *
 * ⚠️ **3 つのハードゲートが全て true でなければ、Redis にも Airtable にも接続しない。**
 *      1. `MARKETING_AUTOMATION_SCHEDULER_ENABLED=true`
 *      2. `MARKETING_CAMPAIGN_ENABLED=true`（live enqueue）
 *      3. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（実送信）
 *    どれか 1 つでも欠ければ**接続前に fail-closed で終了**する。
 *    Phase B では**新規 env を production へ設定しない**ので、常に 1 で止まる。
 *
 * ⚠️ この Function は**メールを送らない**。作るのは ScheduledEmails の PENDING 行だけで、
 *    送信は既存 dispatcher が担う（**送信経路は 1 本のまま**）。
 * ⚠️ Customers を**書かない**（会員昇格・決済・特典・期限を変更しない）。
 *
 * ── 正本の範囲 ────────────────────────────────────────────────
 *   Redis     … 自動化の設定と進行（Definition / Run / claim / lock）
 *   Airtable  … 送信の事実（ScheduledEmails / CampaignDeliveries / EmailEvents）
 */

import {
  createAutomationStore, AUTO_ROOT, AutomationStoreError,
} from '../../src/lib/marketing/automationStore.js';
import {
  selectDueAutomations, MAX_AUTOMATIONS_PER_TICK, MAX_RECIPIENTS_PER_TICK,
} from '../../src/lib/marketing/automationScheduler.js';
import { jstDateString } from '../../src/lib/marketing/automationModel.js';
import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import { buildProspectAudience } from '../../src/lib/marketing/prospectPipeline.js';
import { planTickDelivery, summarizeTick } from '../../src/lib/marketing/automationTickPlan.js';
import { createSnapshotStore, SnapshotError } from '../../src/lib/marketing/customerSnapshotCache.js';
import {
  buildScheduledEmailFields, assertOnlyScheduledFields,
} from '../../src/lib/marketing/marketingEnqueueContract.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/**
 * ⚠️ ゲートが揃わなければ**何にも接続しない**。
 *
 * `MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` は
 * **既存機能のために production で既に true**。この 2 つを数に入れると
 * 「3 重ゲート」は見かけだけで、実際は env 1 つで自動配信が生きてしまう。
 * そこで **この自動化のためだけの独立したゲートを 2 つ**要求する:
 *
 *   1. `MARKETING_AUTOMATION_SCHEDULER_ENABLED=true` … scheduler を動かす意思
 *   2. `MARKETING_AUTOMATION_DISPATCH_ARMED=<今日の JST 日付>` … **当日ぶんの明示的な武装**
 *
 * 2 は日付一致を要求するので、置きっぱなしにしても翌日には自動的に閉じる。
 * さらに既存の 2 つ（live enqueue / dispatch）も従来どおり必要。
 */
export const ARMED_ENV = 'MARKETING_AUTOMATION_DISPATCH_ARMED';

export function readGates(env, nowMs) {
  const e = env || {};
  const scheduler = e.MARKETING_AUTOMATION_SCHEDULER_ENABLED === 'true';
  const liveEnqueue = e.MARKETING_CAMPAIGN_ENABLED === 'true';
  const dispatch = e.MARKETING_CAMPAIGN_DISPATCH_ENABLED === 'true';
  // 当日 JST 日付と一致するときだけ武装（前日の設定が残っていても翌日は閉じる）
  const today = jstDateString(Number.isFinite(nowMs) ? nowMs : Date.now());
  const armed = String(e[ARMED_ENV] || '').trim() === today;
  return {
    scheduler, liveEnqueue, dispatch, armed, today,
    allOpen: scheduler && liveEnqueue && dispatch && armed,
    missing: [
      !scheduler ? 'MARKETING_AUTOMATION_SCHEDULER_ENABLED' : null,
      !armed ? `${ARMED_ENV}(=${today})` : null,
      !liveEnqueue ? 'MARKETING_CAMPAIGN_ENABLED' : null,
      !dispatch ? 'MARKETING_CAMPAIGN_DISPATCH_ENABLED' : null,
    ].filter(Boolean),
  };
}

/**
 * ⚠️ **Scheduled Function 方式。外部 HTTP からは起動できない。**
 *
 * ── 一次的な保証は Netlify のプラットフォーム側 ──────────────────
 * このファイル末尾の `export const config = { schedule }` により、
 * この Function は **scheduled function** として配備される
 * （既存の `cron-email-scheduler` / `cron-expiry-check` /
 *   `cron-payment-email-reconciler` と同じ登録方法に揃えている）。
 *
 * ⚠️ **`export const config` が効くのは Netlify Functions v2 形式だけ。**
 *    v1 形式（`export const handler = async (event) => ({ statusCode, body })`）で書くと
 *    schedule が登録されず、**公開 HTTP Function のまま配備される**（Deploy Preview で実測）。
 *    そのため本 Function は既存 cron と同じ **v2 形式**（`export default` + `Response`）で書く。
 * scheduled function の公開 URL への HTTP リクエストは **Netlify が 404 を返す**ので、
 * そもそも外部からは到達できない。**これが唯一の起動経路の保証**。
 *
 * ── 専用 secret は廃止した ────────────────────────────────────
 * 以前は `MARKETING_AUTOMATION_CRON_SECRET` + `x-cron-secret` で守っていたが、
 * HTTP 経路自体が塞がるので**鍵を増やす必要がなくなった**（鍵は運用の負債になる）。
 *
 * ── 二次的な確認（多層防御）────────────────────────────────────
 * 万一 HTTP 形状のイベントで呼ばれた場合に備え、**scheduled 実行の形をしていない
 * イベントは実行しない**。判定は呼び出し元が自称するヘッダではなく、
 * Netlify が scheduled 実行時にだけ渡す **`next_run` を含む本文**の有無で行う。
 * ヘッダ（`x-netlify-event` など）は詐称できるので**根拠にしない**。
 *
 * ⚠️ 応答は **404**。存在や設定状況を外へ知らせない。
 */
export function isScheduledPayload(payload) {
  let body = payload;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return false; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  // HTTP 形状の痕跡があるものは外部リクエストとして扱う（v1 形式の event が来た場合も弾く）
  if (body.httpMethod || body.rawUrl || body.rawQuery || body.queryStringParameters) return false;
  // Netlify が scheduled 実行で渡す本文（{ next_run }）を要求する
  return typeof body.next_run === 'string' && body.next_run.trim() !== '';
}

/** Upstash REST（AK 既存 env のみ。KMA とキー空間を共有しない） */
function redisCmd(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return Promise.reject(new Error('upstash_not_configured'));
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`upstash_http_${res.status}`);
    return (await res.json()).result;
  });
}

/**
 * 実処理。**テストからはここを直接呼ぶ**（HTTP の器を挟まない）。
 * @param {{ payload: any, now?: number, env?: object }} args
 * @returns {{ statusCode: number, body: object }}
 */

/**
 * この配信回の対象を組み立てる。**Redis と Airtable の写しを読むだけ**で、
 * ScheduledEmails へは書かない（書くのは `enqueueAndRecord`）。
 *
 * ⚠️ Customers 側の一覧は **写し**（`ak:customer-snapshot:`）から読む。
 *    同期 Function で全件走査するとタイムアウトするため（C-2）。
 *    写しが無い / 古ければ **計画を作らない**（古い対象で送らせない）。
 */
async function planProspectTick({ store, definition, runId, occurrenceDate, now }) {
  const prospectStore = createProspectStore({ cmd: redisCmd });
  try {
    const snapshot = createSnapshotStore({ cmd: redisCmd });
    const customerEmails = await snapshot.loadEmailSet({ nowMs: now });

    const hashes = await prospectStore.activeHashes();
    const prospects = [];
    for (let i = 0; i < hashes.length; i += 500) {
      prospects.push(...await prospectStore.loadMany(hashes.slice(i, i + 500)));
    }
    const audience = buildProspectAudience({
      prospects, customerEmails, blacklistEmails: new Set(), nowMs: now, runId,
      buildKey: (email) => `${runId}:${email}`,
      maxRecipients: definition && definition.maxRecipients,
    });

    const planned = planTickDelivery({
      definition, occurrenceDate, runId,
      currentFingerprint: definition && definition.snapshotFingerprint,
      currentCount: definition && definition.snapshotCount,
      customerRecipients: [],
      prospectRecipients: audience.recipients,
      maxRecipients: definition && definition.maxRecipients,
      nowMs: now,
    });
    if (!planned.ok) {
      return { ok: false, prospectStore, summary: { 中止: planned.abort, 詳細: planned.drifts || null } };
    }
    return {
      ok: true, prospectStore, plan: planned.plan,
      summary: summarizeTick({ plan: planned.plan, enqueued: 0, failed: 0 }),
    };
  } catch (e) {
    if (e instanceof SnapshotError) {
      return { ok: false, prospectStore, summary: { 中止: e.code } };
    }
    return { ok: false, prospectStore, summary: { 中止: 'plan_failed' } };
  }
}

/**
 * enqueue して、**成功した prospect にだけ**送信回数を記録する。
 *
 * ⚠️ 送信回数を先に数えると、失敗した回まで「送った」ことになり
 *    無反応 3 回の打ち切りが早まる。**必ず enqueue の後**。
 * ⚠️ この Function は **メールを送らない**。作るのは ScheduledEmails の PENDING 行だけで、
 *    実送信は既存 dispatcher が担う（送信経路は 1 本のまま）。
 */
async function enqueueAndRecord({ plan, prospectStore, now }) {
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { enqueued: 0, failed: plan.recipients.length };

  const fields = buildScheduledEmailFields({
    campaignId: plan.context.campaignId,
    recipients: plan.recipients.map((r) => r.email),
    jobId: plan.jobId,
    scheduledAt: plan.context.scheduledAt,
    automation: plan.context,
  });
  if (!assertOnlyScheduledFields(fields)) return { enqueued: 0, failed: plan.recipients.length };

  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent('ScheduledEmails')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  if (!res.ok) {
    console.error(`❌ [marketing-automation] enqueue 失敗 HTTP ${res.status}`);
    return { enqueued: 0, failed: plan.recipients.length };
  }

  // ⚠️ ここまで来て初めて送信回数を数える
  let recorded = 0;
  for (const email of plan.prospectEmailsToRecord) {
    try {
      await prospectStore.recordSend({ email, nowMs: now, runId: plan.context.automationRunId });
      recorded += 1;
    } catch { /* 1 件の記録失敗で配信全体を落とさない */ }
  }
  return { enqueued: plan.recipients.length, failed: 0, recorded };
}

export async function runScheduledTick({ payload, now: nowArg, env } = {}) {
  const now = Number.isFinite(nowArg) ? nowArg : Date.now();
  const ENV = env || process.env;

  // ══ 起動経路の確認（**ゲート判定より前・Redis / Airtable 初期化より前**）══
  // ⚠️ 一次的な保証は Netlify 側（scheduled function は公開 URL から起動できない）。
  //    ここは多層防御で、scheduled 実行の形をしていない呼び出しを実行しない。
  // ⚠️ ここより上で store も Airtable も**一度も組み立てない**
  if (!isScheduledPayload(payload)) {
    // 存在も設定状況も知らせない
    return { statusCode: 404, body: { error: 'Not Found' } };
  }

  // ══ ハードゲート（**Redis / Airtable へ触れる前**）══════════════
  const gates = readGates(ENV, now);
  if (!gates.allOpen) {
    // ⚠️ ここで return するため、store も Airtable も**一度も初期化されない**
    return { statusCode: 200, body: {
      mode: 'marketing-automation-scheduler',
      ran: false,
      reason: 'gates_closed',
      未設定のゲート: gates.missing,
      接続: { redis: false, airtable: false },
      sideEffects: 'none',
      notice: 'ゲートが閉じているため何もしていません（Redis / Airtable へ接続していません）。',
    } };
  }

  // ── ここから先は 3 ゲートが全て開いているときだけ ──
  const store = createAutomationStore({ cmd: redisCmd });
  const today = jstDateString(now);
  const out = {
    mode: 'marketing-automation-scheduler',
    ran: true,
    起動経路: 'schedule',
    今日: today,
    namespace: AUTO_ROOT,
    上限: { automations: MAX_AUTOMATIONS_PER_TICK, recipients: MAX_RECIPIENTS_PER_TICK },
    claimed: [], skipped: {}, errors: [],
  };

  try {
    const activeIds = await store.listActive();
    const definitions = [];
    for (const id of activeIds) {
      const d = await store.loadDefinition(id);
      if (d) definitions.push(d);
    }

    const { due, skipped } = selectDueAutomations({
      definitions, nowMs: now, maxAutomations: MAX_AUTOMATIONS_PER_TICK,
    });
    out.skipped = skipped;

    for (const item of due) {
      // 1 つずつ claim する（取れなければ**何もしない**）
      const claim = await store.claim({ automationId: item.automationId });
      if (!claim.ok) {
        out.skipped.locked = (out.skipped.locked || 0) + 1;
        continue;
      }
      try {
        // 同一 runId の二重開始を atomic に拒否
        const created = await store.createRun({
          runId: item.runId, automationId: item.automationId,
          operationId: `${item.runId}#001`, status: 'PLANNED',
          snapshotCount: 0, queued: 0, excluded: 0, failed: 0,
          startedAt: new Date(now).toISOString(),
        });
        out.claimed.push({
          automationId: item.automationId, runId: item.runId,
          created: created.created, reason: created.reason || null,
        });
        // 同じ配信回を 2 度始めない
        if (!created.created) continue;

        // ── prospect 配信の計画（**ここでは送らない・書かない**）──
        const tick = await planProspectTick({
          store, definition: definitions.find((d) => d.automationId === item.automationId),
          runId: item.runId, occurrenceDate: item.occurrenceDate, now,
        });
        out.plans = out.plans || [];
        out.plans.push({ automationId: item.automationId, ...tick.summary });

        // ⚠️ enqueue（ScheduledEmails の PENDING 行）は
        //    **`MARKETING_AUTOMATION_ENQUEUE_ENABLED=true` のときだけ**。
        //    計画が中止（snapshot drift / 上限超過）なら何もしない。
        if (tick.ok && process.env.MARKETING_AUTOMATION_ENQUEUE_ENABLED === 'true') {
          const done = await enqueueAndRecord({ plan: tick.plan, prospectStore: tick.prospectStore, now });
          out.enqueued = (out.enqueued || 0) + done.enqueued;
          out.enqueueFailed = (out.enqueueFailed || 0) + done.failed;
        } else if (tick.ok) {
          out.skipped.enqueue_disabled = (out.skipped.enqueue_disabled || 0) + 1;
        }
      } finally {
        await store.releaseClaim({ automationId: item.automationId, token: claim.token }).catch(() => {});
      }
    }
    return { statusCode: 200, body: out };
  } catch (e) {
    // ⚠️ Redis が信用できないときは fail-closed（次回に持ち越す）
    if (e instanceof AutomationStoreError) {
      console.error('❌ [marketing-automation] Redis 異常で中止:', e.code);
      return { statusCode: 503, body: { ...out, ran: false, reason: 'store_unavailable', code: e.code } };
    }
    console.error('❌ [marketing-automation] 処理に失敗しました');
    return { statusCode: 500, body: { error: 'internal error' } };
  }
}

/**
 * Netlify Functions **v2** のエントリ。`export const config` が効くのはこの形式だけ。
 * scheduled 実行では本文に `{ next_run }` が入る。
 */
export default async function handler(req) {
  let payload = null;
  try { payload = await req.json(); } catch { payload = null; }
  const { statusCode, body } = await runScheduledTick({ payload, now: Date.now(), env: process.env });
  return json(statusCode, body);
}

// Netlify Scheduled Functions 設定
// ⚠️ cron は **UTC**。JST = UTC+9 なので `0 1 * * *` = **毎日 JST 10:00**。
//    自動化の quiet hours は 21:00-08:00 JST なので、その外側の午前中に置く。
// ⚠️ この登録により scheduled function になり、公開 URL への HTTP は Netlify 側で拒否される。
// ⚠️ 登録しただけでは副作用 0。処理へ進むには env のゲートが要る:
//      MARKETING_AUTOMATION_SCHEDULER_ENABLED=true
//      MARKETING_AUTOMATION_DISPATCH_ARMED=<当日の JST 日付>
//      MARKETING_CAMPAIGN_ENABLED / MARKETING_CAMPAIGN_DISPATCH_ENABLED
//    いずれも production 未設定のため、現状は起動しても何もしない。
export const config = {
  schedule: '0 1 * * *',
};
