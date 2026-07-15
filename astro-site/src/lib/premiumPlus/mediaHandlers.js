/**
 * mediaHandlers.js — premium-plus-media の GET/POST ハンドラ（純粋・store と secret を注入）
 *
 * GET  … 会員認可（Phase 2 と同じ verifyPlanAccess）。失敗は理由を返さず一律 404。
 *        manifest は表示最小項目のみ（imageKey/checksum/version 等の内部値を返さない）。
 *        画像は Function 経由で返し、公開 Blob URL は返さない。private, no-store / Vary: Cookie。
 * POST … 管理者認可（decideAdminWrite）。拒否時は store に到達せず Set-Cookie も秘密値も返さない。
 *        upload/seed/hide/show/rollback/status を扱う。物理 delete は廃止（410）。
 */

import { verifyPlanAccess, PREMIUM_PLUS_ALLOWED_PLANS } from '../auth/pageAccess.js';
import { computeStats, sortEntries, GALLERY_LIMIT } from '../premiumPlusShowcase.js';
import { decideAdminWrite, ADMIN_WRITE } from './mediaAuth.js';
import { validateUploadMeta } from './uploadValidation.js';
import { validateImage, decodeBase64Image } from './imageValidation.js';
import { readCurrent, applyUpload, applyVisibility, applyRollback, applySeedStage, applySeedCommit } from './manifestStore.js';

// Netlify Functions の同期リクエスト body 上限（~6MB）に対する安全側の閾値。
// 画像は base64 で ~1.33 倍に膨らむため、1 リクエスト 1 画像前提で 5.5MB を上限にする。
export const MAX_BODY_BYTES = Math.floor(5.5 * 1024 * 1024);

// operationId は UUID 等の一意値のみ許可（長さ・文字種を検証）。
// randomUUID(36 桁) を含む [A-Za-z0-9_-] の 8〜64 文字。
export const OPERATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' };
const IMAGE_URL = (date) => `/.netlify/functions/premium-plus-media?action=image&date=${encodeURIComponent(date)}`;

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** 認可失敗・存在秘匿。理由を返さない。 */
function notFound() {
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS },
    body: 'Not Found',
  };
}

/** 会員向け manifest の最小表示項目（内部キーを出さない）。 */
function sanitizeForDisplay(e) {
  return {
    date: e.date,
    venue: e.venue,
    raceNumber: e.raceNumber,
    betType: e.betType,
    isHit: e.isHit,
    payout: e.payout,
    legacy: e.legacy,
    imageUrl: IMAGE_URL(e.date),
  };
}

/** 管理向け status の項目（画像バイト・内部キーは出さない。visible は出す）。 */
function sanitizeForAdmin(e) {
  return {
    date: e.date,
    venue: e.venue,
    raceNumber: e.raceNumber,
    betType: e.betType,
    isHit: e.isHit,
    payout: e.payout,
    legacy: e.legacy,
    visible: e.visible !== false,
  };
}

function visibleEntries(manifest) {
  return sortEntries((manifest.entries || []).filter((e) => e && e.visible !== false));
}

/** store が factory 関数でも object でも受ける（認可通過後に解決＝拒否時は Blobs 未接続）。 */
function resolveStore(store) {
  return typeof store === 'function' ? store() : store;
}

/** GET: 会員認可付き閲覧。 */
export async function handleMediaGet({ params = {}, cookieHeader, secret, now, store, allowedPlans = PREMIUM_PLUS_ALLOWED_PLANS, subtle }) {
  const access = await verifyPlanAccess({ cookieHeader, secret, now, allowedPlans, subtle });
  if (!access.ok) return notFound();

  const resolved = resolveStore(store);
  const { manifest } = await readCurrent(resolved);
  const visible = visibleEntries(manifest);

  if (params.action === 'image') {
    const date = String(params.date || '');
    const entry = visible.find((e) => e.date === date);
    if (!entry || !entry.imageKey) return notFound();
    const blob = await resolved.getBytes(entry.imageKey);
    if (!blob) return notFound();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': blob.metadata?.contentType || entry.contentType || 'image/png',
        ...PRIVATE_HEADERS,
      },
      body: Buffer.from(blob.bytes).toString('base64'),
      isBase64Encoded: true,
    };
  }

  const limit = Math.min(Number(params.limit) || GALLERY_LIMIT, 30);
  return json(200, {
    entries: visible.slice(0, limit).map(sanitizeForDisplay),
    stats: computeStats(visible),
  });
}

function parseBody(body) {
  try {
    return { ok: true, payload: JSON.parse(body || '{}') };
  } catch {
    return { ok: false };
  }
}

