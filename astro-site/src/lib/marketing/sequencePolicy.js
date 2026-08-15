/**
 * sequencePolicy.js — 数十通の連続配信を「送りすぎず・止めるべきときに止める」（純粋・I/O なし）
 *
 * ── 解決する問題 ──────────────────────────────────────────────
 * 現行の `light-trial-to-premium-sequence` は **全 4 通**で終わる。
 * 事業要件は「1 人あたり最大数十通の接点」だが、単に `steps` を増やすと
 *
 *   - 同じ訴求の機械的な連投になる（読まれず、配信停止だけ増える）
 *   - 短期間に集中して届く（頻度の上限が無い）
 *   - 反応（開封・クリック・購入・無反応）が次の判断に使われない
 *
 * ── 方針 ────────────────────────────────────────────────────
 * 1. **最大回数は設定可能**にする（4 → 数十）。上限に達したら自動終了。
 * 2. **頻度上限**を持つ（`minIntervalDays` と「N 日で最大 M 通」）。
 * 3. **訴求角度（angle）**を持たせ、同じ角度の連投を避ける。
 * 4. **反応で次を変える**: 購入は即終了、配信停止・ハードバウンスは即終了、
 *    無反応が続けば間隔を空ける / 打ち切る。
 *
 * ⚠️ 判定の**単一源はここ**。画面・cron・dry-run が同じ関数を通る。
 * ⚠️ 送信そのものはしない。既存の `sequenceProgress` / `campaignSend` が担う。
 */

/** 次に何をするか */
export const NEXT_ACTION = Object.freeze({
  SEND: 'send',
  WAIT: 'wait',
  STOP: 'stop',
});

/** 止める理由（強い順に評価する） */
export const STOP_REASON = Object.freeze({
  PURCHASED: 'purchased',
  UNSUBSCRIBED: 'unsubscribed',
  HARD_BOUNCE: 'hard_bounce',
  COMPLAINT: 'complaint',
  SUPPRESSED: 'suppressed',
  MAX_SENDS: 'max_sends_reached',
  NO_ENGAGEMENT: 'no_engagement',
  CAMPAIGN_DISABLED: 'campaign_disabled',
  NOT_ELIGIBLE: 'not_eligible',
});

export const STOP_REASON_LABEL = Object.freeze({
  purchased: '有料契約が成立（以後の販促は止める）',
  unsubscribed: '配信停止',
  hard_bounce: 'ハードバウンス',
  complaint: '苦情（スパム報告）',
  suppressed: '配信基盤の停止リスト',
  max_sends_reached: '規定回数まで配信済み',
  no_engagement: '反応が無いまま閾値を超えた',
  campaign_disabled: 'キャンペーン停止中',
  not_eligible: '対象条件から外れた',
});

/** 待つ理由 */
export const WAIT_REASON = Object.freeze({
  INTERVAL: 'interval',
  FREQUENCY_CAP: 'frequency_cap',
  QUIET_HOURS: 'quiet_hours',
});

/**
 * 既定のポリシー。**現行の 4 通運用をそのまま表せる**値にしてある
 *（`maxSends` を上げるだけで数十通へ伸ばせる）。
 */
