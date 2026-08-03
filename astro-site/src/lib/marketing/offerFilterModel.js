/**
 * offerFilterModel.js — 割引オファーの絞り込みを「状態」と「残り期間」に分ける（純粋・I/O なし）
 *
 * ── なぜ分けるか ────────────────────────────────────────────────
 * これまで 1 つのチェックリストに
 *   ・申込可能なオファーあり
 *   ・オファー期限が7日以内
 *   ・オファーなし
 * が並んでいた。しかし **「期限が7日以内」は「申込可能なオファーあり」の部分集合**で、
 * 並列の選択肢ではない。両方チェックすると（OR なので）「申込可能なオファーあり」と
 * 同じ結果になり、利用者は違いを説明できない。
 *
 * そこで 2 軸へ分ける。
 *   A. **オファーの現在状態**（排他的。1 顧客は必ず 1 つ）
 *   B. **有効期限の残り**（A で「申込みに使える」人をさらに絞る追加条件）
 *
 * ── 排他にするための優先順位 ──────────────────────────────────
 * 1 顧客が複数のオファー行を持ちうる（過去に発行 → 期限切れ → 再発行 など）。
 * 「いま何ができるか」を答えにするため、次の優先で 1 つに決める:
 *   使える > 申込み済み > 取消 > 期限切れ > 記録なし
 * （使えるオファーが 1 件でもあれば、他に何があっても「使える」が答え）
 *
 * ── 証明できることだけ分類する ────────────────────────────────
 * 判定材料は `PromotionalOffers` の `Status` / `ExpiresAt` / `OfferPrice` だけ
 * （`isLiveOffer` と同じ根拠）。台帳を読めなかった場合は `unknown` にし、
 * **「オファーなし」と断定しない**。
 */

/** オファーの現在状態（排他的） */
export const OFFER_STATE = Object.freeze({
  LIVE: 'live',
  REDEEMED: 'redeemed',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  NONE: 'none',
  UNKNOWN: 'unknown',
});

export const OFFER_STATE_LABEL = Object.freeze({
  [OFFER_STATE.LIVE]: '現在申込みに使えるオファーあり',
  [OFFER_STATE.REDEEMED]: '申込み済み（オファー利用済み）',
  [OFFER_STATE.REVOKED]: '取り消したオファーのみ',
  [OFFER_STATE.EXPIRED]: '期限切れのオファーのみ',
  [OFFER_STATE.NONE]: 'オファーの発行なし',
  [OFFER_STATE.UNKNOWN]: '状態を確認できない',
});

export const OFFER_STATE_DESCRIPTION = Object.freeze({
  [OFFER_STATE.LIVE]: '期限内で価格が設定された割引・購入オファーがあり、顧客がいま申込みに使えます。',
  [OFFER_STATE.REDEEMED]: '発行したオファーで既に申込みが行われています。いま使えるオファーはありません。',
  [OFFER_STATE.REVOKED]: '発行後に取り消したオファーだけが残っています。いま使えるオファーはありません。',
  [OFFER_STATE.EXPIRED]: '発行したオファーの有効期限がすべて終了しています。',
  [OFFER_STATE.NONE]: 'この顧客宛のオファーは 1 件も発行されていません。',
  [OFFER_STATE.UNKNOWN]: 'オファー台帳を読み取れませんでした。「発行なし」とは限りません。',
});

/** 有効期限の残り（**「使えるオファーあり」の人をさらに絞る追加条件**） */
export const OFFER_WINDOW = Object.freeze({
  D7: 'within7',
  D8PLUS: 'over7',
  NO_LIMIT: 'no_expiry',
  UNKNOWN: 'unknown',
});

export const OFFER_WINDOW_LABEL = Object.freeze({
  [OFFER_WINDOW.D7]: '利用期限まで7日以内',
  [OFFER_WINDOW.D8PLUS]: '利用期限まで8日以上',
  [OFFER_WINDOW.NO_LIMIT]: '利用期限なし',
  [OFFER_WINDOW.UNKNOWN]: '残り期間を確認できない',
});

export const OFFER_WINDOW_DESCRIPTION = Object.freeze({
  [OFFER_WINDOW.D7]: 'いま使えるオファーの期限が、現在から 7 日以内に終了します。締切前の案内に使います。',
  [OFFER_WINDOW.D8PLUS]: 'いま使えるオファーの期限まで 8 日以上あります。',
  [OFFER_WINDOW.NO_LIMIT]: '期限の設定が無いオファーです。',
  [OFFER_WINDOW.UNKNOWN]: 'いま使えるオファーが無い、または期限を読み取れないため判定できません。',
});

