/**
 * Premium Plus 実績画像 API（Netlify Blobs）— Phase 3
 *
 * 認可・保存ロジックは純粋モジュール（src/lib/premiumPlus/*）に置き、この Function は
 *   - kill-switch（最上流）
 *   - Netlify Blobs を注入ストアにアダプト
 *   - process.env / event ヘッダの読み取り
 * だけを担う薄いアダプタ。
 *
 * GET  ?action=manifest / ?action=image&date=YYYY-MM-DD … 会員（premium-sanrenpuku/combo）のみ
 * POST { action: upload|seed|hide|show|rollback|status, operationId, expectedVersion, ... }
 *        … 管理者（x-admin-secret + production + 正規 Origin）のみ
 *
 * env: SESSION_SIGNING_SECRET / PREMIUM_PLUS_ADMIN_SECRET / PREMIUM_PLUS_ENABLED / CONTEXT
 *      NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN（ローカル netlify dev のみ）
 */

import { getStore, connectLambda } from '@netlify/blobs';
import { handleMediaGet, handleMediaPost } from '../../src/lib/premiumPlus/mediaHandlers.js';
import { resolvePremiumPlusStoreName } from '../../src/lib/premiumPlus/storeSelection.js';

/** Netlify Blobs を manifestStore が期待する注入インターフェースにアダプトする。 */
function blobStore(storeName) {
  // consistency は既定（eventual）。strong 読取は uncachedEdgeURL を要するが、classic Function の
  // connectLambda コンテキストには含まれず BlobsConsistencyError になる。
  //
  // ⚠️ Phase 5（2026-07-16）で確定した重要事実:
  //   Netlify Blobs は同一キー競合 last-write-wins で concurrency control を提供しない。
  //   onlyIfNew / onlyIfMatch は best-effort であって strong な排他保証ではなく、eventual read で
  //   「キー無し／古い etag」を見た writer が既存の勝者を上書きできる（canary #13 で実 lost-update を
  //   確認）。strong 読取（uncachedEdgeURL）を足しても書込みの排他は得られない。
  //   → この manifest/pointer 更新経路は Blobs 単独では安全でないため、runHandler の
  //     PREMIUM_PLUS_STORAGE_SAFE hard block で常時 404 に封じている。画像（immutable・非競合）の
  //     保存先としてのみ Blobs を使う。詳細: docs/PREMIUM_PLUS_STORAGE_DESIGN.md
  const options = { name: storeName };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  const s = siteID && token ? getStore({ ...options, siteID, token }) : getStore(options);

  return {
    async getJSONWithEtag(key) {
      const res = await s.getWithMetadata(key, { type: 'json' });
      return res ? { value: res.data ?? null, etag: res.etag ?? null } : { value: null, etag: null };
    },
    async getBytes(key) {
      const res = await s.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!res || res.data == null) return null;
      return { bytes: new Uint8Array(res.data), metadata: res.metadata || {} };
    },
    async setJSON(key, obj) {
      await s.setJSON(key, obj);
    },
    // create-only（If-None-Match:*）。既存なら { modified:false }
    async setJSONIfNew(key, obj) {
      return s.setJSON(key, obj, { onlyIfNew: true });
    },
    // CAS（If-Match:<etag>）。etag 不一致なら { modified:false }
    async setJSONIfMatch(key, obj, etag) {
      return s.setJSON(key, obj, { onlyIfMatch: etag });
    },
    // immutable 画像（create-only）
    async setBytesIfNew(key, bytes, metadata) {
      return s.set(key, Buffer.from(bytes), { onlyIfNew: true, metadata });
    },
  };
}

/** Netlify エントリ。テストは runHandler に blobStore factory を注入する。 */
export async function handler(event) {
  return runHandler(event);
}

/**
 * @param {object} event  Netlify Functions event
 * @param {{blobStore?: (storeName:string)=>object}} [deps]  テスト用に store factory を注入可能
 */
