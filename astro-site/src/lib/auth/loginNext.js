/**
 * loginNext.js — ログイン後の戻り先（`/login/?next=…`）の単一源（純粋）
 *
 * 2026-09-29 MK 確定: Light 月払いの期限前・失効後メールのリンクは「ログイン → /pricing/」。
 * 未ログインのまま /pricing/ を開くと会員向け価格（¥44,820）が出ないため、ログインを経由させる。
 *
 * ⚠️ オープンリダイレクトを作らない: 戻り先は**許可リストの完全一致だけ**。
 *    外部 URL・`//` 始まり・クエリ付き・未知のパスは無視して従来どおり /dashboard/ へ。
 * ⚠️ マジックリンクは別タブ（メールアプリ）で開かれるため、戻り先は localStorage に短時間だけ置く。
 */

/** 戻り先として許可するパス（完全一致） */
export const LOGIN_NEXT_ALLOWED = Object.freeze(['/pricing/']);
export const LOGIN_NEXT_STORAGE_KEY = 'ak_login_next';
/** 保存した戻り先の有効時間（マジックリンクの有効時間 60 分より少し長く） */
export const LOGIN_NEXT_TTL_MS = 90 * 60 * 1000;

/** `?next=` の値を検査する。許可リストに無ければ null */
export function resolveLoginNext(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return LOGIN_NEXT_ALLOWED.includes(v) ? v : null;
}

/** 保存用の値（JSON 文字列）。許可されないなら null */
export function encodeLoginNext(path, nowMs = Date.now()) {
  const p = resolveLoginNext(path);
  return p ? JSON.stringify({ path: p, at: nowMs }) : null;
}

/** 保存値から戻り先を取り出す。壊れている・古い・許可外なら null */
export function decodeLoginNext(stored, nowMs = Date.now()) {
  if (typeof stored !== 'string' || !stored) return null;
  try {
    const o = JSON.parse(stored);
    if (!o || !Number.isFinite(o.at) || nowMs - o.at > LOGIN_NEXT_TTL_MS || o.at > nowMs + 60000) return null;
    return resolveLoginNext(o.path);
  } catch { return null; }
}
