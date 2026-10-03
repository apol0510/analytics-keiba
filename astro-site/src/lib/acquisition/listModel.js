/**
 * listModel.js — 「予想を取得」一覧の表示モデル（取得前は本文を含めない）
 *
 * venues[].races[] に入れるのは buildRaceListing（出走情報）・予想キー・取得記録・（srp のときだけ）選別結果。
 * 買い目・印・指数は入れない（一覧から本文が漏れない構造にする）。
 */
import { listDates, loadDay } from './raceSource.js';
import { buildRaceListing } from './predictionContent.js';
import { buildPredictionKey } from './predictionKey.js';
import { evaluateSanrenpukuRace, rankDay } from './sanrenpukuSelection.js';

export function pickDate(requested, dates) {
  return dates.includes(requested) ? requested : (dates[0] || null);
}

export function buildListModel({ cat, product, requestedDate, acquisitions, root, now = Date.now() }) {
  const dates = listDates(cat, { root }).slice(0, 7);
  // 既定は「今日（JST）以降で最も近い日」、無ければ最新日
  const today = new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
  const upcoming = dates.filter((d) => d >= today).sort();
  const date = dates.includes(requestedDate) ? requestedDate : (upcoming[0] || dates[0] || null);
  const byKey = new Map((acquisitions || []).map((e) => [e.key, e]));
  const venues = [];
  const evaluated = [];
  if (date) {
    for (const v of loadDay(cat, date, { root })) {
      const races = [];
      for (const race of v.races) {
        const listing = buildRaceListing({ race, venueTotalRaces: v.totalRaces });
        const key = buildPredictionKey({ product, cat, date, venue: v.venueId, raceNumber: listing.raceNumber });
        if (!key) continue;
        const item = { key, listing, acquired: byKey.get(key) || null };
        if (product === 'srp') {
          const sel = evaluateSanrenpukuRace(race.horses, { horseCount: listing.horseCount, cat });
          item.selection = { grade: sel.grade, skip: sel.skip, reasons: sel.reasons };
          evaluated.push({ ...item, venueName: v.venueName, selection: { ...item.selection, score: sel.score } });
        }
        races.push(item);
      }
      venues.push({ venueName: v.venueName, venueId: v.venueId, races });
    }
  }
  return { cat, product, date, dates: dates.slice().sort(), venues, day: product === 'srp' ? rankDay(evaluated) : null };
}
