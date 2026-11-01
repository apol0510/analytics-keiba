/**
 * upsellClient.js — 顧客ページから販売導線の判定を 1 回だけ取りに行く（ブラウザ用）
 *
 * ページごとに fetch を書かず、**同じ答え**を全ページで共有するための薄い層。
 * 判定そのものはサーバー（/api/upsell.json → upsellTarget.js）が持つ。
 *
 * ── 取得できないときは既存挙動へ倒す（後方互換）─────────────────────
 * 未ログイン・404・通信エラー・API 未デプロイ のときは `channel='unknown'` を返す。
 * 呼び出し側は unknown を「従来どおり」として扱う:
 *   - 三連複の段階表示は従来どおり動く（localStorage だけで完結していたため）
 *   - Premium Plus は従来どおり `/api/premium-plus-stage.json` 側の判定に従う
 * ＝ この機能が落ちても販売導線が消えたり、逆に両方出たりしない。
 */

/** 販売導線。`unknown` は「判定を取得できなかった＝従来動作」 */
export const UPSELL_CLIENT_CHANNEL = Object.freeze({
  SANRENPUKU: 'sanrenpuku',
  PLUS: 'plus',
  NONE: 'none',
  UNKNOWN: 'unknown',
});

const ENDPOINT = '/api/upsell.json';
let cached = null;

/** 取得できなかったとき（未ログイン・404・通信エラー）の判定。従来の値と同一 */
function decisionFallback() {
  return {
    channel: UPSELL_CLIENT_CHANNEL.UNKNOWN,
    sanrenpuku: { allowed: true },
    plus: { allowed: false },
    // 取得できなければ「持っていない」扱い＝カードを出さない（fail closed）
    coupon: { claimed: false },
  };
}

/**
 * この端末にログインの手がかりがあるか（**通信するかどうかの判断にだけ**使う）。
 *
 * `ak_session` は HttpOnly で画面から見えない。発行されるのは有料のマジックリンク
 * ログイン時だけで、そのとき `auth/verify` が必ず `user-plan` を書く。
 * 手がかりが 1 つも無い端末では `/api/upsell.json` は 404 しか返さない。
 * ⚠️ 権限の判定には使わない（権威はサーバーの `ak_session`）。
 */
export function hasLoginHint(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    // ⚠️ 読めない端末（ストレージ拒否など）は「手がかりが無い」と言い切れない → 従来どおり通信する
    if (!s) return true;
    s.getItem('user-plan'); // 読めない端末はここで catch へ（従来どおり通信する）
    if (readNavAuthState(s).loggedIn !== true) return false;
    // 同じ `user-plan` のまま直近に 404 を受けた端末は、まだセッションが無い（下の NO_SESSION_KEY）
    return !hasRecentNoSession(s);
  } catch {
    return true;
  }
}

/**
 * 直近に `/api/upsell.json` が 404 を返した印（**通信するかどうかの判断にだけ**使う）。
 *
 * 無料ログイン（login.astro）・無料登録（free-signup.astro）も `user-plan` を書くが、
 * `ak_session` は有料のマジックリンクログイン時にしか発行されない。そのため無料の方は
 * ページを開くたびに 404 になっていた（2026-11-01 実測: SSR 起動の最多・1 日 約 500 回）。
 *
 * - 印は `user-plan` の値の hash に結びつける。`user-plan` が書き換わったら（ログイン・購入）印は効かない
 * - 30 分で切れる（その後は 1 回だけ通信して確かめ直す）
 * - `auth/verify` はセッション発行時に印を消す（同じ値の `user-plan` が書かれても次の表示で通信する）
 * - 2xx を受けたら消す
 * ⚠️ 本文・email は保存しない（hash と時刻だけ）。権限の判定には使わない
 */
export const NO_SESSION_KEY = 'ak:upsell-no-session';
const NO_SESSION_TTL_MS = 30 * 60 * 1000;

function planHash(s) {
  const raw = String(s.getItem('user-plan') || '');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return `${raw.length}:${h.toString(36)}`;
}

function hasRecentNoSession(s) {
  try {
    const o = JSON.parse(s.getItem(NO_SESSION_KEY) || 'null');
    if (!o || o.h !== planHash(s)) return false;
    const age = Date.now() - Number(o.at);
    return Number.isFinite(age) && age >= 0 && age < NO_SESSION_TTL_MS;
  } catch { return false; }
}

function rememberNoSession(status) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (status === 404) localStorage.setItem(NO_SESSION_KEY, JSON.stringify({ h: planHash(localStorage), at: Date.now() }));
    else if (status >= 200 && status < 300) localStorage.removeItem(NO_SESSION_KEY);
  } catch { /* 印を書けなくても表示は変えない */ }
}

