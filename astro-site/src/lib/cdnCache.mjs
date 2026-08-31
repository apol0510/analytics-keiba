/**
 * cdnCache.mjs — 公開 SSR ページを Netlify のエッジに短時間だけ載せる
 *
 * ── なぜページ側で設定するか（2026-08-31 に実測して判明）─────────
 * 最初は `netlify.toml` の `[[headers]]` に `Netlify-CDN-Cache-Control` を書いたが、
 * **SSR 応答には届かなかった**。deploy preview で実測すると毎回
 *   `cache-status: "Netlify Edge"; fwd=miss`
 *   `cache-status: "Netlify Durable"; fwd=bypass`
 * のままで、エッジを素通りしていた（応答自身の `Cache-Control: no-cache` が勝つ）。
 * そのため **SSR 応答そのものにヘッダを付ける**方式へ変更した。
 *
 * ── 何を変えて、何を変えないか ────────────────────────────────
 * - `Netlify-CDN-Cache-Control` … Netlify のエッジにだけ効く。**これだけを設定する**
 * - `Cache-Control` … ブラウザ向け。**触らない**ので利用者から見た鮮度は従来どおり
 * デプロイのたびにエッジは無効化されるため、データ更新（= deploy）は即座に反映される。
 *
 * ── 使ってよいページ ──────────────────────────────────────────
 * **Cookie・会員判定・個人情報を一切使わない公開ページだけ。**
 * 個人化されたページに付けると、ある利用者向けの HTML を別の利用者へ配信し得る。
 * `scripts/check-cdn-cache-safety.mjs` が、この関数を呼ぶページに
 * `Astro.cookies` / `gatePaidPage` / `verifyPlanAccess` / `requireAuth` /
 * `AccessControl` / `SessionKeepAlive` / `credentials: 'include'` が
 * 含まれていないことを CI で検査する。
 */

/** エッジ保持 5 分＋その後 1 日は「古いものを返しつつ裏で更新」。 */
export const PUBLIC_CDN_CACHE = 'public, s-maxage=300, stale-while-revalidate=86400';

/**
 * 公開 SSR ページの応答をエッジへ載せる。
 * @param {{ response: { headers: Headers } }} astro `Astro` をそのまま渡す
 */
export function setPublicCdnCache(astro) {
  astro.response.headers.set('Netlify-CDN-Cache-Control', PUBLIC_CDN_CACHE);
}
