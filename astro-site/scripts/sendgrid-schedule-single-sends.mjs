#!/usr/bin/env node
/**
 * sendgrid-schedule-single-sends.mjs — 27 通の Single Send を**予約する**（既定は下見）
 *
 * ## 立場
 *
 * 配送するのは SendGrid。ここがやるのは **`send_at` を入れて schedule を押すこと**だけで、
 * **AK 側に配送エンジンを作らない**（cron も queue も持たない）。
 *
 * ## 予約の形（`buildSingleSendPlan` の `dayOffset` に従う）
 *
 * | 宛先 list | 開始日に出る号 | 最終日 |
 * |---|---|---|
 * | `ak-prospect-select-start-1` | m01 | 開始 +9 日（m10）|
 * | `ak-prospect-select-start-2` | m02 | 開始 +8 日（m10）|
 * | `ak-prospect-select-start-3` | m03 | 開始 +7 日（m10）|
 *
 * **1 人が 1 日に受け取るのは 1 通**。
 *
 * ## 予約の前に必ず通す確認（1 つでも欠ければ**予約しない**）
 *
 * 1. reconcile の下見（`active` 全窓 ＋ `excluded` 全窓）が **actionable 0**
 * 2. `AK active − provider rejected = list 合計`
 * 3. 通し番号ごとに `D[n] = L[n]（+ その号の provider rejected）`
 * 4. 27 通が **draft・未予約**
 * 5. 旧 AK が止まっている（`engine=sendgrid`）
 *
 * 正本: `docs/SENDGRID_MC_MIGRATION.md` §15。
 *
 * ## 守ること
 *
 * - 触るのは `/v3/marketing/singlesends` の **GET と PUT `/schedule` だけ**
 *   （削除・本文更新・即時送信の経路を持たない）
 * - 既定は**下見**。`--apply --confirm "SCHEDULE AK SINGLE SENDS"` の両方でだけ予約する
 * - **すでに予約済み（draft でない）通があれば何もしない**（取り違え・二重予約を防ぐ）
 * - 予約後は **GET で 27 件すべて**（`status` / `send_at` / 宛先 list）を検証する
 * - **アドレスを出力しない**（扱うのは通数と日時だけ）
 *
 * ## 使い方
 *
 * ```bash
 * cd /Users/user/Projects/analytics-keiba
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-schedule-single-sends.mjs \
 *   --start "2026-09-20T19:00+09:00"
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-schedule-single-sends.mjs \
 *   --start "2026-09-20T19:00+09:00" --apply --confirm "SCHEDULE AK SINGLE SENDS"
 * ```
 */

import {
  buildSingleSendPlan, buildSchedule, SINGLE_SEND_STARTS,
} from '../src/lib/marketing/sendgridSingleSendPlan.js';
import { buildMessagePlan } from '../src/lib/marketing/sendgridMessagePlan.js';
import { listNameFor } from '../src/lib/marketing/sendgridAutomationPlan.js';

const CONFIRM = 'SCHEDULE AK SINGLE SENDS';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const readArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const confirm = readArg('--confirm');
const startArg = readArg('--start');

const API = 'https://api.sendgrid.com';
const ALLOWED = ['/v3/marketing/singlesends', '/v3/marketing/lists'];
const KEY = process.env.SENDGRID_API_KEY;
const ADMIN = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
const SITE = 'https://analytics.keiba.link';
/** 既知の provider rejected（SendGrid が受理しない宛先）。**投入対象外のまま** */
const PROVIDER_REJECTED = 10;

const sg = async (method, path, body) => {
  if (!ALLOWED.some((p) => path.startsWith(p))) throw new Error(`path_not_allowed:${path}`);
  if (!['GET', 'PUT'].includes(method)) throw new Error(`method_not_allowed:${method}`);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status >= 400) throw new Error(`sendgrid_${res.status}:${path}`);
  return json;
};

