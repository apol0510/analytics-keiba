/**
 * sessionRevocation.js — 退会直後のセッション無効化（2026-10-15 MK 確定「退会確定後は契約由来の閲覧権限を即時停止」）
 *
 * 有料ページ・API の権利判定（paidPageGate / resolveViewer）は Customers を Function ごとに最大 10 分キャッシュする。
 * 退会した会員の古いセッション（別の端末・コピーされた Cookie）がその間キャッシュで通らないよう、
 * 退会の確定時に Redis へ印を置き、印がある会員だけ権利判定でキャッシュを使わず読み直す。
 * 印が読めない（Redis 障害）ときは通常の判定に任せる（キャッシュは最長 10 分で自然に切れる）。
 */

export const SESSION_REVOKED_PREFIX = 'ak:session:revoked:';
/** 印の寿命。権利判定のキャッシュ（10 分）より長ければよい */
export const SESSION_REVOKED_TTL_SEC = 3600;

/** 退会の確定時に呼ぶ。失敗しても退会は戻さない（キャッシュは最長 10 分で自然に切れる） */
export async function markSessionRevoked(redis, recordId, nowMs = Date.now()) {
  if (!redis || !/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ''))) return false;
  try {
    await redis(['SET', `${SESSION_REVOKED_PREFIX}${recordId}`, String(nowMs), 'EX', String(SESSION_REVOKED_TTL_SEC)]);
    return true;
  } catch {
    return false;
  }
}

/** 退会直後の会員か（権利判定でキャッシュを使わず読み直すべきか）。読めないときは false（通常の判定に任せる） */
export async function isSessionRevoked(redis, recordId) {
  if (!redis || !/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ''))) return false;
  try {
    const v = await redis(['GET', `${SESSION_REVOKED_PREFIX}${recordId}`]);
    return v !== null && v !== undefined && v !== '';
  } catch {
    return false;
  }
}

/** 権利判定から呼ぶ既定の確認（env から Redis を作る）。Redis 未設定なら false */
export async function revokedForRecord({ recordId, env, fetchImpl }) {
  return isSessionRevoked(restRedis(env || {}, fetchImpl), recordId);
}

/** Upstash REST の最小クライアント（権利判定の経路へ重い依存を持ち込まない） */
function restRedis(env, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN || !doFetch) return null;
  return async (args) => {
    const res = await doFetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis_${res.status}`);
    const data = await res.json();
    return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
  };
}
