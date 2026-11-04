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

/** 発走日の表示。今日は ''・翌日は '明日 '・それ以外は 'M/D '（前日夜に翌日分を出すときに時刻だけだと今日に読める） */
export function dayPrefix(startAt, nowMs) {
  const t = Date.parse(startAt || '');
  if (!Number.isFinite(t)) return '';
  const day = jstDate(t);
  if (day === jstDate(nowMs)) return '';
  if (day === jstDate(nowMs + 86400e3)) return '明日 ';
  return `${mdLabel(day)} `;
}

/** 円形ゲージの目盛り: 1 周 = 60 分（時計と同じ読み方）。60 分以上前は満タン */
export const RING_WINDOW_SEC = 3600;
/** ここから先は「まもなく」の色（金）に変える */
export const RING_SOON_SEC = 300;

/**
 * 円形ゲージの表示モデル。発走済み・時刻不明は null（ゲージを出さない）。
 *   fraction … 残りの割合 0〜1 ／ second … 周回する点の位置 0〜59 ／ main・sub … 中央の 2 行
 */
export function ringModel(startAt, nowMs) {
  const c = countdown(startAt, nowMs);
  if (c.started || c.seconds == null) return null;
  const sec = c.seconds;
  const hr = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return {
    fraction: Math.min(1, sec / RING_WINDOW_SEC),
    second: s,
    soon: sec <= RING_SOON_SEC,
    main: hr > 0 ? `${hr}時間` : `${m}分`,
    sub: hr > 0 ? `${String(m).padStart(2, '0')}分` : `${String(s).padStart(2, '0')}秒`,
  };
}

/** CountdownRing.astro の DOM を ringModel で塗る（ブラウザ専用）。null なら隠す */
export function paintRing(el, ring) {
  if (!el) return;
  el.hidden = !ring;
  if (!ring) return;
  el.classList.toggle('is-soon', ring.soon);
  el.querySelector('[data-ring-arc]')?.setAttribute('stroke-dasharray', `${(ring.fraction * 100).toFixed(2)} 100`);
  el.querySelector('[data-ring-dot]')?.setAttribute('transform', `rotate(${ring.second * 6} 50 50)`);
  const main = el.querySelector('[data-ring-main]');
  const sub = el.querySelector('[data-ring-sub]');
  if (main && main.textContent !== ring.main) main.textContent = ring.main;
  if (sub && sub.textContent !== ring.sub) sub.textContent = ring.sub;
}

/**
 * トップ・/free/ の「次のレース」。feed = [{ cat, venueName, raceNumber, startAt }]
 * 一番早いレースと同じ日にレースがある区分だけを、区分ごとに 1 件返す
 * （土日は中央・南関が並び、夜は翌日分へ切り替わる。翌日分と当日分を混ぜない）。発走前のレースが無ければ []。
 */
export function nextRacesByCat(feed, nowMs) {
  const byCat = new Map();
  for (const cat of new Set((feed || []).map((r) => r?.cat))) {
    const next = nextRace(feed.filter((r) => r?.cat === cat), nowMs);
    if (next) byCat.set(cat, next);
  }
  const list = [...byCat.values()].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (!list.length) return [];
  const day = jstDate(Date.parse(list[0].startAt));
  return list.filter((r) => jstDate(Date.parse(r.startAt)) === day);
}

/** 上部の見出し行（次のレースのカウントダウン、または全レース発走後の案内） */
export function headline(board, nowMs) {
  const next = nextRace(board?.races, nowMs);
  if (next) {
    const c = countdown(next.startAt, nowMs);
    return { state: 'countdown', label: `${next.venueName} ${next.raceNumber}R`, countdown: c.text, at: `${dayPrefix(next.startAt, nowMs)}${jstHm(next.startAt)}`, startAt: next.startAt };
  }
  if (!board?.races?.length) return { state: 'none' };
  const day = board.date === jstDate(nowMs) ? '本日' : mdLabel(board.date);
  if (board.resultsIn) return { state: 'done', text: `${day}のレースはすべて終了しました` };
  return { state: 'waiting', text: `${day}の発走はすべて終了。有料版の的中結果は${board.date === jstDate(nowMs) && board.resultEta ? `${board.resultEta}に` : '確定後に'}表示します` };
}
