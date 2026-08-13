/**
 * premiumPlusRaceCalendar.js — 「その日は開催があるか」の判定（純粋・I/O なし）
 *
 * ## 前提（実態）
 *
 * **平日は南関、週末は中央（JRA）**があり、年間を通して
 * **中央・南関ともに開催が無い日は 1〜3 日程度**しかない。
 * つまり「開催がある」が既定で、「無い」が例外。
 *
 * ## したがって allow-list ではなく **例外リスト**にする
 *
 * 開催日を全部数え上げる方式（allow-list）にすると、
 * 取り込みが遅れただけで販売が止まる。実態に対して代償が大きすぎる。
 *
 * ここでは **`noRaceDates`（中央・南関とも開催が無い日）だけ**を持ち、
 * それ以外は開催があるものとして扱う。
 *
 * - `noRaceDates` が**空でも通常販売は続く**
 * - 例外日に当たったときだけ、次の販売可能日へ送る
 * - 取込が無いことを理由に販売を止めない
 *
 * ## 開催区分
 *
 * 平日 = 南関 / 土日 = 中央。判定は `premiumPlusRelease.circuitForJst` と同じ規則で、
 * ここでは**日付文字列**から求める（画面・管理画面の表示に使う）。
 *
 * ## 公式カレンダーの自動取込は将来改善
 *
 * 年 1〜3 日の例外を自動で拾うために取込基盤を作る価値はあるが、
 * **販売開始を止める理由にはしない**。例外は手で `noRaceDates` に足せる。
 */

/** 判定結果のコード */
export const RACE_DAY = Object.freeze({
  /** 開催がある（既定） */
  OPEN: 'open',
  /** 例外リストに載っている（中央・南関とも開催が無い） */
  NO_RACE: 'no_race',
  /** 日付の形式が不正 */
  BAD_DATE: 'bad_date',
});

export const RACE_DAY_NOTE = Object.freeze({
  open: '開催があります。',
  no_race: 'この日は中央・南関とも開催がありません。',
  bad_date: '日付が不正です。',
});

/** 開催区分 */
export const CIRCUIT = Object.freeze({
  NANKAN: 'nankan',
  CHUO: 'chuo',
});