const admin = (fn, body) => fetch(`${SITE}/.netlify/functions/${fn}`, {
  method: 'POST',
  headers: { 'x-admin-secret': ADMIN, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => {
  const j = await r.json().catch(() => null);
  if (r.status !== 200) throw new Error(`admin_${r.status}:${(j && j.reason) || fn}`);
  return j;
});

function fail(msg) {
  console.error(`❌ ${msg}`);
  console.error('   予約していません。');
  process.exit(1);
}

if (!KEY) fail('SENDGRID_API_KEY がありません');
if (!ADMIN) fail('管理 API の secret がありません（照合ができません）');
if (!startArg) fail('--start "2026-09-20T19:00+09:00" の形で開始日時を渡してください');

const startMs = Date.parse(startArg);
if (!Number.isFinite(startMs)) fail(`開始日時を読めません: ${startArg}`);
if (startMs < Date.now()) fail('開始日時が過去です');

// ── 1. 予約計画（id は**推測せず** SendGrid から引く）──────────
const listsForPlan = (await sg('GET', '/v3/marketing/lists?page_size=100')).result || [];
const listIdByStart = {};
for (const n of SINGLE_SEND_STARTS) {
  const hit = listsForPlan.find((l) => String(l.name) === listNameFor(n));
  if (hit) listIdByStart[n] = String(hit.id);
}
const existingSends = (await sg('GET', '/v3/marketing/singlesends?page_size=100')).result || [];
const sample = existingSends.find((x) => /^AK Prospect Selection /.test(String(x.name)));
if (!sample) fail('AK Prospect Selection の Single Send が見つかりません');
const sampleDetail = await sg('GET', `/v3/marketing/singlesends/${sample.id}`);
const senderId = sampleDetail.email_config && sampleDetail.email_config.sender_id;
const groupId = sampleDetail.email_config && sampleDetail.email_config.suppression_group_id;
if (!senderId || !groupId) fail('sender / unsubscribe group を引けません');

const msgPlan = buildMessagePlan();
if (!msgPlan.ok) fail(`10 通の計画を作れません: ${msgPlan.reason}`);
const plan = buildSingleSendPlan({
  messages: msgPlan.plan, listIdByStart, senderId, suppressionGroupId: groupId,
});
if (!plan.ok) fail(`計画を作れません: ${plan.reason}`);
const sched = buildSchedule({ sends: plan.sends, baseDateIso: new Date(startMs).toISOString() });
if (!sched.ok) fail(`予約日時を作れません: ${sched.reason}`);
const sendAtByName = new Map(sched.schedule.map((s) => [s.name, s.send_at]));
if (sendAtByName.size !== 27) fail(`27 通になりません（${sendAtByName.size} 通）`);

const jst = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
console.log(`■ 予約計画（開始 ${jst(new Date(startMs).toISOString())} JST）`);
for (const start of SINGLE_SEND_STARTS) {
  const rows = plan.sends.filter((s) => s.startMessage === start);
  const first = sendAtByName.get(rows[0].name);
  const last = sendAtByName.get(rows[rows.length - 1].name);
  console.log(`  ${listNameFor(start)}: ${rows.length} 通 / ${jst(first)} → ${jst(last)}`);
}

// ── 2. 予約前の照合（1 つでも欠ければ予約しない）───────────────
console.log('■ 予約前の照合（read-only）');

const sweep = async (scope, limit) => {
  let off = 0; let actionable = 0; let windows = 0;
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 窓で切ってある
    const j = await admin('admin-sendgrid-migration', { action: 'reconcile', scope, offset: off, limit });
    actionable += Number((j.summary && j.summary['変更予定']) || 0);
    windows += 1;
    const w = j.window || {};
    if (w.nextOffset === null || w.nextOffset === undefined) break;
    off = w.nextOffset;
  }
  return { actionable, windows };
};

const a = await sweep('active', 500);
const e = await sweep('excluded', 25);
const actionable = a.actionable + e.actionable;
console.log(`  ① reconcile actionable = ${actionable}（active ${a.windows} 窓 / excluded ${e.windows} 窓）`);

let off = 0; const D = {}; let A = null; let missing = 0;
for (let i = 0; i < 12; i += 1) {
  // eslint-disable-next-line no-await-in-loop -- 窓で切ってある
  const j = await admin('admin-sendgrid-migration', { action: 'scan', offset: off, limit: 2000 });
  for (const [k, v] of Object.entries((j.summary && j.summary['次に送る番号別']) || {})) D[k] = (D[k] || 0) + v;
  const w = j.window || {};
  A = w.indexSize; missing += Number(w.missing || 0);
  if (w.nextOffset === null || w.nextOffset === undefined) break;
  off = w.nextOffset;
}

const L = SINGLE_SEND_STARTS.map((n) => {
  const hit = listsForPlan.find((l) => l.name === listNameFor(n));
  return hit ? Number(hit.contact_count) : null;
});
const Lsum = L.reduce((x, y) => x + (y || 0), 0);
console.log(`  ② 総数: A ${A} − rejected ${PROVIDER_REJECTED} = ${A - PROVIDER_REJECTED} / list 合計 ${Lsum}`);
console.log(`  ③ 号別: ${SINGLE_SEND_STARTS.map((n) => `n${n} ${(D[n] || 0) - (n === 1 ? PROVIDER_REJECTED : 0)}/${L[n - 1]}`).join(' ')}`);

const sends = existingSends.filter((s) => sendAtByName.has(s.name));
const drafts = sends.filter((s) => s.status === 'draft').length;
const already = sends.filter((s) => s.send_at).length;
console.log(`  ④ Single Send: ${sends.length} 通 / draft ${drafts} / 予約済み ${already}`);

const engine = (await admin('admin-sendgrid-migration', { action: 'preflight' })).engine;
console.log(`  ⑤ engine = ${engine}`);

if (missing > 0) fail(`索引を読み切れていません（missing ${missing}）`);
if (actionable !== 0) fail(`reconcile に未処理があります（actionable ${actionable}）`);
if (A - PROVIDER_REJECTED !== Lsum) fail(`総数が合いません（${A - PROVIDER_REJECTED} ≠ ${Lsum}）`);
for (const n of SINGLE_SEND_STARTS) {
  const expect = (D[n] || 0) - (n === 1 ? PROVIDER_REJECTED : 0);
  if (expect !== L[n - 1]) fail(`通し番号 ${n} が合いません（AK ${expect} ≠ list ${L[n - 1]}）`);
}
if (sends.length !== 27) fail(`27 通そろっていません（${sends.length} 通）`);
if (drafts !== 27) fail(`draft でない通があります（draft ${drafts}）`);
if (already !== 0) fail(`すでに予約済みの通があります（${already} 通）`);
if (engine !== 'sendgrid') fail(`旧 AK が止まっていません（engine=${engine}）`);
console.log('✅ 予約前の照合はすべて満たしています');

if (!apply) {
  console.log('（下見です。--apply --confirm を渡すまで 1 通も予約しません）');
  process.exit(0);
}
if (confirm !== CONFIRM) fail(`--confirm "${CONFIRM}" が要ります`);

// ── 3. 予約 ─────────────────────────────────────────────────
console.log('■ 予約します');
const idByName = new Map(sends.map((s) => [s.name, s.id]));
let done = 0;
for (const [name, sendAt] of sendAtByName.entries()) {
  const id = idByName.get(name);
  if (!id) fail(`id を引けません: ${name}`);
  // eslint-disable-next-line no-await-in-loop -- 27 通を順番に
  await sg('PUT', `/v3/marketing/singlesends/${id}/schedule`, { send_at: sendAt });
  done += 1;
}
console.log(`  予約した通数: ${done}`);

// ── 4. 予約後の検証（27 件すべて GET）─────────────────────────
console.log('■ 予約後の検証');
let ok = 0;
const rows = [];
for (const [name, sendAt] of sendAtByName.entries()) {
  // eslint-disable-next-line no-await-in-loop -- 27 通を順番に
  const d = await sg('GET', `/v3/marketing/singlesends/${idByName.get(name)}`);
  const listIds = ((d.send_to && d.send_to.list_ids) || []).length;
  const match = d.send_at === sendAt && d.status === 'scheduled' && listIds === 1;
  if (match) ok += 1;
  rows.push(`${name} status=${d.status} send_at=${d.send_at} list=${listIds}${match ? '' : '  ← 不一致'}`);
}
for (const r of rows) console.log(`  ${r}`);
console.log(ok === 27 ? '✅ 27 通すべて予約できています' : `❌ 一致しない通があります（${ok}/27）`);
process.exit(ok === 27 ? 0 : 1);