/** 2 つの関係を画面に明示する 1 文（並列ではないことを必ず伝える） */
export const OFFER_RELATION_NOTE =
  '現在利用できるオファーがある顧客を、残り期間でさらに絞り込めます。'
  + '「残り期間」だけを選んでも、いま使えるオファーがある顧客だけが対象になります。';

const DAY_MS = 24 * 60 * 60 * 1000;
const str = (v) => String(v ?? '').trim();

function selection(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(str).filter((x) => x && x !== 'all');
}

/**
 * 顧客 1 人のオファー状態を 1 つに決める。
 *
 * @param {{live: number, redeemed?: number, revoked?: number, expired?: number,
 *          total?: number, available: boolean, soonestExpiresAtMs?: number|null, nowMs: number}} input
 */
export function resolveOfferState({
  live = 0, redeemed = 0, revoked = 0, expired = 0, total = 0,
  available = true, soonestExpiresAtMs = null, nowMs = Date.now(),
} = {}) {
  if (available !== true) {
    return { state: OFFER_STATE.UNKNOWN, window: OFFER_WINDOW.UNKNOWN, daysLeft: null, liveCount: 0 };
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let state = OFFER_STATE.NONE;
  if (live > 0) state = OFFER_STATE.LIVE;
  else if (redeemed > 0) state = OFFER_STATE.REDEEMED;
  else if (revoked > 0) state = OFFER_STATE.REVOKED;
  else if (expired > 0) state = OFFER_STATE.EXPIRED;
  else if (total > 0) state = OFFER_STATE.EXPIRED;   // 記録はあるが分類できない = 使えない側へ倒す

  // 残り期間は「使えるオファーがある」ときだけ意味を持つ
  let window = OFFER_WINDOW.UNKNOWN;
  let daysLeft = null;
  if (state === OFFER_STATE.LIVE) {
    if (soonestExpiresAtMs === null || !Number.isFinite(soonestExpiresAtMs)) {
      window = OFFER_WINDOW.NO_LIMIT;
    } else {
      daysLeft = Math.ceil((soonestExpiresAtMs - now) / DAY_MS);
      window = daysLeft <= 7 ? OFFER_WINDOW.D7 : OFFER_WINDOW.D8PLUS;
    }
  }
  return { state, window, daysLeft, liveCount: live };
}

/** 現在状態の一致（未選択なら絞らない） */
export function matchesOfferState(state, sel) {
  const want = selection(sel);
  if (want.length === 0) return true;
  return want.includes(str(state));
}

/**
 * 残り期間の一致。
 * **`live` 以外は残り期間を持たない**ので、残り期間を指定した時点で
 * 「いま使えるオファーがある人」に自動で限定される（矛盾した条件を作らせない）。
 */
export function matchesOfferWindow(view, sel) {
  const want = selection(sel);
  if (want.length === 0) return true;
  const v = view || {};
  if (v.state !== OFFER_STATE.LIVE) return false;
  return want.includes(str(v.window));
}

/**
 * 選んだ条件が両立しないかを、**取得前**に判定する。
 * 例: 「オファーの発行なし」×「利用期限まで7日以内」は必ず 0 件。
 */
export function detectOfferConflict({ state, window } = {}) {
  const s = selection(state);
  const w = selection(window);
  if (w.length === 0 || s.length === 0) return null;
  if (s.includes(OFFER_STATE.LIVE)) return null;   // live を含むなら成立しうる
  return {
    reason: 'offer_state_window_conflict',
    message: 'この条件の組合せでは対象が存在しません：'
      + '「残り期間」は、いま使えるオファーがある顧客にだけ当てはまります。'
      + '「現在申込みに使えるオファーあり」を選ぶか、残り期間の指定を外してください。',
  };
}

/** 一覧 1 行に出す文字列（状態 + 残り期間） */
export function formatOfferCell(view) {
  const v = view || {};
  const base = OFFER_STATE_LABEL[v.state] || '—';
  if (v.state !== OFFER_STATE.LIVE) return base;
  if (v.window === OFFER_WINDOW.NO_LIMIT) return `${base}（期限なし）`;
  if (!Number.isFinite(v.daysLeft)) return base;
  return `${base}（残り ${v.daysLeft} 日）`;
}

export const OFFER_STATE_VALUES = Object.freeze(Object.values(OFFER_STATE));
export const OFFER_WINDOW_VALUES = Object.freeze(Object.values(OFFER_WINDOW));
