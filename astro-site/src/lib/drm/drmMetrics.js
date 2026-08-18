/**
 * drmMetrics.js — DRM のファネルを 1 つにまとめる（純粋・I/O なし）
 *
 * ── 出すもの ──────────────────────────────────────────────────
 *   sent / delivered / open / click / purchase / CVR / touch 別 conversion / unattributed
 *
 * ── 測っていないものを 0 にしない ──────────────────────────────
 * ⚠️ 既存 `crm/deliveryMeasurement.js` の立場をそのまま使う。
 *    計測が無効・不明なら **`null`** を返し、画面は `NOT_MEASURED_TEXT` を出す。
 *    `open: 0` と「open を測っていない」を同じ 0 にしない（2026-08-04 の 28 名配信で
 *    実際に 9 名が開封していたのに「開封 0」と出せる状態だった）。
 * ⚠️ **provider 受理（accepted）と delivered を混同しない。** 送信 API が 202 を返したことは
 *    到達ではない。`sent` は台帳の送信行、`delivered` は受信サーバーが受け取った記録。
 * ⚠️ 率は**母数が 0 なら作らない**（`null`）。既存 `rolloutView.buildStepView` と同じ作法。
 */

import { MEASURE, canShowCount } from '../crm/deliveryMeasurement.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 母数が正のときだけ率を作る */
export function rate(numerator, denominator) {
  const n = num(numerator);
  const d = num(denominator);
  if (n === null || d === null || d <= 0) return null;
  return n / d;
}

/**
 * 計測状態から「その指標を数えてよいか」を決める。
 * @returns {number|null} 数えてよければ件数、駄目なら null
 */
export function measured(state, value) {
  return canShowCount(state) ? (num(value) ?? 0) : null;
}

/**
 * DRM ファネルを組み立てる。
 *
 * @param {{
 *   sent: number, delivered: number|null,
 *   opened: number|null, clicked: number|null,
 *   purchased: number,
 *   openState?: string, clickState?: string, deliveredState?: string,
 *   byTouch?: object,            // step → { sent, delivered, opened, clicked, purchased }
 *   unattributed?: number,
 * }} input
 */
export function buildDrmFunnel({
  sent, delivered, opened, clicked, purchased,
  openState = MEASURE.UNKNOWN, clickState = MEASURE.UNKNOWN, deliveredState = MEASURE.ENABLED,
  byTouch = null, unattributed = 0,
} = {}) {
  const s = Math.max(0, num(sent) ?? 0);
  const p = Math.max(0, num(purchased) ?? 0);
  const d = measured(deliveredState, delivered);
  const o = measured(openState, opened);
  const c = measured(clickState, clicked);

  const touches = [];
  for (const [step, v] of Object.entries(byTouch || {})) {
    const ts = Math.max(0, num(v && v.sent) ?? 0);
    const tp = Math.max(0, num(v && v.purchased) ?? 0);
    touches.push({
      step: num(step),
      sent: ts,
      delivered: measured(deliveredState, v && v.delivered),
      opened: measured(openState, v && v.opened),
      clicked: measured(clickState, v && v.clicked),
      purchased: tp,
      /** その touch を起点に購入へ至った率（母数は送信済み） */
      conversionRate: rate(tp, ts),
    });
  }
  touches.sort((a, b) => (a.step ?? 0) - (b.step ?? 0));

  return {
    sent: s,
    delivered: d,
    opened: o,
    clicked: c,
    purchased: p,
    /** ⚠️ CVR の母数は**送信済み**（受理数ではない） */
    cvr: rate(p, s),
    /** 到達を母数にした CVR（到達を測れているときだけ） */
    cvrOnDelivered: d === null ? null : rate(p, d),
    openRate: o === null ? null : rate(o, s),
    clickRate: c === null ? null : rate(c, s),
    byTouch: touches,
    /** 購入したが 1 通にも結び付けられなかった数（**0 に丸めない**） */
    unattributed: Math.max(0, num(unattributed) ?? 0),
    measurement: {
      delivered: deliveredState,
      open: openState,
      click: clickState,
      /** 画面が「0 件」と誤解しないための旗 */
      openCountable: canShowCount(openState),
      clickCountable: canShowCount(clickState),
    },
  };
}

export default buildDrmFunnel;
