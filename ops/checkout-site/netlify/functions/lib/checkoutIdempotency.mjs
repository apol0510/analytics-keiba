/**
 * checkoutIdempotency.mjs（分離サイト / checkout.tirol.link 専用）
 *
 * 取引作成の冪等化と再送・リプレイ時の重複防止。Paddle へ「同じ申込」で取引を 2 件作らない。
 *
 * 監査（2026-10-24 MK）と、その後の独立検証（2026-10-25・KAO codeSignals）への対応:
 *  - 署名付き intent の nonce は 120 秒の tolerance 内で再利用でき得た（単回使用の制御が無かった）。
 *  - transactionId 単位の付与冪等性は、異なる 2 取引が並ぶ二重決済を防がない。
 *  - 🛑 #838 の初版は `get → create → set` が**非原子的**で、2 つの同時リクエスト（二重クリック・
 *    同一 intent のほぼ同時再送）が両方とも get で miss し、両方 create してしまう余地があった
 *    （check-then-act の race）。
 *
 * 対応: 取引作成の前に、冪等キー（recordId+productId）を **原子的に予約**する。
 *  - Netlify Blobs の条件付き書込 `setJSON(key, …, { onlyIfNew: true })`（CAS）で予約を取る。
 *    `modified === true` を得た 1 リクエストだけが create へ進み、結果でマーカを上書きする。
 *  - 予約に負けたリクエストは create せず、勝者が書く結果を短時間だけ待って**同じ取引**を返す
 *    （両タブが同じ checkout を開く）。待っても結果が無ければ create せず 409 `checkout_in_progress`
 *    を返す（retry 可能）。🛑 ここで create に落ちると race を再び開くため、落とさない。
 *  - nonce キーは同一 intent の完全な再送（同じ署名）用の別名で、勝者の結果を指す。
 *
 * ストアは Netlify Blobs（env 追加なし＝本番 4KB 制約に無影響）。TTL は値に expiresAt を持たせて
 * 読み取り時に判定する（Blobs は TTL を持たないため）。
 *
 * ⚠️ fail-open の範囲を限定・可視化した（#838 では無言の fail-open が唯一の防御だった）:
 *  - 通常経路の防御は上の**原子的予約**であって、best-effort な get/set ではない。
 *  - ストア自体が不達のとき（予約が取れない）だけ fail-open で create を通し、結果に `degraded: true`
 *    を立てて呼び出し側がログできるようにする。取引**作成**は課金前の非 charge 操作なので、ここで
 *    fail-closed にすると Blobs 障害中は全 checkout が止まり売上が止まる。障害中の残余リスクは
 *    「未払い取引の重複」だけで、二重課金・二重付与は起きない（Paddle はカード入力時のみ課金、付与は
 *    transactionId で冪等）。この一線は意図的なトレードオフとして明示する。
 */

export const NONCE_TTL_SEC = 180; // 署名 tolerance(120s) を少し超える窓。これ以降の再送は署名期限切れで手前で弾かれる
export const IDEM_TTL_SEC = 30 * 60; // 二重クリック・短時間の再申込をまとめる窓（この間は同じ取引を返す）
// 予約に負けた側が、勝者の結果を待つ上限（contended 時だけ発生する稀路）。
export const WAIT_TRIES = 20;
export const WAIT_DELAY_MS = 150;

