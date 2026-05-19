// renderDailyMainRace に渡す optional 引数（featuredHorse / links）の正規化と検証。
// newsletter-preview / newsletter-send-test の双方で同じルールを使うため共通化する。
//
// 2026-05-19 Phase 2.5+ C': 抽出。Phase 2.5+ A で preview に inline 実装したロジックを再利用可能に整理。
//
// 仕様:
//   - input.featuredHorse:
//       null / undefined → 無視（featuredHorse=null を返す）
//       非 object / Array → error
//       object かつ name(trim) が非空 → 正規化して返す
//       object だが name が空 → featuredHorse=null（送信側に渡さない）
//   - input.links:
//       null / undefined → 無視（links=null）
//       非 object / Array → error
//       { free?, premium? } が両方 https:// → 採用
//       いずれかが https:// 以外 → error（javascript:, data:, 相対 URL, protocol-relative を拒否）
//   - 戻り値:
//       { featuredHorse, links, error: null | { error: string, detail?: string[] | string, got?: any } }
//   - error が non-null の場合、caller は 400 response を返す想定。
//     形式は newsletter-preview の従来エラーレスポンスに合わせてある。

/**
 * @param {{featuredHorse?: any, links?: any}} input
 * @returns {{
 *   featuredHorse: null | { name: string, number: number | string, role: string },
 *   links: null | { free?: string, premium?: string },
 *   error: null | { error: string, detail?: string[] | string, got?: any }
 * }}
 */
export function normalizeRenderOptions(input) {
  const requestedFeaturedHorse = input?.featuredHorse;
  const requestedLinks = input?.links;

  // ---- featuredHorse ----
  let featuredHorse = null;
  if (requestedFeaturedHorse != null) {
    if (typeof requestedFeaturedHorse !== 'object' || Array.isArray(requestedFeaturedHorse)) {
      return {
        featuredHorse: null,
        links: null,
        error: {
          error: 'featuredHorse must be an object',
          got: Array.isArray(requestedFeaturedHorse) ? 'array' : typeof requestedFeaturedHorse,
        },
      };
    }
    const name = typeof requestedFeaturedHorse.name === 'string' ? requestedFeaturedHorse.name.trim() : '';
    if (name) {
      featuredHorse = {
        name,
        number: requestedFeaturedHorse.number != null ? requestedFeaturedHorse.number : '',
        role: typeof requestedFeaturedHorse.role === 'string' && requestedFeaturedHorse.role.trim()
          ? requestedFeaturedHorse.role.trim()
          : '本命',
      };
    }
    // name 空 → featuredHorse=null のまま（無視、送信側へ渡さない）
  }

  // ---- links ----
  let links = null;
  if (requestedLinks != null) {
    if (typeof requestedLinks !== 'object' || Array.isArray(requestedLinks)) {
      return {
        featuredHorse: null,
        links: null,
        error: {
          error: 'links must be an object',
          got: Array.isArray(requestedLinks) ? 'array' : typeof requestedLinks,
        },
      };
    }
    const safeHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
    const linkErrors = [];
    if (requestedLinks.free != null && !safeHttps(requestedLinks.free)) linkErrors.push('links.free must be https://');
    if (requestedLinks.premium != null && !safeHttps(requestedLinks.premium)) linkErrors.push('links.premium must be https://');
    if (linkErrors.length > 0) {
      return {
        featuredHorse: null,
        links: null,
        error: { error: 'invalid links', detail: linkErrors },
      };
    }
    const acc = {};
    if (safeHttps(requestedLinks.free)) acc.free = requestedLinks.free;
    if (safeHttps(requestedLinks.premium)) acc.premium = requestedLinks.premium;
    links = Object.keys(acc).length > 0 ? acc : null;
  }

  return { featuredHorse, links, error: null };
}
