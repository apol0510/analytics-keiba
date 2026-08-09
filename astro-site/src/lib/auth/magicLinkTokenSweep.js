/**
 * magicLinkTokenSweep.js — 有効なマジックリンクを常に「最新 1 本」に保つ判定（純粋関数）
 *
 * ── なぜ要るか ─────────────────────────────────────────────────
 * `send-magic-link.js` は従来 `create` するだけで、**過去の未使用トークンを無効化して
 * いなかった**。そのため 5 回要求した利用者は未使用トークンを 5 本同時に保持し、
 * それぞれが TTL いっぱい有効だった。
 * 2026-08-09 に TTL を 15 → 60 分へ延ばした（配信遅延対策）ため、
 * 無効化しないままだと露出面が `本数 × 60 分` に広がる。
 * 常に 1 本だけにすることで `1 × 60 分` に抑え、**延長前（5 本 × 15 分）より小さくする**。
 *
 * ── 触らないもの ───────────────────────────────────────────────
 * - `Used: true`（使用済み）… すでに無効。監査のため書き換えない
 * - 期限切れ … `ExpiresAt` で既に拒否される。書き換えない
 * - 自分自身（今発行したトークン）… 当然残す
 *
 * ⚠️ この層は Airtable を知らない。レコード配列を受け取り **id の配列を返すだけ**。
 */

/** Airtable の 1 回の update 上限 */
export const SWEEP_BATCH_SIZE = 10;

/** 安全弁: 1 回の掃除で触る上限（異常時に大量書き込みしない） */
export const SWEEP_MAX_RECORDS = 50;

const truthy = (v) => v === true || v === 'true' || v === 1;

/**
 * 無効化すべきトークンの id を選ぶ。
 *
 * @param {{
 *   records: Array<{id: string, fields: object}>,  同一 Email のトークン
 *   keepTokenId: string,                           今発行したレコード id（残す）
 *   nowMs: number,
 * }} input
 * @returns {{ ids: string[], skipped: { used: number, expired: number, self: number } }}
 */
export function selectTokensToInvalidate({ records, keepTokenId, nowMs } = {}) {
  const list = Array.isArray(records) ? records : [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const keep = String(keepTokenId ?? '');
  const ids = [];
  const skipped = { used: 0, expired: 0, self: 0 };

  for (const rec of list) {
    if (!rec || typeof rec.id !== 'string' || !rec.id) continue;
    if (rec.id === keep) { skipped.self += 1; continue; }

    const f = rec.fields || {};
    if (truthy(f.Used)) { skipped.used += 1; continue; }   // 使用済みは壊さない

    const exp = Date.parse(f.ExpiresAt ?? '');
    // 期限切れは既に無効。書き換えない（パース不能は「期限不明」= 無効化対象にする）
    if (Number.isFinite(exp) && exp <= now) { skipped.expired += 1; continue; }

    ids.push(rec.id);
    if (ids.length >= SWEEP_MAX_RECORDS) break;
  }
  return { ids, skipped };
}

/** update 呼び出し用に 10 件ずつへ割る */
export function chunkForUpdate(ids, size = SWEEP_BATCH_SIZE) {
  const list = Array.isArray(ids) ? ids : [];
  const n = Math.max(1, Number.isFinite(size) ? size : SWEEP_BATCH_SIZE);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export default selectTokensToInvalidate;
