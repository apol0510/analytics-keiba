/**
 * premiumPlusSaleDate.js — 「いま売っているのは何日分か」の単一源（純粋・I/O なし）
 *
 * ## なぜ必要か
 *
 * 従来、16:30 を過ぎると「本日分の受付は終了しました」で**購入できなかった**。
 * だが商品は「1 日 1 鞍」で毎日ある。締切後に来た人を翌日まで待たせる理由が無く、
 * その時間帯の購入意欲を捨てていた。
 *
 * そこで **16:30 を境に「翌日分」を売る**。売っている対象日が変わるだけで、
 * 買えない時間帯を無くす。
 *
 * ## 対象日の決め方（これがすべて）
 *
 * ```
 *   00:00〜16:29 JST → 本日分
 *   16:30〜23:59 JST → 翌日分
 * ```
 *
 * 16:30 は既存の受付締切（`PP_INTAKE_SCHEDULE.closedFromMin`）と同じ値。
 * **締切の意味が「売らない」から「翌日分へ切り替わる」に変わっただけ**で、
 * 時刻そのものは動かしていない。
 *
 * ## ⚠️ JST の暦日で計算する
 *
 * `toISOString()` の UTC 基準で日付を作ってはいけない。JST の 00:00〜08:59 は
 * UTC ではまだ前日で、1 日ずれる（銀行振込の有効期限で同じ事故があった）。
 *
 * ## 開催は既定で「ある」。例外日だけ次の販売日へ送る
 *
 * 平日は南関、週末は中央があり、**中央・南関とも開催が無い日は年 1〜3 日**しかない。
 * そこで「開催がある」を既定とし、`noRaceDates`（例外リスト）に載っている日だけ
 * 次の販売可能日へ送る。
 *
 * ⚠️ **例外リストが空でも通常販売を続ける。** 取込が無いことを理由に
 *    販売を止めない（実態に対して代償が大きすぎる）。
 *
 * ## ⚠️ 一度確定した対象日は再計算しない
 *
 * 申込の再送・再読込・翌日以降の再実行で対象日が動くと、
 * 「買った日」と「届く日」がズレる。初回申込で確定した値を
 * `resolveOrderSaleDate()` が固定する。
 */

import { checkRaceDay, findNextRaceDay, RACE_DAY, circuitForDate, CIRCUIT_LABEL } from './premiumPlusRaceCalendar.js';

/** 本日分 → 翌日分 に切り替わる時刻（JST の分単位）。既存の受付締切と同じ 16:30 */
export const SALE_CUTOVER_MIN = 16 * 60 + 30;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 売っている対象が「本日分」か「翌日分」か */
export const SALE_TARGET = Object.freeze({
  TODAY: 'today',
  NEXT_DAY: 'next_day',
});

/**
 * ミリ秒 → JST の暦日部品。**UTC 基準で日付を作らない**ための共通処理。
 * @returns {{y:number, m:number, d:number, minutes:number}|null}
 */
