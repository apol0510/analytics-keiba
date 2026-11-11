/**
 * premiumSample.js — 公開する「Premium 画面の見本」のレースを決める（純粋・2026-11-11 MK 指示）
 *
 * MK 指示: 終了済みレースの Premium 画面を見本として 1 件公開する。**的中したレースだけを選んで強調しない**。
 *
 * 選び方（固定・結果を見ない）:
 *   今日（JST）より前で予想がある**いちばん新しい開催日**の、最初の会場の**メインレース**。
 *   結果（的中・不的中・払戻）はこの関数に渡さないので、選択に使えない。画面にも結果は出さない。
 *   `/results-showcase/`（直近の開催日のメインレースの買い目）と同じ日・同じレース。見本は実際の Premium 画面そのもの（抑え等も出す）。
 *
 * 当日のレースは出さない（発走前の有料予想を無料で見せない）。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** JST の今日（YYYY-MM-DD）*/
export function jstToday(nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600e3).toISOString().slice(0, 10);
}

/**
 * @param {{ cat: 'jra'|'nankan', todayJst: string, dates: string[], loadDay: (cat, date) => Array<{venueName, venueId, totalRaces, races}>, mainRaceNumber: (total:number) => number }} p
 * @returns {{ date, venue, race } | null}
 */
export function pickSampleRace({ cat, todayJst, dates, loadDay, mainRaceNumber }) {
  if (!DATE_RE.test(String(todayJst))) return null;
  const past = (Array.isArray(dates) ? dates : []).filter((d) => DATE_RE.test(d) && d < todayJst).sort().reverse();
  for (const date of past) {
    const venues = loadDay(cat, date) || [];
    for (const venue of venues) {
      const main = mainRaceNumber(Number(venue.totalRaces) || 12);
      const race = (venue.races || []).find((r) => Number(r?.raceInfo?.raceNumber) === main);
      if (race) return { date, venue, race };
    }
  }
  return null;
}
