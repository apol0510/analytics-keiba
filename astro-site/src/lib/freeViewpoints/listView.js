/**
 * listView.js — `/free/` の全レース予想一覧（初期表示）用の小さな純粋関数（I/O なし）。
 *
 * 2026-09-27 MK 確定: 初期表示は「全レースの予想一覧」。各行は
 *   発走時刻 / R / レース名 / [メイン] / ◎馬番+馬名 / ○▲△ 馬番 / 詳しく
 *
 * ⚠️ 入力は loadRaceViewpoints.js の horseRows（公開 DTO 由来）だけ。
 *    使うのは headlineMark / headlineKind / 馬番 / 馬名に限る。
 *    有料データを読むモジュール（予想ロジック・買い目・指数）を import しない。
 */
import { getMainRaceNumber } from '../race-config.js';

// ◎ → ○ → ▲ → △ の順（公開 DTO が付ける headlineKind）
const KIND_ORDER = { main: 0, sub: 1, tana: 2, ren: 3 };

/**
 * 1 レースの印（上位 4 頭ぶん）を ◎○▲△ の順で返す。印の無い馬は含めない。
 * @param {Array} horseRows
 * @returns {Array<{mark:string, kind:string, number:number, name:string}>}
 */
export function headlineMarksOf(horseRows) {
  return (Array.isArray(horseRows) ? horseRows : [])
    .filter((h) => h && h.isHeadline && h.headlineMark && h.headlineKind in KIND_ORDER)
    .slice()
    .sort((a, b) => KIND_ORDER[a.headlineKind] - KIND_ORDER[b.headlineKind])
    .map((h) => ({ mark: h.headlineMark, kind: h.headlineKind, number: h.number, name: h.name || '' }));
}

/**
 * そのレースが会場のメインレースか（12R→11R / 10R→9R / 8R→7R。その番号が無ければ最終レース）。
 * 複数会場の同日開催は会場ごとに数える（呼び出し側が会場のレース配列を渡す）。
 * @param {Array} races 同じ会場のレース
 * @param {object} race
 */
export function isMainRaceIn(races, race) {
  const list = Array.isArray(races) ? races.filter(Boolean) : [];
  if (list.length === 0 || !race) return false;
  const target = getMainRaceNumber(list.length);
  const main = list.find((r) => Number(r.raceNumber) === target) || list[list.length - 1];
  return main === race;
}

export default { headlineMarksOf, isMainRaceIn };
