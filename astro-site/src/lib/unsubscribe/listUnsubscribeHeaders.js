/**
 * listUnsubscribeHeaders.js — 送信メールに付ける配信停止ヘッダの**単一源**（純粋・IO なし）
 *
 * ## なぜ HTTPS だけにするか（2026-09-16 / 実害から確定）
 *
 * 旧実装は全 6 経路で **HTTPS と mailto を併記**していた:
 *
 *     List-Unsubscribe: <https://…/unsubscribe?email=…&brand=…>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>
 *     List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * ところが **Apple Mail は mailto が併記されていると mailto を選ぶ**。その結果、
 * 利用者が「配信停止」を押すと `unsubscribe@keiba.link` 宛に件名 `Unsubscribe` の
 * メールが飛ぶだけで、**AK 側の状態は 1 ビットも変わらない**。
 * 受信箱を人が見て手で止めるまで配信が続く＝人手運用が必要になっていた
 * （2026-09-16 に実際に届いて発覚）。
 *
 * **配信停止は無人で完結させる**と決めたので、mailto を外して HTTPS ワンクリックへ寄せる。
 *
 * ## 互換性（mailto を外してよい根拠）
 *
 * | クライアント | 挙動 |
 * |---|---|
 * | Gmail（Web/モバイル）| `List-Unsubscribe-Post` を見て **HTTPS へ POST**（mailto は元々不要）|
 * | Yahoo! / AOL | 同上 |
 * | Outlook.com / Microsoft | HTTPS の URI を開く |
 * | Apple Mail（macOS 13+ / iOS 16+）| RFC 8058 対応。**mailto が無ければ HTTPS を使う** |
 * | 上記以外・旧版 | ネイティブボタンが出ないだけ。**本文末尾の配信停止リンクは常に残す**ので詰まない |
 *
 * RFC 8058 は「ワンクリックを使うなら https URI を入れること」を要求するだけで、
 * mailto の併記は必須ではない。
 *
 * ## 絶対条件
 *
 * - `List-Unsubscribe` に **mailto を入れない**（guard テストが全送信経路を検査する）
 * - `List-Unsubscribe-Post` を**必ず同時に出す**。片方だけだとワンクリックにならない
 * - URL は**受信者ごと**（`?email=…&brand=…`）。宛先は URL 側が正本で、
 *   POST body の値を宛先に使わない（第三者が他人を止められないようにするため）
 */

/** RFC 8058 のワンクリック合図。**この値以外は受け付けない**（parse 側と対）。 */
export const ONE_CLICK_POST_VALUE = 'List-Unsubscribe=One-Click';

/** 配信停止エンドポイント（本番）。 */
export const UNSUBSCRIBE_ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/unsubscribe';

/** 既定ブランド。AK からの送信はすべてこれ。 */
export const DEFAULT_BRAND = 'analytics-keiba';

/**
 * 受信者ごとの配信停止 URL を作る。
 * @param {{email: string, brand?: string, endpoint?: string}} input
 * @returns {string}
 */
export function buildUnsubscribeUrl({ email, brand = DEFAULT_BRAND, endpoint = UNSUBSCRIBE_ENDPOINT } = {}) {
  const e = encodeURIComponent(String(email ?? '').trim());
  const b = encodeURIComponent(String(brand || DEFAULT_BRAND));
  return `${endpoint}?email=${e}&brand=${b}`;
}

/**
 * 送信ヘッダを組み立てる。**HTTPS のみ**。
 *
 * @param {string} unsubscribeUrl 受信者ごとの配信停止 URL（`buildUnsubscribeUrl` の戻り値）
 * @returns {{'List-Unsubscribe': string, 'List-Unsubscribe-Post': string}}
 */
export function buildListUnsubscribeHeaders(unsubscribeUrl) {
  const url = String(unsubscribeUrl ?? '').trim();
  if (!/^https:\/\//i.test(url)) {
    // http / mailto / 空を黙って通さない。**壊れたヘッダで送るより落とす**
    throw new Error('buildListUnsubscribeHeaders: https の URL が必要です');
  }
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': ONE_CLICK_POST_VALUE,
  };
}

/**
 * email から直接ヘッダを作る近道（呼び出し側の定型を減らす）。
 * @param {{email: string, brand?: string, endpoint?: string}} input
 */
export function listUnsubscribeHeadersFor(input) {
  return buildListUnsubscribeHeaders(buildUnsubscribeUrl(input));
}
