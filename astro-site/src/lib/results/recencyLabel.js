/**
 * 結果見出しの「本日 / 昨日 / 最新」を、結果の日付と閲覧時点（JST）から決める。
 *
 * ⚠️ 2026-11-24（事業レビュー 5ef09149）: トップの「🏆 昨日の的中結果」は固定の文字で、
 *    中身は最新の開催（archiveResults[0]）だったため、開催の無い日をはさむと
 *    4 日前の大井を「昨日」と表示していた。ページは静的生成で、開催の無い日は再ビルドも無いので、
 *    ビルド時に決めても古くなる。→ HTML は「最新」で出し、閲覧時にブラウザで本日 / 昨日へ置き換える。
 */

export const RECENCY_FALLBACK = '最新';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → JST のその日の通し日数。形式が違えば null */
function jstDayNumber(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/**
 * @param {string} resultDate 'YYYY-MM-DD'（JST の開催日）
 * @param {number} nowMs 閲覧時刻（epoch ms）
 * @returns {'本日'|'昨日'|'最新'}
 */
export function recencyWord(resultDate, nowMs) {
  const day = jstDayNumber(resultDate);
  if (day == null || !Number.isFinite(nowMs)) return RECENCY_FALLBACK;
  const today = Math.floor((nowMs + JST_OFFSET_MS) / DAY_MS);
  if (day === today) return '本日';
  if (day === today - 1) return '昨日';
  return RECENCY_FALLBACK;
}

/** `[data-recency-date]` を持つ要素の中の `[data-recency-word]` を置き換える（ブラウザ用） */
export function applyRecencyLabels(root, nowMs) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('[data-recency-date]')) {
    const word = recencyWord(el.getAttribute('data-recency-date'), nowMs);
    for (const target of el.querySelectorAll('[data-recency-word]')) target.textContent = word;
  }
}
