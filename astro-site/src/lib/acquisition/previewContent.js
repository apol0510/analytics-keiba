/**
 * previewContent.js — /free-prediction/ のプレビュー詳細に出す内容（純粋・公開してよい範囲だけ）
 *
 * 2026-10-04 MK 確定（docs/PREDICTION_ACQUISITION.md §2-4）: Preview は Premium 詳細と同じ部品・同じ構成で見せるが、
 * 有料本文は出さない。範囲は無料公開の単一源 `freePublicView.js`（buildFreePublicRows）と同じ:
 *   馬番・馬名・騎手・過去走（公開事実）・上位 4 頭の印（◎本命 ○対抗 ▲単穴 △連下最上位）
 * 入れないもの: 買い目（bettingLines）・AI 総合指数・pt・▲△以外の役割（連下/抑え/評価外の分類）・取得後の本文
 */
import { buildFreePublicRows } from '../freePublicView.js';
import { buildRaceListing } from './predictionContent.js';
import { recentRacesFor, historyRecordFor } from './pastRaces.js';

const KIND_ROLE = { main: '本命', sub: '対抗', tana: '単穴', ren: '連下最上位' };

export function buildPreviewContent({ cat, venueName, race, venueTotalRaces }) {
  const info = race?.raceInfo || {};
  const listing = buildRaceListing({ race, venueTotalRaces });
  const rows = buildFreePublicRows(Array.isArray(race?.horses) ? race.horses : [], { resolveRecent: (h) => recentRacesFor(h, cat) });
  const horses = rows.map((r) => ({
    number: r.number,
    name: String(r.name || ''),
    jockey: String(r.jockey || ''),
    // 公開の印だけ（上位 4 頭）。それ以外は null（分類を出さない）
    mark: r.headlineMark || null,
    role: r.headlineKind ? KIND_ROLE[r.headlineKind] : null,
    recent: Array.isArray(r.recent) ? r.recent : [],
    record: cat === 'jra' ? historyRecordFor(r._horse, info) : null,
  }));
  return {
    preview: true,
    product: 'premium',
    cat,
    date: String(info.date || ''),
    venueName,
    raceNumber: listing.raceNumber,
    raceName: listing.raceName,
    startTime: listing.startTime,
    distance: listing.distance,
    horseCount: listing.horseCount,
    isMainRace: listing.isMainRace,
    horses,
  };
}
