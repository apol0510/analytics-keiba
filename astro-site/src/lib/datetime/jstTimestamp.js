/**
 * jstTimestamp.js — 管理者・顧客宛メールに出す日時表記の単一源（純粋関数・IO なし）。
 *
 * 経緯（2026-09-01）:
 * お問い合わせ通知の「受信日時」が `new Date().toLocaleString('ja-JP')` で組まれており、
 * Netlify Functions のランタイム TZ が UTC のため **UTC の時刻が JST 表記の見た目で出ていた**。
 * 実際 11:44 JST の問い合わせが「2026/9/1 2:44:04」と表示され、対応時の時系列判断を誤らせた。
 *
 * 恒久ルール:
 * - メール本文に日時を出すときは **必ずこの関数を通す**（`toLocaleString('ja-JP')` を直接書かない）。
 * - `timeZone: 'Asia/Tokyo'` を明示し、末尾に `JST` を付けて表記を曖昧にしない。
 */

/**
 * 日時を JST 表記の文字列にする（例: `2026/09/01 11:44:04 JST`）。
 *
 * @param {Date|string|number} [input] 省略時は現在時刻。無効値は現在時刻にフォールバックしない（'-' を返す）。
 * @returns {string}
 */
export function formatJst(input) {
  const d = input === undefined ? new Date() : new Date(input);
  if (Number.isNaN(d.getTime())) return '-';
  const formatted = d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${formatted} JST`;
}
