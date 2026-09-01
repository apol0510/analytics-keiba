/**
 * memberExtras.js — 無料会員登録で開く「拡張表示」の算出（**純粋・I/O なし**）
 *
 * ── なぜ登録特典にできるか ────────────────────────────────────
 * `/free-prediction/`（有料版プレビュー）は未登録に**全頭・過去5走・条件別成績**を出している。
 * したがって「過去走を見せる」類は**そちらから迂回できるので特典にならない**。
 * ここで扱うのは `/free-prediction/` に**無い切り口**だけ:
 *
 *   1. 出走間隔        … 前走からの日数（連闘 / 中◯週 / 休養明け）
 *   2. 馬体重の増減    … 前走時点の増減（生値は出ているが「増減」は出していない）
 *   3. 条件変化の履歴  … 過去5走ぶんの会場・距離の推移（羅列はあるが整理していない）
 *   4. 同条件馬の横比較… 前走が同会場・近い距離の馬だけを抜き出して横並び
 *
 * ── 出さないもの ──────────────────────────────────────────────
 * 買い目 / `pt` / AI総合指数 / 役割 / 特徴量。**入力にも使っていない。**
 * 扱うのは公開事実（過去走の日付・会場・距離・着順・馬体重）だけなので、
 * ゲートが破られても有料情報は漏れない。
 */

import { DISTANCE_CHANGE_METERS } from './thresholds.js';

/**
 * 「長い休み」とみなす日数。**2ヶ月 = 60 日**（2026-09-01 に 84 → 60 へ改定）。
 * 休み明け / 叩き◯戦目 / `calcInterval` の「休養明け」ラベルは、すべてこの 1 つの値を基準にする。
 *
 * 暦月ではなく日数で扱う（本モジュールは日数演算で統一。差は 1〜2 日）。
 */
export const LAYOFF_DAYS = 60;

/**
 * 「続けて使っている（＝叩いている）」と言える間隔の上限。**中6週 = 42 日**。
 *
 * 休み明け以降がこの間隔以内で続いているときだけ「叩き◯戦目」を名乗る。
 * これが無いと、70 日おきに走るローテ馬まで「叩き◯戦目」になってしまう
 * （2026-09-02 大井 11R ③ティントレットの実例。`docs/decisions.md` 2026-09-01 参照）。
 *
 * ⚠️ `LAYOFF_DAYS` / `CAMPAIGN_MAX_GAP_DAYS` はどちらも**判断値**であって測定値ではない。
 *    変更時は `docs/decisions.md` に新旧と理由を残し、境界テストを更新すること。
 */
