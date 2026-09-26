/**
 * freePreviewFirstView.js — `/free-prediction/{jra,nankan}` のファーストビュー用データ（純粋・I/O なし）。
 *
 * 2026-09-27 MK 確定（docs/decisions.md）:
 *   ページ上部を「結論・注目馬 → 短い理由 → 無料登録 CTA → 詳しい分析」の順にする。
 *
 * ⚠️ 公開範囲は広げない。
 *   - 馬の情報は必ず buildFreePublicRows()（公開 DTO）を通してから使う。
 *   - 「短い理由」は公開事実（前走着順・近走の 3 着以内回数・騎手）だけから作る。
 *   - pt / AI総合指数 / 役割 / 特徴量 / 買い目は材料にも戻り値にも入れない。
 *     戻り値に `_horse`（生データ参照）を残さないこと。
 */
import { buildFreePublicRows } from './freePublicView.js';
import { getMainRaceNumber } from '../utils/mainRaceBetting.js';

const toRaceNum = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 会場のレース一覧からメインレースを 1 つ選ぶ（getMainRaceNumber と同じ判定）。
 * @param {object[]} races
 * @param {(race:object)=>any} getNumber レース番号を返す関数（'11R' / 11 どちらでもよい）
 */
export function pickMainRace(races, getNumber) {
  const list = Array.isArray(races) ? races.filter(Boolean) : [];
  if (list.length === 0) return null;
  const flagged = list.find((r) => r.isMainRace === true);
  if (flagged) return flagged;
  const target = getMainRaceNumber(list.length);
  return list.find((r) => toRaceNum(getNumber(r)) === target) || list[list.length - 1];
}

// 競走名が無いレースは「第11レース」のような仮名が入る。レース番号と重複するので出さない。
const cleanRaceName = (name) => {
  const n = String(name || '').trim();
  return /^第\s*\d+\s*(レース|R)$/.test(n) ? '' : n;
};

const finishOf = (r) => {
  if (!r || r.finishStatus) return null;
  const n = Number(r.rank ?? r.finish);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 公開事実だけから「注目ポイント」を最大 2 つ作る。良い材料が無ければ空配列。
 * @param {object[]} recentLatestFirst 過去走（新しい順）
 */
export function buildReasons(recentLatestFirst) {
  const recent = (Array.isArray(recentLatestFirst) ? recentLatestFirst : []).slice(0, 5);
  const reasons = [];
  const last = finishOf(recent[0]);
  if (last != null && last <= 3) reasons.push(`前走${last}着`);
  const ranked = recent.map(finishOf).filter((n) => n != null);
  if (ranked.length >= 2) {
    const top3 = ranked.filter((n) => n <= 3).length;
    if (top3 >= 2) reasons.push(`近${ranked.length}走で3着以内${top3}回`);
  }
  return reasons;
}

/**
 * 1 レースぶんの注目馬カードを作る。◎ が無ければ null（何も出さない）。
 * @param {object} p
 * @param {string} p.venue
 * @param {number|string} p.raceNumber
 * @param {string} [p.raceName]
 * @param {object[]} p.horses 正規化済みの生データ（ここで公開 DTO へ落とす）
 * @param {(h:object)=>object[]} [p.resolveRecent] 過去走（公開事実）
 * @param {'latest-first'|'oldest-first'} [p.recentOrder]
 */
export function buildFirstViewPick({ venue, raceNumber, raceName, horses, resolveRecent, recentOrder = 'latest-first' }) {
  const rows = buildFreePublicRows(horses, { resolveRecent });
  const honmei = rows.find((r) => r.headlineKind === 'main');
  if (!honmei) return null;
  const recent = recentOrder === 'oldest-first' ? honmei.recent.slice().reverse() : honmei.recent;
  const reasons = buildReasons(recent);
  const headcount = rows.length;
  return {
    venue: venue || '',
    raceNumber: toRaceNum(raceNumber),
    raceName: cleanRaceName(raceName),
    headcount,
    honmei: { number: honmei.number, name: honmei.name, jockey: honmei.jockey || null },
    reasons: reasons.length > 0 ? reasons : [`出走${headcount}頭からAIが本命に選んだ馬`],
    others: rows
      .filter((r) => r.isHeadline && r.headlineKind !== 'main')
      .map((r) => ({ mark: r.headlineMark, number: r.number, name: r.name })),
  };
}

export default { pickMainRace, buildReasons, buildFirstViewPick };
