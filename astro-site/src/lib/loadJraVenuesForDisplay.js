// JRA 表示用 venue データ構築の単一源（page と fragment route で共有し同一データ・同一描画を保証）。
// 元 free-prediction/jra.astro のインライン処理をそのまま移設（選定ロジック不変）。
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { injectHorseHistoriesIntoVenues } from './loadHorseHistoriesJra.js';

export function loadJraVenuesForDisplay() {
const predictionsDir = join(process.cwd(), 'src', 'data', 'predictions', 'jra');
let predictionData = null;
let venues = [];
let isMultiVenue = false;
let error = null;

try {
  if (existsSync(predictionsDir)) {
    // 階層構造（jra/YYYY/MM/YYYY-MM-DD.json）から最新ファイルを検索
    const years = readdirSync(predictionsDir).filter(name => /^\d{4}$/.test(name));
    let latestFile = null;
    let latestPath = null;

    // 全ファイルを収集して日付でソート
    let allFiles = [];

    for (const year of years) {
      const yearPath = join(predictionsDir, year);
      const months = readdirSync(yearPath).filter(name => /^\d{2}$/.test(name));

      for (const month of months) {
        const monthPath = join(yearPath, month);
        const files = readdirSync(monthPath).filter(file => file.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(file));

        for (const file of files) {
          // ファイル名から日付を抽出（YYYY-MM-DD.json）
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
          if (dateMatch) {
            allFiles.push({
              date: dateMatch[1],
              path: join(monthPath, file),
              timestamp: new Date(dateMatch[1]).getTime()
            });
          }
        }
      }
    }

    // 日付でソート（最新が先頭）
    allFiles.sort((a, b) => b.timestamp - a.timestamp);

    if (allFiles.length > 0) {
      latestFile = allFiles[0].date + '.json';
      latestPath = allFiles[0].path;
    }

    if (latestPath) {
      const fileContent = readFileSync(latestPath, 'utf-8');
      const rawData = JSON.parse(fileContent);

      // データ構造の判定（venues配列があるか）
      if (rawData.venues && Array.isArray(rawData.venues)) {
        // 複数会場フォーマット
        isMultiVenue = true;
        venues = rawData.venues;
        predictionData = rawData;
      } else if (rawData.eventInfo && rawData.predictions) {
        // 単一会場フォーマット（従来互換）
        isMultiVenue = false;
        venues = [{
          venue: rawData.eventInfo.venue,
          eventInfo: rawData.eventInfo,
          predictions: rawData.predictions
        }];
        predictionData = rawData;
      } else {
        throw new Error('予想データのフォーマットが不正です');
      }
    } else {
      throw new Error('中央競馬の予想データがありません');
    }
  } else {
    throw new Error('中央競馬の予想データフォルダが見つかりません');
  }
} catch (err) {
  error = err.message;
}

// horseHistories 由来の表示専用注入 (失敗時は既存 recentRaces にフォールバック)
if (!error && Array.isArray(venues) && venues.length > 0) {
  try {
    const targetDate = predictionData?.date || null;
    if (targetDate) {
      injectHorseHistoriesIntoVenues(venues, targetDate, process.cwd());
    }
  } catch (_e) {
    // 表示専用フォールバック。失敗時は既存 recentRaces のまま表示。
  }
}
  return { predictionData, venues, isMultiVenue, error };
}
