/**
 * ownIndexApply.mjs — 取込時に独自指数（OWN_INDEX_V1・src/utils/ownIndex.js）で印・役割・pt を決め直す。
 *
 * MK 2026-11-26「能力差が小さいときは独自の評価で ◎○ を入れ替える・指数を独自算出に」。正本 docs/PREDICTION_LOGIC.md「独自指数」。
 *   - 対象: 開催日 OWN_INDEX_START 以降。それより前の開催は従来の adjustPrediction の結果のまま
 *   - 独自指数 = 指数（computer JSON の computerIndex・45 以上）＋ 先行力・前走着順・騎手・上がりの 4 項目（各 ±1）
 *   - 役割 = 独自指数の順（本命・対抗・単穴・連下最上位・連下 3・補欠）
 *   - 表示する AI総合指数（ownIndex）= round(1.15 × 独自指数 − 20)（独自の目盛り・順位は変わらない・27〜98）。pt（累積スコア）= AI総合指数 + 70
 *   - 買い目の相手を選ぶときの同じ役割内の順は従来どおり指数の高い順（partnerPt = 指数 + 70・JSON には出さない）
 *   - 🛑 新聞の印（marks）・本紙順位は使わない。騎手成績は開催日より前の確定結果だけ（当日の結果を使わない）
 *   - 騎手成績を読めなければ fail-closed で従来の結果のまま（ログにコードだけ出す）
 */
import { ownIndexRace, ownOrder, addJockeyResults, jockeyKey, OWN_INDEX_VERSION } from '../../src/utils/ownIndex.js';

export const OWN_INDEX_START = '2026-11-28';
/** 騎手成績を数え始める月（keiba-data-shared の computer 予想の最初の月） */
export const JOCKEY_STATS_FROM = '2026-02';
const REF = 'main';
const ROLE_AT = (i) => (i === 0 ? '本命' : i === 1 ? '対抗' : i === 2 ? '単穴' : i === 3 ? '連下最上位' : i < 7 ? '連下' : '補欠');
const ROLE_MARK = { 本命: '◎', 対抗: '○', 単穴: '▲', 連下最上位: '△', 連下: '△', 補欠: '×', 無: '-' };

/** 表示する AI総合指数（独自の目盛り）。独自指数の順を保つ（傾き 1.15 > 1 なので同点にならない） */
export const ownIndexDisplay = (v) => Math.round(1.15 * v - 20);

export const ownIndexOn = (date) => typeof date === 'string' && date >= OWN_INDEX_START;

