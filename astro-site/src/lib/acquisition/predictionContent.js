/**
 * predictionContent.js — 1 予想（1 レース）の本文スナップショットを組み立てる（純粋）
 *
 * 取得時にこの関数の結果を保存し、閲覧はスナップショットから描画する（予想データの保持期間に依存しない）。
 * 外部由来の指数は raw のまま入れない（getHorseAiIndex＝raw−1 だけを入れる）。正本 docs/PREDICTION_ACQUISITION.md
 */
import { getMainRaceNumber, generateRaceUmatanLines, countPointsFromUmatanLine } from '../../utils/mainRaceBetting.js';
import { generateNormalSanrenpuku, generateNarrowSanrenpuku, formatSanrenpukuLine } from '../../utils/sanrenpukuBetting.js';
import { getHorseAiIndex, isOsaeCandidate, isIneligibleHorse } from '../shared-prediction-logic.js';
import { evaluateSanrenpukuRace } from './sanrenpukuSelection.js';
import { PRODUCTS } from './predictionKey.js';
import { recentRacesFor, historyRecordFor } from './pastRaces.js';
import { parseSexAge } from '../horseEnrichment.js';

/**
 * v1（2026-10-03 初版）: Premium にも三連複通常を入れていた・過去走なし
 * v2（2026-10-03 MK 確定）: Premium は馬単専用（三連複を入れない）・全馬に過去走（無料ページと同じ取り出し方）
 *   2026-10-07: 全馬に出走表の基本情報 `profile`（性齢・斤量・騎手・調教師・父。リニューアル前の Premium ページと同じ項目）。
 *   版は上げない（無い保存データは閲覧時に予想データから補う＝ /predictions/view/）
 */
export const CONTENT_VERSION = 2;

const ROLE_PRIORITY = { '対抗': 1, '単穴': 2, '連下最上位': 3, '連下': 4 };
const MAIN_ROLES = ['本命', '対抗', '単穴', '連下最上位', '連下'];
const num = (h) => (Number.isFinite(Number(h?.horseNumber ?? h?.number)) ? Number(h.horseNumber ?? h.number) : null);
const pt = (h) => (Number.isFinite(Number(h?.pt ?? h?.displayScore)) ? Number(h.pt ?? h.displayScore) : 0);
// 表示専用の抑え除去（保存文字列は変えない）。正規表現は旧 Premium ページの stripOsaeForDisplay と同一
export const stripOsaeForDisplay = (line) => String(line || '').replace(/[(（]抑え[^)）]*[)）]/g, '').trim();

/** 点数を絞った馬単: 本命軸 × 役割優先の上位 3 頭。向きは通常の 1 行目と同じ */
export function narrowUmatan(horses, normalLines) {
  const list = Array.isArray(horses) ? horses : [];
  const honmei = list.find((h) => h?.role === '本命');
  const axis = num(honmei);
  if (axis == null) return null;
  const partners = list
    .filter((h) => h && ROLE_PRIORITY[h.role] != null && num(h) != null && num(h) !== axis)
    .sort((a, b) => (ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]) || (pt(b) - pt(a)))
    .slice(0, 3)
    .map(num)
    .sort((a, b) => a - b);
  if (partners.length === 0) return null;
  const first = String((normalLines || [])[0] || '');
  const arrow = first.includes('→') ? '→' : '↔';
  const line = `${axis}${arrow}${partners.join('.')}`;
  return { line, points: countPointsFromUmatanLine(line) };
}

function sanrenpukuLine(spec) {
  return spec ? { line: formatSanrenpukuLine(spec), points: spec.points } : null;
}

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * 出走表の基本情報（表示専用）。リニューアル前の Premium ページ（2026-10-03 以前）と同じ項目・同じ書き方:
 * 性齢「2歳牡」（解釈できなければ元の値）・斤量「56kg」・騎手・調教師・父。値の無い項目は入れない。全部無ければ null。
 */