export const CAMPAIGN_MAX_GAP_DAYS = 42;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `YYYY-MM-DD` を UTC ミリ秒へ。解釈できなければ null。 */
export function parseDate(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/**
 * 出走間隔。**日付が取れないときは null**（「連闘」と誤って言わないため）。
 *
 * 中◯週 は「前走から何週空けたか」。7 日以内を連闘、`LAYOFF_DAYS`（60日＝2ヶ月）以上を休養明けとする。
 *
 * @param {string} raceDate 今日のレース日（YYYY-MM-DD）
 * @param {string} prevDate 前走の日付（YYYY-MM-DD）
 * @returns {{days: number, label: string, longLayoff: boolean}|null}
 */
export function calcInterval(raceDate, prevDate) {
  const a = parseDate(raceDate);
  const b = parseDate(prevDate);
  if (a === null || b === null) return null;
  const days = Math.round((a - b) / 86400000);
  if (days < 0) return null;
  // 中◯週 = 前走との間に挟まった週数。7 日後（翌週の同曜日）は連闘で中 0 週。
  // 8 日 → 中1週 / 14 日 → 中1週 / 21 日 → 中2週 となるよう floor((days-1)/7) を使う。
  const weeks = Math.floor((days - 1) / 7);
  if (weeks <= 0) return { days, label: '連闘', longLayoff: false };
  if (days >= LAYOFF_DAYS) return { days, label: `休養明け（中${weeks}週）`, longLayoff: true };
  return { days, label: `中${weeks}週`, longLayoff: false };
}

/**
 * 馬体重の増減。**前走時点の増減**（当日の馬体重は発走前には確定しないため）。
 * 2 走ぶんの体重が揃わなければ null。
 *
 * @param {Array<{bodyWeight?: unknown}>} past 新しい順の過去走
 * @returns {{latest: number, diff: number|null}|null}
 */
export function calcBodyWeight(past) {
  const list = Array.isArray(past) ? past : [];
  const latest = num(list[0]?.bodyWeight);
  if (latest === null) return null;
  const prev = num(list[1]?.bodyWeight);
  return { latest, diff: prev === null ? null : latest - prev };
}

/**
 * 条件変化の履歴。過去走を新しい順に並べ、**1 走ごとに会場・距離が変わったか**を付ける。
 * 直近の走が今日の条件と比べてどうかも `vsToday` で示す。
 *
 * @param {Array<{venue?: string, distance?: unknown, finish?: unknown}>} past
 * @param {{venue: string, distanceMeters: number|null}} today
 */
export function buildConditionHistory(past, today) {
  const list = (Array.isArray(past) ? past : []).slice(0, 5);
  const todayDistance = num(today?.distanceMeters);
  return list.map((p, i) => {
    const distance = num(p?.distance);
    const older = list[i + 1];
    const olderDistance = older ? num(older.distance) : null;
    return {
      venue: p?.venue ?? null,
      distance,
      finish: p?.finish ?? null,
      // ひとつ前（より古い走）と比べて変わったか。最後の 1 走は比較対象が無いので null
      venueChanged: older ? (p?.venue !== older.venue) : null,
      distanceChanged: (distance !== null && olderDistance !== null)
        ? Math.abs(distance - olderDistance) >= DISTANCE_CHANGE_METERS
        : null,
      // 今日の条件と同じか（最新走だけ意味を持つ）
      vsToday: i === 0
        ? {
          sameVenue: p?.venue != null && today?.venue != null ? p.venue === today.venue : null,
          distanceDiff: (distance !== null && todayDistance !== null) ? distance - todayDistance : null,
        }
        : null,
    };
  });
}

/**
 * 同条件馬の横比較。**前走が今日と同じ会場・近い距離**の馬だけを抜き出す。
 * 前走の着順順（数値でないものは後ろ）に並べる。
 *
 * `/free-prediction/` は馬ごとに縦へ出すだけで、この横並びは無い。
 *
 * @param {Array<{number: number, name: string, prev: object|null}>} horses
 * @param {{venue: string, distanceMeters: number|null}} today
 * @returns {Array<{number: number, name: string, finish: unknown, distance: number|null, bodyWeight: number|null}>}
 */
export function buildSameConditionTable(horses, today) {
  const todayDistance = num(today?.distanceMeters);
  if (todayDistance === null || !today?.venue) return [];
  const rows = (Array.isArray(horses) ? horses : []).flatMap((h) => {
    const p = h?.prev;
    if (!p) return [];
    const distance = num(p.distance);
    if (distance === null) return [];
    if (p.venue !== today.venue) return [];
    if (Math.abs(distance - todayDistance) >= DISTANCE_CHANGE_METERS) return [];
    return [{
      number: h.number,
      name: h.name,
      finish: p.finish ?? null,
      distance,
      bodyWeight: num(p.bodyWeight),
    }];
  });
  const rank = (v) => {
    const n = num(v);
    return n === null ? Number.POSITIVE_INFINITY : n;
  };
  return rows.sort((a, b) => rank(a.finish) - rank(b.finish) || a.number - b.number);
}


/**
 * 休み明け / 叩き◯戦目。
 *
 * 長い休み（`LAYOFF_DAYS` 以上の間隔）のあと、**今日が何戦目か**を数える。
 *   今日 ← 前走 の間隔が長い            → 休み明け（＝復帰初戦）
 *   前走 ← 2走前 の間隔が長い           → 叩き2戦目
 *   2走前 ← 3走前 の間隔が長い          → 叩き3戦目 …
 *
 * ただし **「叩き」を名乗れるのは、休み明け以降を詰めて使っているときだけ**。
 * 休み明け以降の各間隔が 1 本でも `CAMPAIGN_MAX_GAP_DAYS` を超えていたら `null` を返す
 * （例: 70 日おきに 3 走している馬を「叩き3戦目」と読ませない）。
 * 「休み明け」自体（今日 ← 前走が長い）はこの条件の対象外＝そのまま出す。
 *
 * **持っている過去走の範囲でしか分からない**。5 走ぶんしか無いので、
 * それより前に休みがあった場合は判定できず `null` を返す
 * （「休み明けではない」と断定しない）。日付が欠けたらそこで打ち切る。
 *
 * @param {string} raceDate 今日のレース日
 * @param {Array<{date?: string}>} past 新しい順の過去走
 * @returns {{kind: 'layoff'|'run-after-layoff', nth: number, gapDays: number}|null}
 */
export function calcLayoffRun(raceDate, past) {
  const list = Array.isArray(past) ? past : [];
  const today = parseDate(raceDate);
  if (today === null || list.length === 0) return null;

  // gaps[i] = （今日 or list[i-1]） ← list[i] の間隔。長い休みを見つけた時点で
  // gaps[0..i-1] が「休み明け以降の各間隔」になる。
  const gaps = [];
  let prev = today;
  for (let i = 0; i < list.length; i += 1) {
    const at = parseDate(list[i]?.date);
    if (at === null) return null;           // 日付が欠けたら判定しない
    const gap = Math.round((prev - at) / 86400000);
    if (gap < 0) return null;               // 並びが壊れている
    gaps.push(gap);
    if (gap >= LAYOFF_DAYS) {
      // i=0 なら今日が休み明け（復帰初戦）。詰めて使ったかは問わない。
      if (i === 0) return { kind: 'layoff', nth: 1, gapDays: gap };
      // i>=1 は「休み明けから i+1 走目」。ただし休み明け以降を詰めて使っている場合だけ
      // 「叩き」と呼ぶ。1 本でも空いていたら判定しない（断定より無表示を選ぶ）。
      const ranTight = gaps.slice(0, i).every((g) => g <= CAMPAIGN_MAX_GAP_DAYS);
      if (!ranTight) return null;
      return { kind: 'run-after-layoff', nth: i + 1, gapDays: gap };
    }
    prev = at;
  }
  return null;                               // 持っている範囲に長い休みが無い
}

/**
 * 1 頭ぶんの拡張情報をまとめる。データが無い項目は **null のまま返す**
 * （「該当なし」と「データが無い」を取り違えさせないため）。
 */
export function buildHorseExtras(horse, today) {
  const past = Array.isArray(horse?.past) ? horse.past : [];
  if (past.length === 0) return null;
  return {
    interval: calcInterval(today?.date, past[0]?.date),
    layoffRun: calcLayoffRun(today?.date, past),
    bodyWeight: calcBodyWeight(past),
    history: buildConditionHistory(past, today),
  };
}

export default {
  parseDate, calcInterval, calcLayoffRun, calcBodyWeight, buildConditionHistory,
  buildSameConditionTable, buildHorseExtras, LAYOFF_DAYS, CAMPAIGN_MAX_GAP_DAYS,
};
