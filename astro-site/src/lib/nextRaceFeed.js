/**
 * nextRaceFeed.js — トップ・/free/ の「次のレース」に渡す発走予定（サーバー / ビルド専用）
 *
 * トップと /free-prediction/ は静的配信なので、ビルド時に今日以降の分をまとめて埋め、
 * 「次」はブラウザが現在時刻で選ぶ（nextRacesByCat）。ビルドが古くても過ぎたレースを次と出さない。
 * 🛑 出力は cat / venueName / raceNumber / startAt だけ（買い目・印・指数・的中を載せない）。
 */
import { buildListModel } from './acquisition/listModel.js';
import { listDates } from './acquisition/raceSource.js';
import { jstDate } from './ailab/aiLab.js';
import { jstToIso } from './freeLiveBoard.js';

/** 開催日を何日先まで埋めるか（金曜夜に土日ぶんが入る） */
const MAX_DATES = 3;

export function buildNextRaceFeed({ cats = ['jra', 'nankan'], now = Date.now(), root } = {}) {
  const today = jstDate(now);
  const feed = [];
  for (const cat of cats) {
    try {
      const dates = listDates(cat, { root }).filter((d) => d >= today).sort().slice(0, MAX_DATES);
      for (const date of dates) {
        const model = buildListModel({ cat, product: 'premium', requestedDate: date, acquisitions: [], root, now });
        for (const v of model.venues) {
          for (const item of v.races) {
            const startAt = jstToIso(date, item.listing.startTime);
            if (startAt) feed.push({ cat, venueName: v.venueName, raceNumber: item.listing.raceNumber, startAt });
          }
        }
      }
    } catch (error) {
      // 片方が読めなくてももう片方は出す（/free/ の索引と同じ片肺運転）
      console.error(`[nextRaceFeed] ${cat} build error:`, error);
    }
  }
  return feed;
}
