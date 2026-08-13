/**
 * premiumPlusRaceCalendar.js — 「その日は開催があるか」の判定（純粋・I/O なし）
 *
 * ## なぜ必要か
 *
 * 16:30 以降は翌日分を売る。だが **翌日に開催が無ければ、届かない日を売ることになる**。
 * 「たぶん毎日ある」で売ってはいけない。
 *
 * ## 正本と fail closed
 *
 * 開催日の正本は **取り込んだ開催カレンダー**（`src/data/premiumPlusRaceCalendar.json`）。
 * 取り込みは `scripts/importRaceCalendar.mjs` が行う。
 *
 * ⚠️ **分からない日は売らない。** 次のどれかに当たれば販売しない:
 *   - カレンダーが無い / 空
 *   - カレンダーの有効期間より先の日付を聞かれた（`coversUntil` を過ぎている）
 *   - その日が開催日として載っていない
 *
 * 「載っていない = 非開催」と断定できるのは **カレンダーがその日を含む期間を
 * カバーしているときだけ**。カバー範囲外は「非開催」ではなく「不明」であり、
 * どちらも**売らない**が、理由を分けて返す（運用が原因を特定できるように）。
 *
 * ## 本日分は別扱いにしない
 *
 * 本日分もこのカレンダーで判定する。ただし本日は**予想データが既に存在する**ので、
 * 呼び出し側は `knownRaceDates`（当日データ由来）を追加の根拠として渡せる。
 * カレンダー未整備でも本日分の販売が止まらないようにするための逃げ道で、
 * **将来日には使えない**（将来日の予想データは存在しないため）。
 */

/** 判定結果のコード */
export const RACE_DAY = Object.freeze({
  /** 開催がある（売ってよい） */
  OPEN: 'open',
  /** 開催が無い（載っているが非開催） */
  CLOSED: 'closed',
  /** カレンダーが無い / 空 */
  NO_CALENDAR: 'no_calendar',
  /** カレンダーの有効期間より先（分からない） */
  OUT_OF_RANGE: 'out_of_range',
  /** 日付の形式が不正 */
  BAD_DATE: 'bad_date',
});

export const RACE_DAY_NOTE = Object.freeze({
  open: '開催があります。',
  closed: 'この日は開催がありません。',
  no_calendar: '開催カレンダーが取り込まれていません。開催の有無を確認できないため販売しません。',
  out_of_range: '開催カレンダーの有効期間を過ぎています。開催の有無を確認できないため販売しません。',
  bad_date: '日付が不正です。',
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = (v) => typeof v === 'string' && DATE_RE.test(v.trim());

/**
 * 取り込んだ生データ → 判定に使う形。壊れていても例外を投げない。
 *
 * @param {{dates?: string[], coversUntil?: string, source?: string, fetchedAt?: string}|null} raw
 */
export function shapeRaceCalendar(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const dates = new Set(
    (Array.isArray(r.dates) ? r.dates : [])
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter(isDate),
  );
  return {
    dates,
    /** この日までは「載っていなければ非開催」と言い切れる */
    coversUntil: isDate(r.coversUntil) ? r.coversUntil.trim() : null,
    source: typeof r.source === 'string' ? r.source : null,
    fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : null,
    size: dates.size,
  };
}

/**
 * その日に開催があるか。**分からないときは OPEN を返さない。**
 *
 * @param {string} date 'YYYY-MM-DD'（JST の暦日）
 * @param {{calendar?: object|null, knownRaceDates?: string[]}} ctx
 *   knownRaceDates … 当日データ等、カレンダー以外で開催が確定している日
 * @returns {{ok:boolean, code:string, note:string}}
 */
export function checkRaceDay(date, { calendar, knownRaceDates } = {}) {
  if (!isDate(date)) return out(RACE_DAY.BAD_DATE);
  const d = date.trim();

  // カレンダー以外で開催が確定している日（当日の予想データ等）
  const known = Array.isArray(knownRaceDates) ? knownRaceDates.filter(isDate) : [];
  if (known.includes(d)) return out(RACE_DAY.OPEN);

  const cal = calendar && calendar.dates instanceof Set ? calendar : shapeRaceCalendar(calendar);
  if (cal.size === 0) return out(RACE_DAY.NO_CALENDAR);
  if (cal.dates.has(d)) return out(RACE_DAY.OPEN);
  // 載っていない。**カバー範囲内なら非開催と言い切れる**が、範囲外なら「不明」
  if (!cal.coversUntil || d > cal.coversUntil) return out(RACE_DAY.OUT_OF_RANGE);
  return out(RACE_DAY.CLOSED);
}

function out(code) {
  return { ok: code === RACE_DAY.OPEN, code, note: RACE_DAY_NOTE[code] || '' };
}

/** 'YYYY-MM-DD' に日数を足す（JST の暦日として扱う・UTC 基準にしない） */
export function addDays(date, days) {
  if (!isDate(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  // UTC の正午を基準にして日付だけを動かす（タイムゾーンの影響を受けない）
  const t = Date.UTC(y, m - 1, d, 12) + days * 86400000;
  const dt = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * `from` 以降で**最初に開催がある日**を返す。
 *
 * ⚠️ 見つからない / 分からないときは **null**（＝売らない）。
 *    「たぶんこの辺」で日付を作らない。
 *
 * @param {string} from 'YYYY-MM-DD'（この日を含めて探す）
 * @param {{calendar?: object|null, knownRaceDates?: string[], maxLookaheadDays?: number}} ctx
 * @returns {{date:string|null, code:string, note:string, checked:number}}
 */
export function findNextRaceDay(from, { calendar, knownRaceDates, maxLookaheadDays = 14 } = {}) {
  if (!isDate(from)) return { date: null, ...pick(RACE_DAY.BAD_DATE), checked: 0 };
  const cal = calendar && calendar.dates instanceof Set ? calendar : shapeRaceCalendar(calendar);
  const limit = Math.max(1, Math.min(60, Number(maxLookaheadDays) || 14));

  let cursor = from;
  for (let i = 0; i < limit; i += 1) {
    const r = checkRaceDay(cursor, { calendar: cal, knownRaceDates });
    if (r.code === RACE_DAY.OPEN) return { date: cursor, ...pick(RACE_DAY.OPEN), checked: i + 1 };
    // 「不明」に当たったらそこで止める。**その先を推測で探さない**
    if (r.code !== RACE_DAY.CLOSED) return { date: null, ...pick(r.code), checked: i + 1 };
    cursor = addDays(cursor, 1);
  }
  // 期間内に開催が見つからなかった。これも売らない
  return { date: null, ...pick(RACE_DAY.OUT_OF_RANGE), checked: limit };
}

function pick(code) {
  return { code, note: RACE_DAY_NOTE[code] || '' };
}

export default checkRaceDay;
