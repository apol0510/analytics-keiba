/**
 * kl-paddle（独立サイト版 / checkout.tirol.link 上の modern Netlify function・2026-11-24）
 *
 * KL の Paddle 決済（取引の作成・状態・取消・ポータル・プラン変更・解約・解約の取消）を、KL の署名付き intent で受ける。
 * 本体は lib/servicePaddle.mjs（svc='kl' に固定）。endpoint ごとにサービスを固定し、署名の secret（KL_GRANT_INTERNAL_SECRET）と
 * intent の svc が一致しなければ拒否する。経路: POST /.netlify/functions/kl-paddle（`_redirects` は増やさない）。
 *
 * 必要 env（このサイト）: PADDLE_API_KEY（Live）/ KL_GRANT_INTERNAL_SECRET（32 文字以上）
 */
import { handleServiceIntent } from './lib/servicePaddle.mjs';
import { makeBlobStore } from './lib/checkoutIdempotency.mjs';

// Netlify Blobs は実行時に Netlify が提供する（paddle-create-checkout と同じ store・キーは svc で名前空間を分ける）。
// 解決できなければ予約は 'unavailable'（作成は通す・結果に degraded を立ててログ）。
async function defaultStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return makeBlobStore(getStore, 'paddle-checkout');
  } catch {
    return makeBlobStore(() => { throw new Error('blobs_unavailable'); });
  }
}

export default async (request) => handleServiceIntent({ request, env: process.env, svc: 'kl', store: await defaultStore() });
