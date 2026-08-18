/**
 * drmRouting.js — **反応層で次の訴求を変える**（純粋・I/O なし・宣言的）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 既存の `sequencePolicy.decideNext` は「送ってよいか / 待つか / 止めるか」を決めるが、
 * **次に何を送るか**は `nextStep = sent + 1` の線形で、`pickAngle` も**位置ベース**。
 * つまり「開封したのに買っていない人」と「一度も開いていない人」へ**同じ次の 1 通**が行く。
 * Direct Response Marketing はここを変える。
 *
 * ── 設計 ──────────────────────────────────────────────────────
 * ⚠️ **キャンペーン固有ロジックを Function へ直書きしない。**
 *    分岐は `routes`（宣言）で与え、この関数は**当てはめるだけ**。
 *    宣言はキャンペーン定義（catalog）側に置けるので、コードを触らず訴求を差し替えられる。
 * ⚠️ **停止・頻度・送信可否は判定しない。** それは `sequencePolicy` の仕事で、
 *    ここは「送ってよい」と決まった後の**行き先だけ**を選ぶ（責務を二重化しない）。
 * ⚠️ 反応が **未計測（`unknown`）のときに推測で分岐しない**。
 *    `unknown` 用の route が宣言されていなければ**既定の線形**へ落とす（fail closed 側）。
 *
 * ── A/B を後から足せる形 ──────────────────────────────────────
 * route は `variant` を持てる。`variant` は**キャンペーン定義（コード）側の識別子**で、
 * 既存の `campaignId` / `version` / `step` と並べて使う。
 * **新しい schema も列も要らない**（`DeliveryKey` は campaign × version × step × 受信者で
 * 既に一意なので、variant を分けたいときは version か step を分ける既存作法に乗る）。
 */

import { RESPONSE } from './drmResponseState.js';

/** route が当たらなかったときの既定（**線形に次の step**） */
export const DEFAULT_ROUTE_ID = 'default';

/** 宣言できる条件（これ以外は受け付けない＝勝手な条件を増やさない） */
export const ROUTE_WHEN = Object.freeze([
  RESPONSE.PURCHASED,
  RESPONSE.SUPPRESSED,
  RESPONSE.CLICKED,
  RESPONSE.OPENED,
  RESPONSE.DELIVERED,
  RESPONSE.SENT,
  RESPONSE.NOT_SENT,
  RESPONSE.UNKNOWN,
]);

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 宣言された route を正規化する。**知らない条件は捨てる**（黙って通さない）。
 *
 * route の形:
 *   { when: 'opened', step: 7, variant: 'proof-a', angle: 'social-proof',
 *     minSent: 2, maxSent: 6, note: '…' }
 *
 * - `when`     … 反応層（必須・`ROUTE_WHEN` のみ）
 * - `step`     … 送る step（省略時は線形 `sent + 1`）
 * - `variant`  … A/B の識別子（省略可）
 * - `angle`    … 訴求角度（省略可。既存 `pickAngle` と同じ語彙）
 * - `minSent` / `maxSent` … 何通目以降 / 以前に限る（省略可）
 */
export function normalizeRoutes(raw) {
  const allowed = new Set(ROUTE_WHEN);
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const when = str(r && r.when);
    if (!allowed.has(when)) continue;                 // 知らない条件は採用しない
    const step = num(r && r.step);
    if (step !== null && (!Number.isInteger(step) || step < 1)) continue;
    out.push({
      when,
      step,
      variant: str(r && r.variant) || null,
      angle: str(r && r.angle) || null,
      minSent: num(r && r.minSent),
      maxSent: num(r && r.maxSent),
      note: str(r && r.note) || null,
    });
  }
  return out;
}

/** その route が今の状態に当てはまるか */
function matches(route, state) {
  if (route.when !== state.state) return false;
  const sent = Math.max(0, num(state.sentCount) ?? 0);
  if (route.minSent !== null && sent < route.minSent) return false;
  if (route.maxSent !== null && sent > route.maxSent) return false;
  return true;
}

/**
 * **次に何を訴求するか**を決める（送ってよいかは判定しない）。
 *
 * @param {{routes: object[], state: object, maxSends?: number|null}} input
 *   `state` … `drmResponseState.resolveResponseState()` の戻り
 * @returns {{routeId: string, step: number|null, variant: string|null,
 *            angle: string|null, matched: boolean, reason: string|null}}
 */
export function routeNextTouch({ routes, state, maxSends = null } = {}) {
  const s = state || {};
  const list = normalizeRoutes(routes);
  const sent = Math.max(0, num(s.sentCount) ?? 0);
  const linear = sent + 1;
  const cap = num(maxSends);

  const fallback = (reason) => {
    const step = cap !== null && linear > cap ? null : linear;
    return {
      routeId: DEFAULT_ROUTE_ID, step, variant: null, angle: null,
      matched: false, reason,
    };
  };

  // ⚠️ 反応が読めていないのに、反応前提の分岐へ入れない
  if (!s.state) return fallback('no_state');

  /**
   * ⚠️ **終端の層へは何も提案しない**（宣言があっても無視する）。
   *    購入後は即停止・退会/停止リストへは絶対に送らない、が上位の安全要件で、
   *    ここで step を返すと「送り先がある」と誤解させる。
   *    停止そのものは `sequencePolicy.resolveStop` が決めるが、
   *    **行き先を作らない**ことでも二重に塞ぐ。
   */
  if (s.state === RESPONSE.PURCHASED || s.state === RESPONSE.SUPPRESSED) {
    return {
      routeId: DEFAULT_ROUTE_ID, step: null, variant: null, angle: null,
      matched: false, reason: 'terminal_state',
    };
  }
  if (s.state === RESPONSE.UNKNOWN && !list.some((r) => r.when === RESPONSE.UNKNOWN)) {
    return fallback('response_unknown');
  }

  // 宣言順に最初に当たったものを使う（**上に書いたものが強い**）
  for (const r of list) {
    if (!matches(r, s)) continue;
    const step = r.step === null ? linear : r.step;
    if (cap !== null && step > cap) {
      return { routeId: `${r.when}:${r.step ?? 'next'}`, step: null, variant: r.variant, angle: r.angle, matched: true, reason: 'max_sends_reached' };
    }
    return {
      routeId: `${r.when}:${r.step ?? 'next'}`,
      step, variant: r.variant, angle: r.angle, matched: true, reason: null,
    };
  }
  return fallback('no_route_matched');
}

/**
 * 反応層ごとの人数を数える（運営画面の「どの層に何人いるか」）。
 *
 * ⚠️ 未計測（`unknown`）を他の層へ混ぜない。**そのまま 1 つの層として出す。**
 */
export function summarizeSegments(states) {
  const counts = {};
  for (const w of ROUTE_WHEN) counts[w] = 0;
  let total = 0;
  for (const s of Array.isArray(states) ? states : []) {
    const k = str(s && s.state);
    if (!(k in counts)) continue;
    counts[k] += 1;
    total += 1;
  }
  return { total, counts };
}

export default routeNextTouch;
