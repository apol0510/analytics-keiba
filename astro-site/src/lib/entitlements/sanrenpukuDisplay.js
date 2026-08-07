/**
 * sanrenpukuDisplay.js — 三連複保有の**表示**（純粋・I/O なし）
 *
 * ── これは表示レイヤーであって判定ではない ────────────────────────
 * 保有しているか否かの正本は `resolveEntitlements()` の `canViewSanrenpuku`。
 * このモジュールは**その結果を受け取って日本語にするだけ**で、判定を再実装しない
 * （guard テストで `canViewSanrenpuku` と矛盾しないことを固定している）。
 *
 * ── 解決したい誤読 ──────────────────────────────────────────────
 * 三連複は**会員ランクではなく買い切りの永久 entitlement**なので、購入しても
 * `プラン` 列は `Premium` のまま。権利は別列 `LifetimeSanrenpuku` が持つ。
 * そのため管理画面で「プラン」だけを見ると、
 *
 *   - `プラン = Premium Sanrenpuku`（2026-07-10 の銀行振込フロー刷新より前の旧形式）
 *   - `プラン = Premium` + `LifetimeSanrenpuku = true`（現行形式）
 *
 * の後者が三連複購入者だと分からない。両方を同じバッジで見分けられるようにする。
 *
 * ── 「保有」の 2 系統は寿命が違う（同じ扱いにしない）─────────────
 *   lifetime    … 買い切りの永久権。Premium 契約が切れても閲覧できる
 *   legacy tier … 旧 tier による移行期の救済。**Premium 契約が有効な間だけ**閲覧できる
 * 表示でもこの差を潰さない（「永久保有」と「旧プラン・Premium 有効中」を区別する）。
 */

/** 旧 tier（移行期の救済対象）。正本は resolveEntitlements.js の LEGACY_SANRENPUKU_TIERS。 */
const LEGACY_TIERS = Object.freeze(['premium-sanrenpuku', 'premium-combo']);

const LEGACY_TIER_LABEL = Object.freeze({
  'premium-sanrenpuku': 'Premium Sanrenpuku',
  'premium-combo': 'Premium Combo',
});

/** 保有の根拠。表示の出し分けにのみ使う。 */
export const SANRENPUKU_BASIS = Object.freeze({
  /** LifetimeSanrenpuku=true（買い切りの永久権） */
  LIFETIME: 'lifetime',
  /** 旧 tier による保有（Premium 契約が有効な間だけ） */
  LEGACY_TIER: 'legacy_tier',
  /** 旧 tier だが Premium 契約が切れており、現在は閲覧できない */
  LEGACY_EXPIRED: 'legacy_expired',
  /** 保有していない */
  NONE: 'none',
});

/**
 * 三連複保有の表示を組み立てる。
 *
 * @param {object} ent `resolveEntitlements()` の戻り値（**この関数で判定し直さない**）
 * @returns {{
 *   has: boolean,          保有しているか（= ent.canViewSanrenpuku をそのまま）
 *   basis: string,         SANRENPUKU_BASIS
 *   badge: string|null,    一覧のバッジ文字列（保有していなければ null）
 *   label: string,         詳細の「三連複」項目に出す短い日本語
 *   note: string,          label を補う 1 文（根拠と寿命）
 * }}
 */
export function describeSanrenpukuHolding(ent) {
  const e = ent || {};
  const has = e.canViewSanrenpuku === true;
  const tier = typeof e.tier === 'string' ? e.tier : '';
  const isLegacyTier = LEGACY_TIERS.includes(tier);
  const tierLabel = LEGACY_TIER_LABEL[tier] || tier;

  if (!has) {
    // 旧 tier なのに閲覧できない = Premium 契約が切れている。
    // 「三連複を買っていない」と同じ表示にすると誤解を招くので分ける。
    if (isLegacyTier) {
      return {
        has: false,
        basis: SANRENPUKU_BASIS.LEGACY_EXPIRED,
        badge: '三連複（停止中）',
        label: '保有（現在は閲覧不可）',
        note: `旧プラン「${tierLabel}」による保有。Premium 契約が切れているため現在は閲覧できません。`,
      };
    }
    return {
      has: false,
      basis: SANRENPUKU_BASIS.NONE,
      badge: null,
      label: 'なし',
      note: '三連複の買い切りを保有していません。',
    };
  }

  if (e.lifetimeSanrenpuku === true) {
    return {
      has: true,
      basis: SANRENPUKU_BASIS.LIFETIME,
      badge: '三連複保有',
      label: '永久保有',
      note: '買い切りの永久権（LifetimeSanrenpuku）。Premium 契約が切れても閲覧できます。',
    };
  }

  return {
    has: true,
    basis: SANRENPUKU_BASIS.LEGACY_TIER,
    badge: '三連複保有（旧プラン）',
    label: '保有（旧プラン）',
    note: `旧プラン「${tierLabel}」による保有。Premium 契約が有効な間だけ閲覧できます。`,
  };
}

/**
 * 一覧の「プラン」セルに添える 1 行。プラン名自体は書き換えない。
 * 保有していない相手には空文字を返す（列を汚さない）。
 */
export function sanrenpukuBadgeText(ent) {
  return describeSanrenpukuHolding(ent).badge || '';
}
