/**
 * rolloutPlan.js — 大規模コホートの**段階展開**を決める（純粋・I/O なし）
 *
 * ── 解決する問題 ──────────────────────────────────────────────
 * 未付与が 14,479 名ある。100 名/日の固定運用だと **145 日**かかり、
 * しかも毎回 env を開閉して redeploy しないと動かない。これは運用ではない。
 *
 * ── 方針 ────────────────────────────────────────────────────
 * 1. **段階展開（ramp）**: 10 → 100 → 500 → … と、実績を見ながら増やす。
 *    いきなり数千通を出さない（バウンス率・苦情率が跳ねると送信ドメインが焼ける）。
 * 2. **1 日あたりの上限**は状態として持ち、**env の開閉・redeploy 無しで**変えられる。
 * 3. **kill switch は既定 OFF**。止めたいときは 1 つの状態を落とせば**次の tick から止まる**。
 * 4. 進めてよいかの判定は**毎回やり直す**（前回の結論を持ち越さない）。
 *
 * ⚠️ このモジュールは**決めるだけ**で、付与も送信もしない。
 *    実際に書くのは既存の付与経路（`cron-light-trial-grant`）と
 *    送信経路（`admin-marketing` / `marketing-campaign-dispatch`）のまま。
 */

/** 展開の段階。**実績を見て次へ上げる**（自動では上げない） */
export const ROLLOUT_STAGE = Object.freeze({
  /** 止まっている（既定）。kill switch が入っている状態もこれ */
  PAUSED: 'paused',
  /** 少数で経路を確かめる */
  CANARY: 'canary',
  /** 通常運用 */
  STEADY: 'steady',
  /** 拡大 */
  SCALE: 'scale',
  /** 対象を配り終えた */
  COMPLETED: 'completed',
});

/** 段階ごとの 1 日あたり既定上限（状態で上書きできる） */
export const STAGE_DEFAULT_DAILY = Object.freeze({
  paused: 0,
  canary: 10,
  steady: 100,
  scale: 500,
  completed: 0,
});

/** 1 日あたりの絶対上限。**状態が壊れてもこれを超えない** */
export const HARD_DAILY_MAX = 2000;

/** 進めない理由（固定コード。件数・理由だけを画面へ出す） */
export const ROLLOUT_BLOCK = Object.freeze({
  KILLED: 'kill_switch',
  PAUSED: 'paused',
  NOT_ARMED: 'not_armed',
  /**
   * ⚠️ **廃止**。以前は「同じ日は 1 回だけ」を強制していたが、
   *    同日に複数バッチを回すグループ配信と噛み合わないためやめた。
   *    値は互換のため残す（過去ログ・画面のラベル用）。
   */
  ALREADY_RAN_TODAY: 'already_ran_today',
  WAITING_PREVIOUS: 'waiting_previous_step1',
  NO_CANDIDATES: 'no_candidates',
  DAILY_LIMIT_REACHED: 'daily_limit_reached',
  STATE_UNREADABLE: 'state_unreadable',
  COMPLETED: 'completed',
});

