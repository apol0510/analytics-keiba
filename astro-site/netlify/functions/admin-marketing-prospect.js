/**
 * admin-marketing-prospect.js — 見込み客プールの管理 API
 *
 * ⚠️ **メールを送らない**（SendGrid 送信 API を呼ぶコードを持たない）。
 *    配信は既存 dispatcher の 1 本のまま。ここがやるのは
 *    「誰を送信候補にするか」「反応した人を Customers へ登録するか」の管理だけ。
 *
 * ⚠️ Airtable へは **Customers の GET** と、昇格時の **CREATE のみ**。
 *    更新・削除の経路を持たない（allow-list は取り込みと共有）。
 *
 * ⚠️ write（`intake` / `promote` / `suppress`）は
 *    `MARKETING_PROSPECT_WRITE_ENABLED=true` でなければ
 *    **Redis / Airtable を初期化する前に 403**。
 */

import {
  createProspectAdminApi, isProspectWriteEnabled,
  PROSPECT_WRITE_ACTIONS, PROSPECT_WRITE_GATE_ENV,
} from '../../src/lib/marketing/prospectAdminApi.js';
import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import { normalizeEmail } from '../../src/lib/marketing/prospectPolicy.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';
import { createSnapshotStore, SnapshotError } from '../../src/lib/marketing/customerSnapshotCache.js';

const CUSTOMERS_TABLE = 'Customers';
/** 上限に達したら**黙って打ち切らず失敗させる**（対象が不完全なまま進めない） */
const MAX_PAGES = 300;

class CustomerFetchTruncatedError extends Error {
  constructor(pages, count) {
    super('customers_truncated');
    this.code = 'customers_truncated';
    this.pages = pages; this.count = count;
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

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
 * Customers のアドレス集合は **Redis の写しから読む**（C-2）。
 * 同期 Function で全件走査するとタイムアウトするため、走査は
 * `refresh-customer-snapshot-background` に任せてある。
 * 写しが**無い / 古い**ときは **fail-closed**（古い対象で判断させない）。
 */
async function loadCustomerEmailsFromSnapshot({ nowMs }) {
  const store = createSnapshotStore({ cmd: redisCmd });
  return store.loadEmailSet({ nowMs });
}

/** 直接走査版（**使わない**。写しが作れない環境の切り分け用に残す） */
async function fetchCustomerEmails({ KEY, BASE }) {
  const emails = new Set();
  let offset; let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.append('fields[]', 'Email');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`Customers fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    for (const r of (data.records || [])) {
      const e = normalizeEmail(r && r.fields && r.fields.Email);
      if (e) emails.add(e);
    }
    offset = data.offset; pages += 1;
    if (offset && pages >= MAX_PAGES) throw new CustomerFetchTruncatedError(pages, emails.size);
  } while (offset);
  return emails;
}

/** Customers へ **CREATE だけ**（10 件ずつ）。更新も削除もしない */
async function createCustomers({ KEY, BASE, fieldsList }) {
  let created = 0;
  const okIndexes = new Set();
  const recordIds = [];
  for (let i = 0; i < fieldsList.length; i += 10) {
    const chunk = fieldsList.slice(i, i + 10);
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk.map((fields) => ({ fields })), typecast: false }),
    });
    if (!res.ok) {
      // ⚠️ 失敗した塊は**成功扱いにしない**。次回に持ち越す
      console.error(`❌ [prospect] Customers CREATE 失敗 HTTP ${res.status}`);
      continue;
    }
    const data = await res.json();
    const recs = data.records || [];
    for (let j = 0; j < recs.length; j += 1) { okIndexes.add(i + j); recordIds[i + j] = recs[j].id; }
    created += recs.length;
  }
  return { created, okIndexes, recordIds };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'status';
  const now = Date.now();

  // ══ write のハードゲート（**Redis / Airtable 初期化より前**）══
  if (PROSPECT_WRITE_ACTIONS.includes(action) && !isProspectWriteEnabled(process.env)) {
    return json(403, {
      mode: `prospect-${action}`, ok: false, code: 'prospect_write_blocked',
      error: '見込み客の書き込みは未有効です。',
      必要なenv: PROSPECT_WRITE_GATE_ENV,
      接続: { redis: false, airtable: false }, sideEffects: 'none',
    });
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  const store = hasRedis ? createProspectStore({ cmd: redisCmd }) : null;
  const snapshot = hasRedis ? createSnapshotStore({ cmd: redisCmd }) : null;

  const api = createProspectAdminApi({
    store, env: process.env, now: () => now,
    loadCustomerEmails: () => loadCustomerEmailsFromSnapshot({ nowMs: now }),
    loadBlacklist: () => fetchEmailBlacklistReadOnly(BASE, KEY)
      .then((r) => buildBlacklistEmailSet(r || [])).catch(() => new Set()),
    createCustomers: (fieldsList) => createCustomers({ KEY, BASE, fieldsList }),
    availableFields: null,
  });

  try {
    let out;
    if (action === 'status') out = await api.status();
    else if (action === 'preview') out = await api.preview({ maxRecipients: req.maxRecipients, runId: req.runId });
    else if (action === 'promotion-preview') out = await api.promotionPreview({ batchId: req.batchId });
    else if (action === 'lookup') out = await api.lookup({ email: req.email });
    else if (action === 'intake') out = await api.intake({ rows: req.rows, batchId: req.batchId });
    else if (action === 'promote') out = await api.promote({ batchId: req.batchId, confirmCount: req.confirmCount });
    else if (action === 'suppress') out = await api.suppress({ email: req.email, reason: req.reason });
    else if (action === 'purge') out = await api.purge({ limit: req.limit });
    else if (action === 'request-snapshot-refresh') out = await api.requestSnapshotRefresh({ snapshot });
    else return json(400, { error: `未知の action: ${action}` });

    if (out && out.ok === false) {
      const status = out.code === 'prospect_store_unavailable' ? 503
        : (out.code === 'not_found' ? 404 : 409);
      return json(status, out);
    }
    return json(200, out);
  } catch (e) {
    // 写しが無い / 古い / 壊れている → **判断させない**（送信も登録もしない）
    if (e instanceof SnapshotError) {
      return json(503, {
        ok: false, code: e.code,
        error: '顧客一覧の写しが使えません（未作成または古い）。先に写しを更新してください。',
        更新方法: 'refresh-customer-snapshot-background を実行',
        sideEffects: 'none',
      });
    }
    if (e instanceof CustomerFetchTruncatedError) {
      return json(503, {
        ok: false, code: e.code,
        error: '顧客一覧を最後まで取得できませんでした。対象が不完全なため中止しました。',
        取得ページ数: e.pages, 上限: MAX_PAGES, sideEffects: 'none',
      });
    }
    // ⚠️ 例外の中身をそのまま返さない（アドレスが混ざりうる）
    console.error('❌ [prospect] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
