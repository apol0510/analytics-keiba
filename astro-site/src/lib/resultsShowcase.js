// resultsShowcase.js
// ─────────────────────────────────────────────────────────────
// 「有料実績ショーケース」の単一データ源。
//
// 目的:
//   無料ユーザーに「有料版で実際に提供した買い目結果」を毎日見せ、
//   有料への導線にする軽量ページ用のビューを組み立てる。
//
// 方針（2026-07-09 集約 / ユーザー要望）:
//   - 新しいデータは作らない。既存の結果アーカイブ配列
//     (archiveResults.json / archiveResultsJra.json) の【最新日 = index 0】
//     だけを読む。よって importResults*.js の自動取込にそのまま乗り、
//     毎日「上書き」表示される（アーカイブ本体とは別ページ・データ二重管理なし）。
//   - メインレースのみ買い目（本命 → 相手5頭 = 5点）を公開。抑えは伏せる。
//   - それ以外のレースは「的中したかどうか」(✅/✗) だけ。買い目・払戻は出さない。
//   - メイン判定は会場別レース数 → getMainRaceNumber() の正道
//     （JRA は 1日3会場×12R など複数会場同日開催があるため会場別に数える）。
//
// 単一源の遵守:
//   - メイン判定は utils/mainRaceBetting.js の getMainRaceNumber を再利用。
//   - 抑え除去は premium ページと同一正規表現を関数化して共有。
// ─────────────────────────────────────────────────────────────

import { getMainRaceNumber } from '../utils/mainRaceBetting.js';

/**
 * bettingLine 文字列から表示用の「抑え」括弧を除去する。
 * premium-prediction/{jra,nankan}.astro の stripOsaeForDisplay と同一仕様。
 */
export function stripOsae(line) {
  return String(line ?? '').replace(/[(（]抑え[^)）]*[)）]/g, '').trim();
}

/**
 * メインレースの bettingLine（例 "1↔2.3.6.8.9(抑え4.5)"）を
 * { honmei: "1", partners: ["2","3","6","8","9"] } に分解する。
 * ↔ / → / - のいずれの区切りも解釈する（checkUmatanHit と同じ寛容さ）。
 * 分解できない場合は null。
 */
export function parseMainLine(line) {
  const stripped = stripOsae(line);
  if (!stripped) return null;
  const sep = stripped.includes('↔') ? '↔' : stripped.includes('→') ? '→' : '-';
  const idx = stripped.indexOf(sep);
  if (idx < 0) return null;
  const honmei = stripped.slice(0, idx).trim();
  const partners = stripped
    .slice(idx + sep.length)
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!honmei || partners.length === 0) return null;
  return { honmei, partners };
}

function firstOrNull(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

/**
 * 1レース分のアーカイブレコードから、メインレース表示用オブジェクトを組み立てる。
 */
function buildMainRace(race) {
  const parsed = parseMainLine(firstOrNull(race?.bettingLines));
  if (!parsed) return null;
  const payout = Number(race?.umatan?.payout);
  return {
    raceNumber: race.raceNumber,
    raceName: race.displayName || race.raceName || '',
    venue: race.venue,
    honmei: parsed.honmei,
    partners: parsed.partners,
    betPoints: Number(race?.betPoints) || parsed.partners.length,
    isHit: !!race?.isHit,
    combination: race?.umatan?.combination ?? null,
    payout: Number.isFinite(payout) && payout > 0 ? payout : null,
    result: race?.result ?? null,
  };
}

/**
 * アーカイブ1日分エントリ → ショーケース1日ビュー。
 * 会場別にグルーピングし、各会場のメインレース（会場別レース数で判定）と
 * 全レースの ✅/✗ を返す。
 */
export function buildShowcaseDay(dayEntry) {
  if (!dayEntry || !Array.isArray(dayEntry.races)) return null;

  const venues =
    Array.isArray(dayEntry.venues) && dayEntry.venues.length > 0
      ? dayEntry.venues
      : dayEntry.venue
        ? [dayEntry.venue]
        : [];

  // 会場別レース数（メイン判定に使う）
  const racesByVenue = new Map();
  for (const r of dayEntry.races) {
    const v = r.venue || '';
    if (!racesByVenue.has(v)) racesByVenue.set(v, []);
    racesByVenue.get(v).push(r);
  }

  // venues の順を優先しつつ、venues に無い会場も拾う
  const venueOrder = [
    ...venues.filter((v) => racesByVenue.has(v)),
    ...[...racesByVenue.keys()].filter((v) => !venues.includes(v)),
  ];

  const venueGroups = venueOrder.map((venue) => {
    const races = [...racesByVenue.get(venue)].sort(
      (a, b) => Number(a.raceNumber) - Number(b.raceNumber)
    );
    const mainNo = getMainRaceNumber(races.length);
    const mainRaceRecord = races.find((r) => Number(r.raceNumber) === mainNo);
    return {
      venue,
      totalRaces: races.length,
      mainRace: mainRaceRecord ? buildMainRace(mainRaceRecord) : null,
      races: races.map((r) => ({
        raceNumber: r.raceNumber,
        isHit: !!r.isHit,
        isMain: Number(r.raceNumber) === mainNo,
      })),
    };
  });

  return {
    date: dayEntry.date,
    venues,
    venueLabel: venues.join('・') || dayEntry.venue || '',
    totalRaces: Number(dayEntry.totalRaces) || dayEntry.races.length,
    hitRaces: Number(dayEntry.hitRaces) || dayEntry.races.filter((r) => r.isHit).length,
    hitRate: dayEntry.hitRate ?? null,
    recoveryRate: dayEntry.recoveryRate ?? dayEntry.returnRate ?? null,
    totalPayout: Number(dayEntry.totalPayout) || 0,
    verifiedAt: dayEntry.verifiedAt ?? null,
    venueGroups,
  };
}

/**
 * アーカイブ配列（日付降順・index 0 が最新日）から最新日のショーケースビューを返す。
 * データが無ければ null。
 */
export function buildLatestShowcase(archiveArray) {
  if (!Array.isArray(archiveArray) || archiveArray.length === 0) return null;
  return buildShowcaseDay(archiveArray[0]);
}
