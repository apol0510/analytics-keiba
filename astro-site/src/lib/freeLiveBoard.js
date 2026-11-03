/**
 * freeLiveBoard.js — 無料予想ページ（/free-prediction/{jra,nankan}/）の「次のレース発走まで」＋「有料版の的中 ✅/✗」
 *
 * 2026-11-03 MK 確定:
 *   - カウントダウンは全レース共通（メインレースを特別扱いしない）
 *   - 公開してよいのは「有料版がそのレースを的中したかどうか（✅/✗）」だけ。買い目・払戻・印・指数は出さない
 *   - 的中・不的中は正直に全部出す（当日の累計は 的中数 / 結果が出たレース数）
 *
 * 結果は当日の全レース終了後にまとめて取り込まれる（中央 17 時台・南関 21 時台 / aiLab.js RESULT_ETA）。
 * 1 レースごとのリアルタイム結果のデータ源は無いので、取込前は「結果待ち」と出す（推測で ✅/✗ を付けない）。
 *
 * 🛑 出力は許可リストのキーだけ（race: venueName / raceNumber / startAt / hit）。archive の bettingLines・umatan・payout を写さない。
 * ⚠️ Node 専用 import を持たない（ブラウザにも同梱する）。時刻は必ず引数 nowMs で受ける。
 */
import { countdown, jstHm, jstDate, RESULT_ETA } from './ailab/aiLab.js';

export { countdown, jstHm };

/** 'YYYY-MM-DD' → 'M/D' */
export function mdLabel(date) {
  const m = DATE_RE.exec(String(date || '')) && String(date).split('-');
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' と 'HH:MM'（JST）→ ISO。読めなければ null（推測しない） */
export function jstToIso(date, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m || typeof date !== 'string' || !DATE_RE.test(date)) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const t = Date.parse(`${date}T${String(h).padStart(2, '0')}:${m[2]}:00+09:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * archive（日付降順の配列）から、date の日の「会場|レース番号 → isHit」を作る。その日が無ければ null。
 * 取るのは isHit だけ。
 */
export function hitMapFor(archiveArray, date) {
  if (!Array.isArray(archiveArray) || !DATE_RE.test(String(date || ''))) return null;
  const day = archiveArray.find((d) => d && d.date === date);
  if (!day || !Array.isArray(day.races) || day.races.length === 0) return null;
  const map = new Map();
  for (const r of day.races) {
    const n = Number(r?.raceNumber);
    if (!r?.venue || !Number.isInteger(n)) continue;
    map.set(`${r.venue}|${n}`, r.isHit === true);
  }
  return map.size ? map : null;
}

/**
 * listModel（buildListModel の戻り値）と結果 archive から表示モデルを作る。
 * @returns {{ cat, date, races: Array<{venueName, raceNumber, startAt, hit}>, resultsIn: boolean, tally: null|{hit,total}, resultEta: string }}
 *   hit: true（✅）/ false（✗）/ null（結果がまだ無い）
 */
export function buildFreeLiveBoard({ cat, model, archiveArray }) {
  const date = model?.date || null;
  const hits = date ? hitMapFor(archiveArray, date) : null;
  const races = [];
  for (const v of model?.venues || []) {
    for (const item of v?.races || []) {
      const n = Number(item?.listing?.raceNumber);
      if (!Number.isInteger(n)) continue;
      const key = `${v.venueName}|${n}`;
      races.push({
        venueName: String(v.venueName || ''),
        raceNumber: n,
        startAt: jstToIso(date, item.listing.startTime),
        hit: hits && hits.has(key) ? hits.get(key) : null,
      });
    }
  }
  const settled = races.filter((r) => r.hit !== null);
  return {
    cat,
    date,
    races,
    resultsIn: settled.length > 0,
    tally: settled.length ? { hit: settled.filter((r) => r.hit).length, total: settled.length } : null,
    resultEta: RESULT_ETA[cat] || '',
  };
}

/** これから発走するうち一番早いレース（時刻未定は除く）。無ければ null */
export function nextRace(races, nowMs) {
  let best = null;
  for (const r of races || []) {
    const t = Date.parse(r?.startAt || '');
    if (!Number.isFinite(t) || t <= nowMs) continue;
    if (!best || t < best.t) best = { t, race: r };
  }
  return best ? best.race : null;
}

/**
 * 1 レースの状態表示。
 *   result  … ✅ 的中 / ✗ 不的中（有料版の結果）
 *   waiting … 発走済み・結果待ち
 *   upcoming… 発走前（HH:MM 発走）
 *   unknown … 発走時刻未定
 */
export function raceStatus(race, nowMs, resultsIn = false) {
  if (race?.hit === true) return { state: 'result', mark: '✅', text: '的中' };
  if (race?.hit === false) return { state: 'result', mark: '✗', text: '不的中' };
  const t = Date.parse(race?.startAt || '');
  if (!Number.isFinite(t)) return { state: 'unknown', mark: '', text: '発走時刻未定' };
  if (t <= nowMs) return resultsIn ? { state: 'none', mark: '', text: '—' } : { state: 'waiting', mark: '', text: '結果待ち' };
  return { state: 'upcoming', mark: '', text: `${jstHm(race.startAt)} 発走` };
}

/** 上部の見出し行（次のレースのカウントダウン、または全レース発走後の案内） */
export function headline(board, nowMs) {
  const next = nextRace(board?.races, nowMs);
  if (next) {
    const c = countdown(next.startAt, nowMs);
    return { state: 'countdown', label: `${next.venueName} ${next.raceNumber}R`, countdown: c.text, at: jstHm(next.startAt) };
  }
  if (!board?.races?.length) return { state: 'none' };
  const day = board.date === jstDate(nowMs) ? '本日' : mdLabel(board.date);
  if (board.resultsIn) return { state: 'done', text: `${day}のレースはすべて終了しました` };
  return { state: 'waiting', text: `${day}の発走はすべて終了。有料版の的中結果は${board.date === jstDate(nowMs) && board.resultEta ? `${board.resultEta}に` : '確定後に'}表示します` };
}