export const ROLLOUT_BLOCK_LABEL = Object.freeze({
  kill_switch: '緊急停止が入っています',
  paused: '展開は一時停止中です',
  not_armed: '実行日の指定（armedFor）が今日と一致しません',
  already_ran_today: '今日はすでに実行済みです',
  waiting_previous_step1: '前回ぶんの Step1 がまだ片付いていません',
  no_candidates: '対象がいません',
  daily_limit_reached: '本日の上限に達しました',
  state_unreadable: '展開状態を読めません（安全側で停止）',
  completed: '対象を配り終えました',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};
const str = (v) => String(v ?? '').trim();

/** JST の暦日（`YYYY-MM-DD`）。**UTC 基準で切らない** */
export function jstDay(nowMs) {
  const d = new Date(Number(nowMs) + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 既定の展開状態（**止まっている**）。
 * 状態が無い / 壊れているときはこれを使い、**動かさない**。
 */
export function defaultRolloutState() {
  return {
    version: 1,
    stage: ROLLOUT_STAGE.PAUSED,
    /** 緊急停止。true なら段階に関係なく止まる */
    killed: false,
    /**
     * **1 日あたりの上限**（未指定なら段階の既定）。
     * ⚠️ 「1 日 1 回」ではない。1 日に配ってよい**合計人数**。
     */
    dailyLimit: null,
    /**
     * **1 バッチの人数**（未指定なら `dailyLimit` と同じ = 1 日 1 バッチ相当）。
     * 15,000 件を安全に配るには「500 名 → 完了確認 → 次の 500 名」を同日中に繰り返す。
     */
    batchSize: null,
    /** 今日すでに配った人数（`lastRunDay` が今日でなければ 0 として扱う） */
    dayGrantedCount: 0,
    /** 今日のバッチ通し番号（1 から。`operationId` の枝番になる） */
    batchSeq: 0,
    /**
     * 「今日動かしてよい」という明示。`YYYY-MM-DD`（JST）。
     * 置きっぱなしでも**翌日には効かなくなる**ので、暴走しない。
     * `alwaysArmed: true` なら日付を毎日置き直さずに継続運用できる。
     */
    armedFor: null,
    alwaysArmed: false,
    /**
     * 最後に実行した JST 日と件数。
     * ⚠️ 役割は「**今日の集計がどの日のものか**」を示すことだけ。
     *    以前はこれで「同じ日は 1 回だけ」を強制していたが、
     *    グループ配信（同日に 500 名 × 複数バッチ）と噛み合わないため廃止した。
     *    二重付与は operationId の冪等性・DeliveryKey・関所が防ぐ。
     */
    lastRunDay: null,
    lastRunCount: 0,
    /** 累計（画面表示・進捗） */
    totalGranted: 0,
    /**
     * **付与のあと、まだ Step1 を積んでいない引き継ぎ**（`LightGrantOp` の値）。
     * これが残っている限り、次の tick は「新しく配る」より先に queue を進める。
     * 引き継ぎ自体は 24 時間で失効するので、置きっぱなしにはならない。
     */
    pendingHandoffOp: null,
    /** queue 済みでまだ送信を起動していないジョブ ID（送信の起動は台帳が正本） */
    pendingJobIds: [],
    /** jobId → 何通目か。集計を Step 別に積むために覚えておく */
    jobSteps: {},
    /**
     * 送信を起動したときの「そのジョブの送信済み件数」。
     * **202 は送信成功ではない**ので、次の tick で台帳が進んだかを見るために控える。
     */
    dispatchWatch: {},
    updatedAtMs: null,
    note: '',
  };
}

/** jobId → 数値 の対応表を安全に取り込む（壊れた値・多すぎる値は捨てる） */
function normalizeJobMap(raw, pick) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 50) break;
    const key = str(k).slice(0, 120);
    const val = pick(v);
    if (!key || val === null) continue;
    out[key] = val;
    n += 1;
  }
  return out;
}

/** 状態を安全に正規化する（壊れた値は既定へ倒す） */
export function normalizeRolloutState(raw) {
  const d = defaultRolloutState();
  if (!raw || typeof raw !== 'object') return d;
  const stage = Object.values(ROLLOUT_STAGE).includes(str(raw.stage)) ? str(raw.stage) : d.stage;
  const dailyRaw = num(raw.dailyLimit);
  const daily = dailyRaw !== null && dailyRaw >= 0 ? Math.min(Math.floor(dailyRaw), HARD_DAILY_MAX) : null;
  return {
    version: num(raw.version) || 1,
    stage,
    killed: raw.killed === true,
    dailyLimit: daily,
    batchSize: (() => {
      const b = num(raw.batchSize);
      return b !== null && b > 0 ? Math.min(Math.floor(b), HARD_DAILY_MAX) : null;
    })(),
    dayGrantedCount: Math.max(0, num(raw.dayGrantedCount) ?? 0),
    batchSeq: Math.max(0, num(raw.batchSeq) ?? 0),
    armedFor: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.armedFor)) ? str(raw.armedFor) : null,
    alwaysArmed: raw.alwaysArmed === true,
    lastRunDay: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.lastRunDay)) ? str(raw.lastRunDay) : null,
    lastRunCount: Math.max(0, num(raw.lastRunCount) ?? 0),
    totalGranted: Math.max(0, num(raw.totalGranted) ?? 0),
    pendingHandoffOp: str(raw.pendingHandoffOp).slice(0, 100) || null,
    // 壊れた値・多すぎる値は捨てる（ここが暴れると送信起動が暴れる）
    pendingJobIds: Array.isArray(raw.pendingJobIds)
      ? raw.pendingJobIds.map((v) => str(v).slice(0, 120)).filter(Boolean).slice(0, 50)
      : [],
    jobSteps: normalizeJobMap(raw.jobSteps, (v) => {
      const n = num(v);
      return n !== null && n >= 1 && n <= 99 ? Math.floor(n) : null;
    }),
    dispatchWatch: normalizeJobMap(raw.dispatchWatch, (v) => {
      const n = num(v);
      return n !== null && n >= 0 ? Math.floor(n) : null;
    }),
    updatedAtMs: num(raw.updatedAtMs),
    note: str(raw.note).slice(0, 200),
  };
}

