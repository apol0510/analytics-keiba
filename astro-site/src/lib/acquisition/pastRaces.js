/**
 * pastRaces.js — 取得後の本文に載せる過去走（純粋）
 *
 * 2026-10-03 MK 確定: 無料ページで見られる情報を Premium で減らさない（特に過去走）。
 * 無料ページと同じ取り出し方をそのまま使う:
 *   - 中央: horseHistories 由来（recentRacesFromHistories）→ 無ければ recentRaces。新しい順に最大 5 走
 *     ＋「過去走データ」（historyForDetails から通算・勝率・連対率・3着内率・条件別）
 *   - 南関: entries 由来（recentRacesFromEntriesNankan）→ 無ければ getDisplayRecentRacesForNankan。
 *     古い順に保存されているので末尾 5 走を新しい順にする
 * 出すのは表示用の項目だけ（pt・指数・役割は入れない）。正本 docs/PREDICTION_ACQUISITION.md §2
 */
import { getDisplayRecentRacesForNankan } from '../getDisplayRecentRacesForNankan.js';
import { parseDistanceMeters, formatRecentVenue } from '../horseEnrichment.js';

const FIELDS = ['date', 'venue', 'raceName', 'distance', 'trackCondition', 'rank', 'finishStatus', 'popularity', 'headCount',
  'time', 'last3f', 'margin', 'passingOrder', 'bodyWeight', 'jockey', 'carriedWeight', 'winner'];

const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));

export function normalizeRecentRace(r, { cat } = {}) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const k of FIELDS) {
    let v = r[k];
    if (k === 'winner') v = r.winner ?? r.winnerName;
    else if (k === 'date') v = r._dateStr || r.date || r.dateStr;
    else if (k === 'distance') v = r._displayDistance || r.distance;
    else if (k === 'carriedWeight') v = r.carriedWeight ?? r.carryWeight;
    else if (k === 'headCount') v = r.headCount ?? r.entryCount;
    // 中央の racebook 由来の会場表記（例「2札8.22」）は無料ページと同じ整形をする
    else if (k === 'venue' && cat === 'jra') v = formatRecentVenue(r.venue);
    const s = str(v);
    if (s !== null) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

/** 表示する直近の過去走（新しい順・最大 5 走） */
export function recentRacesFor(horse, cat) {
  if (!horse) return [];
  let list;
  if (cat === 'jra') {
    list = Array.isArray(horse.recentRacesFromHistories) && horse.recentRacesFromHistories.length
      ? horse.recentRacesFromHistories : (Array.isArray(horse.recentRaces) ? horse.recentRaces : []);
    list = list.slice(0, 5);
  } else {
    list = Array.isArray(horse.recentRacesFromEntriesNankan) && horse.recentRacesFromEntriesNankan.length
      ? horse.recentRacesFromEntriesNankan : getDisplayRecentRacesForNankan(horse);
    list = (Array.isArray(list) ? list : []).slice(-5).reverse();
  }
  return list.map((r) => normalizeRecentRace(r, { cat })).filter(Boolean);
}

/** 中央の「過去走データ」（無料ページの過去走データと同じ集計） */
export function historyRecordFor(horse, raceInfo) {
  const hist = Array.isArray(horse?.historyForDetails) ? horse.historyForDetails : [];
  const ranked = hist.filter((r) => r && Number.isFinite(Number(r.rank)));
  if (ranked.length === 0) return null;
  const count = (arr) => ({
    n: arr.length,
    w: arr.filter((r) => Number(r.rank) === 1).length,
    p2: arr.filter((r) => Number(r.rank) === 2).length,
    p3: arr.filter((r) => Number(r.rank) === 3).length,
  });
  const all = count(ranked);
  const others = all.n - all.w - all.p2 - all.p3;
  const pct = (k) => `${Math.round((k / all.n) * 100)}%`;
  const fmt = (s) => `${s.n}戦 ${s.w}-${s.p2}-${s.p3}` + (s.n > 0 ? ` (3着内${Math.round(((s.w + s.p2 + s.p3) / s.n) * 100)}%)` : '');
  const raceDist = parseDistanceMeters(raceInfo?.distance);
  const venue = raceInfo?.venue ? String(raceInfo.venue).replace('競馬場', '') : null;
  const conds = [
    ['芝', ranked.filter((r) => r.surface === '芝')],
    ['ダート', ranked.filter((r) => r.surface === 'ダ')],
    Number.isFinite(raceDist) ? [`同距離±200m(${raceDist}m基準)`, ranked.filter((r) => Number.isFinite(Number(r.distanceMeters)) && Math.abs(Number(r.distanceMeters) - raceDist) <= 200)] : null,
    venue ? [`同会場(${venue})`, ranked.filter((r) => r.venue === venue)] : null,
  ].filter((c) => c && c[1].length > 0).map(([label, arr]) => ({ label, text: fmt(count(arr)) }));
  return {
    races: hist.length,
    record: `${all.w}-${all.p2}-${all.p3}-${others}`,
    winPct: pct(all.w),
    placePct: pct(all.w + all.p2),
    showPct: pct(all.w + all.p2 + all.p3),
    conds,
    // 無料ページの「競走成績（直近10走）」と同じ件数
    rows: hist.slice(0, 10).map((r) => normalizeRecentRace(r, { cat: 'jra-history' })).filter(Boolean),
    more: Math.max(0, hist.length - 10),
  };
}
