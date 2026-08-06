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
 * ⚠️ **外部から無認証で起動させない。**
 *
 * この Function は `netlify.toml` に schedule を登録していないため通常の公開 HTTP Function
 * として配備される。認証が無ければ、ゲートを開けた瞬間に誰でも tick を起動できてしまう。
 *
 * 許可するのは次のどちらか:
 *   - Netlify の**スケジュール実行**（`event.headers['x-netlify-event'] === 'schedule'` /
 *     Netlify が付ける schedule 由来の呼び出し）
 *   - `x-admin-secret` が管理用 secret と一致する**手動実行**
 *
 * secret が未設定なら**誰も実行できない**（fail-closed）。
 */
export function authorizeInvocation({ event, env }) {
  const e = env || {};
  const headers = (event && event.headers) || {};
  const get = (k) => headers[k] ?? headers[String(k).toLowerCase()] ?? headers[String(k).toUpperCase()];

  // Netlify のスケジュール実行（本文に next_run が入る / schedule ヘッダが付く）
  const isSchedule = String(get('x-netlify-event') || '').toLowerCase() === 'schedule'
    || (event && event.isScheduled === true);
  if (isSchedule) return { ok: true, via: 'schedule' };

  const SECRET = e.MARKETING_ADMIN_SECRET || e.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return { ok: false, code: 'secret_not_configured' };
  const provided = get('x-admin-secret');
  if (provided !== SECRET) return { ok: false, code: 'forbidden' };
  return { ok: true, via: 'manual' };
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

  // ══ 認可（**ゲート判定より前・接続より前**）══════════════════════
  // ⚠️ ゲートの設定状況すら無認証では見せない（開示も攻撃の下準備になる）
  const auth = authorizeInvocation({ event, env: process.env });
  if (!auth.ok) {
    return json(auth.code === 'secret_not_configured' ? 503 : 403, {
      mode: 'marketing-automation-scheduler',
      ran: false,
      reason: auth.code,
      接続: { redis: false, airtable: false },
      sideEffects: 'none',
    });
  }

  // ══ ハードゲート（**Redis / Airtable へ触れる前**）══════════════
  const gates = readGates(process.env, now);
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
    起動経路: auth.via,
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
