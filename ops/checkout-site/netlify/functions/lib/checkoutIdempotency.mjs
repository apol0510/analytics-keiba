/**
 * checkoutIdempotency.mjs（分離サイト / checkout.tirol.link 専用）
 *
 * 取引作成の冪等化と再送・リプレイ時の重複防止。Paddle へ「同じ申込」で取引を 2 件作らない。
 *
 * 監査（2026-10-24 MK）への対応:
 *  - 署名付き intent の nonce は 120 秒の tolerance 内で再利用でき得た（単回使用の制御が無かった）。
 *  - transactionId 単位の付与冪等性は、異なる 2 取引が並ぶ二重決済を防がない。
 * 対応: 取引作成の前に 2 つの冪等キーを確認し、ヒットすれば **新しい Paddle 取引を作らず** 既存を返す。
 *  1) nonce キー         … 同一 intent の再送・リプレイ（署名が有効な 120 秒窓）→ 同じ取引を返す（新規作成しない）
 *  2) recordId+productId … 二重クリック等、別 intent（別 nonce）での同一申込の再送 → 同じ取引を返す
 * どちらも「未払い取引を 2 件作らない」ことが目的。Paddle はカード入力時だけ課金し、付与は transactionId で冪等なので、
 * 仮にすり抜けても二重課金・二重付与は起きないが、未払い取引の乱立と会員の混乱を避ける。
 *
 * ストアは Netlify Blobs（env 追加なし＝本番 4KB 制約に無影響）。TTL は値に expiresAt を持たせて読み取り時に判定する
 * （Blobs は TTL を持たないため）。ストア障害は fail-open（dedup を諦めてでも取引作成は通す）。失敗して困るのは
 * 「作れない」方であり、重複は上流の冪等性で吸収できる。
 */

export const NONCE_TTL_SEC = 180; // 署名 tolerance(120s) を少し超える窓。これ以降の再送は署名期限切れで手前で弾かれる
export const IDEM_TTL_SEC = 30 * 60; // 二重クリック・短時間の再申込をまとめる窓（この間は同じ取引を返す）

const nonceKey = (nonce) => `nonce:${nonce}`;
const idemKey = (recordId, productId) => `idem:${recordId}:${productId}`;

/**
 * Netlify Blobs を使った、expiresAt 付き・fail-open な小さな KV。
 * get: 期限切れ/不在/障害は null。set: 障害は握りつぶす（dedup を諦めるだけ）。
 */
export function makeBlobStore(getStore, name = 'paddle-checkout') {
  let store = null;
  try { store = getStore(name); } catch { store = null; }
  return {
    async get(key, now = Date.now()) {
      if (!store) return null;
      try {
        const v = await store.get(key, { type: 'json' });
        if (!v || typeof v.expiresAt !== 'number') return null;
        if (now > v.expiresAt) { try { await store.delete(key); } catch { /* 期限切れの掃除失敗は無害 */ } return null; }
        return v.value ?? null;
      } catch { return null; }
    },
    async set(key, value, ttlSec, now = Date.now()) {
      if (!store) return;
      try { await store.setJSON(key, { value, expiresAt: now + ttlSec * 1000 }); } catch { /* fail-open */ }
    },
  };
}

/**
 * 取引作成を冪等に行う。ヒット時は `create` を呼ばず既存の {url, transactionId} を返す。
 * @param {object} a
 * @param {{get:Function,set:Function}} a.store
 * @param {string} a.nonce      intent の nonce（単回使用の冪等キー）
 * @param {string} a.recordId
 * @param {string} a.productId
 * @param {() => Promise<{ok:boolean,url?:string,transactionId?:string,status?:number,code?:string}>} a.create
 *        createPaddleTransaction を呼ぶ thunk。成功結果だけをキャッシュする。
 * @param {Date} [a.now]
 * @returns {Promise<{ok:true,url,transactionId,reused?:'nonce'|'idem'} | {ok:false,status,code}>}
 */
export async function idempotentCreateCheckout({ store, nonce, recordId, productId, create, now = new Date(), nonceTtlSec = NONCE_TTL_SEC, idemTtlSec = IDEM_TTL_SEC }) {
  const ms = now.getTime();
  // 1) 同一 intent（nonce）の再送・リプレイ → 作り直さず同じ取引を返す
  if (nonce) {
    const hit = await store.get(nonceKey(nonce), ms);
    if (hit?.transactionId && hit?.url) return { ok: true, url: hit.url, transactionId: hit.transactionId, reused: 'nonce' };
  }
  // 2) 別 intent でも同じ会員・同じ商品なら、短時間は同じ取引を返す（二重クリック等）
  const ik = (recordId && productId) ? idemKey(recordId, productId) : null;
  if (ik) {
    const hit = await store.get(ik, ms);
    if (hit?.transactionId && hit?.url) {
      if (nonce) await store.set(nonceKey(nonce), hit, nonceTtlSec, ms); // この nonce でも同じ結果を指す
      return { ok: true, url: hit.url, transactionId: hit.transactionId, reused: 'idem' };
    }
  }
  // 3) 新規作成（成功時だけキャッシュ）
  const r = await create();
  if (!r || !r.ok) return r;
  const cached = { url: r.url, transactionId: r.transactionId };
  if (ik) await store.set(ik, cached, idemTtlSec, ms);
  if (nonce) await store.set(nonceKey(nonce), cached, nonceTtlSec, ms);
  return { ok: true, url: r.url, transactionId: r.transactionId };
}