/**
 * キャンペーン期間から十分に外れているか（**通信を省くかどうかの判断にだけ**使う）。
 * 端末の時計のずれを考え、前後 1 日の余裕を持たせる。期間内・境界付近は従来どおり通信する。
 * 期間外のサーバー応答は `active: false, offers: []` で、画面には何も出ない（下の `empty` と同じ）。
 */
const CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000;
export function isOutsideCampaignWindow(nowMs = Date.now()) {
  const s = Date.parse(CAMPAIGN_WINDOW.startsAtIso);
  const e = Date.parse(CAMPAIGN_WINDOW.endsAtIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(nowMs)) return false;
  return nowMs < s - CLOCK_MARGIN_MS || nowMs >= e + CLOCK_MARGIN_MS;
}

/**
 * 販売導線を取得する（同一ページ内では 1 回だけ通信し、以後は使い回す）。
 * @returns {Promise<{channel: string, sanrenpuku: {allowed: boolean}, plus: object}>}
 */
export function getUpsellDecision() {
  if (cached) return cached;
  cached = (async () => {
    const fallback = decisionFallback();
    try {
      const res = await fetch(ENDPOINT, { credentials: 'same-origin' });
      rememberNoSession(res.status);
      if (!res.ok) return fallback; // 404 = 未ログイン等 → 従来どおり
      const data = await res.json();
      if (!data || typeof data.channel !== 'string') return fallback;
      return data;
    } catch {
      return fallback;
    }
  })();
  return cached;
}

/**
 * 三連複の導線（予告・CTA）を出してよいか。
 * `unknown` は従来どおり出す（この機能の障害で既存導線を止めない）。
 */
export async function canShowSanrenpukuUpsell() {
  const d = await getUpsellDecision();
  if (d.channel === UPSELL_CLIENT_CHANNEL.UNKNOWN) return true;
  return d.channel === UPSELL_CLIENT_CHANNEL.SANRENPUKU;
}

/**
 * 本人のクーポン（マイページのカード用）。
 *
 * 追加の通信はしない（`getUpsellDecision()` の結果を使い回す）。
 *
 * ⚠️ **取得済みだけでなく「いま取得できる」場合も返す**（2026-08-22 修正）。
 *    旧実装は `claimed === true` だけを通していたため、
 *    サーバーが `canClaim: true` を返してもマイページにカードが出なかった。
 *    どちらを出すかの判定は**サーバーの単一源**（`resolveCouponAccess`）が決める。
 * ⚠️ 表示文言・条件はサーバーが返した文字列をそのまま使うこと。
 *    クライアントで条件文や価格を組み立てない。
 */
export async function getReopenCoupon() {
  const d = await getUpsellDecision();
  const c = d && d.coupon;
  const show = !!c && (c.claimed === true || c.canClaim === true);
  return show ? c : { claimed: false, canClaim: false };
}

/** Premium Plus の導線を出してよいか（unknown は従来どおり Plus 側 API の判定に委ねる） */
export async function canShowPlusUpsell() {
  const d = await getUpsellDecision();
  if (d.channel === UPSELL_CLIENT_CHANNEL.UNKNOWN) return true;
  return d.channel === UPSELL_CLIENT_CHANNEL.PLUS;
}

// ── お知らせ（未読の赤い点）────────────────────────────────
//
// ⚠️ 2026-08-23 追加。それまでクーポンを渡しても**お客様に知らせる手段が無く**、
//    たまたまマイページを開かない限り気づけなかった。
//
// 既読は**その端末の localStorage** に持つ（本番 schema を増やさない）。
// 読めない環境（プライベートウィンドウ等）では「未読」に倒す＝見落としを作らない。

import { describeAllNotices } from '../premiumPlus/couponNotice.js';
import { readNavAuthState } from '../navigation/navAuthState.js';
// 期間の単一源（値はここへ書き写さない）
import { CAMPAIGN_WINDOW } from '../promotions/campaignOffers.js';

const SEEN_KEY = 'ak:coupon-notice-seen';

/** 種類ごとの既読 signature（`{ usable: '...', campaign: '...' }`）*/
function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY) || '';
    if (!raw) return {};
    // 旧形式（signature の文字列だけ）も読めるようにする
    if (raw[0] !== '{') return { usable: raw, claimable: raw };
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