/** 段階に対する 1 日あたりの上限（状態の指定 > 段階の既定、ただし絶対上限で頭打ち） */
export function resolveDailyLimit(state) {
  const s = normalizeRolloutState(state);
  const byStage = STAGE_DEFAULT_DAILY[s.stage] ?? 0;
  const n = s.dailyLimit === null ? byStage : s.dailyLimit;
  return Math.max(0, Math.min(n, HARD_DAILY_MAX));
}

/**
 * 1 バッチの人数。**指定が無ければ 1 日上限と同じ**（＝従来どおり 1 日 1 バッチ相当）。
 *
 * ⚠️ 「1 日に配れる合計」（`dailyLimit`）と「1 回に配る人数」（`batchSize`）は別物。
 *    15,000 件を安全に配るには、500 名を配って結果を確かめ、また 500 名…を繰り返す。
 */
export function resolveBatchSize(state) {
  const s = normalizeRolloutState(state);
  const daily = resolveDailyLimit(s);
  const b = s.batchSize === null ? daily : s.batchSize;
  return Math.max(0, Math.min(b, daily, HARD_DAILY_MAX));
}

/** 今日すでに配った人数（日付が変わっていれば 0） */
export function grantedToday(state, nowMs) {
  const s = normalizeRolloutState(state);
  return s.lastRunDay === jstDay(nowMs) ? s.dayGrantedCount : 0;
}

/**
 * **今回いくつ進めてよいか**を決める。
 *
 * ⚠️ 進めない理由は必ず 1 つ返す（「なんとなく 0 件」にしない）。
 * ⚠️ `remaining` が分からない（null）ときは**進めない**（fail closed）。
 *
 * @param {{state: object, nowMs: number, remainingCandidates: number|null,
 *          previousOutstanding: number|null, envEnabled: boolean}} input
 * @returns {{ok: boolean, allowance: number, reason: string|null, stage: string,
 *            dailyLimit: number, day: string}}
 */
export function planRolloutTick({
  state, nowMs, remainingCandidates, previousOutstanding, envEnabled,
}) {
  const s = normalizeRolloutState(state);
  const day = jstDay(nowMs);
  const dailyLimit = resolveDailyLimit(s);
  const batchSize = resolveBatchSize(s);
  const base = {
    allowance: 0, stage: s.stage, dailyLimit, batchSize, day,
    grantedToday: grantedToday(s, nowMs),
    batchSeq: s.lastRunDay === jstDay(nowMs) ? s.batchSeq : 0,
  };

  // ① env のマスタースイッチ。**既定 OFF**（コード側の最後の砦）
  if (envEnabled !== true) return { ...base, ok: false, reason: ROLLOUT_BLOCK.PAUSED };
  // ② 緊急停止は段階より強い
  if (s.killed === true) return { ...base, ok: false, reason: ROLLOUT_BLOCK.KILLED };
  if (s.stage === ROLLOUT_STAGE.PAUSED) return { ...base, ok: false, reason: ROLLOUT_BLOCK.PAUSED };
  if (s.stage === ROLLOUT_STAGE.COMPLETED) return { ...base, ok: false, reason: ROLLOUT_BLOCK.COMPLETED };

  // ③ 「今日動かす」の明示。`alwaysArmed` なら日付指定を省ける（継続運用）
  if (!s.alwaysArmed && s.armedFor !== day) {
    return { ...base, ok: false, reason: ROLLOUT_BLOCK.NOT_ARMED };
  }
  // ④ 前のバッチが片付くまで次を配らない（**関所＝バッチの直列化**）
  //    ⚠️ ここが「同じ日は 1 回だけ」に代わる安全装置。
  //       付与 → queue → 送信 → 台帳確認 が終わるまで `outstanding > 0` なので、
  //       次のバッチは始まらない。cron が重複起動しても同じ判断になる。
  const outstanding = num(previousOutstanding);
  if (outstanding === null) return { ...base, ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE };
  if (outstanding > 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.WAITING_PREVIOUS };

  // ⑤ 対象が読めない / いない
  const remaining = num(remainingCandidates);
  if (remaining === null) return { ...base, ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE };
  if (remaining <= 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.NO_CANDIDATES };

  // ⑥ 今日の残り枠（**1 日 1 回ではなく、1 日の合計人数**で止める）
  if (dailyLimit <= 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED };
  const already = grantedToday(s, nowMs);
  const dailyRoom = Math.min(dailyLimit, HARD_DAILY_MAX) - already;
  if (dailyRoom <= 0) {
    return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED, grantedToday: already };
  }

  const allowance = Math.min(batchSize, dailyRoom, remaining);
  if (allowance <= 0) {
    return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED, grantedToday: already };
  }

  return {
    ...base,
    ok: true,
    allowance,
    reason: null,
    grantedToday: already,
    /** このバッチの通し番号（`operationId` の枝番になる。1 日の中で必ず増える） */
    batchSeq: (s.lastRunDay === day ? s.batchSeq : 0) + 1,
  };
}