export const CIRCUIT_LABEL = Object.freeze({
  nankan: '南関',
  chuo: '中央',
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v.trim());

/**
 * 取り込んだ生データ → 判定に使う形。壊れていても例外を投げない。
 *
 * ⚠️ **空でも正常**。空 = 「例外日が無い」であって「分からない」ではない。
 *
 * @param {{noRaceDates?: string[], source?: string, fetchedAt?: string, note?: string}|null} raw
 */
export function shapeRaceCalendar(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(r.noRaceDates) ? r.noRaceDates : [];
  const noRaceDates = new Set(
    list.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(isDate),
  );
  return {
    noRaceDates,
    source: typeof r.source === 'string' ? r.source : null,
    fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : null,
    /** 例外リストをこの日まで確認済み（表示・警告用。**販売条件ではない**） */
    checkedUntil: isDate(r.checkedUntil) ? r.checkedUntil.trim() : null,
    note: typeof r.note === 'string' ? r.note : null,
    size: noRaceDates.size,
  };
}

/** 'YYYY-MM-DD' → 開催区分（平日=南関 / 土日=中央） */
export function circuitForDate(date) {
  if (!isDate(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  // UTC 正午基準で曜日だけを取る（タイムゾーンの影響を受けない）
  const day = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return day === 0 || day === 6 ? CIRCUIT.CHUO : CIRCUIT.NANKAN;
}

/**
 * その日に開催があるか。**既定は「ある」**。
 *
 * @param {string} date 'YYYY-MM-DD'（JST の暦日）
 * @param {{calendar?: object|null}} ctx
 * @returns {{ok:boolean, code:string, note:string, circuit:string|null, circuitLabel:string|null}}
 */
export function checkRaceDay(date, { calendar } = {}) {
  if (!isDate(date)) return out(RACE_DAY.BAD_DATE, null);
  const d = date.trim();
  const cal = calendar && calendar.noRaceDates instanceof Set ? calendar : shapeRaceCalendar(calendar);
  const circuit = circuitForDate(d);
  // 例外リストに載っているときだけ「開催なし」。**それ以外は開催あり**
  if (cal.noRaceDates.has(d)) return out(RACE_DAY.NO_RACE, circuit);
  return out(RACE_DAY.OPEN, circuit);
}

function out(code, circuit) {
  return {
    ok: code === RACE_DAY.OPEN,
    code,
    note: RACE_DAY_NOTE[code] || '',
    circuit,
    circuitLabel: circuit ? CIRCUIT_LABEL[circuit] : null,
  };
}

/** 'YYYY-MM-DD' に日数を足す（暦日として扱う・タイムゾーンの影響を受けない） */
export function addDays(date, days) {
  if (!isDate(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12) + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * `from` 以降で**最初に開催がある日**。既定で開催があるので、
 * 例外が連続していない限り 1〜2 回で見つかる。
 *
 * @returns {{date:string|null, code:string, note:string, checked:number}}
 */
export function findNextRaceDay(from, { calendar, maxLookaheadDays = 14 } = {}) {
  if (!isDate(from)) return { date: null, code: RACE_DAY.BAD_DATE, note: RACE_DAY_NOTE.bad_date, checked: 0 };
  const cal = calendar && calendar.noRaceDates instanceof Set ? calendar : shapeRaceCalendar(calendar);
  const limit = Math.max(1, Math.min(60, Number(maxLookaheadDays) || 14));

  let cursor = from;
  for (let i = 0; i < limit; i += 1) {
    if (!cal.noRaceDates.has(cursor)) {
      return { date: cursor, code: RACE_DAY.OPEN, note: RACE_DAY_NOTE.open, checked: i + 1 };
    }
    cursor = addDays(cursor, 1);
  }
  // 例外が 14 日続くことは実態としてあり得ないが、暴走はさせない
  return { date: null, code: RACE_DAY.NO_RACE, note: '連続して開催がありません。', checked: limit };
}

/**
 * 例外リストの確認期限が切れていないか。**販売は止めない**が、
 * 気づかず古いまま運用するのを防ぐために警告する。
 *
 * @param {{calendar?: object|null, nowDate?: string, warnWithinDays?: number}} input
 * @returns {{stale:boolean, expiringSoon:boolean, checkedUntil:string|null, note:string}}
 */
export function checkCalendarFreshness({ calendar, nowDate, warnWithinDays = 30 } = {}) {
  const cal = calendar && calendar.noRaceDates instanceof Set ? calendar : shapeRaceCalendar(calendar);
  const today = isDate(nowDate) ? nowDate.trim() : null;
  if (!cal.checkedUntil) {
    return {
      stale: true, expiringSoon: false, checkedUntil: null,
      note: '開催の例外日をどこまで確認したか記録がありません。販売は続きますが、例外日を取りこぼす可能性があります。',
    };
  }
  if (!today) return { stale: false, expiringSoon: false, checkedUntil: cal.checkedUntil, note: '' };
  if (today > cal.checkedUntil) {
    return {
      stale: true, expiringSoon: false, checkedUntil: cal.checkedUntil,
      note: `開催の例外日は ${cal.checkedUntil} までしか確認していません。販売は続きますが、例外日を取りこぼす可能性があります。`,
    };
  }
  const warnFrom = addDays(cal.checkedUntil, -Math.abs(warnWithinDays));
  if (warnFrom && today >= warnFrom) {
    return {
      stale: false, expiringSoon: true, checkedUntil: cal.checkedUntil,
      note: `開催の例外日の確認期限（${cal.checkedUntil}）が近づいています。`,
    };
  }
  return { stale: false, expiringSoon: false, checkedUntil: cal.checkedUntil, note: '' };
}

export default checkRaceDay;
