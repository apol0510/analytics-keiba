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
 * ⚠️ 判定は `weeklyNewsletterPlan.js`、文面は `weeklyNewsletterContent.js`（どちらも純粋）。
 * ⚠️ 触るのは `/v3/marketing/lists` の GET と `/v3/marketing/singlesends` の GET / POST / PUT だけ。
 */

import {
  planWeeklySend, validateWeeklyContent, summarizeWeeklyPlan,
  WEEKLY_LIST_NAME, WEEKLY_REFUSE,
} from '../../src/lib/marketing/weeklyNewsletterPlan.js';
import { buildWeeklyContent, renderWeekly } from '../../src/lib/marketing/weeklyNewsletterContent.js';
import { buildLatestShowcase } from '../../src/lib/resultsShowcase.js';
import { resolveProspectEngine } from '../../src/lib/marketing/sendgridCutover.js';

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
      send_to: { list_ids: [plan.slot.listId] },
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

  return done({
    ok: true, action: 'scheduled', ...summarizeWeeklyPlan(plan), sideEffects: 'singlesend_only',
  });
}

/** **毎日 1 回**（03:00 UTC = 12:00 JST）。枠が無ければ何もしない */
export const config = { schedule: '0 3 * * *' };
