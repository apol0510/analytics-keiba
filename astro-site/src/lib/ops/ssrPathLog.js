/**
 * ssrPathLog.js — SSR Function が「どのパスで・誰に」起動されたかを関数ログに 1 行で残す（2026-11-01）
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
 *   [ssr-path] GET 200 ua pf q /free/nankan/
 *              │   │   │  │  │ └ パス（クエリは捨てる。長い ID・@ を含む区切りは :id に置換）
 *              │   │   │  │  └ クエリの有無（q / -）。値は残さない
 *              │   │   │  └ 先読み（Sec-Purpose / Purpose: prefetch）なら pf、そうでなければ -
 *              │   │   └ ua（通常） / bot（UA がボット） / noua（UA なし）
 *              │   └ status
 *              └ method
 *
 * - 🛑 クエリ・Cookie・IP・UA 本文・メールアドレス・トークンは残さない。
 * - Redis 等へは書かない（1 起動ごとに外部書込を増やさない・費用ゼロの関数ログだけ）。
 * - 失敗しても本体の応答は変えない（middleware 側で握りつぶす）。
 */

export const SSR_PATH_LOG_TAG = '[ssr-path]';

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|python|curl|wget|go-http|axios|node-fetch|scrapy|httpclient|java\/|okhttp|semrush|ahrefs|mj12|bytespider|ccbot|lighthouse|pagespeed/i;

const MAX_PATH = 120;

/** パスの区切りのうち、ID・トークン・メールに見えるものを :id に置き換える */
export function normalizeSsrPath(pathname) {
  const raw = String(pathname || '/').slice(0, 400);
  const out = raw
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (seg.includes('@') || seg.includes('%40')) return ':id';
      if (seg.length >= 24) return ':id';
      if (/^[0-9a-f]{12,}$/i.test(seg)) return ':id';
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
  return out.length > MAX_PATH ? `${out.slice(0, MAX_PATH)}…` : out;
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
 * @returns {string}
 */
export function describeSsrRequest(request, status) {
  const url = new URL(request.url);
  const who = classifyAgent(request.headers.get('user-agent'));
  const pf = isPrefetch(request.headers) ? 'pf' : '-';
  const q = url.search && url.search !== '?' ? 'q' : '-';
  return `${SSR_PATH_LOG_TAG} ${request.method} ${Number(status) || 0} ${who} ${pf} ${q} ${normalizeSsrPath(url.pathname)}`;
}