// eventual read 収束の backoff。本番は実 sleep、テストは deps.waiter で instant 上書き。
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phase 5 hard block（2026-07-16）:
 *   Netlify Blobs 単独では manifest/pointer の multi-writer 更新で lost-update を防げない
 *   （last-write-wins・concurrency control なし。canary #13 で実証）。env フラグとは独立に、
 *   コード定数でこの Function 全体（GET/POST）を常時 404 に封じる。誤って env を有効化しても
 *   本番へ書けないようにする二重の kill。安全な storage backend（docs/PREMIUM_PLUS_STORAGE_DESIGN.md）
 *   が実装され安全が実証されるまで、この値を true にしてはならない。
 *   ※ この定数を true にする変更は CI/レビュー/テストを必ず通す（env だけでは有効化できない）。
 */
export const PREMIUM_PLUS_STORAGE_SAFE = false;

export async function runHandler(event, deps = {}) {
  const blobStoreFactory = typeof deps.blobStore === 'function' ? deps.blobStore : blobStore;
  const waiter = typeof deps.waiter === 'function' ? deps.waiter : realSleep;
  // テストは downstream の store 選択/認可ロジックを検証するため __storageSafe:true で hard block を
  // 明示バイパスできる。本番（deps 無し）は必ず定数側 = false となり 404 に封じられる。
  const storageSafe = deps.__storageSafe === true ? true : PREMIUM_PLUS_STORAGE_SAFE;
  if (!storageSafe) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
  }

  // 実ストア（本番 classic Function）利用時のみ、Lambda 互換の Blobs コンテキストを
  // event から初期化する。これを呼ばないと後段の getStore が MissingBlobsEnvironmentError を
  // 投げる（本番は従来ここへ到達する前に 403 で落ちていたため未発覚だった）。
  // テストは blobStore を注入するため呼ばない（モック event に Blobs メタデータが無く失敗する）。
  if (typeof deps.blobStore !== 'function') {
    connectLambda(event);
  }

  // 【a. kill-switch・最上流】PREMIUM_PLUS_ENABLED が 'true' でない限り全メソッド 404。
  // ここで return するため store 選択・getStore・Blobs には一切到達しない（書き込み 0 件）。
  if (process.env.PREMIUM_PLUS_ENABLED !== 'true') {
    return { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
  }

  // 【b/c. store 選択・fail-closed】PREMIUM_PLUS_CANARY を厳格判定。誤設定は本番へフォールバック
  // させず 503 で停止する。ここで return するため getStore・認証処理・Blobs へ到達しない。
  // 生値はレスポンス・ログに一切含めない（configuration error の事実のみ）。
  const storeSel = resolvePremiumPlusStoreName(process.env.PREMIUM_PLUS_CANARY);
  if (!storeSel.ok) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
      body: 'Service Unavailable',
    };
  }
  // 解決済みストア名に束縛した factory（認可通過後に getStore を呼ぶ）。
  const storeName = storeSel.storeName;
  const store = () => blobStoreFactory(storeName);

  try {
    const now = Date.now();
    const headers = event.headers || {};

    if (event.httpMethod === 'GET') {
      return await handleMediaGet({
        params: event.queryStringParameters || {},
        cookieHeader: headers.cookie || headers.Cookie || '',
        secret: process.env.SESSION_SIGNING_SECRET,
        now,
        // 会員認可を通ってから getStore を呼ぶ（factory を渡す）
        store,
      });
    }

    return await handleMediaPost({
      method: event.httpMethod,
      providedSecret: headers['x-admin-secret'] || headers['X-Admin-Secret'],
      origin: headers.origin || headers.Origin,
      context: process.env.CONTEXT,
      adminSecret: process.env.PREMIUM_PLUS_ADMIN_SECRET,
      body: event.body,
      now,
      // 管理者認可を通ってから getStore を呼ぶ（factory を渡す）
      store,
      waiter,
    });
  } catch (error) {
    // ログ衛生: error.message は内部ストレージ URL / key / token 断片を含み得るため出さない。
    // 種別（error.name）だけを記録する。
    console.error('[premium-plus-media] error:', (error && error.name) || 'Error');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
}