/**
 * いま出すべきお知らせ（無ければ `show: false`）。追加の通信はしない。
 * @returns {Promise<{show: boolean, unseen: boolean, count: number, label: string, signature: string}>}
 *
 * ⚠️ ナビの赤い点は**全ページ・未ログインの方にも**載る。ログインの手がかりが無い端末では
 *    `/api/upsell.json` は必ず 404 なので、通信せずに「取得できなかった」と同じ値を使う
 *    （Netlify Functions の起動回数削減・2026-11-01・`docs/SAFETY_CHECKS.md` ルール 9）。
 *    ここでは `cached` を作らない。同じページのマイページ等が `getUpsellDecision()` を
 *    呼んだときは従来どおり通信する（判定を毒さない）。
 */
export async function getCouponNotice() {
  // 手がかりが無い端末は通信しない（上の説明・`cached` は作らない）
  const d = (cached || hasLoginHint()) ? await getUpsellDecision() : decisionFallback();
  // ⚠️ 無料の方はセッションが無く `d.campaign` が取れない。公開 API から取り直す
  const campaign = (d && d.campaign) ? d.campaign : await getCampaign();
  const all = describeAllNotices({
    coupon: d && d.coupon, campaign,
    // ⚠️ サーバーが作った文字列をそのまま渡す。ランク判定をここで作らない
    rankNotice: d && d.rankNotice,
    seen: readSeen(),
  });
  const first = all.items[0] || null;
  return {
    // ⚠️ `show` は**既読を含めて 1 件でもあるか**（ナビに出し続けるための条件）
    show: all.total > 0,
    unseen: all.count > 0,
    count: all.count,
    /** 既読を含む全件（ナビ・お知らせ一覧はこちらを見る）*/
    total: all.total,
    all: all.all,
    /** 1 件目の内容（1 行だけ出す画面用）*/
    kind: first ? first.kind : '',
    label: first ? first.label : '',
    signature: first ? first.signature : '',
    /** すべての未読（お知らせ一覧用）*/
    items: all.items,
  };
}

/**
 * 見てもらえたので赤い点を消す。
 * ⚠️ **実際に画面へ出たときだけ**呼ぶこと（開いていないのに既読にしない）。
 */
export function markCouponNoticeSeen(signature) {
  const sig = String(signature || '').trim();
  if (!sig) return false;
  try { localStorage.setItem(SEEN_KEY, sig); return true; } catch { return false; }
}

/**
 * 表示したお知らせをまとめて既読にする。
 * ⚠️ 種類ごとに覚える。1 つ見ただけで**もう一方まで既読にしない**。
 */
export function markNoticesSeen(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return false;
  try {
    const seen = readSeen();
    for (const it of list) {
      if (it && it.kind && it.signature) seen[it.kind] = it.signature;
    }
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    return true;
  } catch { return false; }
}


// ── キャンペーン割引（無料の方にも届ける）────────────────────
//
// ⚠️ **無料会員にはサーバーセッションが無い**（有料判定用のため発行されない）。
//    そのため `/api/upsell.json` は無料の方に 404 を返し、案内が届かなかった。
//    セッションがあるときはそちらの結果を使い、無いときだけ公開 API を叩く。

let campaignCached = null;

/** 画面が知っている契約（localStorage）。**表示の出し分けにだけ**使う */
function declaredPlan() {
  try {
    const raw = localStorage.getItem('user-plan');
    if (!raw) return '';
    const o = JSON.parse(raw);
    return String((o && o.plan) || '');
  } catch { return ''; }
}

/**
 * いま案内するキャンペーン割引。
 * ⚠️ 実際に割り引くかは**申込時にサーバーが決める**。ここは案内のための値。
 */
export async function getCampaign() {
  if (campaignCached) return campaignCached;
  campaignCached = (async () => {
    // ⚠️ ログインの手がかりが無い端末では `/api/upsell.json` は 404 しか返さないので叩かない
    if (!cached && !hasLoginHint()) return fetchPublicCampaign();
    // 有料の方（セッションあり）は既存の 1 回の通信に相乗り
    const d = await getUpsellDecision();
    if (d && d.campaign) return d.campaign;
    // 無料の方はセッションが無いので公開 API を使う
    return fetchPublicCampaign();
  })();
  return campaignCached;
}

/** 公開 API（`/api/campaign.json`）からキャンペーンを取る。期間外は通信しない */
async function fetchPublicCampaign() {
  const empty = { active: false, offers: [], deadlineText: '', signature: '' };
  // 期間外は公開 API も `active: false` しか返さない（画面に何も出ない）ので叩かない
  if (isOutsideCampaignWindow(Date.now())) return empty;
  try {
    const q = encodeURIComponent(declaredPlan());
    const r = await fetch(`/api/campaign.json?plan=${q}`, { credentials: 'same-origin' });
    if (!r.ok) return empty;
    const j = await r.json();
    return j && Array.isArray(j.offers) ? j : empty;
  } catch { return empty; }
}
