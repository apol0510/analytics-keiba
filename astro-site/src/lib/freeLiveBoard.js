/**
 * freeLiveBoard.js — 無料予想ページ（/free-prediction/{jra,nankan}/）の「次のレース発走まで」＋「有料版の的中 ✅/✗」
 *
 * 2026-11-03 MK 確定:
 *   - カウントダウンは全レース共通（メインレースを特別扱いしない）
 *   - 公開してよいのは「有料版がそのレースを的中したかどうか（✅/✗）」だけ。買い目・払戻・印・指数は出さない
 *   - 的中・不的中は正直に全部出す（当日の累計は 的中数 / 結果が出たレース数）
 *
 * 結果は当日の全レース終了後にまとめて取り込まれる（中央 17 時台・南関 21 時台 / aiLab.js RESULT_ETA）。
 * 結果が無いレースは発走予定時刻だけを出す（推測で ✅/✗ を付けない）。
 *
 * 2026-11-04 MK 確定:
 *   - レースごとの待ち表示は出さない。結果の案内は画面の注記に 1 か所だけ（RESULT_NOTE）
 *   - 発走予定時刻を過ぎただけで発走済み・終了と断定しない（放馬等で遅れることがある）
 *   - 予定時刻を過ぎても DUE_HOLD_SEC の間は、同じ会場の次のレースへ切り替えない
 *
 * 🛑 出力は許可リストのキーだけ（race: venueName / raceNumber / startAt / hit）。archive の bettingLines・umatan・payout を写さない。
 * ⚠️ Node 専用 import を持たない（ブラウザにも同梱する）。時刻は必ず引数 nowMs で受ける。
 */
import { BET_CUTOFF_LEAD_SEC, BET_CUTOFF_NOTE, countdown, cutoffAt, jstHm, jstDate } from './ailab/aiLab.js';

export { BET_CUTOFF_NOTE, countdown, cutoffAt, jstHm };

const CUTOFF_MS = BET_CUTOFF_LEAD_SEC * 1000;

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
 * @returns {{ cat, date, races: Array<{venueName, raceNumber, startAt, hit}>, resultsIn: boolean, tally: null|{hit,total} }}
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
  const tally = tallyOf(races);
  return {
    cat,
    date,
    races,
    resultsIn: tally !== null,
    tally,
  };
}

/** 予定時刻を過ぎても、この秒数は同じ会場の次のレースへ切り替えない（放馬・蹄鉄の打ち直しなどの遅れ） */
export const DUE_HOLD_SEC = 600;
/** 結果の案内はこの 1 か所だけ */
export const RESULT_NOTE = 'レース結果は取得後に反映されます';

/**
 * 今見せるレース。{ race, due } か null。
 * 会場ごとに「結果が無く、予定時刻 + DUE_HOLD_SEC を過ぎていない最初のレース」を先頭とし、
 * 締切前の先頭があれば一番早いもの（due: false）、全会場が締切を過ぎていれば due: true。
 * 別の会場は遅れの影響を受けないので、そちらのカウントダウンは止めない。
 */
export function currentRace(races, nowMs) {
  const heads = new Map();
  for (const r of races || []) {
    const t = Date.parse(r?.startAt || '');
    if (!Number.isFinite(t) || typeof r.hit === 'boolean' || t + DUE_HOLD_SEC * 1000 <= nowMs) continue;
    const key = `${r.cat || ''}|${r.venueName}`;
    const cur = heads.get(key);
    if (!cur || t < cur.t) heads.set(key, { t, race: r });
  }
  const list = [...heads.values()].sort((a, b) => a.t - b.t);
  const upcoming = list.find((h) => h.t - CUTOFF_MS > nowMs);
  if (upcoming) return { race: upcoming.race, due: false };
  return list.length ? { race: list[0].race, due: true } : null;
}

/** 次に発走を迎えるレース（時刻未定は除く）。予定時刻を過ぎたレースを保留中なら null */
export function nextRace(races, nowMs) {
  const c = currentRace(races, nowMs);
  return c && !c.due ? c.race : null;
}

/**
 * 1 レースの状態表示。next は nextRace の戻り値（同じオブジェクトなら「次」として強調する）。
 *   result  … ✅ 的中 / ✗ 不的中（有料版の結果）
 *   past    … 予定時刻を過ぎて結果が無い（予定時刻だけを控えめに出す）
 *   due     … 予定時刻を過ぎた直後（遅れの可能性があるので控えめにしない）
 *   next    … 次のレース
 *   upcoming… 予定時刻前
 *   unknown … 発走時刻未定
 */
