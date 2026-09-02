/**
 * predictionDestination.js — 「今日の予想」を押した会員をどのページへ送るかの単一源
 *
 * ── なぜ要るか（2026-09-02）────────────────────────────────────
 * グローバルナビには**有料予想ページへのリンクが 1 本も無かった**。
 * 無料予想（`/free-prediction/*`）だけがナビに載っており、Light / Premium 会員が
 * 予想へ行く道は「マイページのカード」1 枚しかなかった。そのカードは localStorage
 * 依存で消えるため（`viewerEntitlements.js` 参照）、**会員が予想に到達できなくなる**。
 *
 * ── 設計 ────────────────────────────────────────────────────
 * ナビは行き先を 1 本（`/today/`）に固定し、**誰をどこへ送るかはサーバーが決める**。
 * クライアントに分岐を持たせない（localStorage が消えても壊れない）。
 *
 * ⚠️ **`effectiveTier` を使わない。**
 *    `effectiveTier` は `canViewSanrenpuku` を最優先に見るため、
 *    「三連複は買い切りで保有・馬単 Premium は期限切れ」の会員が `premium-sanrenpuku`
 *    と判定される。その人を `/premium-prediction/nankan/` へ送ると、そのページは
 *    `canViewPremium` を要求するので**ログイン画面へ跳ね返される**（無限往復）。
 *    行き先は必ず「そのページが要求する権利そのもの」で選ぶ。
 *
 *      /premium-prediction/nankan/ … requiredPlan='premium'  → canViewPremium
 *      /light-predictions/         … requiredPlan='standard' → canViewLight
 *      /free/                      … 認可なし（誰でも見られる無料予想の索引）
 */

/** 行き先。**実在するパスだけ**を並べる（存在しない URL を組み立てない）。 */
export const PREDICTION_DESTINATIONS = Object.freeze({
  /** 馬単 Premium 会員 */
  premium: '/premium-prediction/nankan/',
  /** Light 会員。会場指定なしで南関（大井・浦和・船橋）の最新開催日を表示する */
  light: '/light-predictions/',
  /**
   * 無料会員・未ログイン。
   * **索引**（中央 / 南関を選べる無料予想トップ）へ送る。会場を勝手に決めない。
   * 有料会員は権利のあるページへ直行させるが、無料側で南関を既定にすると
   * 「中央しか見ない利用者」に毎回選び直させることになる。
   */
  free: '/free/',
  /** 判定できなかったとき。権利を主張しない中立な行き先 */
  unknown: '/dashboard/',
});

/**
 * 閲覧者 → 行き先。
 *
 * @param {{state?: string, entitlements?: object}} viewer `resolveViewer` の戻り値
 * @returns {string} 実在するパス
 */
export function resolvePredictionDestination(viewer) {
  const state = viewer && typeof viewer === 'object' ? viewer.state : null;

  // 判定できなかった（鍵未設定・Airtable 一時障害）。
  // 有料ページへ送ると跳ね返され、無料ページへ送ると有料会員に無料版を見せる。
  // どちらでもない中立な場所（マイページ）へ送る。
  if (state === 'unknown') return PREDICTION_DESTINATIONS.unknown;

  const e = (viewer && viewer.entitlements) || {};

  // ページが要求する権利そのもので選ぶ（上から順に強い権利）
  if (e.canViewPremium === true) return PREDICTION_DESTINATIONS.premium;
  if (e.canViewLight === true) return PREDICTION_DESTINATIONS.light;

  // 無料会員・未ログイン・権利なし（期限切れ / 退会 / 三連複のみ保有）はすべて無料予想へ。
  // ⚠️ ここで有料ページへ送らない。送っても `gatePaidPage` に拒否されるだけで、
  //    利用者には「押しても戻される」壊れた導線に見える。
  return PREDICTION_DESTINATIONS.free;
}

/**
 * ナビに出すラベル。行き先が変わっても文言は 1 つに保つ
 * （プランごとに文言を変えると、権利の存在が未ログイン者に漏れる）。
 */
export const PREDICTION_NAV_LABEL = '今日の予想';

/** ナビの遷移先（サーバー側ルータ）。ナビ自身は分岐を持たない。 */
export const PREDICTION_NAV_HREF = '/today/';
