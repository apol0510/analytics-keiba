/**
 * freeBoardLive.js — 無料 LIVE ボードのレース単位の結果と発走時刻の変更（南関・サーバー専用）
 *
 * 2026-11-04 MK: 最終レースを待たず、取得できたレースから順次反映する。変更後の発走時刻はカウントダウンへ反映する。
 * 地方競馬公式（keiba.go.jp）の成績表とレース一覧を読み、公開するのは ✅/✗（真偽値）と変更後の時刻だけ。
 *
 * 🛑 archive は書かない（部分日が回収率・週次配信へ波及する）。確定値は従来どおり archive が勝つ（ブラウザ側 applyLive）。
 * 🛑 着順・馬番・払戻・買い目を返さない。保存もしない。
 * 🛑 同着・読めないページは判定しない（hit を作らない）。アクセス拒否を受けたら 1 時間読まない（回避しない）。
 * 読むのはページの閲覧があるときだけ。1 回に成績 2 ページまで・間隔 1.5 秒・ロックで全体 1 分に 1 回。
 */
import { checkUmatanHit } from './results/umatanHit.js';

const BASE = 'https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo';
const USER_AGENT = 'analytics-keiba-free-board/1.0 (low-rate; sequential; one request per 1.5s or slower)';
const BABA_CODE = Object.freeze({ 大井: '20', 川崎: '21', 船橋: '19', 浦和: '18' });
const BLOCK_STATUS = new Set([401, 403, 406, 429, 451]);

/** 発走予定からこの時間は成績表を見に行かない */
export const RESULT_MIN_DELAY_MS = 8 * 60 * 1000;
export const LOCK_SEC = 55;
export const STATE_TTL_SEC = 3 * 86400;
const MAX_RESULT_FETCH = 2;
const MAX_TRIES = 30;
const LIST_INTERVAL_MS = 2 * 60 * 1000;
const LIST_AHEAD_MS = 90 * 60 * 1000;
const BLOCK_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const stateKey = (date) => `ak:freeboard:v1:nankan:${date}`;
const urlDate = (date) => date.replace(/-/g, '%2f');
const raceKey = (r) => `${r.venueName}|${r.raceNumber}`;
const strip = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** 成績表 → { first, second }（馬番）。発表前・同着・形が違うときは null */
export function parseResultTop2(html, raceNumber) {
  const h = String(html || '');
  if (!/<title>\s*レース成績表\s*<\/title>/.test(h) || !h.includes(`k_raceNo=${raceNumber}`)) return null;
  const a = h.indexOf('class="gradeTable"');
  if (a < 0) return null;
  const table = h.slice(a, h.indexOf('</table>', a) + 1 || undefined);
  const rows = [...table.matchAll(/<td class="a">\s*(\d+)\s*<\/td>[\s\S]*?<td class="c">\s*(\d+)\s*<\/td>/g)].map((m) => ({ rank: Number(m[1]), number: Number(m[2]) }));
  const firsts = rows.filter((r) => r.rank === 1);
  const seconds = rows.filter((r) => r.rank === 2);
  if (firsts.length !== 1 || seconds.length !== 1) return null;
  return { first: firsts[0].number, second: seconds[0].number };
}

/** レース一覧 → Map(レース番号 → 'HH:MM')。変更欄があればそちらを採る。日付が違う・読めなければ null */
export function parseRaceListTimes(html, date) {
  const h = String(html || '');
  const [y, m, d] = date.split('-').map(Number);
  if (!h.includes(`${y}年${m}月${d}日`)) return null;
  const times = new Map();
  for (const row of h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]));
    const rn = /^(\d{1,2})\s*R$/.exec(cells[0] || '');
    if (!rn || cells.length < 3 || times.has(Number(rn[1]))) continue;
    const time = [cells[2], cells[1]].find((t) => /^\d{1,2}:\d{2}$/.test(t || ''));
    if (time) times.set(Number(rn[1]), time.padStart(5, '0'));
  }
  return times.size ? times : null;
}

/** 公開本線との照合。買い目が無ければ null（判定しない） */
export function judgeHit(lines, top2) {
  if (!Array.isArray(lines) || lines.length === 0 || !top2) return null;
  const result = { results: [{ number: top2.first }, { number: top2.second }] };
  return lines.some((line) => checkUmatanHit(line, result));
}

