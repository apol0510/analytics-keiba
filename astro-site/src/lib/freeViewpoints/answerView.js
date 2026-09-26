/**
 * answerView.js — `/free/` の「今日の無料予想」（答えを先に見せる部分）を組み立てる（純粋・I/O なし）。
 *
 * 2026-09-27 MK 確定（docs/decisions.md）:
 *   最初に見せるのは分析方法ではなく「今日の予想結果・注目馬」。
 *
 * ⚠️ 入力は loadRaceViewpoints.js の view（horseRows は公開 DTO 由来）だけ。
 *    使うのは headlineMark / headlineKind / 馬番 / 馬名 / 騎手 / 前走着順（公開事実）に限る。
 *    有料データを読むモジュール（予想ロジック・買い目・指数）を import しない。
 */
import { getMainRaceNumber } from '../race-config.js';

// ◎ → ○ → ▲ → △ の順（公開 DTO が付ける headlineKind）
const KIND_ORDER = { main: 0, sub: 1, tana: 2, ren: 3 };

/**
 * 1 レースの印（上位 4 頭ぶん）を ◎○▲△ の順で返す。
 * @param {Array} horseRows
 */
export function headlineMarksOf(horseRows) {
  return (Array.isArray(horseRows) ? horseRows : [])
    .filter((h) => h && h.isHeadline && h.headlineMark && h.headlineKind in KIND_ORDER)
    .slice()
    .sort((a, b) => KIND_ORDER[a.headlineKind] - KIND_ORDER[b.headlineKind])
    .map((h) => ({ mark: h.headlineMark, kind: h.headlineKind, number: h.number, name: h.name || '', jockey: h.jockey || null }));
}

/**
 * 会場のメインレース（12R→11R / 10R→9R / 8R→7R。その番号が無ければ最終レース）。
 * @param {Array} races
 */
export function pickMainRaceOf(races) {
  const list = Array.isArray(races) ? races.filter(Boolean) : [];
  if (list.length === 0) return null;
  const target = getMainRaceNumber(list.length);
  return list.find((r) => Number(r.raceNumber) === target) || list[list.length - 1];
}

/**
 * ◎ のごく短い理由。前走 1〜3 着のときだけ出す（公開事実。盛らない・無ければ null）。
 * @param {object|undefined} row ◎ の horseRow
 */
export function shortReasonOf(row) {
  const f = Number(row?.prev?.finish);
  if (!Number.isInteger(f) || f < 1 || f > 3) return null;
  return `前走${f}着`;
}

// 競走名が無いレースには「第11レース」のような仮名が入る。レース番号と重複するので出さない。
const cleanRaceName = (name) => {
  const n = String(name || '').trim();
  return /^第\s*\d+\s*(レース|R)$/.test(n) ? '' : n;
};

/**
 * 各会場のメインレースぶんの「今日の無料予想」。◎ が無い会場は出さない。
 * @param {{venues?: Array}} view
 */
export function buildAnswerPicks(view) {
  return (Array.isArray(view?.venues) ? view.venues : []).map((venue) => {
    const race = pickMainRaceOf(venue?.races);
    if (!race) return null;
    const marks = headlineMarksOf(race.horseRows);
    if (!marks.some((m) => m.kind === 'main')) return null;
    const mainRow = (race.horseRows || []).find((h) => h?.headlineKind === 'main');
    return {
      venue: venue.venue || '',
      raceNumber: Number(race.raceNumber) || null,
      raceName: cleanRaceName(race.raceName),
      startTime: race.startTime || null,
      marks,
      reason: shortReasonOf(mainRow),
    };
  }).filter(Boolean);
}

export default { headlineMarksOf, pickMainRaceOf, shortReasonOf, buildAnswerPicks };
