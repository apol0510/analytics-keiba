/**
 * POST /api/predictions/acquire — 予想を 1 件取得する（docs/PREDICTION_ACQUISITION.md）
 *
 * フォーム送信（key=予想キー）。成功・取得済みとも 303 で本文ページへ。
 * 同一オリジン以外は 403、権限外は 403、形式外は 400、予想データが無いときは 404、保存できないときは 503。
 * 本人は ak_session の recordId だけ（フォームに会員を指定する項目は無い）。
 */
export const prerender = false;

import { handleAcquire, isSameOriginPost, viewUrlFor } from '../../../lib/acquisition/acquisitionServer.js';

const text = (status, body) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
});

export async function POST({ request }) {
  if (!isSameOriginPost(request)) return text(403, 'Forbidden');
  let rawKey = '';
  try {
    // フォーム（application/x-www-form-urlencoded）の key だけを読む
    const params = new URLSearchParams(await request.text());
    rawKey = String(params.get('key') || '');
  } catch {
    return text(400, 'Bad Request');
  }
  const r = await handleAcquire({ request, rawKey, env: process.env });
  if (r.status === 'denied') return r.response;
  if (r.status === 'ok') {
    return new Response(null, { status: 303, headers: { Location: viewUrlFor(r.key), 'Cache-Control': 'private, no-store' } });
  }
  if (r.status === 'invalid') return text(400, '予想の指定が正しくありません。');
  if (r.status === 'forbidden') return text(403, 'この予想を取得する権利がありません。');
  if (r.status === 'not_found') return text(404, 'この予想は見つかりませんでした。');
  return text(503, 'ただいま予想を取得できません。時間をおいてもう一度お試しください。');
}

export async function GET() {
  return text(405, 'Method Not Allowed');
}
