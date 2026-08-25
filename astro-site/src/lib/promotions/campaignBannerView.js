/**
 * campaignBannerView.js — ご案内バナーの**出し方**を決める（純粋・I/O なし）
 *
 * ## なぜ切り出したか（2026-08-25 の本番不具合 2 件）
 *
 * 1. `/free-signup/` で「無料登録する」ボタンが**同じページ**を指していた
 * 2. `/pricing/` で登録済みの方に**文字の無いオレンジのボタン**が出て、
 *    押しても何も起きなかった（`href` 未設定）
 *
 * どちらも「画面のスクリプトの中だけに条件がある」ため、テストで触れず素通りした。
 * ここに出して、**全プラン × 全ページを機械で確認できる**ようにする。
 */

/** 末尾スラッシュの有無で別物にしない */
function normalizePath(p) {
  const s = String(p || '').split('?')[0].split('#')[0].trim();
  if (!s) return '';
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * ボタンを出すか決める。
 *
 * ⚠️ **出さない条件を 3 つとも守ること**:
 *   - 行き先が無い（登録済みの方など）→ 出さない。文字の無いボタンを作らない
 *   - 文言が無い → 出さない（何のボタンか分からない）
 *   - **いま見ているページと同じ**→ 出さない（押しても何も起きない）
 *
 * @param {{ banner?: object, currentPath?: string }} input
 * @returns {{ show: boolean, href: string, label: string, reason: string }}
 */
export function resolveBannerCta({ banner, currentPath } = {}) {
  const b = banner || {};
  const href = String(b.ctaHref || '').trim();
  const label = String(b.ctaLabel || '').trim();
  const no = (reason) => ({ show: false, href: '', label: '', reason });

  if (!href) return no('no_href');
  if (!label) return no('no_label');
  if (normalizePath(href) === normalizePath(currentPath)) return no('same_page');
  return { show: true, href, label, reason: '' };
}

/**
 * バナー全体を出すか。
 * ⚠️ 見出しが無ければ出さない（枠だけ出しても意味が無い）。
 */
export function resolveBannerView({ banner, currentPath } = {}) {
  const b = banner || {};
  if (b.show !== true) return { show: false, headline: '', sub: '', cta: resolveBannerCta({}) };
  const headline = String(b.headline || '').trim();
  if (!headline) return { show: false, headline: '', sub: '', cta: resolveBannerCta({}) };
  return {
    show: true,
    headline,
    sub: String(b.sub || '').trim(),
    cta: resolveBannerCta({ banner: b, currentPath }),
  };
}
