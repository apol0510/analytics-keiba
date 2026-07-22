/**
 * paymentEmailDeps.js — worker / reconciler の「実 IO 依存」を env から組み立てる境界。
 *
 * ここだけが Airtable / SendGrid / Upstash に実接続する。ロジック本体（paymentEmailWorker.js /
 * paymentEmailReconciler.js）はこれを注入されるだけで、ユニットテストは fake を渡す。
 * この glue 自体はユニットテスト対象外（実接続の境界）。
 */

// 決済メール経路の送信元は senderIdentity.js が単一源。email-config.js の FROM_EMAIL
// （noreply@keiba.link・ニュースレター等の別経路用）は **この経路では import しない**。
import { SUPPORT_EMAIL } from '../../../netlify/functions/config/email-config.js';
import { resolveVerifiedSender, hasVerifiedSender } from './senderIdentity.js';
import { buildPaymentConfirmationEmail } from './paymentConfirmationEmail.js';
import { runWorkerOnce } from './paymentEmailWorker.js';

const CUSTOMERS = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';

/** 本番 Customers の接続先（key / base / table）。 */
function productionTarget() {
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('Airtable credentials missing');
  return { key, base, table: CUSTOMERS };
}

/**
 * カナリア専用の接続先。**専用 env のみ**を使い、本番 Customers / 本番キーへは絶対に fallback しない。
 * - 認証キーは **PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY のみ**（本番 AIRTABLE_API_KEY は参照しない）。
 * - Base/Table も専用 env のみ。
 * いずれか未設定なら throw（fail closed）。key / Base ID / Table ID は例外メッセージにも載せない。
 */
function canaryTarget() {
  const key = process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY;
  const base = process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID;
  const table = process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID;
  if (!key) throw new Error('canary airtable api key not configured'); // 値は出さない（fail closed）
  if (!base || !table) throw new Error('canary airtable target not configured'); // 値は出さない（fail closed）
  return { key, base, table };
}

async function getRecordFrom(target, recordId) {
  const res = await fetch(`https://api.airtable.com/v0/${target.base}/${encodeURIComponent(target.table)}/${recordId}`, {
    headers: { Authorization: `Bearer ${target.key}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return { id: j.id, fields: j.fields || {} };
}

async function patchRecordFrom(target, recordId, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${target.base}/${encodeURIComponent(target.table)}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH ${res.status}`); // Base/Table/本文をログへ出さない
  return res.json();
}

/** unknown_after_attempt の一覧（reconciler 用）。 */
async function listUnknownFrom(target) {
  const formula = `{PaymentEmailStatus} = 'unknown_after_attempt'`;
  const url = `https://api.airtable.com/v0/${target.base}/${encodeURIComponent(target.table)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${target.key}` } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.records || []).map((r) => ({ id: r.id, fields: r.fields || {} }));
}

/**
 * **書込み先フィールドの存在確認（read-only プローブ）**。
 *
 * Airtable の List Records は `fields[]` に**存在しないフィールド名**が含まれると 422
 * （UNKNOWN_FIELD_NAME）を返す。この性質を使い、**1 件も書かずに**必要フィールドの
 * 有無を判定する。
 *
 * この方式を選ぶ理由:
 * - **Meta API（schema.bases:read）権限に依存しない**。カナリア PAT は data scope のみで 403 になる
 * - **本番レコードへの試験書込みをしない**（no-op PATCH 方式は採らない）
 * - test Base / production Base で**同一の契約**（呼び出し側は deps 差し替えのみ）
 *
 * 欠落時は個別に二分せず、1 フィールドずつ確認して**欠落名の一覧**を返す（運用者が直せるように）。
 * 判定不能（ネットワーク断・401/403 等）は **ok:false** とし fail closed にする。
 * 応答本文・Base/Table・レコード値はログにも戻り値にも含めない。
 */
async function verifyWritableFieldsFrom(target, fieldNames) {
  const base = `https://api.airtable.com/v0/${target.base}/${encodeURIComponent(target.table)}`;
  const probe = async (names) => {
    const qs = names.map((n) => `fields%5B%5D=${encodeURIComponent(n)}`).join('&');
    const res = await fetch(`${base}?maxRecords=1&${qs}`, {
      headers: { Authorization: `Bearer ${target.key}` },
    });
    return res.status; // 200 = 全て存在 / 422 = いずれか不明 / それ以外 = 判定不能
  };
  try {
    const all = await probe(fieldNames);
    if (all === 200) return { ok: true, missing: [] };
    if (all !== 422) return { ok: false, missing: null, undetermined: true }; // fail closed
    const missing = [];
    for (const name of fieldNames) {
      const one = await probe([name]);
      if (one === 422) missing.push(name);
      else if (one !== 200) return { ok: false, missing: null, undetermined: true };
    }
    return { ok: false, missing };
  } catch {
    return { ok: false, missing: null, undetermined: true }; // 判定不能 = fail closed
  }
}