function toExpectedVersion(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/** POST: 管理者認可付き更新。 */
export async function handleMediaPost({ method, providedSecret, origin, context, adminSecret, body, now, store: rawStore, subtle }) {
  const authz = await decideAdminWrite({ method, adminSecret, providedSecret, origin, context }, { subtle });
  if (authz.decision !== ADMIN_WRITE.ALLOW) {
    // store を解決しない（Blobs 未接続）。Set-Cookie も秘密値も返さない。理由は汎用。
    const label = { 405: 'Method Not Allowed', 503: 'Service Unavailable' }[authz.status] || 'Forbidden';
    return json(authz.status, { error: label });
  }

  // body 上限（Netlify Functions 同期 body ~6MB。seed は seed-stage で分割する前提）
  if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return json(413, { error: 'Payload Too Large' });
  }

  // 認可通過後にのみ store を解決する
  const store = resolveStore(rawStore);

  const parsed = parseBody(body);
  if (!parsed.ok) return json(400, { error: 'Bad Request' });
  const payload = parsed.payload;
  const action = payload.action;
  const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : '';
  const expectedVersion = toExpectedVersion(payload.expectedVersion);
  if (Number.isNaN(expectedVersion)) return json(400, { error: 'invalid expectedVersion' });

  // 読み取り（管理者）。version を返し、以降の楽観ロックに使わせる。
  if (action === 'status') {
    const { logicalVersion, manifest } = await readCurrent(store);
    const all = sortEntries(manifest.entries || []);
    return json(200, {
      version: logicalVersion, // クライアントは opaque な楽観ロック値として使う（= logicalVersion）
      entries: all.slice(0, 30).map(sanitizeForAdmin),
      stats: computeStats(visibleEntries(manifest)),
    });
  }

  // 物理削除は廃止（論理非表示 hide を使う）
  if (action === 'delete') {
    return json(410, { error: '物理削除は廃止されました。action:"hide" で論理非表示にしてください。' });
  }

  // conflict（409）系はすべて version 競合として扱う（OPERATION_MISMATCH も含む）
  const conflictBody = (result) => ({ error: 'conflict', reason: result.reason, ...(result.currentVersion !== undefined ? { currentVersion: result.currentVersion } : {}) });

  // seed ステージ: 画像のみ保存（current 不変・複数回に分割可）。operationId 不要。
  if (action === 'seed-stage') {
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    if (rawItems.length === 0) return json(400, { error: 'items required' });
    const items = [];
    for (const raw of rawItems) {
      const metaResult = validateUploadMeta(raw, { allowLegacy: true });
      if (!metaResult.ok) return json(400, { error: `metadata: ${metaResult.reason}` });
      const bytes = decodeBase64Image(raw.imageBase64);
      if (!bytes) return json(400, { error: 'image decode failed' });
      const imageResult = await validateImage(bytes, { subtle });
      if (!imageResult.ok) return json(400, { error: `image: ${imageResult.reason}` });
      items.push({ meta: metaResult.meta, image: imageResult });
    }
    const result = await applySeedStage({ store, items, subtle });
    if (result.ok) return json(200, { ok: true, staged: result.staged });
    return json(500, { error: `stage failed: ${result.reason}` });
  }

  // 書き込み系は operationId 必須 + 形式検証
  if (!operationId) return json(400, { error: 'operationId required' });
  if (!OPERATION_ID_RE.test(operationId)) return json(400, { error: 'invalid operationId' });

  if (action === 'upload') {
    const metaResult = validateUploadMeta(payload, { allowLegacy: false });
    if (!metaResult.ok) return json(400, { error: `metadata: ${metaResult.reason}` });
    const bytes = decodeBase64Image(payload.imageBase64);
    if (!bytes) return json(400, { error: 'image decode failed' });
    const imageResult = await validateImage(bytes, { subtle });
    if (!imageResult.ok) return json(400, { error: `image: ${imageResult.reason}` });

    const result = await applyUpload({ store, image: imageResult, meta: metaResult.meta, operationId, expectedVersion, now, subtle });
    if (result.ok) return json(200, { ok: true, version: result.version, operationId, idempotent: result.idempotent === true, ...(result.entry ? { saved: sanitizeForAdmin(result.entry) } : {}) });
    if (result.conflict) return json(409, conflictBody(result));
    return json(500, { error: `transaction failed: ${result.reason}` });
  }

  // seed コミット: ステージ済み画像 (date+checksum) を参照して 1 回だけマニフェスト切替
  if (action === 'seed-commit') {
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    if (rawItems.length === 0) return json(400, { error: 'items required' });
    const items = [];
    for (const raw of rawItems) {
      const metaResult = validateUploadMeta(raw, { allowLegacy: true });
      if (!metaResult.ok) return json(400, { error: `metadata: ${metaResult.reason}` });
      if (typeof raw.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(raw.checksum)) return json(400, { error: 'invalid checksum' });
      items.push({ meta: metaResult.meta, checksum: raw.checksum });
    }
    const result = await applySeedCommit({ store, items, operationId, expectedVersion, now, subtle });
    if (result.ok) return json(200, { ok: true, version: result.version, operationId, count: result.count, idempotent: result.idempotent === true });
    if (result.conflict) return json(409, conflictBody(result));
    return json(500, { error: `transaction failed: ${result.reason}` });
  }

  if (action === 'hide' || action === 'show') {
    const date = typeof payload.date === 'string' ? payload.date.trim() : '';
    if (!date) return json(400, { error: 'date required' });
    const result = await applyVisibility({ store, date, visible: action === 'show', operationId, expectedVersion, now, subtle });
    if (result.ok) return json(200, { ok: true, version: result.version, operationId, date, visible: action === 'show', idempotent: result.idempotent === true });
    if (result.conflict) return json(409, conflictBody(result));
    if (result.reason === 'entry_not_found') return json(404, { error: 'entry not found' });
    return json(500, { error: `transaction failed: ${result.reason}` });
  }

  if (action === 'rollback') {
    const targetVersion = Number(payload.targetVersion);
    if (!Number.isInteger(targetVersion) || targetVersion < 1) return json(400, { error: 'invalid targetVersion' });
    const result = await applyRollback({ store, targetVersion, operationId, expectedVersion, now, subtle });
    if (result.ok) return json(200, { ok: true, version: result.version, rolledBackFrom: targetVersion, operationId, idempotent: result.idempotent === true });
    if (result.conflict) return json(409, conflictBody(result));
    if (result.reason === 'target_not_found') return json(404, { error: 'target version not found' });
    return json(500, { error: `transaction failed: ${result.reason}` });
  }

  return json(400, { error: 'unknown action' });
}
