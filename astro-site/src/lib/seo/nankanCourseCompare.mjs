/**
 * nankanCourseCompare.mjs — 南関4場の横断比較ページ（/course/compare/）のデータ
 *
 * 値はすべて各コース記事（src/pages/blog/course/<venue>-<distance>m.astro）の表から写したもの。
 * 記事の表と食い違わないことを nankanCourseCompare.test.mjs が確かめる（記事を直したらここも直す）。
 *
 * - favorite: 記事の人気別成績表の「1番人気」行（勝率・連対率・複勝率、%）
 * - bestGate: 記事の馬番別成績表のうち、出走数 30 以上の行で勝率が最も高い馬番
 * - 馬番別の表で出走数 30 以上の行が無い距離は「その他の距離」として記事へのリンクだけを載せる
 */

export const VENUES = [
  { id: 'ooi', name: '大井', direction: '右回り（1650m は左回り）', straight: 386, note: '南関東4場で最も長い直線' },
  { id: 'kawasaki', name: '川崎', direction: '左回り', straight: 300, note: '1周1,200mの小回りコース' },
  { id: 'funabashi', name: '船橋', direction: '左回り', straight: 308, note: '南関東4場で2番目に長い直線' },
  { id: 'urawa', name: '浦和', direction: '左回り', straight: 220, note: '南関東4場で最も短い直線' },
];

export const COURSES = [
  { venue: 'ooi', distance: 1200, favorite: { win: 40.9, top2: 61.5, top3: 73.5 }, bestGate: { gate: 16, win: 13.6, starts: 59 } },
  { venue: 'ooi', distance: 1400, favorite: { win: 49.8, top2: 68.7, top3: 81.5 }, bestGate: { gate: 5, win: 11.1, starts: 225 } },
  { venue: 'ooi', distance: 1600, favorite: { win: 42.2, top2: 56.3, top3: 70.2 }, bestGate: { gate: 4, win: 12.5, starts: 312 } },
  { venue: 'ooi', distance: 1800, favorite: { win: 45.9, top2: 63.5, top3: 79.7 }, bestGate: { gate: 12, win: 20.6, starts: 34 } },
  { venue: 'kawasaki', distance: 900, favorite: { win: 47.3, top2: 69.3, top3: 80.0 }, bestGate: { gate: 4, win: 14.1, starts: 149 } },
  { venue: 'kawasaki', distance: 1400, favorite: { win: 42.5, top2: 65.6, top3: 76.0 }, bestGate: { gate: 3, win: 13.7, starts: 307 } },
  { venue: 'kawasaki', distance: 1500, favorite: { win: 42.0, top2: 59.2, top3: 71.6 }, bestGate: { gate: 7, win: 15.9, starts: 164 } },
  { venue: 'kawasaki', distance: 1600, favorite: { win: 41.9, top2: 61.3, top3: 72.6 }, bestGate: { gate: 1, win: 16.9, starts: 65 } },
  { venue: 'kawasaki', distance: 2000, favorite: { win: 40.9, top2: 52.3, top3: 59.1 }, bestGate: { gate: 3, win: 19.1, starts: 47 } },
  { venue: 'funabashi', distance: 1000, favorite: { win: 46.6, top2: 67.2, top3: 81.0 }, bestGate: { gate: 5, win: 17.5, starts: 57 } },
  { venue: 'funabashi', distance: 1200, favorite: { win: 47.6, top2: 65.6, top3: 75.9 }, bestGate: { gate: 9, win: 12.2, starts: 303 } },
  { venue: 'funabashi', distance: 1500, favorite: { win: 38.6, top2: 62.9, top3: 75.8 }, bestGate: { gate: 11, win: 15.4, starts: 78 } },
  { venue: 'funabashi', distance: 1600, favorite: { win: 43.4, top2: 62.3, top3: 71.7 }, bestGate: { gate: 11, win: 15.1, starts: 59 } },
  { venue: 'funabashi', distance: 1800, favorite: { win: 46.3, top2: 70.7, top3: 73.2 }, bestGate: { gate: 7, win: 18.2, starts: 33 } },
  { venue: 'urawa', distance: 800, favorite: { win: 44.6, top2: 66.3, top3: 79.2 }, bestGate: { gate: 12, win: 17.1, starts: 41 } },
  { venue: 'urawa', distance: 1500, favorite: { win: 40.7, top2: 62.3, top3: 76.6 }, bestGate: { gate: 8, win: 12.5, starts: 160 } },
];

export const OTHER_COURSES = [
  { venue: 'ooi', distance: 1000 },
  { venue: 'ooi', distance: 1650 },
  { venue: 'ooi', distance: 1700 },
  { venue: 'ooi', distance: 2000 },
  { venue: 'ooi', distance: 2400 },
  { venue: 'ooi', distance: 2600 },
  { venue: 'kawasaki', distance: 2100 },
  { venue: 'funabashi', distance: 1700 },
  { venue: 'funabashi', distance: 2200 },
  { venue: 'funabashi', distance: 2400 },
  { venue: 'urawa', distance: 1300 },
  { venue: 'urawa', distance: 1400 },
  { venue: 'urawa', distance: 2000 },
];

export const courseSlug = (c) => `${c.venue}-${c.distance}m`;
export const courseUrl = (c) => `/blog/course/${courseSlug(c)}/`;
export const venueOf = (id) => VENUES.find((v) => v.id === id);

/** 1番人気の複勝率が最も高いコース（堅い順の先頭） */
export function mostReliableFavorite(courses = COURSES) {
  return [...courses].sort((a, b) => b.favorite.top3 - a.favorite.top3 || b.favorite.win - a.favorite.win)[0];
}

/** 1番人気の勝率が最も低いコース（2番人気以下が勝ちやすい） */
export function leastReliableFavorite(courses = COURSES) {
  return [...courses].sort((a, b) => a.favorite.win - b.favorite.win || a.favorite.top3 - b.favorite.top3)[0];
}

/** 勝率が最も高い馬番を持つコース */
export function strongestGate(courses = COURSES) {
  return [...courses].sort((a, b) => b.bestGate.win - a.bestGate.win)[0];
}

/** 競馬場ごとの距離（短い順・記事のある全距離） */
export function distancesByVenue(venueId) {
  return [...COURSES, ...OTHER_COURSES]
    .filter((c) => c.venue === venueId)
    .sort((a, b) => a.distance - b.distance);
}

export const fmt = (n) => n.toFixed(1);