export const DEFAULT_POLICY = Object.freeze({
  /** 1 人あたりの最大配信回数 */
  maxSends: 4,
  /** 次の 1 通までの最小間隔（日） */
  minIntervalDays: 3,
  /** 「直近 N 日で最大 M 通」。短期間の過剰配信を防ぐ */
  frequencyCap: Object.freeze({ windowDays: 7, maxSends: 2 }),
  /** 無反応がこの回数続いたら間隔を伸ばす */
  slowdownAfterNoEngagement: 3,
  /** 間隔を伸ばすときの倍率 */
  slowdownFactor: 2,
  /** 無反応がこの回数続いたら打ち切る（`null` なら打ち切らない） */
  stopAfterNoEngagement: 8,
  /** 同じ訴求角度を連続で使わない */
  avoidRepeatAngle: true,
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};
const str = (v) => String(v ?? '').trim();
const DAY_MS = 24 * 3600_000;

/** ポリシーを正規化する（壊れた値は既定へ。**上限は緩めない**） */
export function normalizePolicy(raw) {
  const d = DEFAULT_POLICY;
  const p = raw && typeof raw === 'object' ? raw : {};
  const cap = p.frequencyCap && typeof p.frequencyCap === 'object' ? p.frequencyCap : {};
  const maxSends = num(p.maxSends);
  const minInterval = num(p.minIntervalDays);
  const stopAfter = p.stopAfterNoEngagement === null ? null : num(p.stopAfterNoEngagement);
  return {
    maxSends: maxSends !== null && maxSends > 0 ? Math.floor(maxSends) : d.maxSends,
    minIntervalDays: minInterval !== null && minInterval >= 0 ? minInterval : d.minIntervalDays,
    frequencyCap: {
      windowDays: num(cap.windowDays) ?? d.frequencyCap.windowDays,
      maxSends: num(cap.maxSends) ?? d.frequencyCap.maxSends,
    },
    slowdownAfterNoEngagement: num(p.slowdownAfterNoEngagement) ?? d.slowdownAfterNoEngagement,
    slowdownFactor: Math.max(1, num(p.slowdownFactor) ?? d.slowdownFactor),
    stopAfterNoEngagement: stopAfter === null ? null : (stopAfter ?? d.stopAfterNoEngagement),
    avoidRepeatAngle: p.avoidRepeatAngle !== false,
  };
}

/**
 * **止めるべきか**を判定する（強い順に 1 つだけ返す）。
 * 反応・契約・配信可否はすべて既存の判定結果を受け取るだけで、ここでは作らない。
 */
export function resolveStop({ policy, state }) {
  const p = normalizePolicy(policy);
  const s = state || {};
  if (s.campaignEnabled === false) return { stop: true, reason: STOP_REASON.CAMPAIGN_DISABLED };
  // 目的を達成したら以後の販促は止める（最優先）
  if (s.purchased === true) return { stop: true, reason: STOP_REASON.PURCHASED };
  // 明確な拒否・到達不能は即停止
  if (s.unsubscribed === true) return { stop: true, reason: STOP_REASON.UNSUBSCRIBED };
  if (s.hardBounced === true) return { stop: true, reason: STOP_REASON.HARD_BOUNCE };
  if (s.complained === true) return { stop: true, reason: STOP_REASON.COMPLAINT };
  if (s.providerSuppressed === true) return { stop: true, reason: STOP_REASON.SUPPRESSED };
  if (s.eligible === false) return { stop: true, reason: STOP_REASON.NOT_ELIGIBLE };

  const sent = Math.max(0, num(s.sentCount) ?? 0);
  if (sent >= p.maxSends) return { stop: true, reason: STOP_REASON.MAX_SENDS };

  const noEng = num(s.consecutiveNoEngagement);
  if (p.stopAfterNoEngagement !== null && noEng !== null && noEng >= p.stopAfterNoEngagement) {
    return { stop: true, reason: STOP_REASON.NO_ENGAGEMENT };
  }
  return { stop: false, reason: null };
}

/**
 * 次の 1 通までの間隔（日）。**無反応が続くほど空ける**。
 * ステップ側の `delayDays` があればそれを基準にし、ポリシーの下限を割らない。
 */
export function resolveIntervalDays({ policy, state, stepDelayDays }) {
  const p = normalizePolicy(policy);
  const base = Math.max(num(stepDelayDays) ?? p.minIntervalDays, p.minIntervalDays);
  const noEng = num((state || {}).consecutiveNoEngagement) ?? 0;
  if (p.slowdownAfterNoEngagement > 0 && noEng >= p.slowdownAfterNoEngagement) {
    return base * p.slowdownFactor;
  }
  return base;
}

/**
 * 頻度上限に触れていないか。「直近 `windowDays` 日で `maxSends` 通まで」。
 *
 * @param {{policy: object, recentSendAtMs: number[], nowMs: number}} input
 */
export function checkFrequencyCap({ policy, recentSendAtMs, nowMs }) {
  const p = normalizePolicy(policy);
  const now = num(nowMs);
  if (now === null) return { ok: false, reason: WAIT_REASON.FREQUENCY_CAP, recent: null };
  const since = now - p.frequencyCap.windowDays * DAY_MS;
  const recent = (Array.isArray(recentSendAtMs) ? recentSendAtMs : [])
    .map((t) => num(t)).filter((t) => t !== null && t >= since).length;
  if (recent >= p.frequencyCap.maxSends) {
    return { ok: false, reason: WAIT_REASON.FREQUENCY_CAP, recent };
  }
  return { ok: true, reason: null, recent };
}

/**
 * **次に何をするか**を 1 つに決める（単一源）。
 *
 * @returns {{action: string, reason: string|null, nextStep: number|null,
 *            nextAtMs: number|null, intervalDays: number|null}}
 */
export function decideNext({ policy, state, stepDelayDays, nowMs }) {
  const p = normalizePolicy(policy);
  const s = state || {};
  const stop = resolveStop({ policy: p, state: s });
  if (stop.stop) {
    return { action: NEXT_ACTION.STOP, reason: stop.reason, nextStep: null, nextAtMs: null, intervalDays: null };
  }
  const sent = Math.max(0, num(s.sentCount) ?? 0);
  const nextStep = sent + 1;
  const intervalDays = resolveIntervalDays({ policy: p, state: s, stepDelayDays });

  const last = num(s.lastSentAtMs);
  const now = num(nowMs);
  if (now === null) {
    return { action: NEXT_ACTION.WAIT, reason: WAIT_REASON.INTERVAL, nextStep, nextAtMs: null, intervalDays };
  }
  // 1 通目は間隔を待たない（初回接触）
  const dueAt = last === null ? now : last + intervalDays * DAY_MS;
  if (dueAt > now) {
    return { action: NEXT_ACTION.WAIT, reason: WAIT_REASON.INTERVAL, nextStep, nextAtMs: dueAt, intervalDays };
  }
  const cap = checkFrequencyCap({ policy: p, recentSendAtMs: s.recentSendAtMs, nowMs: now });
  if (!cap.ok) {
    return { action: NEXT_ACTION.WAIT, reason: cap.reason, nextStep, nextAtMs: null, intervalDays };
  }
  return { action: NEXT_ACTION.SEND, reason: null, nextStep, nextAtMs: now, intervalDays };
}

/**
 * 訴求角度（angle）の割り当て。
 *
 * 同じ角度の連投を避ける。角度が尽きたら**先頭から回す**が、
 * 直前と同じものは選ばない（`avoidRepeatAngle`）。
 *
 * @param {{angles: string[], stepNumber: number, lastAngle?: string|null, policy?: object}} input
 */
export function pickAngle({ angles, stepNumber, lastAngle = null, policy }) {
  const p = normalizePolicy(policy);
  const list = (Array.isArray(angles) ? angles : []).map(str).filter(Boolean);
  if (list.length === 0) return null;
  const n = Math.max(1, num(stepNumber) ?? 1);
  let idx = (n - 1) % list.length;
  if (p.avoidRepeatAngle && list.length > 1 && list[idx] === str(lastAngle)) {
    idx = (idx + 1) % list.length;
  }
  return list[idx];
}

/**
 * 反応から「無反応が何回続いたか」を数える（次の判断の材料）。
 *
 * @param {Array<{opened?: boolean, clicked?: boolean}>} history 新しい順でも古い順でもよい
 * @param {{order?: 'asc'|'desc'}} [opts] 既定は古い順（asc）
 */
export function countConsecutiveNoEngagement(history, { order = 'asc' } = {}) {
  const rows = Array.isArray(history) ? history.slice() : [];
  const seq = order === 'desc' ? rows : rows.reverse();
  let n = 0;
  for (const r of seq) {
    const engaged = !!(r && (r.opened === true || r.clicked === true));
    if (engaged) break;
    n += 1;
  }
  return n;
}

/** 画面へ出す要約（**PII を含めない**） */
export function describePolicy(policy) {
  const p = normalizePolicy(policy);
  return {
    maxSends: p.maxSends,
    minIntervalDays: p.minIntervalDays,
    frequencyCap: `${p.frequencyCap.windowDays} 日で最大 ${p.frequencyCap.maxSends} 通`,
    slowdown: p.slowdownAfterNoEngagement > 0
      ? `無反応 ${p.slowdownAfterNoEngagement} 回で間隔 ${p.slowdownFactor} 倍`
      : 'なし',
    stopAfterNoEngagement: p.stopAfterNoEngagement === null
      ? '打ち切らない' : `無反応 ${p.stopAfterNoEngagement} 回で終了`,
  };
}

export default decideNext;
