// 三連複AI推奨買い目ロジック（AI_SANRENPUKU_AXIS_V1）
//
// 構成:
//   - 絞り込み (narrow): 本命軸、相手候補=対抗+単穴+連下上位、相手2頭組合せ
//   - 通常 本命軸 (normal-honmei-axis): 本命軸、2頭目=対抗/単穴/連下上位、3頭目=2頭目候補+連下+抑え
//   - 通常 対抗軸 (normal-taikou-axis): 対抗軸、2頭目=本命/単穴/連下上位、3頭目=2頭目候補+連下+抑え
//
// 役割揺れ対応: 連下最上位 / 連下 / 抑え / 押さえ / 補欠
//
// 連下上位 (renkaTop): 連下最上位を優先、無ければ連下のpt最大

// 抑え判定は単一源 osaeClassification.js に集約（ローカル isOsaeRole は撤去）。
// 旧 isOsaeRole は role のみ（ci 閾値なし）で、表示・買い目（ci≥45）と基準が
// ズレていた。isOsaeCandidate に統一して三連複も同一基準にする。
import { isOsaeCandidate } from './osaeClassification.js';

function horseNumber(h) {
  return h?.horseNumber ?? h?.number ?? null;
}

function horsePt(h) {
  const v = Number(h?.pt ?? h?.displayScore ?? h?.rawScore);
  return Number.isFinite(v) ? v : 0;
}

