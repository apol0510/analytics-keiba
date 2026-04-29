/**
 * src/data/predictions/*.json (eventInfo/predictions スキーマ) を
 * 旧 allRacesPrediction.json (raceDate/races/horses:{main,sub,...}) スキーマに変換する。
 *
 * importPrediction.js が生成する形と free-prediction.astro が期待する形の橋渡し。
 * 最新日付のファイルを自動選択して返す。
 */
import {
  computeOverallScore,
  getStarRating,
  computeConfidence,
  parseSexAge,
  computeImportance,
  computeEvalPoints,
} from './horseEnrichment.js';

// role → mark / role → 旧 type の対応
const MARK_MAP = {
  '本命': '◎',
  '対抗': '○',
  '単穴': '▲',
  '連下最上位': '☆',
  '連下': '△',
  '補欠': '×',
  '押さえ': '×',
};

function convertHorse(h, allRaceHorses, raceDistance) {
  const pt = Number(h.pt || 0);
  const overallScore = computeOverallScore(pt);
  const stars = getStarRating(overallScore);
  const confidence = computeConfidence(pt);
  const importance = computeImportance(h, allRaceHorses);
  const evalPoints = computeEvalPoints(h, allRaceHorses, raceDistance);
  const { gender, ageNum } = parseSexAge(h.age);
  const factors = [
    { icon: '★', text: `総合評価:${stars}（${confidence}）` },
    { icon: '★', text: `累積スコア: ${pt}pt` },
  ];
  return {
    number: h.horseNumber,
    name: h.horseName,
    mark: MARK_MAP[h.role] || '',
    type: h.role,
    role: h.role,
    pt,
    overallScore,
    stars,
    confidence,
    importance,
    evalPoints,
    factors,
    jockey: h.jockey || '',
    trainer: h.trainer || '',
    age: h.age || '',
    ageNum,
    gender,
    weight: h.weight ?? null,
    sire: h.sire || '',
    computerIndex: h.computerIndex ?? null,
    frame: h.frame ?? h.gateNumber ?? null,
    recentRaces: Array.isArray(h.recentRaces) ? h.recentRaces : [],
  };
}

/**
 * 新スキーマ1件を旧スキーマに変換する。
 * @param {{eventInfo:{date:string,venue:string,totalRaces:number}, predictions:Array}} newData
 */
export function adaptNewToLegacy(newData) {
  const { eventInfo, predictions } = newData;
  const date = eventInfo.date;
  const venue = eventInfo.venue;
  const trackLabel = venue.endsWith('競馬') ? venue : `${venue}競馬`;

  // 存在するレース番号一覧から「メインレース」を決定
  // 11R があれば 11R、無ければ最大レース番号
  const raceNumbers = predictions.map(p => Number(p.raceInfo.raceNumber)).filter(n => Number.isFinite(n));
  const mainRaceNumber = raceNumbers.includes(11) ? 11 : Math.max(...raceNumbers, 0);

  const races = predictions.map(p => {
    const rn = Number(p.raceInfo.raceNumber);
    const horsesByRole = {
      main: null,
      sub: null,
      hole1: null,
      hole2: null,
      connectTop: null,
      connect: [],
      reserve: [],
    };
    const holes = [];

    const raceHorses = p.horses || [];
    const raceDistance = p.raceInfo && p.raceInfo.distance;
    for (const h of raceHorses) {
      const conv = convertHorse(h, raceHorses, raceDistance);
      switch (h.role) {
        case '本命': horsesByRole.main = conv; break;
        case '対抗': horsesByRole.sub = conv; break;
        case '単穴': holes.push(conv); break;
        case '連下最上位': horsesByRole.connectTop = conv; break;
        case '連下': horsesByRole.connect.push(conv); break;
        case '補欠':
        case '押さえ':
          horsesByRole.reserve.push(conv);
          break;
      }
    }
    horsesByRole.hole1 = holes[0] || null;
    horsesByRole.hole2 = holes[1] || null;

    const allHorses = raceHorses.map(h => convertHorse(h, raceHorses, raceDistance));

    return {
      // 旧スキーマでは raceNumber は "11R" のような文字列
      raceNumber: `${rn}R`,
      raceName: p.raceInfo.raceName || `${rn}R`,
      tier: rn === mainRaceNumber ? 'main' : 'normal',
      isMainRace: rn === mainRaceNumber,
      displayOrder: rn,
      raceInfo: {
        title: `${date} ${venue}${rn}R ${p.raceInfo.raceName || ''}`.trim(),
        date,
        track: trackLabel,
        raceNumber: `${rn}R`,
        raceName: p.raceInfo.raceName || `${rn}R`,
        distance: p.raceInfo.distance || '',
        horseCount: p.raceInfo.horseCount || allHorses.length,
        startTime: p.raceInfo.startTime || '',
        raceCondition: p.raceInfo.raceCondition || '',
      },
      horses: horsesByRole,
      allHorses,
    };
  });

  // displayOrder 昇順で安定
  races.sort((a, b) => a.displayOrder - b.displayOrder);

  return {
    raceDate: date,
    lastUpdated: new Date().toISOString(),
    track: trackLabel,
    totalRaces: eventInfo.totalRaces || races.length,
    races,
  };
}

