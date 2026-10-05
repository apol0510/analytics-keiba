/**
 * /api/plan-status.json — 端末に残った「無料ログイン」が、いまは有料会員かを確かめる（POST・読むだけ）
 *
 * 返すのは `{ requiresLogin: boolean }` だけ（プラン名・期限・氏名は返さない）。
 * 「有料会員はログインリンクが要る」という情報は /login（auth-user）が既に返している範囲と同じ。
 * auth-user と違い、最終ログインの書き込みもトークン発行もしない（副作用ゼロ）。
 * 使い方は `staleFreeSession.js`（1 端末 12 時間に 1 回）。
 */
export const prerender = false;

import { resolveMembership, shouldSendMagicLink, classifyCustomerMatches, CUSTOMER_LOOKUP } from '../../lib/auth/index.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function POST({ request }) {
  let email = '';
  try { email = String((await request.json())?.email || '').trim().toLowerCase(); } catch { /* 下で弾く */ }
  if (!/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email) || email.length > 254) return reply(400, { error: 'invalid' });
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) return reply(503, { error: 'unavailable' });
  try {
    const q = new URLSearchParams({ filterByFormula: `LOWER(TRIM({Email})) = '${email}'`, maxRecords: '5' });
    const res = await fetch(`https://api.airtable.com/v0/${base}/Customers?${q}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return reply(503, { error: 'unavailable' });
    const rows = (await res.json()).records || [];
    const lookup = classifyCustomerMatches(rows);
    // 見つからない・重複は「確かめられない」＝ログアウトさせない（推測で状態を変えない）
    if (lookup.kind !== CUSTOMER_LOOKUP.SINGLE) return reply(200, { requiresLogin: false });
    const membership = resolveMembership({ fields: lookup.record.fields, recordId: lookup.record.id, now: Date.now() });
    return reply(200, { requiresLogin: shouldSendMagicLink(membership) });
  } catch {
    return reply(503, { error: 'unavailable' });
  }
}
