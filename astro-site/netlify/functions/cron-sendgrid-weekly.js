/**
 * cron-sendgrid-weekly.js — 選別後の**週 2 回の一斉配信**を自動で組む（既定は何もしない）
 *
 * ## やること
 *
 * 1. 反応した人の list（`ak-drm-engaged`）の人数を読む
 * 2. 次の枠（水・土 19:00 JST）を決める。**すでにあれば作らない**
 * 3. 前日の実績から文面を組み、**品質基準を通らなければ送らない**
 * 4. Single Send を作って**予約する**（配るのは SendGrid）
 *
 * ## やらないこと
 *
 * - **選別中は動かない**（27 通と重なると 1 日 2 通になる）
 * - **自前で配らない**（queue も dispatcher も持たない）
 * - **1 週間に 3 通目を作らない**
 * - env `SENDGRID_WEEKLY_ENABLED=true` が無ければ**読みもしない**（完全に不活性）
 *
 * ## 元々の会員を足す（`SENDGRID_WEEKLY_NATIVE_ENABLED=true` のときだけ / 2026-09-28）
 *
 * 枠の 12 時間前から、元々の会員の日付付き list（`ak-native-weekly-YYYY-MM-DD`）を段階的に作る
 * （判定 → list 作成・upsert → job 完了と人数一致の確認）。**ready になった枠だけ**宛先へ足す。
 * 枠の 2 時間前までに ready にならなければ **native を足さずに**予約する（fail closed）。
 * 手順と I/O は `nativeWeeklyRunner.js` / `nativeWeeklyIo.js`、判定は `nativeWeeklySync.js`。
 * **gate が閉じていれば、従来の週次と 1 バイトも変わらない**（guard で固定）。
 *
 * ⚠️ 判定は `weeklyNewsletterPlan.js`、文面は `weeklyNewsletterContent.js`（どちらも純粋）。
 * ⚠️ この関数本体が触るのは `/v3/marketing/lists` の GET と `/v3/marketing/singlesends` の GET / POST / PUT だけ。
 *    native list の作成・upsert・削除は `nativeWeeklyIo.createNativeSendgrid`（native list に限る）。
 */

