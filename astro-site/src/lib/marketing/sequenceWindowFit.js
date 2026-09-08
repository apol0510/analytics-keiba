/**
 * sequenceWindowFit.js — 連続配信が**キャンペーン期間内に配り終わるか**（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-08 に確認した穴）
 *
 * 期間限定キャンペーンの campaign は `get enabled() { return isCampaignActive(); }`
 * で、**期間外になった瞬間に停止**する（期間外に案内すると「メールは届くのに
 * 1 円も割り引かれない」になるので、この停止自体は正しい）。
 *
 * ところが**連続配信の最終 step が期間内に収まるか**は誰も検査していなかった。
 * 収まらない定義を置くと、
 *
 *   - 途中まで送った人へ**続きが永久に届かない**（`campaign_disabled` で恒久停止）
 *   - しかも**エラーも警告も出ない**（設計どおりの停止として処理される）
 *
 * 実際 2026-09-06 15:00Z（JST 9/7 00:00）に期間が閉じ、割引 3 本の tick は
 * その時刻を境に一切動かなくなった。定義側で検査していれば、期間を延ばすか
 * step 間隔を詰めるかの判断を**配信を始める前に**できた。
 *
 * ## 検査するもの
 *
 * step の `delayDays` は**直前の送信からの日数**（`computeNextSendAtMs`）なので、
 * 最終 step は開始から `delayDays の総和` 日後に届く。これが期間の終わりを
 * 超えないことを確かめる。
 *
 * ⚠️ **1 通目が期間の初日に出るとは限らない**（本番の 1 通目は開始翌日だった）。
 *    そこで `startedAtMs` を渡せる形にし、渡さないときは期間の開始で評価する
 *    （＝いちばん甘い条件。それでも超えるなら定義が確実に壊れている）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

/** 上限（`maxSends`）まで含めた step 一覧を、番号順で返す */
function activeSteps(campaign) {
  const steps = (campaign && campaign.sequence && Array.isArray(campaign.sequence.steps))
    ? campaign.sequence.steps : [];
  const declared = int(campaign?.sequence?.maxSends);
  const max = declared && declared > 0 ? declared : steps.length;
  return steps
    .map((s, i) => ({ ...s, stepNumber: int(s.stepNumber) ?? i + 1 }))
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .filter((s) => s.stepNumber <= max);
}

/**
 * 1 通目から最終 step までにかかる日数（`delayDays` の総和）。
 * step が 1 つだけなら 0。
 */
export function totalSequenceDays(campaign) {
  const steps = activeSteps(campaign);
  if (steps.length === 0) return null;
  return steps.reduce((sum, s) => sum + (int(s.delayDays) ?? 0), 0);
}

/**
 * その campaign の連続配信が期間内に収まるか。
 *
 * @param {{campaign: object, window: {startsAtIso: string, endsAtIso: string},
 *          startedAtMs?: number|null}} input
 * @returns {{ok: boolean, reason: string|null, totalDays: number|null,
 *            windowDays: number|null, lastSendAtMs: number|null, endsAtMs: number|null}}
 */
export function describeSequenceWindowFit({ campaign, window, startedAtMs = null } = {}) {
  const steps = activeSteps(campaign);
  const empty = {
    ok: true, reason: null, totalDays: null, windowDays: null, lastSendAtMs: null, endsAtMs: null,
  };
  if (steps.length <= 1) return empty;                       // 1 通なら期間を跨がない

  const startsAtMs = Date.parse(String(window?.startsAtIso || ''));
  const endsAtMs = Date.parse(String(window?.endsAtIso || ''));
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) {
    // 期間が読めないなら**検査しない**とは言わず、壊れている事実を返す（fail closed）
    return { ...empty, ok: false, reason: 'window_unreadable' };
  }
  if (endsAtMs <= startsAtMs) return { ...empty, ok: false, reason: 'window_inverted', endsAtMs };

  const totalDays = totalSequenceDays(campaign);
  const windowDays = (endsAtMs - startsAtMs) / DAY_MS;
  const base = Number.isFinite(Number(startedAtMs)) && Number(startedAtMs) > 0
    ? Number(startedAtMs) : startsAtMs;
  const lastSendAtMs = base + totalDays * DAY_MS;

  if (lastSendAtMs >= endsAtMs) {
    return { ok: false, reason: 'last_step_after_window', totalDays, windowDays, lastSendAtMs, endsAtMs };
  }
  return { ok: true, reason: null, totalDays, windowDays, lastSendAtMs, endsAtMs };
}

/**
 * カタログ全体の検査。**期間で自動停止する campaign だけ**が対象。
 *
 * @param {{campaigns: object[], window: object, isWindowBound: (c:object)=>boolean}} input
 * @returns {Array<{campaignId: string, reason: string, totalDays: number|null, windowDays: number|null}>}
 */
export function findSequenceWindowOverflows({ campaigns, window, isWindowBound } = {}) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const bound = typeof isWindowBound === 'function' ? isWindowBound : () => false;
  const out = [];
  for (const c of list) {
    if (!bound(c)) continue;
    const fit = describeSequenceWindowFit({ campaign: c, window });
    if (fit.ok) continue;
    out.push({
      campaignId: String(c.campaignId || ''),
      reason: fit.reason,
      totalDays: fit.totalDays,
      windowDays: fit.windowDays,
    });
  }
  return out;
}

export default describeSequenceWindowFit;
