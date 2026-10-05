/**
 * aiLab.js — AI ラボ（試験運用・中央のみ）の純粋ロジック
 *
 * 正本: docs/AI_LAB.md（2026-10-05 MK 確定）
 *   - KAP（keiba-ai-predictor）の全頭の期待値（AI 勝率 × 単勝オッズ）を、レースごとにランキングで見せる
 *   - KAP が選んだ馬（穴馬に偏る）と金額は**受け取らない・保存しない・出さない**
 *   - 「選んだ馬」の代わりに **AK の上位 5 頭**（本命→対抗→単穴→連下最上位→連下・同役割は pt 降順）を出す。
 *     有料予想（1 件ずつ取得）の価値を守るため **発走後（結果が出たら）だけ** 出す
 *   - 答え合わせ: 1 着が AK 上位 5 頭に入ったか／勝ち馬は AI 期待値で何位だったか。成績は結果が出た全レースで数える
 */
import { getTop5Challengers } from '../../utils/mainRaceBetting.js';
import { JRA_VENUES } from '../acquisition/predictionKey.js';

export const INGEST_SCHEMA = 'ak_ailab_ingest.v1';
// JRA 場コード（race_id の 4 番目）→ 場名
export const JRA_COURSE = Object.freeze({
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
  '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉',
});
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RACES = 48;
const MAX_HORSES = 18;

/** KAP の race_id（2026-10-04-05-11）→ { date, venueName, venueId, raceNumber }。読めなければ null */
export function parseKapRaceId(raceId) {
  const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/.exec(String(raceId || ''));
  if (!m) return null;
  const venueName = JRA_COURSE[m[2]];
  const raceNumber = Number(m[3]);
  if (!venueName || raceNumber < 1 || raceNumber > 12) return null;
  return { date: m[1], venueName, venueId: JRA_VENUES[venueName], raceNumber };
}

const finite = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/**
 * 受け取ったデータを検査し、**保存してよい項目だけ**に絞る（未知の項目＝KAP の買い目・金額は落とす）。
 * @returns {{ ok: true, day: object } | { ok: false, reason: string }}
 */
export function sanitizeIngest(payload) {
  const p = payload || {};
  if (p.schema !== INGEST_SCHEMA) return { ok: false, reason: 'schema' };
  if (p.market !== 'jra') return { ok: false, reason: 'market' };
  if (!DATE_RE.test(String(p.date))) return { ok: false, reason: 'date' };
  if (!Array.isArray(p.races) || p.races.length === 0 || p.races.length > MAX_RACES) return { ok: false, reason: 'races' };
  const races = [];
  for (const r of p.races) {
    const id = parseKapRaceId(r?.race_id);
    if (!id || id.date !== p.date) return { ok: false, reason: 'race_id' };
    if (!Array.isArray(r.field) || r.field.length > MAX_HORSES) return { ok: false, reason: 'field' };
    const field = [];
    for (const h of r.field) {
      const n = Number(h?.horse_number ?? h?.selection);
      if (!Number.isInteger(n) || n < 1 || n > MAX_HORSES) return { ok: false, reason: 'horse_number' };
      const pc = finite(h?.p_calibrated, 0, 1);
      const odds = finite(h?.odds, 1, 99999);
      field.push({ n, p: pc, odds, ev: pc != null && odds != null ? Math.round(pc * odds * 10000) / 10000 : null });
    }
    races.push({
      raceId: String(r.race_id), venueName: id.venueName, venueId: id.venueId, raceNumber: id.raceNumber,
      oddsBasis: r.odds_basis === 'decision' || r.odds_basis === 'latest' ? r.odds_basis : null,
      observedAt: typeof r.observed_at === 'string' && Number.isFinite(Date.parse(r.observed_at)) ? r.observed_at : null,
      field,
    });
  }
  return { ok: true, day: { date: p.date, model: typeof p.model_version === 'string' ? p.model_version.slice(0, 80) : null, races } };
}

/** AK の上位 5 頭（本命＋役割優先の上位 4 頭）。horses は AK の予想データ */
export function akTop5(horses) {
  const list = Array.isArray(horses) ? horses : [];
  const num = (h) => Number(h?.horseNumber ?? h?.number);
  const honmei = list.find((h) => h?.role === '本命');
  const rest = getTop5Challengers(list.filter((h) => h !== honmei)).slice(0, honmei ? 4 : 5);
  return [honmei, ...rest].filter(Boolean)
    .map((h) => ({ n: num(h), role: h.role === '連下最上位' ? '連下' : h.role }))
    .filter((x) => Number.isInteger(x.n));
}

/** 取込時に AK の予想（その日の loadDay('jra')）から上位 5 頭と発走時刻を添える */
export function attachAk(day, akVenues) {
  const byKey = new Map();
  for (const v of akVenues || []) for (const r of v.races || []) byKey.set(`${v.venueId}:${Number(r.raceInfo?.raceNumber)}`, r);
  return {
    ...day,
    races: day.races.map((r) => {
      const ak = byKey.get(`${r.venueId}:${r.raceNumber}`);
      return { ...r, startTime: ak?.raceInfo?.startTime ? String(ak.raceInfo.startTime) : null, akTop5: ak ? akTop5(ak.horses) : null };
    }),
  };
}

/** 'HH:MM' + date（JST）→ ms。読めなければ null */
export function startMs(date, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Date.parse(`${date}T${m[1].padStart(2, '0')}:${m[2]}:00+09:00`) : null;
}

/**
 * 画面用（1 日分）。results は acquiredResults.buildResultIndex の索引（日付|場名|R → 着順）
 * AK 上位 5 頭は「結果が出た or 発走時刻を過ぎた」レースだけ出す
 */
export function dayView(day, { results, nowMs = Date.now() } = {}) {
  const races = (day?.races || []).map((r) => {
    const ranking = r.field.slice().sort((a, b) => (b.ev ?? -1) - (a.ev ?? -1) || a.n - b.n)
      .map((h, i) => ({ ...h, rank: h.ev == null ? null : i + 1 }));
    const res = results?.get(`${day.date}|${r.venueName}|${r.raceNumber}`) || null;
    const st = startMs(day.date, r.startTime);
    const finished = !!res || (st != null && nowMs >= st);
    const top5 = finished && Array.isArray(r.akTop5) ? r.akTop5 : null;
    const winner = res ? res.first : null;
    return {
      ...r, ranking, finished, akTop5: top5,
      result: res ? { order: [res.first, res.second, res.third].filter(Boolean),
        winnerInAkTop5: top5 ? top5.some((h) => h.n === winner) : null,
        winnerEvRank: ranking.find((h) => h.n === winner)?.rank ?? null } : null,
    };
  });
  races.sort((a, b) => (a.venueName < b.venueName ? -1 : a.venueName > b.venueName ? 1 : a.raceNumber - b.raceNumber));
  return { date: day?.date, model: day?.model || null, races };
}

/** 成績（結果が出た全レースで数える・都合のよいレースだけ選ばない） */
export function labStats(views) {
  let settled = 0, top5Hit = 0, evTop5 = 0, evRanked = 0;
  for (const v of views || []) for (const r of v.races || []) {
    if (!r.result || !Array.isArray(r.akTop5)) continue;
    settled += 1;
    if (r.result.winnerInAkTop5) top5Hit += 1;
    if (r.result.winnerEvRank != null) { evRanked += 1; if (r.result.winnerEvRank <= 5) evTop5 += 1; }
  }
  return { settled, top5Hit, evRanked, evTop5 };
}
