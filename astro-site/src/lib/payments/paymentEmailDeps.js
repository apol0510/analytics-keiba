/**
 * paymentEmailDeps.js — worker / reconciler の「実 IO 依存」を env から組み立てる境界。
 *
 * ここだけが Airtable / SendGrid / Upstash に実接続する。ロジック本体（paymentEmailWorker.js /
 * paymentEmailReconciler.js）はこれを注入されるだけで、ユニットテストは fake を渡す。
 * この glue 自体はユニットテスト対象外（実接続の境界）。
 */

import { SUPPORT_EMAIL, FROM_EMAIL } from '../../../netlify/functions/config/email-config.js';

const CUSTOMERS = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';

function airtableBase() {
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('Airtable credentials missing');
  return { key, base };
}

async function getRecord(recordId) {
  const { key, base } = airtableBase();
  const res = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(CUSTOMERS)}/${recordId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return { id: j.id, fields: j.fields || {} };
}

async function patchRecord(recordId, fields) {
  const { key, base } = airtableBase();
  const res = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(CUSTOMERS)}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH ${res.status}: ${await res.text()}`);
  return res.json();
}

/** unknown_after_attempt の一覧（reconciler 用）。 */
async function listUnknownAfterAttempt() {
  const { key, base } = airtableBase();
  const formula = `{PaymentEmailStatus} = 'unknown_after_attempt'`;
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(CUSTOMERS)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.records || []).map((r) => ({ id: r.id, fields: r.fields || {} }));
}

/** SendGrid Mail Send。custom_args に record_id / idempotency_key を載せる。throw せず結果を返す。 */
async function sendMail({ to, recordId, idempotencyKey }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { threw: true, error: 'no_api_key' };
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
        reply_to: { email: SUPPORT_EMAIL },
        subject: '【KEIBA Analytics】ご入金を確認いたしました',
        content: [{ type: 'text/html', value: '<p>ご入金を確認いたしました。ご利用を開始いただけます。</p>' }],
        custom_args: { record_id: recordId, idempotency_key: idempotencyKey, purpose: 'payment_confirmation_v2' },
      }),
    });
    return { status: res.status, messageId: res.headers.get('X-Message-Id') || null };
  } catch (e) {
    return { threw: true, error: String(e && e.message).slice(0, 200) };
  }
}

/** SendGrid Activity 検索（idempotency_key で照合）。HTTP status と messages を返す。 */
async function searchActivity(idempotencyKey) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { httpStatus: 0, messages: null };
  try {
    const q = `unique_args["idempotency_key"]="${idempotencyKey}"`;
    const url = `https://api.sendgrid.com/v3/messages?query=${encodeURIComponent(q)}&limit=10`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status !== 200) return { httpStatus: res.status, messages: null };
    const j = await res.json();
    return { httpStatus: 200, messages: Array.isArray(j.messages) ? j.messages : null };
  } catch {
    return { httpStatus: 0, messages: null };
  }
}

// ── Upstash Redis（REST）: ロック + fencing token ─────────────────
function upstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisCmd(args) {
  const u = upstash();
  if (!u) throw new Error('upstash_not_configured');
  const res = await fetch(u.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return (await res.json()).result;
}

/** SET NX EX + fencing token（INCR）。取得できたら {ok, token}。 */
async function acquireLock(key) {
  const token = await redisCmd(['INCR', 'payemail:fence']);
  const ok = await redisCmd(['SET', key, String(token), 'NX', 'EX', '90']);
  return { ok: ok === 'OK', token };
}

async function releaseLock(key, token) {
  // 自分の token のときだけ削除（compare-then-del）。
  const cur = await redisCmd(['GET', key]);
  if (String(cur) === String(token)) await redisCmd(['DEL', key]);
}

/** worker 用の実 deps。 */
export function makeWorkerDeps() {
  return {
    hasApiKey: !!process.env.SENDGRID_API_KEY,
    getRecord, patchRecord, acquireLock, releaseLock, sendMail,
    log: (o) => console.log('[worker]', JSON.stringify(o)),
  };
}

/** reconciler 用の実 deps。 */
export function makeReconcilerDeps() {
  return {
    searchActivity, patchRecord, listUnknownAfterAttempt,
    log: (o) => console.log('[reconciler]', JSON.stringify(o)),
  };
}

export { getRecord, patchRecord };