function uniqueNums(nums) {
  const seen = new Set();
  const out = [];
  for (const n of nums) {
    if (n == null) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function pickRenkaTop(horses) {
  if (!Array.isArray(horses)) return null;
  const top = horses.find((h) => h?.role === '連下最上位');
  if (top) return top;
  const renka = horses
    .filter((h) => h?.role === '連下')
    .sort((a, b) => horsePt(b) - horsePt(a));
  return renka[0] || null;
}

// 3頭組合せ生成（順不同、重複なし）
//   axisNum: 軸番号
//   c2pool, c3pool: 相手番号リスト
function buildCombos(axisNum, c2pool, c3pool) {
  if (axisNum == null) return [];
  const result = new Map(); // key = sorted-triple-string
  for (const a of c2pool) {
    if (a == null || a === axisNum) continue;
    for (const b of c3pool) {
      if (b == null || b === axisNum || b === a) continue;
      const sorted = [axisNum, a, b].slice().sort((x, y) => x - y);
      result.set(sorted.join('-'), sorted);
    }
  }
  return Array.from(result.values());
}

// 絞り込み買い目
export function generateNarrowSanrenpuku(horses) {
  if (!Array.isArray(horses)) return null;
  const honmei = horses.find((h) => h?.role === '本命');
  const taikou = horses.find((h) => h?.role === '対抗');
  const tana = horses.find((h) => h?.role === '単穴');
  const renkaTop = pickRenkaTop(horses);

  const axisNum = horseNumber(honmei);
  if (axisNum == null) return null;

  const partners = uniqueNums([taikou, tana, renkaTop].map(horseNumber))
    .filter((n) => n !== axisNum);

  if (partners.length < 2) return null;

  const lines = buildCombos(axisNum, partners, partners);
  return {
    axis: axisNum,
    c2pool: partners.slice(),
    c3pool: partners.slice(),
    osae: [],
    lines,
    points: lines.length,
  };
}

// 通常買い目（axisRole = '本命' or '対抗'）
export function generateNormalSanrenpuku(horses, axisRole) {
  if (!Array.isArray(horses)) return null;
  const axisHorse = horses.find((h) => h?.role === axisRole);
  const axisNum = horseNumber(axisHorse);
  if (axisNum == null) return null;

  // 2頭目候補: 軸が本命なら {対抗,単穴,連下上位}、対抗なら {本命,単穴,連下上位}
  const main2Roles = axisRole === '本命' ? ['対抗', '単穴'] : ['本命', '単穴'];
  const main2Horses = horses.filter((h) => main2Roles.includes(h?.role));
  const renkaTop = pickRenkaTop(horses);
  const c2poolRaw = main2Horses.concat(renkaTop ? [renkaTop] : []).map(horseNumber);
  const c2pool = uniqueNums(c2poolRaw).filter((n) => n !== axisNum);

  // 3頭目候補: c2pool + 連下 + 抑え
  const renkaNums = horses.filter((h) => h?.role === '連下').map(horseNumber);
  // 抑え候補は単一源 isOsaeCandidate（抑え系 role かつ ci≥45）に統一。
  const osaeNums = horses.filter(isOsaeCandidate).map(horseNumber);
  const c3pool = uniqueNums([...c2pool, ...renkaNums, ...osaeNums]).filter((n) => n !== axisNum);
  const osae = uniqueNums(osaeNums).filter((n) => n !== axisNum && !c2pool.includes(n));

  if (c2pool.length < 1 || c3pool.length < 2) return null;

  const lines = buildCombos(axisNum, c2pool, c3pool);
  return {
    axis: axisNum,
    c2pool,
    c3pool,
    osae,
    lines,
    points: lines.length,
  };
}

// 表示用文字列: "6 - 3.8.7 - 3.8.7.4.1.9(抑え5.2)"
//   絞り込みの場合は osae=[]、c3pool==c2pool → "6 - 3.8.7 - 3.8.7"
export function formatSanrenpukuLine(spec) {
  if (!spec || spec.axis == null) return '';
  const axisStr = String(spec.axis);
  const c2Str = spec.c2pool.join('.');
  const c3NonOsae = spec.c3pool.filter((n) => !spec.osae.includes(n));
  const c3Str = c3NonOsae.join('.');
  let line = `${axisStr} - ${c2Str} - ${c3Str}`;
  if (spec.osae && spec.osae.length > 0) {
    line += `(抑え${spec.osae.join('.')})`;
  }
  return line;
}

// 南関 premium-sanrenpuku と同じ「絞り込み買い目」2段グループ表示用の行配列。
//   1段目: 本命-対抗-(単穴群, 連下全頭)
//   2段目: 本命-単穴1-(対抗, 単穴2, 連下全頭)
// 各行の points = 3頭目候補の数。役割選定は buildRaceSanrenpuku と同じ role ベース
// （本命/対抗/単穴/連下/連下最上位）。表示専用（narrow spec の値・点数は変更しない）。
export function generateNarrowedDisplayLines(horses) {
  if (!Array.isArray(horses)) return [];
  const honmei = horses.find((h) => h?.role === '本命');
  const taikou = horses.find((h) => h?.role === '対抗');
  const tanaList = horses.filter((h) => h?.role === '単穴');
  const renkaNums = horses
    .filter((h) => h?.role === '連下' || h?.role === '連下最上位')
    .map(horseNumber);

  const mainNumber = horseNumber(honmei);
  if (mainNumber == null) return [];
  const subNumber = horseNumber(taikou);
  const hole1 = horseNumber(tanaList[0]);
  const hole2 = horseNumber(tanaList[1]);

  const out = [];
  // 1段目: 本命-対抗-(単穴群, 連下全頭)
  if (subNumber != null) {
    const targets = uniqueNums([hole1, hole2, ...renkaNums])
      .filter((n) => n != null && n !== mainNumber && n !== subNumber)
      .sort((a, b) => a - b);
    if (targets.length) out.push({ line: `${mainNumber}-${subNumber}-${targets.join(',')}`, points: targets.length });
  }
  // 2段目: 本命-単穴1-(対抗, 単穴2, 連下全頭)
  if (hole1 != null) {
    const targets = uniqueNums([subNumber, hole2, ...renkaNums])
      .filter((n) => n != null && n !== mainNumber && n !== hole1)
      .sort((a, b) => a - b);
    if (targets.length) out.push({ line: `${mainNumber}-${hole1}-${targets.join(',')}`, points: targets.length });
  }
  return out;
}

// 結果との照合
export function checkSanrenpukuHit(top3, lines) {
  if (!Array.isArray(top3) || top3.length !== 3) return false;
  if (!Array.isArray(lines) || lines.length === 0) return false;
  const target = top3.slice().sort((a, b) => a - b).join('-');
  for (const line of lines) {
    if (!Array.isArray(line) || line.length !== 3) continue;
    const s = line.slice().sort((a, b) => a - b).join('-');
    if (s === target) return true;
  }
  return false;
}

// 1レース分の三連複買い目一式
export function buildRaceSanrenpuku(horses) {
  return {
    narrow: generateNarrowSanrenpuku(horses),
    normalHonmeiAxis: generateNormalSanrenpuku(horses, '本命'),
    normalTaikouAxis: generateNormalSanrenpuku(horses, '対抗'),
  };
}
