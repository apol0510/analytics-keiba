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

export const CONTENT_VERSION = 1;

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

function horseRows(horses) {
  return (Array.isArray(horses) ? horses : [])
    .filter((h) => num(h) != null)
    .map((h) => {
      const role = MAIN_ROLES.includes(h.role) ? h.role : (isOsaeCandidate(h) ? '抑え' : (isIneligibleHorse(h) ? '不要' : '抑え'));
      return {
        number: num(h),
        name: String(h.horseName || h.name || ''),
        jockey: String(h.jockey || ''),
        role,
        aiIndex: getHorseAiIndex(h),
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
    horses: horseRows(horses),
  };
  const sanNormal = [generateNormalSanrenpuku(horses, '本命'), generateNormalSanrenpuku(horses, '対抗')]
    .map(sanrenpukuLine).filter(Boolean);

  if (product === PRODUCTS.SRP) {
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
  return {
    ...head,
    umatan: { normal, narrowed: narrowUmatan(horses, stored) },
    sanrenpuku: { normal: sanNormal },
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