export function jstParts(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** JST 暦日部品 → 'YYYY-MM-DD' */
export function formatJstDate(parts) {
  if (!parts) return null;
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

/**
 * いま売っている対象日を決める。**表示も注文もここだけを使う**。
 *
 * @param {number} nowMs
 * @returns {{
 *   ok: boolean,
 *   date: string|null,        'YYYY-MM-DD'（JST の暦日）
 *   target: string,           SALE_TARGET
 *   isNextDay: boolean,
 *   label: string,            '8月14日分'
 *   productLabel: string,     '8月14日分 Premium Plus'
 *   intakeLabel: string,      '本日分 受付中' / '翌日分 受付中'
 *   cutoverMin: number,
 * }}
 */
export function resolveSaleTarget(nowMs, { calendar } = {}) {
  const p = jstParts(nowMs);
  // 時刻が読めないときは**売らない側**へ倒す（fail closed）
  if (!p) {
    return {
      ok: false, sellable: false, date: null, baseDate: null, shifted: false,
      circuit: null, circuitLabel: null,
      reason: 'bad_time', note: '時刻を判定できませんでした。',
      target: SALE_TARGET.TODAY, isNextDay: false,
      label: '', productLabel: '', intakeLabel: '', cutoverMin: SALE_CUTOVER_MIN,
    };
  }
  const isNextDay = p.minutes >= SALE_CUTOVER_MIN;
  // ⚠️ 翌日は **JST の暦日**へ 1 日足してから整形する（UTC 基準で足さない）
  const base = formatJstDate(isNextDay ? jstParts(nowMs + DAY_MS) : p);

  // ── 開催の確認（**既定は「ある」**。例外日だけ送る）──────────────
  const ctx = { calendar };
  const first = checkRaceDay(base, ctx);
  let date = base;
  let shifted = false;
  let reason = first.code;
  let note = first.note;

  if (first.code === RACE_DAY.NO_RACE) {
    // 中央・南関とも開催が無い例外日。次の販売可能日へ送る
    const next = findNextRaceDay(addDaysStr(base, 1), ctx);
    if (next.date) {
      date = next.date;
      shifted = true;
      reason = RACE_DAY.OPEN;
      note = `${base} は中央・南関とも開催がないため、次の開催日（${next.date}）分を販売します。`;
    } else {
      // 例外が連続する異常時のみ。ここは実態としてあり得ない
      date = null;
      reason = next.code;
      note = next.note;
    }
  } else if (first.code === RACE_DAY.BAD_DATE) {
    date = null;
  }

  const sellable = date !== null;
  const parts = sellable ? partsOfDate(date) : null;
  const label = parts ? `${parts.m}月${parts.d}日分` : '';
  const circuit = sellable ? circuitForDate(date) : null;
  return {
    /** 開催区分（平日=南関 / 週末=中央）。画面・管理画面に出す */
    circuit,
    circuitLabel: circuit ? CIRCUIT_LABEL[circuit] : null,
    ok: true,
    /** 販売してよいか。**false なら購入させない**（fail closed） */
    sellable,
    /** 販売対象日。売れないときは null（推測で日付を作らない） */
    date,
    /** 時刻から導いた素の対象日（開催確認の前）。運用ログ・説明用 */
    baseDate: base,
    /** 非開催のため次の開催日へ送ったか */
    shifted,
    /** 売れない/送った理由（RACE_DAY のコード） */
    reason,
    note,
    target: isNextDay ? SALE_TARGET.NEXT_DAY : SALE_TARGET.TODAY,
    isNextDay,
    label,
    productLabel: label ? `${label} Premium Plus` : 'Premium Plus',
    intakeLabel: isNextDay ? '翌日分 受付中' : '本日分 受付中',
    cutoverMin: SALE_CUTOVER_MIN,
  };
}

/** 'YYYY-MM-DD' → 暦日部品 */
function partsOfDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return { y, m, d };
}

/** 'YYYY-MM-DD' に日を足す（カレンダー側と同じ計算） */
function addDaysStr(date, days) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12) + days * 86400000;
  const dt = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * 注文に載せる商品名。**対象日を必ず含める**。
 *
 * 管理者通知メール・お客様控え・申請履歴はすべてこの文字列を運ぶので、
 * ここに日付が入っていれば「どの日の買い目を届けるか」が経路の端まで残る。
 *
 * @param {string} label   `resolveSaleTarget().label`
 * @param {number} price
 */
export function buildSaleProductName(label, price) {
  const yen = Number.isFinite(price) ? `¥${price.toLocaleString('ja-JP')}` : '';
  const head = label ? `Premium Plus ${label}` : 'Premium Plus';
  return yen ? `${head} (${yen})` : head;
}

/**
 * 受け取った対象日が、サーバーが今出すべき対象日と一致するか。
 *
 * ⚠️ **クライアントの値をそのまま採用しない。** 画面を開いたまま 16:30 をまたぐと
 * ずれるので、注文はサーバーが出し直した日付で確定させる。
 * ここは「ずれていたか」を運用ログへ残すための判定。
 *
 * @returns {{match:boolean, server:string|null, claimed:string|null}}
 */
export function verifySaleTarget(claimed, nowMs, ctx) {
  const server = resolveSaleTarget(nowMs, ctx);
  const c = typeof claimed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(claimed.trim())
    ? claimed.trim() : null;
  return { match: !!server.date && c === server.date, server: server.date, claimed: c };
}

/**
 * ── 注文の対象日を**確定させる**（冪等）──────────────────────────
 *
 * 一度確定した対象日は**二度と再計算しない**。再送・再読込・翌日以降の
 * 再実行で日付が動くと「買った日」と「届く日」がズレる。
 *
 * @param {{
 *   storedDate?: string|null,   すでに注文へ保存されている対象日
 *   nowMs: number,
 *   calendar?: object|null,
 *   knownRaceDates?: string[],
 * }} input
 * @returns {{
 *   date: string|null, label: string, productLabel: string,
 *   sellable: boolean, reused: boolean, reason: string, note: string,
 * }}
 */
export function resolveOrderSaleDate({ storedDate, nowMs, calendar } = {}) {
  const stored = typeof storedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(storedDate.trim())
    ? storedDate.trim() : null;
  if (stored) {
    // ⚠️ 保存済みなら**それが正**。開催カレンダーで再判定もしない
    //    （確定後にカレンダーが変わっても、客に約束した日は変えない）。
    const parts = partsOfDate(stored);
    const label = `${parts.m}月${parts.d}日分`;
    const c = circuitForDate(stored);
    return {
      date: stored, label, productLabel: `${label} Premium Plus`,
      circuit: c, circuitLabel: c ? CIRCUIT_LABEL[c] : null,
      sellable: true, reused: true, reason: 'stored',
      note: '初回申込で確定した対象日をそのまま使います（再計算しません）。',
    };
  }
  const t = resolveSaleTarget(nowMs, { calendar });
  return {
    date: t.date, label: t.label, productLabel: t.productLabel,
    circuit: t.circuit, circuitLabel: t.circuitLabel,
    sellable: t.sellable, reused: false, reason: t.reason, note: t.note,
  };
}

export default resolveSaleTarget;
