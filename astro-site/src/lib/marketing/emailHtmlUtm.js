/**
 * 管理画面から送る通常メルマガ（自由入力の HTML 本文）のリンクに utm を付ける（2026-11-21）。
 *
 * #893 はマーケティングメールの共通シェル（CTA）にだけ utm を付けた。管理画面の「メルマガ配信」
 * （send-newsletter / 予約配信 / キュー配信）は本文 HTML をそのまま送るため、本文中の
 * analytics.keiba.link へのリンクに utm が無く、メール経由の訪問・購入が GA4 で Direct に数えられていた。
 *
 * 🔴 付けるのは withEmailUtm と同じ規則だけ（許可 origin・既に utm_ がある URL は変えない・
 *    個人を識別する値は付けない）。配信停止リンク・差し替え前の印（{{...}}）は変えない。
 * 🔴 本文の文言・宛先・送信条件は変えない（href の値だけ）。
 */
import { withEmailUtm } from './marketingEmailShell.js';

export const NEWSLETTER_UTM_CAMPAIGN = 'ak_newsletter';

const HREF_RE = /(\bhref\s*=\s*)(["'])([^"']*)\2/gi;

function shouldSkip(url) {
  if (url.includes('{{')) return true;
  try {
    return /unsubscribe/i.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

/**
 * HTML 内の href を走査し、許可 origin のリンクへ utm を付ける。
 * 文字列でない・空なら入力をそのまま返す。
 */
export function addEmailUtmToHtml(html, campaign = NEWSLETTER_UTM_CAMPAIGN) {
  if (typeof html !== 'string' || !html) return html;
  return html.replace(HREF_RE, (match, prefix, quote, rawHref) => {
    const decoded = rawHref.trim().replace(/&amp;/g, '&');
    if (shouldSkip(decoded)) return match;
    const tagged = withEmailUtm(decoded, campaign);
    if (tagged === decoded) return match;
    return `${prefix}${quote}${tagged.replace(/&/g, '&amp;')}${quote}`;
  });
}