/**
 * pending の一覧（dispatcher 用）。**status=pending に限定し件数制限**して取得する。
 * 全件走査はしない。必要フィールドだけ取得し、Email 等の PII は取り出さない。
 * pending 判定は Airtable 側 filterByFormula で行い、取得後も id/fields のみ返す。
 */
async function listPendingFrom(target, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
  const formula = `{PaymentEmailStatus} = 'pending'`;
  // fields[] で必要最小限だけ取得（Email / 氏名は取らない）。maxRecords で上限を固定。
  const fieldsQs = ['PaymentEmailStatus', 'PaymentEmailIdempotencyKey', 'PaymentEmailAttemptCount']
    .map((n) => `fields%5B%5D=${encodeURIComponent(n)}`).join('&');
  const url = `https://api.airtable.com/v0/${target.base}/${encodeURIComponent(target.table)}`
    + `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${cap}&pageSize=${cap}&${fieldsQs}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${target.key}` } });
  if (!res.ok) return []; // 取得失敗は 0 件（fail closed で送らない）
  const j = await res.json();
  return (j.records || []).map((r) => ({ id: r.id, fields: r.fields || {} }));
}

// 本番 Customers 用（admin-promote-customer.js / reconciler / worker が使う）。
async function getRecord(recordId) { return getRecordFrom(productionTarget(), recordId); }
async function patchRecord(recordId, fields) { return patchRecordFrom(productionTarget(), recordId, fields); }
async function listUnknownAfterAttempt() { return listUnknownFrom(productionTarget()); }
async function listPending(limit) { return listPendingFrom(productionTarget(), limit); }

/** SendGrid Mail Send。custom_args に record_id / idempotency_key を載せる。throw せず結果を返す。 */
async function sendMail({ to, recordId, idempotencyKey, fullName, plan, planType, expiration }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { threw: true, error: 'no_api_key' };
  // 送信元契約（単一源 senderIdentity.js）。未設定 / 空 / 不一致は **POST せず** fail closed。
  // worker 側でも事前に弾くが、直接呼ばれても送らないよう二重化する（noreply へ落とさない）。
  const sender = resolveVerifiedSender(process.env);
  if (!sender.ok) return { threw: true, error: sender.reason }; // 値は載せない（reason コードのみ）

  // 本文の単一源。**ログイン導線は必ずこの builder が入れる**（ここで文字列を組み立てない）。
  const mail = buildPaymentConfirmationEmail({
    fullName, plan, planType, expiration,
    siteBase: process.env.MAGIC_LINK_BASE_URL, // 未設定なら builder が本番 URL をフォールバック
  });

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: sender.email, name: sender.name },
        reply_to: { email: SUPPORT_EMAIL },
        subject: mail.subject,
        content: [
          // text/plain を先に置く（SendGrid は content 配列の順序で MIME を構成する）
          { type: 'text/plain', value: mail.text },
          { type: 'text/html', value: mail.html },
        ],
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
    hasVerifiedSender: hasVerifiedSender(process.env),
    getRecord, patchRecord, acquireLock, releaseLock, sendMail,
    verifyWritableFields: (names) => verifyWritableFieldsFrom(productionTarget(), names),
    log: (o) => console.log('[worker]', JSON.stringify(o)),
  };
}

/**
 * カナリア専用 worker deps。**専用 Base/Table のみ**を使う（本番 Customers へ fallback しない）。
 * カナリア env 未設定なら canaryTarget() が throw して fail closed になる。
 */
export function makeCanaryWorkerDeps() {
  const target = canaryTarget();
  return {
    // 送信元契約は通常 worker と**同一**（カナリアだけ別の送信元を使わない）。
    hasApiKey: !!process.env.SENDGRID_API_KEY,
    hasVerifiedSender: hasVerifiedSender(process.env),
    getRecord: (id) => getRecordFrom(target, id),
    patchRecord: (id, f) => patchRecordFrom(target, id, f),
    acquireLock, releaseLock, sendMail,
    // schema preflight も本番と同一契約（カナリアだけ検証を省かない）。
    verifyWritableFields: (names) => verifyWritableFieldsFrom(target, names),
    log: (o) => console.log('[canary-worker]', JSON.stringify(o)),
  };
}

/**
 * dispatcher 用の実 deps（B1）。pending 列挙 + worker コアの同一プロセス実行 + dispatch ロック。
 * runOne は **worker コア（runWorkerOnce）を HTTP を介さず**直接実行する。
 */
export function makeSchedulerLockDeps() {
  return { acquireLock, releaseLock };
}

export function makeDispatcherDeps() {
  const workerDeps = makeWorkerDeps();
  return {
    acquireLock, releaseLock,
    listPending,
    runOne: (recordId, now) => runWorkerOnce({ recordId, now, deps: workerDeps }),
    log: (o) => console.log('[dispatcher]', JSON.stringify(o)),
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