/**
 * import.meta.glob で集めた predictions/*.json 群をフィルタして
 * 日付降順でソートしたエントリ配列を返す（生データ）。
 *
 * @param {Record<string, any>} modules - import.meta.glob で eager:true 取得した map
 * @param {{venueSlug?:string}} [opts] - venueSlug 指定時はその会場のみ（例: 'urawa'）
 * @returns {Array<{path:string, date:string, venueSlug:string, data:any}>}
 */
export function listNankanPredictionEntries(modules, opts = {}) {
  const { venueSlug } = opts;
  const entries = [];
  for (const [path, mod] of Object.entries(modules)) {
    // JRA 配下は対象外（nankan のみ）
    if (path.includes('/predictions/jra/')) continue;
    const m = path.match(/\/predictions\/(\d{4}-\d{2}-\d{2})-([a-z0-9]+)\.json$/i);
    if (!m) continue;
    const date = m[1];
    const slug = m[2].toLowerCase();
    if (venueSlug && slug !== venueSlug.toLowerCase()) continue;
    const data = mod?.default || mod;
    if (!data?.eventInfo || !Array.isArray(data?.predictions)) continue;
    entries.push({ path, date, venueSlug: slug, data });
  }
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.venueSlug.localeCompare(b.venueSlug);
  });
  return entries;
}

/**
 * 最新1件を選んで旧スキーマに変換して返す（nankan 用）。
 * venueSlug 指定で会場固定も可能。指定 venue が無い場合は opts.fallbackToAny=true で
 * 任意の最新 nankan データにフォールバックする。
 *
 * category: 'jra' が指定された場合は pickLatestJraPrediction に委譲する。
 *
 * @param {Record<string, any>} modules - import.meta.glob の結果
 * @param {{venueSlug?:string, fallbackToAny?:boolean, category?:'nankan'|'jra'}} [opts]
 * @returns {{raceDate:string, track:string, totalRaces:number, races:Array, _sourceFile:string, _fallback?:boolean}|null}
 */
export function pickLatestAndAdapt(modules, opts = {}) {
  const { venueSlug, fallbackToAny = false, category = 'nankan' } = opts;
  if (category === 'jra') return pickLatestJraPrediction(modules);
  let entries = listNankanPredictionEntries(modules, { venueSlug });
  let fellBack = false;
  if (entries.length === 0 && venueSlug && fallbackToAny) {
    entries = listNankanPredictionEntries(modules);
    fellBack = true;
  }
  if (entries.length === 0) return null;
  const latest = entries[0];
  const adapted = adaptNewToLegacy(latest.data);
  adapted._sourceFile = latest.path;
  if (fellBack) adapted._fallback = true;
  return adapted;
}

// ============================================================
// JRA 用（multi-venue スキーマ）
// ============================================================

/**
 * JRA 予想ファイル（src/data/predictions/jra/YYYY/MM/YYYY-MM-DD.json）を
 * import.meta.glob 結果から全列挙し、日付降順で返す。
 *
 * @param {Record<string, any>} modules - `import.meta.glob('/src/data/predictions/jra/**\/*.json', { eager: true })` の結果
 * @returns {Array<{path:string, date:string, data:any}>}
 */
export function listJraPredictionEntries(modules) {
  const entries = [];
  for (const [path, mod] of Object.entries(modules)) {
    const m = path.match(/\/predictions\/jra\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const data = mod?.default || mod;
    // JRA スキーマ: {date, totalVenues, totalRaces, venues:[{venue, eventInfo, predictions}]}
    if (!data?.date || !Array.isArray(data?.venues)) continue;
    entries.push({ path, date: m[1], data });
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  return entries;
}

/**
 * JRA の最新予想ファイルを返す。スキーマは元の multi-venue 形式のまま。
 * （JRA ページは venues 配列を前提に表示しているため、変換せずに返す）
 *
 * @param {Record<string, any>} modules
 * @returns {{date:string, totalVenues:number, totalRaces:number, venues:Array, _sourceFile:string}|null}
 */
export function pickLatestJraPrediction(modules) {
  const entries = listJraPredictionEntries(modules);
  if (entries.length === 0) return null;
  const latest = entries[0];
  return { ...latest.data, _sourceFile: latest.path };
}