const nonceKey = (nonce) => `nonce:${nonce}`;
const idemKey = (recordId, productId) => `idem:${recordId}:${productId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isResult = (v) => Boolean(v && v.transactionId && v.url);

/**
 * Netlify Blobs を使った、expiresAt 付きの小さな KV。
 *  - get: 期限切れ/不在/障害は null。
 *  - set: 既存を上書き（結果の確定）。障害は握りつぶす。
 *  - reserve: **原子的** な新規作成（CAS）。'won'（予約成立）/ 'taken'（既に誰かが居る）/
 *             'unavailable'（ストア不達）。期限切れの残骸は 1 度だけ掃除して取り直す。
 *  - release: 予約の取り消し（create 失敗時に次の試行を塞がないため）。
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
      try { await store.setJSON(key, { value, expiresAt: now + ttlSec * 1000 }); } catch { /* 上書き失敗は次の get で救済 */ }
    },
    async reserve(key, ttlSec, now = Date.now()) {
      if (!store) return 'unavailable';
      const record = { value: { pending: true, at: now }, expiresAt: now + ttlSec * 1000 };
      try {
        let res = await store.setJSON(key, record, { onlyIfNew: true });
        if (res && res.modified) return 'won';
        // 既に存在する。期限切れの残骸（Blobs に TTL が無い）なら 1 度だけ掃除して取り直す。
        const existing = await store.get(key, { type: 'json' });
        if (existing && typeof existing.expiresAt === 'number' && now > existing.expiresAt) {
          try { await store.delete(key); } catch { /* harmless */ }
          res = await store.setJSON(key, record, { onlyIfNew: true });
          if (res && res.modified) return 'won';
        }
        return 'taken';
      } catch { return 'unavailable'; }
    },
    async release(key) {
      if (!store) return;
      try { await store.delete(key); } catch { /* 取り消し失敗は expiresAt で救済 */ }
    },
  };
}

/**
 * 取引作成を冪等に行う。ヒット時／予約競合時は `create` を呼ばず同じ取引を返す。
 * @param {object} a
 * @param {{get:Function,set:Function,reserve?:Function,release?:Function}} a.store
 * @param {string} a.nonce      intent の nonce（同一 intent 再送の別名キー）
 * @param {string} a.recordId
 * @param {string} a.productId
 * @param {() => Promise<{ok:boolean,url?:string,transactionId?:string,status?:number,code?:string}>} a.create
 *        createPaddleTransaction を呼ぶ thunk。成功結果だけをキャッシュする。
 * @param {Date} [a.now]
 * @returns {Promise<{ok:true,url,transactionId,reused?:'nonce'|'idem',degraded?:true}
 *                   | {ok:false,status,code}>}
 */
export async function idempotentCreateCheckout({
  store, nonce, recordId, productId, create, now = new Date(),
  nonceTtlSec = NONCE_TTL_SEC, idemTtlSec = IDEM_TTL_SEC,
  waitTries = WAIT_TRIES, waitDelayMs = WAIT_DELAY_MS,
}) {
  const ms = now.getTime();
  const alias = async (result) => { if (nonce) await store.set(nonceKey(nonce), result, nonceTtlSec, ms); };

  // 1) 同一 intent（nonce）の完全な再送・リプレイ → 作り直さず同じ取引を返す
  if (nonce) {
    const hit = await store.get(nonceKey(nonce), ms);
    if (isResult(hit)) return { ok: true, url: hit.url, transactionId: hit.transactionId, reused: 'nonce' };
  }
  const ik = (recordId && productId) ? idemKey(recordId, productId) : null;

  // 2) 同じ会員・同じ商品で、既に結果が確定していれば同じ取引を返す（二重クリックの後着など）
  if (ik) {
    const hit = await store.get(ik, ms);
    if (isResult(hit)) { await alias(hit); return { ok: true, url: hit.url, transactionId: hit.transactionId, reused: 'idem' }; }
  }

  // 3) 🛑 race を閉じる要: 作成の前に冪等キーを **原子的に** 予約する。
  //    reserve が無い store（古い呼び出し元・テスト）では best-effort にフォールバックする。
  const reserved = (ik && typeof store.reserve === 'function') ? await store.reserve(ik, idemTtlSec, ms) : 'unavailable';

  if (reserved === 'taken') {
    // 予約に負けた = 別リクエストが作成中/作成済み。勝者の結果を短時間だけ待って同じ取引を返す。
    let other = await store.get(ik, ms);
    for (let i = 0; !isResult(other) && i < waitTries; i += 1) {
      await sleep(waitDelayMs);
      other = await store.get(ik, ms);
    }
    if (isResult(other)) { await alias(other); return { ok: true, url: other.url, transactionId: other.transactionId, reused: 'idem' }; }
    // 待っても結果が無い（勝者がまだ create 中/失敗）→ 二重作成を避け、retry 可能な 409 を返す。
    return { ok: false, status: 409, code: 'checkout_in_progress' };
  }

  // reserved === 'won'（この 1 件だけが作成権を持つ）/ 'unavailable'（ストア不達 → fail-open で作成は通す）
  const r = await create();
  if (!r || !r.ok) {
    if (ik && reserved === 'won' && typeof store.release === 'function') await store.release(ik); // 予約を解放（次の試行を塞がない）
    return r;
  }
  const cached = { url: r.url, transactionId: r.transactionId };
  if (ik) await store.set(ik, cached, idemTtlSec, ms); // 予約マーカを結果で上書き（確定）
  await alias(cached);
  return { ok: true, url: r.url, transactionId: r.transactionId, ...(reserved === 'unavailable' ? { degraded: true } : {}) };
}
