/**
 * dailyCampaignCard.js — 無料予想の「特別価格」案内カード（1 日 1 回）の判定（純粋・I/O なし・2026-11-11 MK 指示）
 *
 * 表示仕様（MK 指示）:
 *   - 1 ユーザー 1 日最大 1 回（日付は JST 0 時で切り替え）。閉じたらその日は出さない。移動・再読み込みでも繰り返さない。
 *   - 開いた瞬間には出さない（閲覧開始 15〜20 秒後、または一定量を見た段階 → 画面側の発火条件）。
 *   - 有料会員・決済中・購入直後には出さない。スマホでは閲覧を妨げない小型カード。
 *   - 閲覧内容に合わせる: 中央だけ → 中央版／南関だけ → 南関版／両方 → 中央＋南関。年額も選べる（カード内の 1 行）。
 *   - 効果を測るため、一定割合を非表示群（holdout）にする。群は端末ごとに固定。
 *
 * 状態はブラウザの localStorage だけ（表示の都合・会員の権利や価格には一切使わない）。
 * 価格は subscriptionCampaign.js の値をサーバー側で埋め込む（ここでは扱わない）。
 */

export const CARD_STATE_KEY = 'ak:cmp-card:v1';
export const GROUP_KEY = 'ak:cmp-group:v1';
export const VENUE_DAYS_KEY = 'ak:free-venue-days';
/** 非表示群の割合（比較用）*/
export const HOLDOUT_RATE = 0.1;
/** 閲覧開始から出すまで（MK: 15〜20 秒）*/
export const DELAY_MS = 18_000;
/** 一定量を見た段階（ページの縦の割合・開いたレース詳細の数）*/
export const SCROLL_RATIO = 0.5;
export const OPENED_DETAILS = 2;
/** 閲覧傾向の記録日数 */
export const VENUE_KEEP_DAYS = 14;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VENUES = ['jra', 'nankan'];

export function jstDay(nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600e3).toISOString().slice(0, 10);
}

function safeParse(raw) {
  try { return JSON.parse(raw || 'null'); } catch { return null; }
}

/** 有料会員か（user-plan の表示用キャッシュ。期限切れは有料として扱わない）*/
export function isPaidViewer(userPlanRaw, nowMs = Date.now()) {
  const up = typeof userPlanRaw === 'string' ? safeParse(userPlanRaw) : userPlanRaw;
  if (!up || typeof up !== 'object') return false;
  const plan = String(up.plan || '').trim().toLowerCase();
  if (!plan || plan === 'free') return false;
  if (up.isExpired === true) return false;
  const vu = Date.parse(String(up.validUntil || ''));
  if (Number.isFinite(vu) && vu < nowMs) return false;
  return true;
}

/** 端末の比較群（初回だけ乱数で決め、以後は固定）*/
export function assignGroup(existing, rand = Math.random()) {
  if (existing === 'show' || existing === 'holdout') return existing;
  return rand < HOLDOUT_RATE ? 'holdout' : 'show';
}

/**
 * 今日、案内カード（または非表示群の記録）を出してよいか。
 * @returns {{ show: boolean, reason: string }}
 */
export function decideCampaignCard({ nowMs = Date.now(), stateRaw, userPlanRaw, inCheckout = false, campaignOpen = true }) {
  if (!campaignOpen) return { show: false, reason: 'closed' };
  if (inCheckout) return { show: false, reason: 'checkout' };
  if (isPaidViewer(userPlanRaw, nowMs)) return { show: false, reason: 'paid' };
  const st = typeof stateRaw === 'string' ? safeParse(stateRaw) : stateRaw;
  if (st && st.day === jstDay(nowMs)) return { show: false, reason: 'already_today' };
  return { show: true, reason: 'ok' };
}

/** 今日表示した（閉じた）記録。日付が変われば次の日にまた 1 回 */
export function markShown(nowMs = Date.now(), { dismissed = false } = {}) {
  return JSON.stringify({ day: jstDay(nowMs), dismissed: Boolean(dismissed) });
}

/** 無料予想の会場別の閲覧日（直近 VENUE_KEEP_DAYS 日・重複なし）*/
export function recordVenueDay(raw, venue, nowMs = Date.now()) {
  const cur = (typeof raw === 'string' ? safeParse(raw) : raw) || {};
  const today = jstDay(nowMs);
  const cutoff = jstDay(nowMs - (VENUE_KEEP_DAYS - 1) * 864e5);
  const out = {};
  for (const v of VENUES) {
    const days = (Array.isArray(cur[v]) ? cur[v] : []).filter((d) => DAY_RE.test(d) && d >= cutoff);
    if (v === venue && !days.includes(today)) days.push(today);
    out[v] = days.sort().slice(-VENUE_KEEP_DAYS);
  }
  return out;
}

/**
 * 案内する主力プラン（1 件）。
 * 両方の会場を直近に見ている → 中央＋南関／いま見ている会場 → その会場の版／記録だけで分かる会場 → その版／不明 → 中央＋南関
 */
export function pickCampaignPlan({ pageVenue, venueDays }) {
  const d = venueDays || {};
  const seen = (v) => Array.isArray(d[v]) && d[v].length > 0;
  if (seen('jra') && seen('nankan')) return 'premium';
  if (pageVenue === 'jra') return 'premium-jra';
  if (pageVenue === 'nankan') return 'premium-nankan';
  if (seen('jra')) return 'premium-jra';
  if (seen('nankan')) return 'premium-nankan';
  return 'premium';
}
