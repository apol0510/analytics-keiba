/**
 * cron-prospect-worker.js — 見込み客まわりの**自動処理**（Scheduled Function）
 *
 * ⚠️ **公開 URL からは起動できない。** `export const config = { schedule }` により
 *    scheduled function として配備され、HTTP 起動は Netlify が拒否する。
 *    管理画面から「今すぐ」を押したいときは、**認証済みの管理 API が Redis に
 *    依頼札を立て**、次の tick がそれを拾う（起動経路は schedule だけ）。
 *
 * ── 2 つの仕事 ────────────────────────────────────────────────
 *   1. **反応した人の自動登録**（open / click → ENGAGED → Customers へ冪等に CREATE）
 *   2. **顧客一覧の写しの更新**（依頼があるか、古い / 無いとき）
 *
 * ── 二重登録を作らない ────────────────────────────────────────
 *   - 昇格の権利を `SET NX`（`promo-lock:<hash>`）で 1 つだけ取る
 *   - 写しにアドレスが居れば **そもそも計画に載らない**（`planPromotions`）
 *   - **Airtable の CREATE が成功した相手だけ** PROMOTED にする。
 *     失敗したら **ENGAGED のまま**残し、次の tick で再試行する
 *   - Airtable へは **CREATE のみ**。更新も削除もしない
 *
 * ⚠️ この Function は**メールを送らない**。
 */

import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import { planPromotions } from '../../src/lib/marketing/prospectPipeline.js';
import {
  createSnapshotStore, evaluateSnapshot, SnapshotError,
} from '../../src/lib/marketing/customerSnapshotCache.js';

/** 自動昇格のゲート（**production 未設定**） */
export const AUTO_PROMOTE_ENV = 'MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED';
/** 1 tick で登録する上限（少しずつ進める） */
export const AUTO_PROMOTE_MAX = 100;
const CUSTOMERS_TABLE = 'Customers';
const SNAPSHOT_MAX_PAGES = 2000;

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

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});

/** Customers へ 1 件だけ作る。**成功したら recordId を返す** */
async function createOne({ KEY, BASE, fields }) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  const rec = (data.records || [])[0];
  return { ok: !!rec, recordId: rec ? rec.id : null };
}

/**
 * 反応した人を Customers へ登録する。**1 件ずつ**（失敗を隣へ波及させない）。
 */
export async function promoteEngaged({ store, snapshot, KEY, BASE, now, max }) {
  const out = { 対象: 0, 登録: 0, 失敗: 0, 取り合い: 0, 既存: 0 };
  const customerEmails = await snapshot.loadEmailSet({ nowMs: now });

  const hashes = await store.engagedHashes();
  const prospects = [];
  for (let i = 0; i < hashes.length; i += 500) {
    prospects.push(...await store.loadMany(hashes.slice(i, i + 500)));
  }
  const plan = planPromotions({
    prospects, customerEmails,
    nowIso: new Date(now).toISOString(),
    batchId: `prospect-auto-${new Date(now).toISOString().slice(0, 10)}`,
    availableFields: null, maxPerRun: max || AUTO_PROMOTE_MAX,
  });
  out.対象 = plan.promote.length;
  out.既存 = plan.skipped.already_customer || 0;

  for (const p of plan.promote) {
    const hash = p.hash;
    // ⚠️ 権利を取れなければ他が処理中。**二重に作らない**
    if (hash && !(await store.claimPromotion(hash))) { out.取り合い += 1; continue; }
    try {
      const r = await createOne({ KEY, BASE, fields: p.fields });
      if (!r.ok) {
        // ⚠️ ENGAGED のまま残す（次の tick で再試行される）
        out.失敗 += 1;
        if (hash) await store.releasePromotionClaim(hash);
        continue;
      }
      await store.recordPromotion({ email: p.email, nowMs: now, recordId: r.recordId });
      out.登録 += 1;
    } catch {
      out.失敗 += 1;
      if (hash) await store.releasePromotionClaim(hash).catch(() => {});
    }
  }
  return out;
}

/** 写しを作り直す（Airtable は GET のみ） */
export async function refreshSnapshot({ snapshot, KEY, BASE, now }) {
  const emails = [];
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
      const e = String((r && r.fields && r.fields.Email) || '').trim().toLowerCase();
      if (e) emails.push(e);
    }
    offset = data.offset; pages += 1;
    // ⚠️ 途中で打ち切ったら**写しを更新しない**（不完全な写しで判断させない）
    if (offset && pages >= SNAPSHOT_MAX_PAGES) throw new Error('customers_truncated');
  } while (offset);

  const meta = await snapshot.save({ emails, nowMs: now, source: 'scheduled' });
  return { 件数: meta.count, chunks: meta.chunks, pages };
}

export default async function handler() {
  const now = Date.now();
  const out = { mode: 'prospect-worker', ran: true, 写し: null, 昇格: null, errors: [] };

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return json(503, { ...out, ran: false, reason: 'airtable_not_configured' });
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return json(503, { ...out, ran: false, reason: 'redis_not_configured' });
  }

  const snapshot = createSnapshotStore({ cmd: redisCmd });
  const store = createProspectStore({ cmd: redisCmd });

  // ── 1. 写しの更新（依頼があるか、古い / 無いとき）──
  try {
    const [meta, req] = await Promise.all([snapshot.loadMeta(), snapshot.loadRefreshRequest()]);
    const v = evaluateSnapshot({ meta, nowMs: now });
    if (req || !v.ok) {
      out.写し = await refreshSnapshot({ snapshot, KEY, BASE, now });
      out.写し.契機 = req ? '管理画面からの依頼' : v.reason;
      if (req) await snapshot.clearRefreshRequest();
    } else {
      out.写し = { 更新不要: true, 経過秒: v.経過秒, 件数: v.件数 };
    }
  } catch (e) {
    // 写しが作れなくても昇格は試す（写しが古ければ昇格側が fail-closed で止まる）
    out.errors.push('snapshot_refresh_failed');
    console.error('❌ [prospect-worker] 写しの更新に失敗:', e && e.message);
  }

  // ── 2. 反応した人の自動登録 ──
  if (process.env[AUTO_PROMOTE_ENV] !== 'true') {
    out.昇格 = { 実行: false, reason: 'auto_promote_disabled', 必要なenv: AUTO_PROMOTE_ENV };
  } else {
    try {
      out.昇格 = { 実行: true, ...await promoteEngaged({ store, snapshot, KEY, BASE, now }) };
    } catch (e) {
      if (e instanceof SnapshotError) {
        // ⚠️ 写しが使えないなら**登録しない**（既存顧客との重複を判定できない）
        out.昇格 = { 実行: false, reason: e.code };
      } else {
        out.errors.push('promote_failed');
        console.error('❌ [prospect-worker] 自動登録に失敗しました');
        out.昇格 = { 実行: false, reason: 'promote_failed' };
      }
    }
  }

  console.log('👥 [prospect-worker]', { 写し: out.写し, 昇格: out.昇格, errors: out.errors });
  return json(200, out);
}

// Netlify Scheduled Functions 設定
// ⚠️ cron は **UTC**。10 分ごと。schedule 登録により **公開 URL からは起動できない**。
// ⚠️ 自動登録は `MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED=true` のときだけ動く（production 未設定）。
export const config = {
  schedule: '*/10 * * * *',
};
