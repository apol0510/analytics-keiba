/**
 * refresh-customer-snapshot-background.js — Customers の写しを作り直す（Background Function）
 *
 * ── なぜ Background なのか（C-2 の本体）────────────────────────
 * 同期 Function は既定 10 秒で切れる。Customers が 15,000 件を超えると
 * 全件走査は 30〜70 秒かかり、dry-run も ACTIVE 化も**必ず失敗する**。
 * 走査だけをここへ追い出し（Background は 15 分まで）、
 * 同期側は **Redis の写しを読むだけ**にする。
 *
 * ⚠️ **Airtable へは GET のみ。** Customers を書かない・送らない。
 * ⚠️ 認証必須（`x-admin-secret`）。写しの中身は返さない（件数と指紋だけ）。
 * ⚠️ 途中で失敗したら **meta を更新しない**（古い写しのまま残す方が、
 *    半端な写しで送るより安全）。
 */

import { createSnapshotStore } from '../../src/lib/marketing/customerSnapshotCache.js';

const CUSTOMERS_TABLE = 'Customers';
/** Background なので余裕はあるが、無限には回さない */
const MAX_PAGES = 2000;

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
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return { statusCode: 503, body: JSON.stringify({ error: '管理用 secret 未設定' }) };
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { statusCode: 500, body: JSON.stringify({ error: 'Airtable 認証情報が未設定' }) };
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Redis 未設定' }) };
  }

  const now = Date.now();
  const emails = [];
  let offset; let pages = 0;
  try {
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
      // ⚠️ 上限に達したら**写しを更新しない**（不完全な写しで送らせない）
      if (offset && pages >= MAX_PAGES) throw new Error('customers_truncated');
    } while (offset);

    const store = createSnapshotStore({ cmd: redisCmd });
    const meta = await store.save({ emails, nowMs: now, source: 'background' });
    console.log('📇 [customer-snapshot] 更新:', {
      件数: meta.count, chunks: meta.chunks, pages, 所要ms: Date.now() - now,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, 件数: meta.count, chunks: meta.chunks, pages,
        builtAt: meta.builtAt, fingerprint: meta.fingerprint.slice(0, 12),
        所要ms: Date.now() - now,
      }),
    };
  } catch (e) {
    // ⚠️ 中身を返さない。**meta は更新していない**ので、古い写しがそのまま残る
    console.error('❌ [customer-snapshot] 更新に失敗しました:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'refresh failed', pages }) };
  }
};

export default handler;
