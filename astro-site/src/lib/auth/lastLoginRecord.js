/**
 * lastLoginRecord.js — ログイン時刻の記録（純粋部分）
 *
 * ── なぜ「書いてよい唯一の例外」なのか ──────────────────────────────
 * PR-B 以降、ログイン経路は Customers を**書き換えない**設計になっている
 * （旧実装が有効期限の延長やポイント付与を副作用で行い、退会者の期限が伸びる等の
 *  事故を起こしたため）。その原則は維持したうえで、**`LastLoginAt` 1 列だけ**を例外にする。
 *
 * 例外にする理由: 2026-08-01 時点で「最終ログイン」を持つ列が無く、
 * 無料会員の来訪が一切追えない（旧 `最終ポイント付与日` は 2026-07-08 で更新停止）。
 * 休眠判定・カムバック施策の対象抽出がすべて憶測になる。
 *
 * ── 守ること ────────────────────────────────────────────────
 *   1. 書くのは `LastLoginAt` **のみ**。契約・課金・権限の列には絶対に触れない
 *   2. **best-effort**。書き込み失敗でログインを失敗させない（呼び出し側で握りつぶす）
 *   3. Airtable に列が無い間は 422 になるが、それも失敗として無視する
 *      （列を作った瞬間から自動的に記録が始まる）
 *   4. 過剰更新を避けるため、前回記録から `MIN_UPDATE_INTERVAL_MS` 未満なら書かない
 */

/** この列以外を書いてはいけない（guard テストで固定） */
export const LAST_LOGIN_FIELD = 'LastLoginAt';

/**
 * 同一ユーザーの連続ログインで毎回 PATCH しないための最小間隔（6 時間）。
 * 「最終ログイン日」の用途には十分で、Airtable の書き込み量を抑えられる。
 */
export const MIN_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 今この瞬間に `LastLoginAt` を書くべきか。
 *
 * @param {{ fields?: object, nowMs: number, minIntervalMs?: number }} input
 * @returns {{ update: false, reason: string } | { update: true, fields: { LastLoginAt: string } }}
 */
export function planLastLoginUpdate({ fields = {}, nowMs, minIntervalMs = MIN_UPDATE_INTERVAL_MS } = {}) {
  if (!Number.isFinite(nowMs)) return { update: false, reason: 'invalid_now' };

  const prev = Date.parse(String(fields[LAST_LOGIN_FIELD] ?? '').trim());
  if (Number.isFinite(prev)) {
    // 未来日時は不正データ。上書きして正常化する（放置すると永久に更新されない）
    if (prev <= nowMs && nowMs - prev < minIntervalMs) {
      return { update: false, reason: 'recently_updated' };
    }
  }

  return { update: true, fields: { [LAST_LOGIN_FIELD]: new Date(nowMs).toISOString() } };
}

/**
 * 書き込み対象が `LastLoginAt` だけであることを検証する（呼び出し側の事故防止）。
 * @returns {boolean}
 */
export function assertOnlyLastLoginField(fields) {
  const keys = Object.keys(fields || {});
  return keys.length === 1 && keys[0] === LAST_LOGIN_FIELD;
}
