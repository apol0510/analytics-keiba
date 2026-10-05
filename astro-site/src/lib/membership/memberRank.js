/**
 * memberRank.js — 会員ランク（会員歴＝ご登録からの月数で決まる）・純粋関数
 *
 * 正本: docs/MEMBER_RANK.md（2026-10-05 MK 確定）
 *   - ランクは「会員歴（月数）」だけで決める。取得数・購入額では上げない（たくさん買うほど得をする設計にしない）
 *   - 会員歴の起点は Customers の `登録日`。`PaidAt` は入金確認のたびに上書きされ継続の起点にならないため使わない
 *   - 対象は有料の権利を今持っている会員だけ（無料会員にはランクを出さない）
 *   - 月数は JST の暦で数える（例: 1/15 登録 → 2/14 は 0 か月・2/15 で 1 か月。月末起点 1/31 → 2/28 で 1 か月）
 *   - 起点が読めないときは null（推測でランクを付けない）
 */
const JST_MS = 9 * 3600 * 1000;

/** ランク表（minMonths 以上で到達）。色は docs/GLASS_DESIGN_RULES.md の役割（着順色・Premium の紫）から選ぶ */
export const RANKS = Object.freeze([
  Object.freeze({ key: 'regular', label: 'レギュラー', minMonths: 0, tone: 'blue' }),
  Object.freeze({ key: 'bronze', label: 'ブロンズ', minMonths: 3, tone: 'bronze' }),
  Object.freeze({ key: 'silver', label: 'シルバー', minMonths: 6, tone: 'silver' }),
  Object.freeze({ key: 'gold', label: 'ゴールド', minMonths: 12, tone: 'gold' }),
  Object.freeze({ key: 'platinum', label: 'プラチナ', minMonths: 24, tone: 'violet' }),
]);

function jstParts(ms) {
  const d = new Date(ms + JST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** 登録日（'YYYY-MM-DD' or ISO）を JST の暦日として読む。読めなければ null */
function parseRegistered(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return { y: Number(ymd[1]), m: Number(ymd[2]), d: Number(ymd[3]) };
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? jstParts(ms) : null;
}

/** 起点から now までの満月数（JST 暦）。未来日は null */
export function tenureMonths(registeredAt, nowMs = Date.now()) {
  const a = parseRegistered(registeredAt);
  if (!a) return null;
  const b = jstParts(nowMs);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) {
    // 月末起点（1/31 等）は、その月の末日に達したら 1 か月とみなす
    const lastDay = new Date(Date.UTC(b.y, b.m, 0)).getUTCDate();
    if (!(a.d > lastDay && b.d === lastDay)) months -= 1;
  }
  return months < 0 ? null : months;
}

/**
 * @returns {null | { months, rank, next, monthsToNext, progress, since }}
 *   progress: 0〜1（今のランク内での進み具合。最上位は 1）
 */
export function memberRank({ registeredAt, nowMs = Date.now() } = {}) {
  const months = tenureMonths(registeredAt, nowMs);
  if (months == null) return null;
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (months >= RANKS[i].minMonths) idx = i;
  const rank = RANKS[idx];
  const next = RANKS[idx + 1] || null;
  const span = next ? next.minMonths - rank.minMonths : 1;
  return {
    months,
    rank,
    next,
    monthsToNext: next ? next.minMonths - months : 0,
    progress: next ? Math.min(1, Math.max(0, (months - rank.minMonths) / span)) : 1,
    since: parseRegistered(registeredAt),
  };
}
