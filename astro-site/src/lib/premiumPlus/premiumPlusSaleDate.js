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
 * ## ⚠️ 翌日が非開催日かは**判定できない**
 *
 * 2026-08-13 時点で、この repo に開催カレンダーは無く、将来日の開催有無を知る
 * データ源も無い（予想データは当日に dispatch で届く）。
 * したがって「翌日が非開催なら次の開催日へ送る」は**実装しない**。
 * 推測で日付を作ると、届かない日を売ることになる。
 * 対象日は管理画面と申込通知に必ず出すので、非開催時は運用で気づける。
 */

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
export function resolveSaleTarget(nowMs) {
  const p = jstParts(nowMs);
  // 時刻が読めないときは**売らない側**へ倒す（fail closed）
  if (!p) {
    return {
      ok: false, date: null, target: SALE_TARGET.TODAY, isNextDay: false,
      label: '', productLabel: '', intakeLabel: '', cutoverMin: SALE_CUTOVER_MIN,
    };
  }
  const isNextDay = p.minutes >= SALE_CUTOVER_MIN;
  // ⚠️ 翌日は **JST の暦日**へ 1 日足してから整形する（UTC 基準で足さない）
  const target = isNextDay ? jstParts(nowMs + DAY_MS) : p;
  const date = formatJstDate(target);
  const label = `${target.m}月${target.d}日分`;
  return {
    ok: true,
    date,
    target: isNextDay ? SALE_TARGET.NEXT_DAY : SALE_TARGET.TODAY,
    isNextDay,
    label,
    productLabel: `${label} Premium Plus`,
    intakeLabel: isNextDay ? '翌日分 受付中' : '本日分 受付中',
    cutoverMin: SALE_CUTOVER_MIN,
  };
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
export function verifySaleTarget(claimed, nowMs) {
  const server = resolveSaleTarget(nowMs);
  const c = typeof claimed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(claimed.trim())
    ? claimed.trim() : null;
  return { match: !!server.date && c === server.date, server: server.date, claimed: c };
}

export default resolveSaleTarget;
