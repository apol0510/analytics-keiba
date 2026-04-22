/**
 * src/data/predictions/*.json (eventInfo/predictions スキーマ) を
 * 旧 allRacesPrediction.json (raceDate/races/horses:{main,sub,...}) スキーマに変換する。
 *
 * importPrediction.js が生成する形と free-prediction.astro が期待する形の橋渡し。
 * 最新日付のファイルを自動選択して返す。
 */

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

function convertHorse(h) {
  const pt = Number(h.pt || 0);
  const factors = [
    { icon: '★', text: `累積スコア: ${pt}pt` },
  ];
  return {
    number: h.horseNumber,
    name: h.horseName,
    mark: MARK_MAP[h.role] || '',
    type: h.role,
    role: h.role,
    pt,
    factors,
    jockey: h.jockey || '',
    trainer: h.trainer || '',
    age: h.age || '',
    weight: h.weight || '',
    sire: h.sire || '',
    recentRaces: h.recentRaces || [],
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

    for (const h of (p.horses || [])) {
      const conv = convertHorse(h);
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

    const allHorses = (p.horses || []).map(convertHorse);

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
 * import.meta.glob で集めた predictions/*.json 群から最新日付を選び、
 * 旧スキーマに変換して返す。
 *
 * @param {Record<string, any>} modules - import.meta.glob で eager:true 取得した map
 *        キー例: "/src/data/predictions/2026-04-23-urawa.json"
 * @returns {{raceDate:string, track:string, totalRaces:number, races:Array, _sourceFile:string}|null}
 */
export function pickLatestAndAdapt(modules) {
  const entries = [];
  for (const [path, mod] of Object.entries(modules)) {
    // ファイル名からカテゴリ系（jra/）配下は除外（nankan のみ）
    if (path.includes('/predictions/jra/')) continue;
    const m = path.match(/\/predictions\/(\d{4}-\d{2}-\d{2})-([a-z0-9]+)\.json$/i);
    if (!m) continue;
    const date = m[1];
    const venueSlug = m[2];
    // mod は default または object 直下で JSON が入る
    const data = mod?.default || mod;
    if (!data?.eventInfo || !Array.isArray(data?.predictions)) continue;
    entries.push({ path, date, venueSlug, data });
  }

  if (entries.length === 0) return null;

  // 日付降順（同一日は venueSlug のアルファベット順）でソートし先頭を選ぶ
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.venueSlug.localeCompare(b.venueSlug);
  });

  const latest = entries[0];
  const adapted = adaptNewToLegacy(latest.data);
  adapted._sourceFile = latest.path;
  return adapted;
}