export function raceStatus(race, nowMs, next = null) {
  if (race?.hit === true) return { state: 'result', mark: '✅', text: '的中' };
  if (race?.hit === false) return { state: 'result', mark: '✗', text: '不的中' };
  const t = Date.parse(race?.startAt || '');
  if (!Number.isFinite(t)) return { state: 'unknown', mark: '', text: '発走時刻未定' };
  const hm = jstHm(race.startAt);
  if (t - CUTOFF_MS > nowMs) return next && race === next ? { state: 'next', mark: '', text: `次 ${hm}` } : { state: 'upcoming', mark: '', text: `${hm} 予定` };
  return t + DUE_HOLD_SEC * 1000 > nowMs ? { state: 'due', mark: '', text: `${hm} 予定` } : { state: 'past', mark: '', text: hm };
}

/** ライブ情報の取得先（南関だけ。単一源は lib/freeBoardLive.js） */
export const LIVE_URL = '/api/free-board/live.json';
export const LIVE_POLL_MS = 60 * 1000;

/**
 * /api/free-board/live.json の値を races へ反映する（ブラウザ専用の入口・races を書き換える）。
 * 🛑 archive から入った hit は上書きしない（確定値が勝つ）。date が違う応答は使わない。
 */
export function applyLive(races, date, live) {
  if (!live || live.date !== date) return false;
  let changed = false;
  for (const r of races || []) {
    const key = `${r.venueName}|${r.raceNumber}`;
    if (r.scheduledAt === undefined) r.scheduledAt = r.startAt;
    const startAt = live.times?.[key] || r.scheduledAt;
    if (startAt !== r.startAt) { r.startAt = startAt; changed = true; }
    if (r.hit === true || r.hit === false) continue;
    if (typeof live.hits?.[key] === 'boolean') { r.hit = live.hits[key]; changed = true; }
  }
  return changed;
}

/** 当日累計（的中数 / 結果が出たレース数）。無ければ null */
export function tallyOf(races) {
  const settled = (races || []).filter((r) => typeof r?.hit === 'boolean');
  return settled.length ? { hit: settled.filter((r) => r.hit).length, total: settled.length } : null;
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
 * 円形ゲージの表示モデル。残り時間は締切まで。startAt は発走予定時刻で渡す。締切を過ぎた・時刻不明は null（ゲージを出さない）。
 *   fraction … 残りの割合 0〜1 ／ second … 周回する点の位置 0〜59 ／ main・sub … 中央の 2 行
 */
export function ringModel(startAt, nowMs) {
  const c = countdown(cutoffAt(startAt), nowMs);
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
    const c = currentRace(feed.filter((r) => r?.cat === cat), nowMs);
    if (c) byCat.set(cat, { ...c.race, due: c.due });
  }
  const list = [...byCat.values()].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (!list.length) return [];
  const day = jstDate(Date.parse(list[0].startAt));
  return list.filter((r) => jstDate(Date.parse(r.startAt)) === day);
}

/** 「次のレース」の時刻の行。r は nextRacesByCat の要素 */
export function nextRaceAtText(r, nowMs) {
  const cut = jstHm(cutoffAt(r.startAt));
  return r.due ? `締切時刻（${cut}）を過ぎました` : `${dayPrefix(r.startAt, nowMs)}${cut} 締切（${jstHm(r.startAt)} 発走予定）`;
}

/** 上部の見出し行（次のレースのカウントダウン、予定時刻を過ぎたレース、または全レース後の案内） */
export function headline(board, nowMs) {
  const cur = currentRace(board?.races, nowMs);
  if (cur && !cur.due) {
    const c = countdown(cutoffAt(cur.race.startAt), nowMs);
    return { state: 'countdown', cutoff: `${dayPrefix(cur.race.startAt, nowMs)}${jstHm(cutoffAt(cur.race.startAt))}`, label: `${cur.race.venueName} ${cur.race.raceNumber}R`, countdown: c.text, at: `${dayPrefix(cur.race.startAt, nowMs)}${jstHm(cur.race.startAt)}`, startAt: cur.race.startAt };
  }
  if (cur) return { state: 'due', label: `${cur.race.venueName} ${cur.race.raceNumber}R`, at: jstHm(cur.race.startAt), cutoff: jstHm(cutoffAt(cur.race.startAt)) };
  if (!board?.races?.length) return { state: 'none' };
  const today = board.date === jstDate(nowMs);
  const day = today ? '本日' : mdLabel(board.date);
  const timed = board.races.filter((r) => Number.isFinite(Date.parse(r?.startAt || '')));
  const allIn = timed.length > 0 && timed.every((r) => typeof r.hit === 'boolean');
  if (allIn || (board.resultsIn && !today)) return { state: 'done', text: `${day}のレースはすべて終了しました` };
  return { state: 'passed', text: `${day}の最終レースの発走予定時刻を過ぎました` };
}
