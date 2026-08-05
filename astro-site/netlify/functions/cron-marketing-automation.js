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

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

/** ⚠️ 3 ゲートが揃わなければ**何にも接続しない** */
export function readGates(env) {
  const e = env || {};
  const scheduler = e.MARKETING_AUTOMATION_SCHEDULER_ENABLED === 'true';
  const liveEnqueue = e.MARKETING_CAMPAIGN_ENABLED === 'true';
  const dispatch = e.MARKETING_CAMPAIGN_DISPATCH_ENABLED === 'true';
  return {
    scheduler, liveEnqueue, dispatch,
    allOpen: scheduler && liveEnqueue && dispatch,
    missing: [
      !scheduler ? 'MARKETING_AUTOMATION_SCHEDULER_ENABLED' : null,
      !liveEnqueue ? 'MARKETING_CAMPAIGN_ENABLED' : null,
      !dispatch ? 'MARKETING_CAMPAIGN_DISPATCH_ENABLED' : null,
    ].filter(Boolean),
  };
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

export const handler = async (event) => {
  const now = Date.now();

  // ══ ハードゲート（**Redis / Airtable へ触れる前**）══════════════
  const gates = readGates(process.env);
  if (!gates.allOpen) {
    // ⚠️ ここで return するため、store も Airtable も**一度も初期化されない**
    return json(200, {
      mode: 'marketing-automation-scheduler',
      ran: false,
      reason: 'gates_closed',
      未設定のゲート: gates.missing,
      接続: { redis: false, airtable: false },
      sideEffects: 'none',
      notice: 'ゲートが閉じているため何もしていません（Redis / Airtable へ接続していません）。',
    });
  }

  // ── ここから先は 3 ゲートが全て開いているときだけ ──
  const store = createAutomationStore({ cmd: redisCmd });
  const today = jstDateString(now);
  const out = {
    mode: 'marketing-automation-scheduler',
    ran: true,
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
        // ⚠️ enqueue の実装は admin-marketing の共通契約経由（Phase B の配線対象）。
        //    ここでは claim と run の作成までに留め、**送信は行わない**。
      } finally {
        await store.releaseClaim({ automationId: item.automationId, token: claim.token }).catch(() => {});
      }
    }
    return json(200, out);
  } catch (e) {
    // ⚠️ Redis が信用できないときは fail-closed（次回に持ち越す）
    if (e instanceof AutomationStoreError) {
      console.error('❌ [marketing-automation] Redis 異常で中止:', e.code);
      return json(503, { ...out, ran: false, reason: 'store_unavailable', code: e.code });
    }
    console.error('❌ [marketing-automation] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
