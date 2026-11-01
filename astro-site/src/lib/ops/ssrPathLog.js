/**
 * ssrPathLog.js — SSR Function が「どのルートで・誰に」起動されたかを関数ログに 1 行で残す（2026-11-01）
 *
 * ## なぜ
 *
 * Netlify の Functions 無料枠は月 125,000 回。AK は SSR だけで 1 日 約 9,100 回起動しており、
 * GA4 の人のページビュー（1 日 約 1,560）と大きく食い違う。差がボット・先読み・API・
 * キャッシュの外れ（クエリ付き URL 等）のどれなのか、Netlify の画面・API では分からない。
 * 削減は実測の大きい順に行う（推測で削らない）ため、起動ごとに 1 行だけ記録する。
 *
 * ## 何を残すか / 残さないか
 *
 *   [ssr-path] GET 200 ua pf q /archive/nankan/[year]/[month]
 *              │   │   │  │  │ └ ルートパターン（実際の値は残さない）。どのルートにも当たらなければ 404:/<先頭区切り>
 *              │   │   │  │  └ クエリの有無（q / -）。値は残さない
 *              │   │   │  └ 先読み（Sec-Purpose / Purpose: prefetch）なら pf、そうでなければ -
 *              │   │   └ ua（通常） / bot（UA がボット） / noua（UA なし）
 *              │   └ status
 *              └ method
 *
 * - **ルートに当たった起動は、実際のパスを 1 文字も残さない**（`src/pages` のファイル名から作るパターンだけ）。
 *   動的区切り（`[slug]`・`[date]` 等）に入ったトークン・ID・日付・メールは出ない。
 * - どのルートにも当たらない 404 は、先頭の区切りが「ありふれた英字名」（`wp-login.php`・`.env` 等。
 *   数字の並び・英数混在の乱数風・長いものは除く）のときだけ残し、それ以外は `:seg` に伏せる。2 段目以降は `/*`。
 *   ボットの探索を `public/_redirects` で静的 404 にする判断（SAFETY_CHECKS ルール 9）に使う。
 * - 🛑 クエリ・Cookie・IP・UA 本文・メールアドレス・トークンは残さない。
 * - Redis 等へは書かない（1 起動ごとに外部書込を増やさない・費用ゼロの関数ログだけ）。
 * - 失敗しても本体の応答は変えない（middleware 側で握りつぶす）。
 */

export const SSR_PATH_LOG_TAG = '[ssr-path]';

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|python|curl|wget|go-http|axios|node-fetch|scrapy|httpclient|java\/|okhttp|semrush|ahrefs|mj12|bytespider|ccbot|lighthouse|pagespeed/i;

/** Astro がどのルートにも当たらなかったときに渡すパターン */
const UNMATCHED_ROUTES = new Set(['', '/404', '/_not-found', '/500']);

/** ルートパターンに許す文字（`src/pages` のファイル名由来: 英数・- _ . / [ ] ...） */
const ROUTE_SAFE_RE = /^\/[A-Za-z0-9_\-./[\]]*$/;

/**
 * どのルートにも当たらなかったパスの先頭区切りを、ありふれた名前のときだけ残す。
 * 短い識別子・トークン（英数混在・数字の並び）は残さない。
 */
export function unmatchedPathBucket(pathname) {
  const segs = String(pathname || '/').split('/').filter(Boolean);
  if (segs.length === 0) return '404:/';
  const first = segs[0];
  const rest = segs.length > 1 ? '/*' : '';
  return `404:/${isCommonName(first) ? first.toLowerCase() : ':seg'}${rest}`;
}

function isCommonName(seg) {
  if (!/^\.?[A-Za-z][A-Za-z0-9._-]{0,23}$/.test(seg)) return false;
  if (/\d/.test(seg)) return false;
  // 拡張子を除いた本体が「英字だけ・区切りつき」の名前に限る（大文字小文字の混在した乱数風は除く）
  const stem = seg.replace(/^\./, '').replace(/\.[A-Za-z]{1,5}$/, '');
  if (/[A-Z]/.test(stem) && /[a-z]/.test(stem)) return false;
  return true;
}

/** ルートパターンを記録用に整える（想定外の文字があれば伏せる） */
export function routeLabel(routePattern, pathname) {
  const route = String(routePattern || '');
  if (UNMATCHED_ROUTES.has(route)) return unmatchedPathBucket(pathname);
  if (!ROUTE_SAFE_RE.test(route) || route.length > 120) return ':route';
  return route;
}

export function classifyAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'noua';
  return BOT_RE.test(ua) ? 'bot' : 'ua';
}

export function isPrefetch(headers) {
  const v = `${headers?.get?.('sec-purpose') || ''} ${headers?.get?.('purpose') || ''}`;
  return /prefetch/i.test(v);
}

/**
 * @param {Request} request
 * @param {number} status
 * @param {string} [routePattern] middleware の `context.routePattern`
 * @returns {string}
 */
export function describeSsrRequest(request, status, routePattern) {
  const url = new URL(request.url);
  const who = classifyAgent(request.headers.get('user-agent'));
  const pf = isPrefetch(request.headers) ? 'pf' : '-';
  const q = url.search && url.search !== '?' ? 'q' : '-';
  return `${SSR_PATH_LOG_TAG} ${request.method} ${Number(status) || 0} ${who} ${pf} ${q} ${routeLabel(routePattern, url.pathname)}`;
}