import {
  planWeeklySend, validateWeeklyContent, summarizeWeeklyPlan,
  WEEKLY_LIST_NAME, WEEKLY_REFUSE,
} from '../../src/lib/marketing/weeklyNewsletterPlan.js';
import { buildWeeklyContent, renderWeekly } from '../../src/lib/marketing/weeklyNewsletterContent.js';
import { buildLatestShowcase } from '../../src/lib/resultsShowcase.js';
import { resolveProspectEngine } from '../../src/lib/marketing/sendgridCutover.js';
import { isNativeGateOpen, buildSendToListIds, NATIVE_STATUS } from '../../src/lib/marketing/nativeWeeklySync.js';
import { runNativeWeeklyStep } from '../../src/lib/marketing/nativeWeeklyRunner.js';
import {
  createNativeRedis, createNativeSendgrid, readNativeState, writeNativeState,
  loadNativeCustomers, loadBlacklist, loadOnboardingDeliveredIndex, loadEngagedEmails,
} from '../../src/lib/marketing/nativeWeeklyIo.js';
import { ONBOARDING_CAMPAIGN_ID } from '../../src/lib/marketing/nativeWeeklyAudience.js';
import { getCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import { resolveAutoStart } from '../../src/lib/marketing/campaignSequence.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';

/** 開けるまで**何もしない**（既定は不活性） */
export const WEEKLY_GATE_ENV = 'SENDGRID_WEEKLY_ENABLED';
/** 選別の最終配信（これを過ぎるまで週次は作らない）*/
export const SELECTION_ENDS_ENV = 'SENDGRID_SELECTION_ENDS_AT';

const sg = async (method, path, body) => {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('sendgrid_key_missing');
  if (!/^\/v3\/marketing\/(lists|singlesends)/.test(path)) throw new Error(`path_not_allowed:${path}`);
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error(`method_not_allowed:${method}`);
  const r = await fetch(`https://api.sendgrid.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (r.status >= 400) throw new Error(`sendgrid_${r.status}`);
  return json;
};

export default async function handler() {
  const log = (o) => console.log(JSON.stringify({ fn: 'sendgrid-weekly', ...o }));
  const done = (body) => { log(body); return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }); };

  if (String(process.env[WEEKLY_GATE_ENV] || '').trim() !== 'true') {
    return done({ ok: true, action: 'skip', reason: 'gate_closed', sideEffects: 'none' });
  }
  // ⚠️ 旧 AK が prospect を送る設定に戻っていたら**触らない**（二重配信を作らない）
  if (resolveProspectEngine(process.env) !== 'sendgrid') {
    return done({ ok: true, action: 'skip', reason: 'engine_not_sendgrid', sideEffects: 'none' });
  }

  const now = Date.now();
  const selectionEndsMs = Date.parse(String(process.env[SELECTION_ENDS_ENV] || ''));

  let listId = null;
  let audienceCount = 0;
  let existingNames = [];
  try {
    const lists = (await sg('GET', '/v3/marketing/lists?page_size=100')).result || [];
    const hit = lists.find((l) => String(l.name) === WEEKLY_LIST_NAME);
    if (hit) { listId = String(hit.id); audienceCount = Number(hit.contact_count) || 0; }
    existingNames = ((await sg('GET', '/v3/marketing/singlesends?page_size=100')).result || [])
      .map((s) => String(s.name));
  } catch (e) {
    return done({ ok: false, reason: String((e && e.message) || 'sendgrid_unavailable'), sideEffects: 'none' });
  }

  const plan = planWeeklySend({
    nowMs: now,
    selectionEndsMs: Number.isFinite(selectionEndsMs) ? selectionEndsMs : null,
    existingNames,
    audienceCount,
    listId,
  });
  if (!plan.ok) {
    return done({ ok: true, action: 'skip', reason: plan.reason, sideEffects: 'none' });
  }

  // ── 元々の会員（gate が開いているときだけ）──────────────────────
  let native = { enabled: false };
  let nativeRedis = null;
  if (isNativeGateOpen(process.env)) {
    const step = await runNativeStepForSlot({ slot: plan.slot, nowMs: now });
    native = { ...step.summary, ready: step.ready === true };
    nativeRedis = step.redis;
    if (step.defer) {
      return done({ ok: true, action: 'skip', reason: 'native_in_progress', native, sideEffects: step.summary.reason === 'importing' ? 'native_list_upserted' : 'none' });
    }
    native.listId = step.ready ? step.listId : null;
  }

  /** 文面は**前日の実績**から組む。素材が無ければ送らない */
  let archive = [];
  try {
    const mod = await import('../../src/data/archiveResults.json', { with: { type: 'json' } });
    archive = (mod && (mod.default || mod)) || [];
  } catch { archive = []; }
  const showcase = buildLatestShowcase(archive);
  const content = buildWeeklyContent({ dateKey: plan.slot.dateKey, showcase });
  if (!content.ok) {
    return done({ ok: true, action: 'skip', reason: `content:${content.reason}`, sideEffects: 'none' });
  }
  const verdict = validateWeeklyContent(content.step);
  if (!verdict.ok) {
    // ⚠️ **品質基準を通らない文面は送らない**（黙って送らない・理由だけ残す）
    return done({ ok: true, action: 'skip', reason: WEEKLY_REFUSE.COPY_REJECTED, issues: verdict.issues, sideEffects: 'none' });
  }

  const rendered = renderWeekly(content.step);
  const sample = existingNames.find((n) => /^AK Prospect Selection /.test(n));
  let senderId = null;
  let groupId = null;
  try {
    const all = (await sg('GET', '/v3/marketing/singlesends?page_size=100')).result || [];
    const ref = all.find((s) => String(s.name) === sample);
    if (ref) {
      const detail = await sg('GET', `/v3/marketing/singlesends/${ref.id}`);
      senderId = detail.email_config && detail.email_config.sender_id;
      groupId = detail.email_config && detail.email_config.suppression_group_id;
    }
  } catch { /* 下で弾く */ }
  if (!senderId || !groupId) {
    return done({ ok: true, action: 'skip', reason: 'sender_or_group_missing', sideEffects: 'none' });
  }

  let created = null;
  try {
    created = await sg('POST', '/v3/marketing/singlesends', {
      name: plan.slot.name,
      send_to: { list_ids: native.enabled ? buildSendToListIds({ engagedListId: plan.slot.listId, nativeListId: native.listId, nativeReady: native.ready }) : [plan.slot.listId] },
      email_config: {
        subject: rendered.subject,
        html_content: rendered.html,
        plain_content: rendered.text,
        generate_plain_content: false,
        sender_id: senderId,
        suppression_group_id: groupId,
      },
    });
    await sg('PUT', `/v3/marketing/singlesends/${created.id}/schedule`, { send_at: plan.slot.sendAt });
  } catch (e) {
    return done({ ok: false, action: 'failed', reason: String((e && e.message) || 'create_failed'), sideEffects: created ? 'singlesend_created_not_scheduled' : 'none' });
  }

  if (native.enabled && native.ready && nativeRedis) {
    try {
      const st = await readNativeState(nativeRedis, plan.slot.dateKey);
      await writeNativeState(nativeRedis, plan.slot.dateKey, { ...(st || {}), status: NATIVE_STATUS.SCHEDULED, singleSendId: String(created.id), updatedAtMs: Date.now() });
    } catch { /* 予約は済んでいる。状態を残せなかったことだけ要約に出す */ native.stateWrite = 'failed'; }
  }
  const { listId: _nativeListId, ...nativeSummary } = native;
  return done({
    ok: true, action: 'scheduled', ...summarizeWeeklyPlan(plan), native: nativeSummary,
    sideEffects: native.enabled && native.ready ? 'singlesend_with_native' : 'singlesend_only',
  });
}

/**
 * 元々の会員の list を 1 歩進める（依存をここで組み立てて runner へ渡す）。
 * ⚠️ 例外は外へ出さない（runner が「native を足さない」へ倒す）。
 */
async function runNativeStepForSlot({ slot, nowMs }) {
  let redis = null;
  try { redis = createNativeRedis(makeRedisCmd(process.env)); } catch { redis = null; }
  const ctx = { fetchImpl: fetch, KEY: process.env.AIRTABLE_API_KEY, BASE: process.env.AIRTABLE_BASE_ID };
  const deps = {
    redis,
    readState: readNativeState,
    writeState: writeNativeState,
    sendgrid: () => createNativeSendgrid({ apiKey: process.env.SENDGRID_API_KEY, fetchImpl: fetch }),
    loadInputs: async () => {
      if (!ctx.KEY || !ctx.BASE) throw new Error('airtable_config_missing');
      const campaign = getCampaign(ONBOARDING_CAMPAIGN_ID, { includeDisabled: true });
      const auto = resolveAutoStart(campaign);
      // Airtable は base あたり毎秒 5 リクエスト。並べると 429 で判定材料が欠ける（＝native を足せない）
      // ので **Airtable は順に**読む。配信基盤の停止リストだけ並行で読む。
      const providerP = fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now: nowMs });
      const customers = await loadNativeCustomers(ctx);
      const blacklist = await loadBlacklist(ctx);
      const deliveredIndex = await loadOnboardingDeliveredIndex(ctx, ONBOARDING_CAMPAIGN_ID);
      const provider = await providerP;
      const emails = customers.map((r) => String((r.fields || {}).Email || '').trim().toLowerCase()).filter(Boolean);
      const engagedEmails = await loadEngagedEmails({ redis, emails });
      return {
        customers,
        blacklistHard: blacklist.hard,
        blacklistSoft: blacklist.soft,
        providerSuppressed: provider && provider.ok ? provider.emails : null,
        onboarding: {
          campaign, deliveredIndex, withinDays: auto ? auto.withinDays : null,
          brand: 'analytics-keiba', fromEmail: getBrandConfig('analytics-keiba').defaultFromEmail,
        },
        engagedEmails,
      };
    },
    referencedListIds: async () => {
      const all = (await sg('GET', '/v3/marketing/singlesends?page_size=100')).result || [];
      const refs = new Set();
      for (const s of all.filter((x) => ['scheduled', 'draft'].includes(String(x.status)))) {
        // eslint-disable-next-line no-await-in-loop
        const d = await sg('GET', `/v3/marketing/singlesends/${s.id}`);
        for (const id of ((d && d.send_to && d.send_to.list_ids) || [])) refs.add(String(id));
      }
      return refs;
    },
  };
  const step = await runNativeWeeklyStep({ slot, nowMs, deps });
  return { ...step, redis };
}

/**
 * **毎時 1 回**。枠が無ければ何もしない（名前で二重予約を防ぐので、何度動いても 1 枠 1 通）。
 * 元々の会員の list は枠の 12 時間前から段階的に作るため、日 1 回では間に合わない。
 */
export const config = { schedule: '5 * * * *' };
