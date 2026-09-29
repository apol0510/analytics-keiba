/**
 * scheduledChecks.js — 「未来に残る確認作業」の登録簿を読み、今日やるべきものを選ぶ（純粋）
 *
 * ## なぜ要るか（2026-09-28 MK 確定の恒久ルール）
 *
 * 「後日確認」「一定期間後に評価」「外部結果待ち」を PROGRESS に「○月○日に確認」と書くだけでは、
 * 人間の記憶や再指示に依存して抜け落ちる。確認は登録簿 `ops/scheduled-checks.json` に
 *   - 実行日時または発火条件（runFrom / runUntil / trigger）
 *   - 自動実行経路（kind → 実行する関数。workflow scheduled-checks.yml が毎日呼ぶ）
 *   - 比較基準（compare）
 *   - 結果の記録先（record）
 *   - 失敗時の扱い（onFailure）
 * をそろえて載せ、機械が拾って実行する。1 つでも欠けた登録は**検査で落とす**。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 実装済みの確認の種類（kind）。ここに無い kind は登録できない */
export const KNOWN_KINDS = Object.freeze(['gsc-date-archive', 'airtable-premium-conversions', 'airtable-light-renewal-outcomes', 'payment-funnel-first-record', 'premium-plus-first-order']);

export const REQUIRED_FIELDS = Object.freeze(['id', 'title', 'kind', 'runFrom', 'runUntil', 'trigger', 'compare', 'record', 'onFailure']);

/**
 * 登録簿の検査。問題があれば理由の配列（空なら OK）。
 * @param {{checks: Array}} registry
 */
export function validateRegistry(registry) {
  const errors = [];
  const checks = Array.isArray(registry?.checks) ? registry.checks : null;
  if (!checks) return ['checks が配列ではない'];
  const ids = new Set();
  for (const [i, c] of checks.entries()) {
    const at = `checks[${i}]${c?.id ? `(${c.id})` : ''}`;
    for (const f of REQUIRED_FIELDS) {
      const v = c?.[f];
      if (v === undefined || v === null || v === '' || (typeof v === 'object' && Object.keys(v).length === 0)) {
        errors.push(`${at}: ${f} が無い`);
      }
    }
    if (c?.id) {
      if (!/^[a-z0-9-]+$/.test(c.id)) errors.push(`${at}: id は英小文字・数字・- のみ`);
      if (ids.has(c.id)) errors.push(`${at}: id が重複`);
      ids.add(c.id);
    }
    if (c?.kind && !KNOWN_KINDS.includes(c.kind)) errors.push(`${at}: 未実装の kind「${c.kind}」`);
    if (c?.runFrom && !DATE_RE.test(c.runFrom)) errors.push(`${at}: runFrom が YYYY-MM-DD でない`);
    if (c?.runUntil && !DATE_RE.test(c.runUntil)) errors.push(`${at}: runUntil が YYYY-MM-DD でない`);
    if (DATE_RE.test(c?.runFrom || '') && DATE_RE.test(c?.runUntil || '') && c.runUntil < c.runFrom) {
      errors.push(`${at}: runUntil が runFrom より前`);
    }
  }
  return errors;
}

/** JST の今日（YYYY-MM-DD） */
export function jstToday(nowMs = Date.now()) {
  return new Date(Number(nowMs) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 今日の扱いを決める。
 * @param {Array} checks
 * @param {string} today YYYY-MM-DD（JST）
 * @param {Set<string>} completedIds 成功記録（Issue）がある id
 * @returns {Array<{id, action: 'run'|'expired'|'wait'|'done'}>}
 */
export function planToday(checks, today, completedIds = new Set()) {
  return (checks || []).map((c) => {
    if (completedIds.has(c.id)) return { id: c.id, action: 'done' };
    if (today < c.runFrom) return { id: c.id, action: 'wait' };
    if (today > c.runUntil) return { id: c.id, action: 'expired' };
    return { id: c.id, action: 'run' };
  });
}

export const issueTitle = (id) => `[自動測定] ${id}`;
export const failureIssueTitle = (id) => `[自動測定 失敗] ${id}`;

/**
 * 「失敗」ではなく「まだ起きていない / まだ確定していない」ことを表す理由。
 * 赤にせず（毎日の失敗通知を出さず）、待機中 Issue を 1 つだけ更新して翌日また確認する。
 * 期限（runUntil）を過ぎても成功しなければ、期限切れとして Issue に必ず残す。
 */
export const PENDING_CODES = Object.freeze(['no_conversion_yet', 'data_not_ready', 'no_reminder_sent_yet', 'no_application_yet', 'no_confirmation_yet', 'no_plus_order_yet', 'no_plus_confirmation_yet']);
export const EXIT = Object.freeze({ OK: 0, REGISTRY: 1, FAILED: 2, PENDING: 3 });
export const exitCodeFor = (code) => (PENDING_CODES.includes(code) ? EXIT.PENDING : EXIT.FAILED);
