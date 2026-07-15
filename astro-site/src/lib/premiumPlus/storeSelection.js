/**
 * storeSelection.js — PREMIUM_PLUS_CANARY の生値から使用する Blobs ストア名を厳格に決める（純粋・fail-closed）
 *
 * 目的: canary を本番ストア `premium-plus` から完全隔離し、canary 残骸を本番へ混入させない。
 * ただし env の誤設定を本番ストアへ「フォールバック」させない（それ自体が事故源）。
 *   undefined（未設定） → premium-plus       （正式）
 *   "false"            → premium-plus       （正式）
 *   "true"             → premium-plus-canary（canary 専用ストア）
 *   それ以外すべて       → 拒否（configuration error）
 *     ""（空文字）/ "TRUE" / "False" / " true "（空白付き）/ "1" / "yes" / slash・改行・任意 store 名 …
 *
 * 自由な store 名 override は提供しない（固定 2 択のみ）。誤設定・注入で本番/他機能ストアを
 * 破壊させないため。呼び出し側は ok:false のとき getStore・Blobs read/write・認証処理へ到達させない。
 */

export const PREMIUM_PLUS_STORES = Object.freeze({
  PRODUCTION: 'premium-plus',
  CANARY: 'premium-plus-canary',
});

export const STORE_SELECT_REJECT = Object.freeze({
  INVALID_CANARY_FLAG: 'invalid_canary_flag',
});

/**
 * @param {unknown} rawValue process.env.PREMIUM_PLUS_CANARY（string | undefined）
 * @returns {{ok:true, storeName:string}|{ok:false, reason:string}}
 */
export function resolvePremiumPlusStoreName(rawValue) {
  if (rawValue === undefined) return { ok: true, storeName: PREMIUM_PLUS_STORES.PRODUCTION };
  if (rawValue === 'false') return { ok: true, storeName: PREMIUM_PLUS_STORES.PRODUCTION };
  if (rawValue === 'true') return { ok: true, storeName: PREMIUM_PLUS_STORES.CANARY };
  // 上記の厳密一致以外（空文字・大小違い・空白付き・"1"/"yes"・slash/改行・任意 store 名）は
  // すべて configuration error。生値は返さない（呼び出し側でログ・レスポンスへ出さない）。
  return { ok: false, reason: STORE_SELECT_REJECT.INVALID_CANARY_FLAG };
}