export function horseProfile(h) {
  const sa = parseSexAge(text(h?.age));
  const sexAge = sa.ageNum != null && sa.gender ? `${sa.ageNum}歳${sa.gender}` : text(h?.age);
  const w = text(h?.weight);
  const out = {
    sexAge,
    weight: w && Number.isFinite(Number(w)) ? `${Number(w)}kg` : '',
    jockey: text(h?.jockey),
    trainer: text(h?.trainer),
    sire: text(h?.sire),
  };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return Object.keys(out).length ? out : null;
}

function horseRows(horses, cat, raceInfo) {
  return (Array.isArray(horses) ? horses : [])
    .filter((h) => num(h) != null)
    .map((h) => {
      const role = MAIN_ROLES.includes(h.role) ? h.role : (isOsaeCandidate(h) ? '抑え' : (isIneligibleHorse(h) ? '不要' : '抑え'));
      return {
        number: num(h),
        name: String(h.horseName || h.name || ''),
        jockey: String(h.jockey || ''),
        profile: horseProfile(h),
        role,
        aiIndex: getHorseAiIndex(h),
        recent: recentRacesFor(h, cat),
        record: cat === 'jra' ? historyRecordFor(h, raceInfo) : null,
      };
    })
    .sort((a, b) => a.number - b.number);
}

/**
 * @param {object} p
 * @param {'premium'|'srp'} p.product
 * @param {'jra'|'nankan'} p.cat
 * @param {string} p.venueName
 * @param {object} p.race  { raceInfo, horses, bettingLines }
 * @param {number} p.venueTotalRaces 会場のレース数（メインレース判定）
 */
export function buildPredictionContent({ product, cat, venueName, race, venueTotalRaces }) {
  const info = race?.raceInfo || {};
  const horses = Array.isArray(race?.horses) ? race.horses : [];
  const raceNumber = Number(info.raceNumber);
  const isMain = raceNumber === getMainRaceNumber(Number(venueTotalRaces) || 12);
  const head = {
    v: CONTENT_VERSION,
    product,
    cat,
    date: String(info.date || ''),
    venueName,
    raceNumber,
    raceName: String(info.raceName || ''),
    startTime: String(info.startTime || ''),
    distance: String(info.distance ?? ''),
    horseCount: Number(info.horseCount) || horses.length,
    isMainRace: isMain,
    horses: horseRows(horses, cat, info),
  };
  if (product === PRODUCTS.SRP) {
    const sanNormal = [generateNormalSanrenpuku(horses, '本命'), generateNormalSanrenpuku(horses, '対抗')]
      .map(sanrenpukuLine).filter(Boolean);
    const sel = evaluateSanrenpukuRace(horses, { horseCount: head.horseCount, cat });
    return {
      ...head,
      selection: { grade: sel.grade, skip: sel.skip, reasons: sel.reasons },
      sanrenpuku: { normal: sanNormal, center: sanrenpukuLine(generateNarrowSanrenpuku(horses)) },
    };
  }
  const stored = Array.isArray(race?.bettingLines?.umatan) && race.bettingLines.umatan.length
    ? race.bettingLines.umatan : generateRaceUmatanLines(horses, isMain);
  // 点数は保存文字列（原文）から数える。表示だけ抑えを除く。bettingLines は書き換えない
  const normal = stored.filter(Boolean)
    .map((lineStr) => ({ line: stripOsaeForDisplay(lineStr), points: countPointsFromUmatanLine(lineStr) }));
  // Premium は馬単専用。三連複は Premium Sanrenpuku の商品価値なので入れない（2026-10-03 MK 確定）
  return {
    ...head,
    umatan: { normal, narrowed: narrowUmatan(horses, stored) },
  };
}

/** 取得前の一覧に出してよい項目だけ（本文は含めない） */
export function buildRaceListing({ race, venueTotalRaces }) {
  const info = race?.raceInfo || {};
  const raceNumber = Number(info.raceNumber);
  return {
    raceNumber,
    raceName: String(info.raceName || ''),
    startTime: String(info.startTime || ''),
    distance: String(info.distance ?? ''),
    horseCount: Number(info.horseCount) || (Array.isArray(race?.horses) ? race.horses.length : 0),
    isMainRace: raceNumber === getMainRaceNumber(Number(venueTotalRaces) || 12),
  };
}