async function getPage(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (BLOCK_STATUS.has(res.status)) return { blocked: true };
  return { html: res.ok ? await res.text() : null };
}

/**
 * state を 1 段進める（呼び出し側がロックを持つ）。races = [{ venueName, raceNumber, startAt, lines }]
 * 読めなかったものは何も書かない。
 */
export async function advanceState({ state, races, date, nowMs, fetchImpl, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const next = { hits: { ...state.hits }, times: { ...state.times }, tries: { ...state.tries }, listAt: state.listAt || 0, blockedUntil: state.blockedUntil || 0 };
  if (next.blockedUntil > nowMs) return next;
  const at = (r) => Date.parse(next.times[raceKey(r)] || r.startAt);
  let fetched = 0;
  const pause = async () => { if (fetched++ > 0) await wait(1500); };
  try {
    const live = races.filter((r) => Number.isFinite(at(r)));
    const watching = live.some((r) => !(raceKey(r) in next.hits) && at(r) < nowMs + LIST_AHEAD_MS);
    if (watching && nowMs - next.listAt >= LIST_INTERVAL_MS) {
      next.listAt = nowMs;
      for (const venueName of new Set(live.map((r) => r.venueName))) {
        const code = BABA_CODE[venueName];
        if (!code) continue;
        await pause();
        const page = await getPage(`${BASE}/RaceList?k_raceDate=${urlDate(date)}&k_babaCode=${code}`, fetchImpl);
        if (page.blocked) { next.blockedUntil = nowMs + BLOCK_MS; return next; }
        const times = page.html ? parseRaceListTimes(page.html, date) : null;
        for (const r of live.filter((x) => x.venueName === venueName)) {
          const hm = times?.get(r.raceNumber);
          if (!hm) continue;
          const iso = new Date(Date.parse(`${date}T${hm}:00+09:00`)).toISOString();
          if (iso === new Date(Date.parse(r.startAt)).toISOString()) delete next.times[raceKey(r)];
          else next.times[raceKey(r)] = iso;
        }
      }
    }
    const targets = live
      .filter((r) => !(raceKey(r) in next.hits) && r.lines?.length && (next.tries[raceKey(r)] || 0) < MAX_TRIES && at(r) + RESULT_MIN_DELAY_MS <= nowMs)
      .sort((a, b) => at(a) - at(b))
      .slice(0, MAX_RESULT_FETCH);
    for (const r of targets) {
      const code = BABA_CODE[r.venueName];
      if (!code) continue;
      await pause();
      next.tries[raceKey(r)] = (next.tries[raceKey(r)] || 0) + 1;
      const page = await getPage(`${BASE}/RaceMarkTable?k_raceDate=${urlDate(date)}&k_raceNo=${r.raceNumber}&k_babaCode=${code}`, fetchImpl);
      if (page.blocked) { next.blockedUntil = nowMs + BLOCK_MS; return next; }
      const hit = judgeHit(r.lines, parseResultTop2(page.html, r.raceNumber));
      if (hit !== null) next.hits[raceKey(r)] = hit;
    }
  } catch (error) {
    console.error('[freeBoardLive] fetch error:', error?.name || 'error');
  }
  return next;
}

const parseState = (raw) => {
  try {
    const s = JSON.parse(raw || 'null');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
};

/** ブラウザへ返す形（🛑 hits と times だけ） */
export const publicView = (state) => ({ hits: { ...(state.hits || {}) }, times: { ...(state.times || {}) } });

/** Redis の状態を返す。ロックを取れたときだけ公式を読みに行く */
export async function loadLive({ redis, races, date, nowMs, fetchImpl = fetch }) {
  if (!redis || !races.length) return publicView({});
  const key = stateKey(date);
  const state = parseState(await redis(['GET', key]));
  const locked = await redis(['SET', `${key}:lock`, '1', 'NX', 'EX', String(LOCK_SEC)]);
  if (locked !== 'OK') return publicView(state);
  const next = await advanceState({ state, races, date, nowMs, fetchImpl });
  await redis(['SET', key, JSON.stringify(next), 'EX', String(STATE_TTL_SEC)]);
  return publicView(next);
}
