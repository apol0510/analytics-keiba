/**
 * admin-marketing-automation.js — AK 専用メルマガ自動化の**管理 API（Phase A: dry-run まで）**
 *
 * ── この Function は絶対にメールを送らない ────────────────────
 * SendGrid の**送信 API を呼ぶコードを持たない**（guard テストで固定）。
 * 自動化は**新しい配信基盤を作らない**。実際の enqueue / 送信は既存 AK の
 *   `admin-marketing.js`（ScheduledEmails / CampaignDeliveries へ登録）
 *   → 既存 dispatcher（`MARKETING_CAMPAIGN_DISPATCH_ENABLED` でゲート）
 * にそのまま乗る。**送信経路は 1 つだけ**。
 *
 * ── Phase A の範囲 ────────────────────────────────────────────
 *   `list`    … プリセットと現在の設定（read-only）
 *   `preview` … **dry-run**。対象件数と除外理由だけを返す（**1 通も送らない・1 行も書かない**）
 *   `status`  … 実行履歴の表示（read-only）
 * `enable` / `run` / `cancel` は **Phase B**。本 Phase では 501 を返す
 * （設定の永続化と実行は、承認後に別途配線する）。
 *
 * ── Customers を変えない ──────────────────────────────────────
 * 会員昇格・PaymentConfirmed・Status・PlanType・有効期限・特典を**書く経路が無い**。
 * Airtable へは **GET しか出さない**（guard テストで固定）。
 *
 * ── KMA を持ち込まない ────────────────────────────────────────
 * tenant / 顧客 / キャンペーン / 送信元 / 配信停止 / 台帳 / env / Redis / Airtable /
 * 料金 / UI は**すべて AK 内が正本**。KMA の名前空間・env・送信元は参照しない。
 */

import {
  createAutomationAdminApi, isWriteEnabled, WRITE_ACTIONS, WRITE_GATE_ENV,
} from '../../src/lib/marketing/automationAdminApi.js';
import { createAutomationStore } from '../../src/lib/marketing/automationStore.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';

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

const CUSTOMERS_TABLE = 'Customers';
/**
 * ⚠️ 上限に達したら**黙って打ち切らず失敗させる**。
 * 以前は 60 ページ（6,000 件）で `break` して黙って返していた。外部無料ユーザーの
 * 取り込みで Customers が 15,000 件規模になると、**先頭 6,000 件だけで対象集合・件数・
 * 指紋を計算し、しかもエラーにならない**。過小な対象で dry-run が通り、そのまま承認されうる。
 */
const MAX_PAGES = 300;
export class CustomerFetchTruncatedError extends Error {
  constructor(pages, count) {
    super('customers_truncated');
    this.name = 'CustomerFetchTruncatedError';
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

/** Airtable は **GET のみ**（この Function に書き込み経路は無い） */
async function fetchAllReadOnly({ KEY, BASE, table }) {
  const out = [];
  let offset; let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset; pages += 1;
    // ⚠️ まだ続きがあるのに上限に達した = 対象集合が不完全。**返さずに落とす**
    if (offset && pages >= MAX_PAGES) throw new CustomerFetchTruncatedError(pages, out.length);
  } while (offset);
  return out;
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
  const action = req.action || 'list';
  const now = Date.now();

  // ══ production write のハードゲート ══════════════════════════
  // ⚠️ **Redis store を初期化する前**に弾く（接続 0）。
  //    UI で隠すだけでは足りないので、API を直接叩かれても必ずここで止まる。
  if (WRITE_ACTIONS.includes(action) && !isWriteEnabled(process.env)) {
    return json(403, {
      mode: `automation-${action}`,
      ok: false,
      code: 'write_blocked',
      error: '本番自動配信は未有効です（管理者による書き込みが無効化されています）。',
      必要なenv: WRITE_GATE_ENV,
      接続: { redis: false, airtable: false },
      sideEffects: 'none',
    });
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  // Redis は**設定されているときだけ**組み立てる（未設定なら store=null で fail-closed 表示）
  const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  const store = hasRedis ? createAutomationStore({ cmd: redisCmd }) : null;

  const api = createAutomationAdminApi({
    store, env: process.env, now: () => now,
    loadCustomers: () => fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE }),
    loadBlacklist: () => fetchEmailBlacklistReadOnly(BASE, KEY)
      .then((r) => buildBlacklistEmailSet(r || [])).catch(() => new Set()),
  });

  try {
    let out;
    if (action === 'list') out = await api.list();
    else if (action === 'get') out = await api.get({ automationId: req.automationId });
    else if (action === 'preview') out = await api.preview({ automationId: req.automationId, overrides: req.overrides });
    else if (action === 'runs') out = await api.runs({ automationId: req.automationId });
    else if (action === 'run-detail') out = await api.runDetail({ runId: req.runId });
    else if (action === 'status') out = await api.status({ automationId: req.automationId });
    else if (action === 'create') out = await api.create({ presetId: req.presetId, overrides: req.overrides });
    else if (action === 'update') out = await api.update({ automationId: req.automationId, expectedVersion: req.expectedVersion, overrides: req.overrides });
    else if (action === 'activate') out = await api.activate({ automationId: req.automationId, expectedVersion: req.expectedVersion, snapshotFingerprint: req.snapshotFingerprint });
    else if (action === 'pause') out = await api.pause({ automationId: req.automationId, expectedVersion: req.expectedVersion });
    else if (action === 'cancel') out = await api.cancel({ automationId: req.automationId, expectedVersion: req.expectedVersion, queueSnapshot: req.queueSnapshot });
    else return json(400, { error: `未知の action: ${action}` });

    if (out && out.ok === false) {
      const status = out.code === 'store_unavailable' ? 503
        : (out.code === 'not_found' ? 404 : 409);
      return json(status, out);
    }
    return json(200, out);
  } catch (e) {
    // 顧客一覧が途中までしか取れていない場合は、**過小な対象で先へ進ませない**
    if (e instanceof CustomerFetchTruncatedError) {
      console.error('❌ [marketing-automation] 顧客一覧が上限で打ち切られました');
      return json(503, {
        ok: false, code: e.code,
        error: '顧客一覧を最後まで取得できませんでした。対象が不完全なため中止しました。',
        取得ページ数: e.pages, 取得件数: e.count, 上限: MAX_PAGES,
        sideEffects: 'none',
      });
    }
    // ⚠️ 例外の中身をそのまま返さない（顧客データが混ざりうる）
    console.error('❌ [marketing-automation] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
