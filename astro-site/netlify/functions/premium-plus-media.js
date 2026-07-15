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

import { getStore } from '@netlify/blobs';
import { handleMediaGet, handleMediaPost } from '../../src/lib/premiumPlus/mediaHandlers.js';

const STORE_NAME = 'premium-plus';

/** Netlify Blobs を manifestStore が期待する注入インターフェースにアダプトする。 */
function blobStore() {
  const options = { name: STORE_NAME, consistency: 'strong' };
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

export async function handler(event) {
  // 【kill-switch・最上流】PREMIUM_PLUS_ENABLED が 'true' でない限り全メソッド 404。
  // ここで return するため Blobs には一切到達しない（書き込み・削除ともに構造的に 0 件）。
  if (process.env.PREMIUM_PLUS_ENABLED !== 'true') {
    return { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
  }

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
        store: blobStore,
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
      store: blobStore,
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
