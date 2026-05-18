// 予想 JSON から「本日メインレースの targetRace + featuredHorse」を抽出する純粋関数。
// admin-newsletter-simple.astro の SSR で import.meta.glob した結果を渡して呼ぶ。
//
// 仕様:
//   - 入力 predictionsByFile: { '<filename>': <parsed-json>, ... }
//     - filename 例: '2026-05-19-ooi.json'
//     - 中身: { eventInfo: { date, venue, totalRaces }, predictions: [{ raceInfo, horses, bettingLines }] }
//   - 入力 today: 'YYYY-MM-DD'
//   - 出力:
//     - 該当日のファイルが無い → null
//     - 該当日のファイルはあるがメインレースが取れない → null
//     - メインレースは取れるが horse が取れない → { targetRace, featuredHorse: null }
//     - 全て取れる → { targetRace, featuredHorse: { name, number, role } }
//
// featuredHorse 抽出ルール（優先順）:
//   1. role === '本命' の馬 → { name, number, role: '本命' }
//   2. fallback: pt 最大の馬 → { name, number, role: '注目馬' }
//   3. horseName / horseNumber が無い → null（仮データで埋めない）

import { getMainRaceNumber } from '../../utils/mainRaceBetting.js';

/**
 * @param {Record<string, any>} predictionsByFile - filename → parsed JSON
 * @param {string} today - 'YYYY-MM-DD'
 * @returns {null | {
 *   targetRace: { raceId: string, venue: string, raceNumber: number, raceName: string, postTime: string, distance?: number, horseCount?: number },
 *   featuredHorse: null | { name: string, number: number | string, role: '本命' | '注目馬' },
 *   source: { date: string, venue: string, totalRaces: number, filename: string },
 * }}
 */
export function buildTodayMainRaceMeta(predictionsByFile, today) {
  if (!predictionsByFile || typeof predictionsByFile !== 'object') return null;
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;

  // 該当日のファイル候補（複数会場同日開催も想定して全件拾うが、最初の1件を採用）
  const candidates = [];
  for (const [key, data] of Object.entries(predictionsByFile)) {
    if (!data || typeof data !== 'object') continue;
    const basename = key.split('/').pop() || key;
    // ファイル名先頭が today と一致 OR eventInfo.date === today
    const eventDate = typeof data.eventInfo?.date === 'string' ? data.eventInfo.date : null;
    const filenameMatches = basename.startsWith(today + '-');
    if (filenameMatches || eventDate === today) {
      candidates.push({ filename: basename, data });
    }
  }
  if (candidates.length === 0) return null;

  // 最初の会場を採用（複数会場ある場合はファイル名 ASCII 順に並ぶ）
  candidates.sort((a, b) => a.filename.localeCompare(b.filename));
  const { filename, data } = candidates[0];

  const eventInfo = data.eventInfo || {};
  const totalRaces = Number(eventInfo.totalRaces);
  if (!Number.isFinite(totalRaces) || totalRaces <= 0) return null;

  const mainRaceNumber = getMainRaceNumber(totalRaces);
  const predictions = Array.isArray(data.predictions) ? data.predictions : [];
  const mainPrediction = predictions.find(
    (p) => Number(p?.raceInfo?.raceNumber) === Number(mainRaceNumber)
  );
  if (!mainPrediction || !mainPrediction.raceInfo) return null;

  const ri = mainPrediction.raceInfo;
  const targetRace = {
    raceId: `${today}-${eventInfo.venue || ri.venue || 'unknown'}-${mainRaceNumber}R`,
    venue: String(ri.venue || eventInfo.venue || ''),
    raceNumber: Number(ri.raceNumber || mainRaceNumber),
    raceName: String(ri.raceName || 'メインレース'),
    postTime: String(ri.startTime || ri.postTime || ''),
  };
  if (ri.distance != null) targetRace.distance = Number(ri.distance);
  if (ri.horseCount != null) targetRace.horseCount = Number(ri.horseCount);

  const featuredHorse = pickFeaturedHorse(mainPrediction.horses);

  return {
    targetRace,
    featuredHorse,
    source: {
      date: today,
      venue: String(eventInfo.venue || ri.venue || ''),
      totalRaces,
      filename,
    },
  };
}

/**
 * horses 配列から featuredHorse を選ぶ純粋関数。
 *
 * @param {Array} horses
 * @returns {null | { name: string, number: number | string, role: '本命' | '注目馬' }}
 */
export function pickFeaturedHorse(horses) {
  if (!Array.isArray(horses) || horses.length === 0) return null;

  const getName = (h) => (typeof h?.horseName === 'string' ? h.horseName.trim() : '');
  const getNumber = (h) => {
    const n = h?.horseNumber;
    return n != null && n !== '' ? n : null;
  };

  // 1. role === '本命' の馬
  const honmei = horses.find((h) => h?.role === '本命' && getName(h));
  if (honmei) {
    const num = getNumber(honmei);
    return {
      name: getName(honmei),
      number: num != null ? num : '',
      role: '本命',
    };
  }

  // 2. fallback: pt 最大の馬
  let topPt = -Infinity;
  let topHorse = null;
  for (const h of horses) {
    const name = getName(h);
    if (!name) continue;
    const pt = Number(h?.pt);
    if (!Number.isFinite(pt)) continue;
    if (pt > topPt) {
      topPt = pt;
      topHorse = h;
    }
  }
  if (topHorse) {
    const num = getNumber(topHorse);
    return {
      name: getName(topHorse),
      number: num != null ? num : '',
      role: '注目馬',
    };
  }

  // 3. 馬名が取れない / pt が取れない → null（仮データで埋めない）
  return null;
}
