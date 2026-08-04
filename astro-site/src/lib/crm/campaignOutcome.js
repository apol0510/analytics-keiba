/**
 * campaignOutcome.js — キャンペーンの成果を**因果を断定せずに**並べる（純粋・I/O なし）
 *
 * ── なぜ「断定しない」のか ────────────────────────────────────
 * 「メールを送った → ログインした」は**メールのおかげとは限らない**。
 * 同じ日に別の施策を打っていたり、もともと来る予定だった人かもしれない。
 * それを一緒くたに「メールの成果」と書くと、次の判断を誤る。
 *
 * そこで成果を **3 段階の確からしさ**で分ける。
 *
 *   direct     メール経由と確認できる（本文のリンク経由・token 一致など）
 *   correlated 送信後の期間に起きた（時間的な相関だけ。因果は不明）
 *   unknown    紐づけられない
 *
 * ⚠️ 現時点の AK では click 計測が無効なので **direct はほぼ成立しない**。
 *    その事実も一緒に返し、画面が「0 件」と誤解させないようにする。
 */

import { MEASURE, canShowCount } from './deliveryMeasurement.js';

/** 成果の確からしさ */
export const ATTRIBUTION = Object.freeze({
  DIRECT: 'direct',
  CORRELATED: 'correlated',
  UNKNOWN: 'unknown',
});

export const ATTRIBUTION_LABEL = Object.freeze({
  direct: 'メール経由と確認できる',
  correlated: '送信後に起きた（相関のみ・因果は不明）',
  unknown: '紐づけられない',
});

/** 成果を見る期間 */
export const OUTCOME_WINDOWS = Object.freeze([
  { id: 'd7', label: '送信後 7 日', days: 7 },
  { id: 'd30', label: '送信後 30 日', days: 30 },
]);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 1 キャンペーンの成果表を作る。
 *
 * @param {{
 *   delivery: object,                 summarizeDelivery() の戻り値
 *   window: {id: string, label: string, days: number},
 *   observed: {
 *     loggedIn?: number, lightUsed?: number, premiumPurchased?: number,
 *     revenueYen?: number, unsubscribed?: number,
 *     viaEmailLink?: number,          本文リンク経由と確認できた人数
 *   },
 *   audienceSize: number,
 * }} input
 */
export function buildOutcomeReport(input = {}) {
  const d = input.delivery || {};
  const o = input.observed || {};
  const m = d.measurement || { open: MEASURE.UNKNOWN, click: MEASURE.UNKNOWN };
  const win = input.window || OUTCOME_WINDOWS[0];
  const audience = num(input.audienceSize);

  // direct は「本文リンク経由」でしか言えない。click 計測が無効ならそもそも観測できない
  const directObservable = canShowCount(m.click);
  const direct = directObservable ? num(o.viaEmailLink) : null;

  const rate = (x) => (audience > 0 && Number.isFinite(x) ? Math.round((x / audience) * 1000) / 10 : null);

  return {
    window: win,
    audienceSize: audience,
    // ── 配信の事実（計測状態つき）──
    delivery: {
      queued: num(d.queued),
      sentAccepted: num(d.sentAccepted),
      delivered: num(d.delivered),
      openedUnique: d.openedUnique || null,
      openEvents: d.openEvents || null,
      clickedUnique: d.clickedUnique || null,
      clickEvents: d.clickEvents || null,
      bounce: num(d.bounce),
      spamReport: num(d.spamReport),
      unsubscribe: num(d.unsubscribe),
    },
    // ── 成果（確からしさ別）──
    outcomes: [
      {
        key: 'loggedIn', label: 'ログインした人数',
        attribution: ATTRIBUTION.CORRELATED,
        value: num(o.loggedIn), rate: rate(num(o.loggedIn)),
      },
      {
        key: 'lightUsed', label: 'Light を利用した人数',
        attribution: ATTRIBUTION.CORRELATED,
        value: num(o.lightUsed), rate: rate(num(o.lightUsed)),
      },
      {
        key: 'premiumPurchased', label: 'Premium を購入した人数',
        attribution: ATTRIBUTION.CORRELATED,
        value: num(o.premiumPurchased), rate: rate(num(o.premiumPurchased)),
      },
      {
        key: 'revenueYen', label: '購入金額',
        attribution: ATTRIBUTION.CORRELATED,
        value: num(o.revenueYen), rate: null, unit: '円',
      },
      {
        key: 'unsubscribed', label: '配信停止',
        attribution: ATTRIBUTION.CORRELATED,
        value: num(o.unsubscribed), rate: rate(num(o.unsubscribed)),
      },
      {
        key: 'viaEmailLink', label: 'メール本文のリンク経由',
        attribution: ATTRIBUTION.DIRECT,
        value: direct,
        rate: direct === null ? null : rate(direct),
        unavailableReason: direct === null
          ? 'クリック計測が無効なため、メール経由かどうかを判定できません' : null,
      },
    ],
    notes: buildNotes({ m, directObservable, win }),
  };
}

function buildNotes({ m, directObservable, win }) {
  const notes = [
    `「${ATTRIBUTION_LABEL[ATTRIBUTION.CORRELATED]}」は ${win.label} に起きた出来事を数えたものです。`
    + 'メールを送らなくても起きたかもしれないので、効果の証明ではありません。',
  ];
  if (!directObservable) {
    notes.push('クリック計測が無効なため、「メール経由と確認できる」成果は 1 件も観測できません（0 件ではなく未計測）。');
  }
  if (m.open !== MEASURE.ENABLED) {
    notes.push('開封も AK の台帳へ届いていないため、開封率は配信基盤側の参考値でしか確認できません。');
  }
  return notes;
}

/**
 * 比較のための最小の前提チェック。
 * **母数が違うキャンペーン同士を率で比べない**（誤読の温床）。
 */
export function canCompare(a, b) {
  const sa = num(a && a.audienceSize);
  const sb = num(b && b.audienceSize);
  if (sa === 0 || sb === 0) return { ok: false, reason: 'empty_audience' };
  const ratio = sa > sb ? sa / sb : sb / sa;
  if (ratio > 10) return { ok: false, reason: 'audience_size_too_different' };
  const ma = a.delivery && a.delivery.openedUnique;
  const mb = b.delivery && b.delivery.openedUnique;
  if (ma && mb && ma.state !== mb.state) return { ok: false, reason: 'measurement_state_differs' };
  return { ok: true, reason: null };
}

export default buildOutcomeReport;
