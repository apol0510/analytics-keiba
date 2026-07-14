/**
 * Premium Plus 実績画像 API（Netlify Blobs）
 *
 * 毎日 1 枚の投票内容照会スクショと、その結果（的中/不的中・払戻・投票額）を保存し、
 * /premium-plus/ と /premium-sanrenpuku/ の CTA が実行時に読み出す。
 *
 * ビルド不要・数秒で本番反映される（画像を git に置かない理由がこれ）。
 *
 * エンドポイント:
 *   GET  ?action=manifest          → 公開マニフェスト + 自動集計した実績数値
 *   GET  ?action=image&date=YYYY-MM-DD → 画像バイナリ
 *   POST { action: 'upload', ... } → 画像 + 結果を保存（要 x-admin-secret）
 *   POST { action: 'delete', date } → 1 日分を削除（要 x-admin-secret）
 *
 * 認可:
 *   書き込みは PREMIUM_PLUS_ADMIN_SECRET と一致する x-admin-secret ヘッダが必須。
 *   env 未設定なら書き込みは全て 503（fail closed）。読み取りは公開。
 *   ※ 画像そのものは「有料実績の証拠」であり、URL を知られても実害は無い前提。
 *     Premium Plus の買い目本体はここでは配信しない。
 *
 * 集計ロジックの単一源: src/lib/premiumPlusShowcase.js
 */

import { getStore } from '@netlify/blobs';
import {
  normalizeEntry,
  upsertEntry,
  removeEntry,
  sortEntries,
  computeStats,
  GALLERY_LIMIT,
} from '../../src/lib/premiumPlusShowcase.js';

const STORE_NAME = 'premium-plus';
const MANIFEST_KEY = 'manifest';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function store() {
  // strong: アップロード直後の管理画面リロードで古いマニフェストを読まないため
  const options = { name: STORE_NAME, consistency: 'strong' };

  // 本番（Netlify Functions ランタイム）は Blobs のコンテキストが自動注入されるのでこれだけでよい。
  // ローカルの netlify dev では注入されないことがあるため、siteID + token が env にあるときだけ
  // 手動設定にフォールバックする（本番に token は無いので、この分岐は本番では通らない）。
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) return getStore({ ...options, siteID, token });

  return getStore(options);
}

async function readManifest(s) {
  const raw = await s.get(MANIFEST_KEY, { type: 'json' });
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return sortEntries(entries.map(normalizeEntry).filter(Boolean));
}

async function writeManifest(s, entries) {
  await s.setJSON(MANIFEST_KEY, { entries, updatedAt: new Date().toISOString() });
}

function ok(body, extraHeaders = {}) {
  return { statusCode: 200, headers: { ...jsonHeaders, ...extraHeaders }, body: JSON.stringify(body) };
}

function fail(statusCode, error) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify({ error }) };
}

/** 書き込み系の認可。通れば null、弾いたらレスポンスを返す。 */
function authorize(event) {
  const secret = process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!secret) {
    return fail(503, 'PREMIUM_PLUS_ADMIN_SECRET が未設定です。Netlify の環境変数を設定してください。');
  }
  const provided = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (provided !== secret) {
    return fail(403, '管理者シークレットが一致しません。');
  }
  return null;
}

/** data URL / 素の base64 のどちらでも受ける */
function decodeImage(imageBase64) {
  if (typeof imageBase64 !== 'string' || !imageBase64) return null;
  const match = imageBase64.match(/^data:([^;]+);base64,(.*)$/);
  const base64 = match ? match[2] : imageBase64;
  const contentType = match ? match[1] : 'image/png';
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    return { buffer, contentType };
  } catch {
    return null;
  }
}

export async function handler(event) {
  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const s = store();

      if (params.action === 'image') {
        const date = String(params.date || '');
        const entries = await readManifest(s);
        const entry = entries.find((e) => e.date === date);
        if (!entry || !entry.imageKey) return fail(404, '画像が見つかりません');

        const blob = await s.get(entry.imageKey, { type: 'arrayBuffer' });
        if (!blob) return fail(404, '画像が見つかりません');

        return {
          statusCode: 200,
          headers: {
            'Content-Type': entry.contentType || 'image/png',
            // 日次更新なので短め。差し替え（撮り直し）が数分で反映される。
            'Cache-Control': 'public, max-age=300',
          },
          body: Buffer.from(blob).toString('base64'),
          isBase64Encoded: true,
        };
      }

      // default: manifest
      const entries = await readManifest(s);
      const limit = Math.min(Number(params.limit) || GALLERY_LIMIT, 30);
      return ok({
        // 画像の実バイナリは返さない。表示に必要な項目だけ。
        entries: entries.slice(0, limit).map((e) => ({
          date: e.date,
          venue: e.venue,
          raceNumber: e.raceNumber,
          betType: e.betType,
          isHit: e.isHit,
          payout: e.payout,
          legacy: e.legacy,
          imageUrl: `/.netlify/functions/premium-plus-media?action=image&date=${e.date}`,
        })),
        stats: computeStats(entries),
      });
    }

    if (event.httpMethod === 'POST') {
      const denied = authorize(event);
      if (denied) return denied;

      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch {
        return fail(400, 'JSON の解析に失敗しました');
      }

      const s = store();
      const entries = await readManifest(s);

      if (payload.action === 'delete') {
        const date = String(payload.date || '');
        const target = entries.find((e) => e.date === date);
        if (!target) return fail(404, `${date} のエントリがありません`);
        if (target.imageKey) {
          await s.delete(target.imageKey).catch(() => {});
        }
        const next = removeEntry(entries, date);
        await writeManifest(s, next);
        return ok({ deleted: date, count: next.length });
      }

      // action: 'upload'（既定）
      const image = decodeImage(payload.imageBase64);
      if (!image) return fail(400, '画像が不正です（base64・5MB 以内）');

      const candidate = normalizeEntry({
        ...payload,
        contentType: image.contentType,
        imageKey: `image/${payload.date}`,
        uploadedAt: new Date().toISOString(),
        // 管理画面・スクリプト経由の新規分は必ず集計対象（legacy は seed スクリプトのみが立てる）
        legacy: payload.legacy === true,
      });
      if (!candidate) return fail(400, 'date が不正です（YYYY-MM-DD）');

      await s.set(candidate.imageKey, image.buffer, {
        metadata: { contentType: image.contentType, date: candidate.date },
      });

      const next = upsertEntry(entries, candidate);
      await writeManifest(s, next);

      return ok({ saved: candidate, count: next.length, stats: computeStats(next) });
    }

    return fail(405, 'Method not allowed');
  } catch (error) {
    console.error('[premium-plus-media] error:', error);
    return fail(500, error.message || 'internal error');
  }
}
