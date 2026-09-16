/**
 * admin-unsubscribe-backfill.js — 旧 mailto 経路の配信停止依頼を**一度だけ**一括精算する
 *
 * PR #558 が production へ published される前（`LEGACY_CUTOFF_ISO`）に送ったメールには
 * `List-Unsubscribe` に mailto が併記されており、Apple Mail 等はそちらを選ぶ。
 * その依頼は `unsubscribe@keiba.link` の受信箱に溜まるだけで **AK 側に反映されていない**。
 * その積み残しをまとめて停止へ反映し、旧 mailto 残件をゼロにしてクローズする。
 *
 * ⚠️ **通常運用の経路ではない。** 以後は #558 の HTTPS ワンクリックだけが正規。
 *
 * ## 何をしないか
 *
 * - 2 つ目の停止ロジックを作らない。**書き込みは #558 の正本をそのまま呼ぶ**
 *   （`updateUnsubscribeStatus` / `suppressProspect`）
 * - 契約・権限・退会・決済系フィールドには触れない（触る先は #558 と同じ 2 つだけ）
 * - **メールを 1 通も送らない**
 * - 受信箱を読まない（宛先リストは呼び出し側が渡す）
 *
 * ## 安全条件（fail closed）
 *
 * - `UNSUBSCRIBE_BACKFILL_SECRET` 専用。**他の管理 secret へ fallback しない**
 *   （#554 の教訓: fallback があると、既存 secret を持つだけでこの経路が使える）
 * - 既定は **dry-run**。`dryRun:false` は `expectedCount` が実際の対象数と一致したときだけ通る
 * - 片方でも読めなかった相手は `unknown` に倒し、**書かない**
 * - 生アドレスは戻り値にもログにも出さない（`emailTraceId` のハッシュのみ）
 */

import { decideAdminWrite, ADMIN_WRITE } from '../../src/lib/premiumPlus/mediaAuth.js';
import {
  normalizeBackfillInput, classifyBackfillTarget, summarizeBackfillPlan,
  decideBackfillExecution, LEGACY_CUTOFF_ISO, MAX_BACKFILL_TARGETS,
} from '../../src/lib/unsubscribe/unsubscribeBackfill.js';
// ⚠️ 停止の書き込みは #558 の正本を再利用する（ここで作り直さない）
import {
  updateUnsubscribeStatus, suppressProspect, emailTraceId, normalizeEmail,
  escapeAirtableFormulaString,
} from './unsubscribe.js';
import { createProspectStore, emailHash } from '../../src/lib/marketing/prospectStore.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { PROSPECT_STATE } from '../../src/lib/marketing/prospectPolicy.js';

const BRAND = 'analytics-keiba';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

