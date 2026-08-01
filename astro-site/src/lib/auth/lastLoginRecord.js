/**
 * lastLoginRecord.js — ログイン時刻の記録（単一源）
 *
 * ── なぜ「書いてよい唯一の例外」なのか ──────────────────────────────
 * PR-B 以降、ログイン経路は Customers を**書き換えない**設計になっている
 * （旧実装が有効期限の延長やポイント付与を副作用で行い、退会者の期限が伸びる等の
 *  事故を起こしたため）。その原則は維持したうえで、**`最終ログイン` 1 列だけ**を例外にする。
 *
 * 例外にする理由: 無料会員の来訪が一切追えず、休眠判定・カムバック施策の対象抽出が
 * すべて憶測になっていた（旧 `最終ポイント付与日` は 2026-07-08 で更新停止）。
 *
 * ── 書き込み先は既存列 `最終ログイン`（2026-08-01 確定）────────────────
 * Airtable Customers には **以前から `最終ログイン`（dateTime）列が存在**していた
 * （値は全 1,452 レコード空・コードからも未使用）。Airtable API は「値のあるフィールド」しか
 * 返さないため実データ走査では見つからず、当初は `LastLoginAt` を新設する計画だった。
 * **同義の空列を 2 本並べないため、既存列をそのまま使う**（新設しない）。
 * 既存の命名規約（`氏名` / `有効期限` / `登録日` / `最終ポイント付与日`）とも揃う。
 *
 * ── 守ること ────────────────────────────────────────────────
 *   1. 書くのは `最終ログイン` **のみ**。契約・課金・権限・特典の列には絶対に触れない
 *   2. **ログイン成功後にだけ**呼ぶ（認証失敗・判定だけの照会では呼ばない）
 *   3. **best-effort**。書き込み失敗でログインを失敗させない
 *   4. 過剰更新を避けるため、前回記録から `MIN_UPDATE_INTERVAL_MS` 未満なら書かない
 *   5. `最終ポイント付与日` は**読むだけ**（旧記録として表示に使う）。書き換えない
 */

/**
 * 書き込み先の Airtable フィールド名。**ここだけが定義**。
 * 参照側（カルテ・管理画面）もこの定数を import すること。
 */
export const LAST_LOGIN_FIELD = '最終ログイン';

/**
 * 同一ユーザーの連続ログインで毎回 PATCH しないための最小間隔（6 時間）。
 * 「最終ログイン日」の用途には十分で、Airtable の書き込み量を抑えられる。
 */
export const MIN_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 記録しなかった理由（呼び出し側のログ・テスト用） */
export const LAST_LOGIN_SKIP = Object.freeze({
  INVALID_NOW: 'invalid_now',
  RECENTLY_UPDATED: 'recently_updated',
  NO_TARGET: 'no_target',
  FIELD_GUARD: 'field_guard',
  WRITE_FAILED: 'write_failed',
});

/**
 * 今この瞬間に `最終ログイン` を書くべきか。
 *
 * @param {{ fields?: object, nowMs: number, minIntervalMs?: number }} input
 * @returns {{ update: false, reason: string } | { update: true, fields: Record<string, string> }}
 */
export function planLastLoginUpdate({ fields = {}, nowMs, minIntervalMs = MIN_UPDATE_INTERVAL_MS } = {}) {
  if (!Number.isFinite(nowMs)) return { update: false, reason: LAST_LOGIN_SKIP.INVALID_NOW };

  const prev = Date.parse(String(fields[LAST_LOGIN_FIELD] ?? '').trim());
  if (Number.isFinite(prev)) {
    // 未来日時は不正データ。上書きして正常化する（放置すると永久に更新されない）
    if (prev <= nowMs && nowMs - prev < minIntervalMs) {
      return { update: false, reason: LAST_LOGIN_SKIP.RECENTLY_UPDATED };
    }
  }

  // サーバー時刻を ISO dateTime で保存する（クライアント申告の時刻は使わない）
  return { update: true, fields: { [LAST_LOGIN_FIELD]: new Date(nowMs).toISOString() } };
}

/**
 * 書き込み対象が `最終ログイン` だけであることを検証する（呼び出し側の事故防止）。
 * @returns {boolean}
 */
export function assertOnlyLastLoginField(fields) {
  const keys = Object.keys(fields || {});
  return keys.length === 1 && keys[0] === LAST_LOGIN_FIELD;
}

/**
 * ログイン成功時の記録本体。**I/O は注入**（Airtable SDK に依存しない）。
 *
 * 例外は投げない。書き込み失敗（列が無い / 権限 / 通信）は `written:false` を返すだけで、
 * 呼び出し側のログインを止めない。
 *
 * @param {{
 *   update: (fields: Record<string, string>) => Promise<unknown>,
 *   fields?: object,
 *   nowMs: number,
 *   minIntervalMs?: number,
 * }} input
 * @returns {Promise<{ written: boolean, reason?: string, fields?: Record<string, string>, error?: string }>}
 */
export async function recordLastLogin({ update, fields = {}, nowMs, minIntervalMs } = {}) {
  if (typeof update !== 'function') return { written: false, reason: LAST_LOGIN_SKIP.NO_TARGET };

  const plan = planLastLoginUpdate({ fields, nowMs, minIntervalMs });
  if (!plan.update) return { written: false, reason: plan.reason };
  // 想定外の列が混ざったら書かない（二重の歯止め）
  if (!assertOnlyLastLoginField(plan.fields)) return { written: false, reason: LAST_LOGIN_SKIP.FIELD_GUARD };

  try {
    await update(plan.fields);
    return { written: true, fields: plan.fields };
  } catch (e) {
    return {
      written: false,
      reason: LAST_LOGIN_SKIP.WRITE_FAILED,
      error: (e && e.message) ? String(e.message) : 'unknown',
    };
  }
}