function monthsBetween(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}/${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * 開催日より前の騎手成績（予想ファイルの騎手 × 確定着順を馬番で照合・市場ごと）。
 * @returns {Promise<Map<string, { rides: number, wins: number }>>}
 */
export async function loadJockeyStats(client, category, date) {
  const pairs = [];
  for (const ym of monthsBetween(JOCKEY_STATS_FROM, date.slice(0, 7))) {
    const preds = await client.listDirectory(`${category}/predictions/computer/${ym}`, { ref: REF, required: false });
    const res = await client.listDirectory(`${category}/results/${ym}`, { ref: REF, required: false });
    const resNames = new Set((res ?? []).filter((e) => e.type === 'file').map((e) => e.name));
    for (const e of preds ?? []) {
      const m = e.type === 'file' && e.name.match(/^(\d{4}-\d{2}-\d{2})-[A-Z]{3}\.json$/);
      if (m && m[1] < date && resNames.has(e.name)) pairs.push({ pred: e.path, res: `${category}/results/${ym}/${e.name}` });
    }
  }
  const loaded = await pool(pairs, 6, async (p) => [await client.fetchJson(p.pred, { ref: REF, required: false }), await client.fetchJson(p.res, { ref: REF, required: false })]);
  const stats = new Map();
  for (const [pred, res] of loaded) if (pred && res) addJockeyResults(stats, pred, res);
  return stats;
}

/**
 * computer JSON（会場別ファイルをまとめた { venues: [...] } または 1 会場）→ 会場名 → レース番号 → 馬番 → { ci, jockey, recent }
 */
export function computerHorseIndex(computerJSON) {
  const venues = Array.isArray(computerJSON?.venues) ? computerJSON.venues : (computerJSON ? [computerJSON] : []);
  const out = new Map();
  for (const v of venues) {
    const name = v?.venue || v?.name;
    if (!name) continue;
    const races = new Map();
    for (const r of v.races ?? []) {
      const horses = new Map();
      for (const h of r.horses ?? []) {
        const num = Number(h?.number ?? h?.horseNumber);
        if (!Number.isInteger(num)) continue;
        // keiba-data-shared の pastRaces は古い順 → 新しい順に並べ直す
        horses.set(num, { ci: Number(h.computerIndex), jockey: h.jockey ?? '', recent: [...(h.pastRaces ?? [])].reverse() });
      }
      races.set(Number(r.raceNumber), horses);
    }
    out.set(name, races);
  }
  return out;
}

/**
 * 調整済みの 1 会場（adjustPrediction の結果）に独自指数を当てる。破壊的に書き換えて返す。
 * @param {object} adjusted normalizeAndAdjust の結果（races[].horses[]）
 * @param {Map} computerIndexByVenue computerHorseIndex の値
 * @param {Map} jockeyStats loadJockeyStats の値
 * @returns {{ applied: number, skipped: number }}
 */
export function applyOwnIndex(adjusted, computerIndexByVenue, jockeyStats) {
  let applied = 0;
  let skipped = 0;
  const venueRaces = computerIndexByVenue.get(adjusted?.venue);
  for (const race of adjusted?.races ?? []) {
    const src = venueRaces?.get(Number(race.raceNumber));
    if (!src || !Array.isArray(race.horses) || !race.horses.length) { skipped++; continue; }
    const input = [];
    for (const h of race.horses) {
      const c = src.get(Number(h.number));
      const ci = Number(h.sourceComputerIndex ?? c?.ci);
      if (!c || !Number.isFinite(ci) || (h.rawScore || 0) <= 0) continue;
      input.push({ number: Number(h.number), base: ci, recent: c.recent, jockeyRecord: jockeyStats.get(jockeyKey(c.jockey)) ?? { rides: 0, wins: 0 } });
    }
    const index = ownIndexRace(input);
    if (index.size < 3) { skipped++; continue; }
    const byNum = new Map(race.horses.map((h) => [Number(h.number), h]));
    // 指数 45 未満などで独自指数の対象外になった評価馬は、従来の pt の順で後ろに並べる
    const rest = race.horses.filter((h) => (h.rawScore || 0) > 0 && !index.has(Number(h.number)))
      .sort((a, b) => (b.displayScore || 0) - (a.displayScore || 0) || Number(a.number) - Number(b.number));
    const order = [...ownOrder(index).map((n) => byNum.get(n)), ...rest];
    for (const h of race.horses) { h.role = '無'; }
    order.forEach((h, i) => {
      h.role = ROLE_AT(i);
      const v = index.get(Number(h.number));
      if (v) {
        h.ownIndex = ownIndexDisplay(v.ownIndex);
        h.displayScore = h.ownIndex + 70;
        h.partnerPt = v.base + 70;
      }
    });
    for (const h of race.horses) h.mark = ROLE_MARK[h.role] ?? '-';
    race._analyticsRule = OWN_INDEX_VERSION;
    applied++;
  }
  return { applied, skipped };
}

/**
 * その開催日の computer JSON（会場別ファイル）をまとめて読む → { venues: [{ venue, races }] }。無ければ null
 */
export async function loadComputerForDate(client, category, date) {
  const dir = `${category}/predictions/computer/${date.slice(0, 4)}/${date.slice(5, 7)}`;
  const entries = await client.listDirectory(dir, { ref: REF, required: false });
  const files = (entries ?? []).filter((e) => e.type === 'file' && e.name.startsWith(`${date}-`) && e.name.endsWith('.json'));
  const venues = [];
  for (const f of files) {
    const d = await client.fetchJson(f.path, { ref: REF, required: false });
    if (d && (d.venue || d.track) && Array.isArray(d.races)) venues.push({ venue: d.venue || d.track, races: d.races });
  }
  return venues.length ? { venues } : null;
}

/** 取込の入口: 開催日 OWN_INDEX_START 以降だけ入力を読む。読めなければ null（従来の評価順のまま） */
export async function loadOwnIndexContext(client, category, date, log = console.log) {
  if (!ownIndexOn(date)) return null;
  try {
    const computerJSON = await loadComputerForDate(client, category, date);
    if (!computerJSON) { log('⏭️  [OWN_INDEX] computer JSON なし → 従来の評価順'); return null; }
    const jockeyStats = await loadJockeyStats(client, category, date);
    log(`📊 [OWN_INDEX] 騎手成績 ${jockeyStats.size} 名（${date} より前の確定結果）`);
    return { byVenue: computerHorseIndex(computerJSON), jockeyStats };
  } catch (e) {
    log(`⚠️  [OWN_INDEX] 入力の取得に失敗 → 従来の評価順（${e?.code || e?.name || 'error'}）`);
    return null;
  }
}

export function applyOwnIndexLogged(adjusted, ctx, log = console.log) {
  if (!ctx) return;
  const r = applyOwnIndex(adjusted, ctx.byVenue, ctx.jockeyStats);
  log(`🧮 [OWN_INDEX] ${adjusted?.venue}: ${r.applied} レースに適用・${r.skipped} レースは従来どおり`);
}