/** Customers を 1 件読む（read-only）。読めなければ `unknown`。 */
async function readCustomer(email) {
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID_ANALYTICS_KEIBA || process.env.AIRTABLE_BASE_ID;
  if (!key || !base) return { state: 'unknown', unsubscribed: null };
  try {
    const formula = `LOWER({Email}) = '${escapeAirtableFormulaString(normalizeEmail(email))}'`;
    const url = `https://api.airtable.com/v0/${base}/Customers`
      + `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { state: 'unknown', unsubscribed: null };
    const data = await res.json();
    const rec = (data.records || [])[0];
    if (!rec) return { state: 'missing', unsubscribed: null };
    return { state: 'found', unsubscribed: rec.fields?.UnsubscribedAnalyticsKeiba === true };
  } catch {
    return { state: 'unknown', unsubscribed: null };
  }
}

/** 見込み客プールを 1 件読む（read-only）。読めなければ `unknown`。 */
async function readProspect(email, store) {
  if (!store) return { state: 'unknown', suppressed: null };
  try {
    const p = await store.loadByHash(emailHash(email));
    if (!p) return { state: 'missing', suppressed: null };
    return { state: 'found', suppressed: p.state === PROSPECT_STATE.SUPPRESSED };
  } catch {
    return { state: 'unknown', suppressed: null };
  }
}

exports.handler = async (event) => {
  // ── 認可（fail closed・専用 secret のみ）────────────────────────
  //    ⚠️ fallback を足さないこと（#554 の教訓）
  const adminSecret = process.env.UNSUBSCRIBE_BACKFILL_SECRET;
  const auth = await decideAdminWrite({
    method: event.httpMethod,
    adminSecret,
    providedSecret: event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'],
    origin: event.headers?.origin || event.headers?.Origin,
    context: process.env.CONTEXT,
  });
  if (auth.decision !== ADMIN_WRITE.ALLOW) {
    return json(auth.status, { ok: false, error: 'Forbidden', sideEffects: 'none' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return json(400, { ok: false, error: 'Invalid JSON', sideEffects: 'none' });
  }

  const dryRun = body.dryRun !== false; // 既定 true
  const operationId = String(body.operationId || '').trim() || null;
  const { emails, rejected, received } = normalizeBackfillInput(body.emails);

  if (emails.length === 0) {
    return json(400, {
      ok: false, error: '対象アドレスがありません', received, rejected, sideEffects: 'none',
    });
  }

  let store = null;
  try { store = createProspectStore({ cmd: makeRedisCmd(process.env) }); } catch { store = null; }

  // ── 照合（read-only）────────────────────────────────────────
  const rows = [];
  for (const email of emails) {
    const [c, p] = await Promise.all([readCustomer(email), readProspect(email, store)]);
    const cls = classifyBackfillTarget({
      customer: c.state, customerUnsubscribed: c.unsubscribed,
      prospect: p.state, prospectSuppressed: p.suppressed,
    });
    // ⚠️ 生アドレスは持ち回らない。以後は trace（ハッシュ）で追跡する
    rows.push({ email, trace: emailTraceId(email), ...cls });
  }

  const summary = summarizeBackfillPlan(rows);
  const gate = decideBackfillExecution({
    dryRun, needsWrite: summary.needsWrite, expectedCount: body.expectedCount,
  });

  const base = {
    cutoff: LEGACY_CUTOFF_ISO,
    maxTargets: MAX_BACKFILL_TARGETS,
    operationId,
    received,
    rejected,
    summary,
    // 追跡用（PII なし）。途中失敗時にどこまで進んだかを突き合わせられる
    traces: rows.map((r) => ({ trace: r.trace, statuses: r.statuses })),
  };

  if (!gate.ok) {
    return json(dryRun ? 200 : 409, { ok: false, reason: gate.reason, sideEffects: 'none', ...base });
  }
  if (dryRun) {
    return json(200, {
      ok: true, dryRun: true, sideEffects: 'none',
      nextStep: '同じ入力に dryRun:false と expectedCount を付けて再実行すると適用されます。',
      ...base,
    });
  }

  // ── 適用（#558 の正本をそのまま呼ぶ）──────────────────────────
  const applied = [];
  let failed = 0;
  for (const r of rows) {
    if (!r.needsWrite.customer && !r.needsWrite.prospect) continue;
    const result = { trace: r.trace, customer: null, prospect: null };
    if (r.needsWrite.customer) {
      const out = await updateUnsubscribeStatus(r.email, BRAND, 'unsubscribe');
      result.customer = out && out.ok ? 'ok' : `failed:${(out && out.reason) || 'unknown'}`;
    }
    if (r.needsWrite.prospect) {
      result.prospect = await suppressProspect(r.email);
    }
    const bad = (result.customer && result.customer.startsWith('failed'))
      || (result.prospect && !['recorded', 'already'].includes(result.prospect));
    if (bad) failed += 1;
    applied.push(result);
  }

  console.log('📮 [unsubscribe-backfill]', JSON.stringify({
    event: 'legacy_mailto_backfill', operationId,
    unique: summary.unique, needsWrite: summary.needsWrite, applied: applied.length, failed,
  }));

  return json(failed > 0 ? 207 : 200, {
    ok: failed === 0,
    dryRun: false,
    sideEffects: 'unsubscribe_applied',
    appliedCount: applied.length,
    failedCount: failed,
    applied, // trace のみ。生アドレスは含めない
    ...base,
  });
};