/** 実行後の状態（**同じ日にもう一度走らせない**印を必ず付ける） */
export function applyRolloutRun({ state, nowMs, granted, batchSeq }) {
  const s = normalizeRolloutState(state);
  const day = jstDay(nowMs);
  const n = Math.max(0, num(granted) ?? 0);
  // 日付が変われば今日の集計は 0 から数え直す
  const already = s.lastRunDay === day ? s.dayGrantedCount : 0;
  const seq = num(batchSeq);
  return {
    ...s,
    lastRunDay: day,
    lastRunCount: n,
    dayGrantedCount: already + n,
    batchSeq: seq !== null && seq > 0
      ? seq
      : (s.lastRunDay === day ? s.batchSeq : 0) + 1,
    totalGranted: s.totalGranted + n,
    updatedAtMs: Number(nowMs) || null,
    /**
     * ⚠️ **武装（armedFor）はその日のうちは外さない。**
     *    以前は 1 バッチで外していたが、それだと同日 2 バッチ目が
     *    `not_armed` で止まる。1 日の上限（`dailyLimit`）と関所で守る。
     *    翌日には日付が変わって自然に失効する。
     */
    armedFor: s.alwaysArmed ? s.armedFor : (s.armedFor === day ? day : null),
  };
}

/**
 * 次の段階の提案（**自動では上げない**。画面に出して人が決める）。
 * 「実績が良ければ上げてよい」という判断材料だけを返す。
 */
export function suggestNextStage({ state, deliveredRate, bounceRate, complaintRate }) {
  const s = normalizeRolloutState(state);
  const d = num(deliveredRate);
  const b = num(bounceRate);
  const c = num(complaintRate);
  if (d === null || b === null || c === null) {
    return { stage: s.stage, ok: false, reason: '実績を確認できないため据え置き' };
  }
  // 業界的な危険水域。ここを超えたら**下げる**
  if (b > 0.05 || c > 0.001) {
    return { stage: ROLLOUT_STAGE.PAUSED, ok: true, reason: 'バウンス/苦情が高いので停止' };
  }
  if (d < 0.9) return { stage: s.stage, ok: false, reason: '到達率が低いため据え置き' };
  const order = [ROLLOUT_STAGE.CANARY, ROLLOUT_STAGE.STEADY, ROLLOUT_STAGE.SCALE];
  const i = order.indexOf(s.stage);
  if (i === -1) return { stage: s.stage, ok: false, reason: '段階を上げられない状態' };
  if (i === order.length - 1) return { stage: s.stage, ok: false, reason: '最大段階に到達' };
  return { stage: order[i + 1], ok: true, reason: '実績が基準内のため次段階を提案' };
}

/** 残り日数の見積り（画面表示用。**約束ではない**） */
export function estimateRemainingDays({ remainingCandidates, dailyLimit }) {
  const r = num(remainingCandidates);
  const d = num(dailyLimit);
  if (r === null || d === null || d <= 0) return null;
  return Math.ceil(r / d);
}

export default planRolloutTick;
