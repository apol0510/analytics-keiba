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

/**
 * 1 日あたりの**絶対上限**。状態が壊れてもこれを超えない。
 *
 * ⚠️ 以前は 2000 固定だった（カナリア期の安全弁）。
 *    AK の最終目的は約 15,000 件のコホートへ Step1 を配ることで、
 *    2000/日 では 8 日かかる。**必要なら 1 日で配り切れる**ようにここを上げ、
 *    実際の配信量は運用が `dailyLimit` で明示する（既定値は無い＝必ず指定させる）。
 * ⚠️ それでも**無制限にはしない**。桁を間違えた指定（15 万など）は弾く。
 */
export const ABSOLUTE_MAX_PER_DAY = 20000;

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
  /**
   * 関所の未処理数が「自分が配った数」を超えている＝**説明できない未処理**。
   * 別経路の付与・状態の巻き戻りなどが疑われるので、推測で進めず止める。
   */
  OUTSTANDING_MISMATCH: 'outstanding_mismatch',
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
  outstanding_mismatch: '未処理の数が説明できません（安全側で停止）',
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
     * **いまの論理バッチで配った人数**（`batchSize` に達するまで積み上がる）。
     * 論理バッチ 500 名は付与側の上限で 200 + 200 + 100 の 3 回に分かれるので、
     * 「500 名ぶん配り終えたか」はこの数で判断する。
     * 500 名を queue → 送信し終えて関所が空いたら 0 に戻る。
     */
    batchGrantedCount: 0,
    /**
     * **異常で自動停止したか**（`stage: 'paused'` の理由の区別）。
     * 1 日上限に達しただけの停止と、人が直すべき異常停止を混同しないために持つ。
     */
    autoStopped: false,
    /** 自動停止の理由コード（PII は入れない） */
    stopReason: null,
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
    /**
     * **論理バッチぶんの引き継ぎ**（付与 1 回ごとに 1 つ増える）。
     * 500 名は 200 + 200 + 100 の 3 回に分かれるので、**3 つ溜めてから**まとめて queue する。
     * 旧 `pendingHandoffOp`（単数）は後方互換のため読み続ける。
     */
    pendingHandoffOps: [],
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
  const daily = dailyRaw !== null && dailyRaw >= 0 ? Math.min(Math.floor(dailyRaw), ABSOLUTE_MAX_PER_DAY) : null;
  return {
    version: num(raw.version) || 1,
    stage,
    killed: raw.killed === true,
    dailyLimit: daily,
    batchSize: (() => {
      const b = num(raw.batchSize);
      return b !== null && b > 0 ? Math.min(Math.floor(b), ABSOLUTE_MAX_PER_DAY) : null;
    })(),
    dayGrantedCount: Math.max(0, num(raw.dayGrantedCount) ?? 0),
    batchSeq: Math.max(0, num(raw.batchSeq) ?? 0),
    batchGrantedCount: Math.max(0, num(raw.batchGrantedCount) ?? 0),
    autoStopped: raw.autoStopped === true,
    stopReason: str(raw.stopReason).slice(0, 80) || null,
    armedFor: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.armedFor)) ? str(raw.armedFor) : null,
    alwaysArmed: raw.alwaysArmed === true,
    lastRunDay: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.lastRunDay)) ? str(raw.lastRunDay) : null,
    lastRunCount: Math.max(0, num(raw.lastRunCount) ?? 0),
    totalGranted: Math.max(0, num(raw.totalGranted) ?? 0),
    pendingHandoffOp: str(raw.pendingHandoffOp).slice(0, 100) || null,
    pendingHandoffOps: Array.isArray(raw.pendingHandoffOps)
      ? raw.pendingHandoffOps.map((v) => str(v).slice(0, 100)).filter(Boolean).slice(0, 10)
      : (str(raw.pendingHandoffOp) ? [str(raw.pendingHandoffOp).slice(0, 100)] : []),
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
  return Math.max(0, Math.min(n, ABSOLUTE_MAX_PER_DAY));
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
  return Math.max(0, Math.min(b, daily, ABSOLUTE_MAX_PER_DAY));
}

/** 今日すでに配った人数（日付が変わっていれば 0） */
export function grantedToday(state, nowMs) {
  const s = normalizeRolloutState(state);
  return s.lastRunDay === jstDay(nowMs) ? s.dayGrantedCount : 0;
}

/** 今日まだ配ってよい人数（1 日上限 − 今日すでに配った数）。負にはしない */
export function dailyRoomToday(state, nowMs) {
  const s = normalizeRolloutState(state);
  return Math.max(0, resolveDailyLimit(s) - grantedToday(s, nowMs));
}

/**
 * **候補を何人ぶん観測するか**（＝この 1 回で配りうる最大人数）。
 *
 * ⚠️ 候補の取得は bounded（必要な分だけ Airtable から取る）なので、
 *    **観測窓がそのまま allowance の上限になる**。窓が意図より狭いと
 *    `planRolloutTick` の `remaining` が小さく出て、**エラーも出さずに**
 *    バッチが縮む。
 * ⚠️ 2026-08-17 の事故: `batchSize=500 / dailyLimit=500` を設定したのに、
 *    観測が付与側の既定（`LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE` 未設定 = 100）で
 *    打ち切られ、**100 名しか付与されなかった**。以後、観測窓は
 *    設定された `batchSize` と今日の残り枠に**必ず**合わせる。
 *    **既定値（100）へ落とすことは二度としない。**
 *
 * @param {object} state
 * @param {number} nowMs
 * @param {{perCallMax?: number}} [opts]
 *   `perCallMax` = **1 回の付与呼び出しで扱える上限**（付与側の
 *   `HARD_MAX_BATCH_SIZE`。2026-08-13 の #319 以来の既存仕様）。
 *   `batchSize` がこれより大きくても**断らない**。1 回あたりをこの上限で刻み、
 *   残りは次の tick が続きを拾う（`dayGrantedCount` は積み上がるので
 *   `dailyLimit` の意味は変わらない）。**設定を拒否しない・100 へも落とさない**。
 *
 * 例:
 * - batchSize=500 / 残り枠 500 / perCallMax 500 → 窓 **500**
 * - batchSize=500 / 今日すでに 100 名 → 窓 **400**（= 残り枠）
 * - batchSize=1000 / 残り枠 1000 / perCallMax 500 → 窓 **500**（1000 は 2 回に分かれて進む）
 */
export function resolveObservationWindow(state, nowMs, { perCallMax } = {}) {
  const s = normalizeRolloutState(state);
  const cap = Number.isFinite(perCallMax) && perCallMax > 0 ? perCallMax : Infinity;
  // ⚠️ いまのバッチが埋まっていても **0 にしない**。次に付与が起きるとしたら
  //    それは「新しいバッチの 1 回目」なので、窓は `batchSize` に戻る。
  //    ここを 0 にすると候補を 1 人も観測できず、`remainingCandidates` が
  //    下限 1 に落ちて **1 名ずつしか配れなくなる**（同日完走に届かない）。
  //    進めてよいかどうかを決めるのは `planRolloutTick`（関所・1 日上限）。
  const room = resolveBatchRoom(s) || resolveBatchSize(s);
  return Math.max(0, Math.min(room, dailyRoomToday(s, nowMs), cap));
}

/**
 * **いまの論理バッチで、あと何人配れるか**（`batchSize - batchGrantedCount`）。
 *
 * ⚠️ 論理バッチ（`batchSize`）と付与 1 回（`GRANT_OPERATION_MAX` = 200）は別物。
 *    500 名のバッチは 200 + 200 + 100 の 3 回に分かれて配られ、
 *    **3 回を配り終えてから** queue → 送信 → 関所確認へ進む。
 * ⚠️ 0 のときは「このバッチはもう配り切った」＝ 関所が空くまで次を始めない。
 *    ただし関所が空いていれば**次のバッチを始めてよい**ので、
 *    `planRolloutTick` が `batchSize` へ戻して計画する。
 */
export function resolveBatchRoom(state) {
  const s = normalizeRolloutState(state);
  const size = resolveBatchSize(s);
  return Math.max(0, size - Math.max(0, s.batchGrantedCount));
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
    /** 候補を何人ぶん観測すべきか。**事実収集はこの窓で取る**（狭いと allowance が黙って縮む） */
    observationWindow: resolveObservationWindow(s, nowMs),
    /** いまの論理バッチの進み具合（500 名なら 200 → 400 → 500） */
    batchGrantedCount: Math.max(0, s.batchGrantedCount),
    batchRoom: resolveBatchRoom(s),
    startsNewBatch: false,
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
  // ④ 関所（**論理バッチ単位**でバッチを直列化する）
  //    ⚠️ 500 名のバッチは付与側の上限で 200 + 200 + 100 に分かれる。
  //       その 3 回の途中は「自分が配ったぶん」が未処理として残るので、
  //       **バッチを配り切るまでは未処理があっても進む**。
  //       配り切ったら queue → 送信 → 台帳確認（`outstanding` が 0 に戻る）まで待つ。
  //    ⚠️ 未処理が「自分が配った数」を超えるのは説明できない状態。**推測で進めない**。
  const outstanding = num(previousOutstanding);
  if (outstanding === null) return { ...base, ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE };
  const granted = Math.max(0, s.batchGrantedCount);
  let batchRoom = resolveBatchRoom(s);
  let startsNewBatch = false;
  if (granted > 0) {
    // バッチの途中。未処理は**自分が配ったぶん**のはずで、それを超えるのは説明できない
    if (outstanding > granted) {
      return { ...base, ok: false, reason: ROLLOUT_BLOCK.OUTSTANDING_MISMATCH };
    }
    if (batchRoom <= 0) {
      // 配り切った → queue → 送信 → 台帳確認（未処理 0）まで待つ
      if (outstanding > 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.WAITING_PREVIOUS };
      batchRoom = batchSize;
      startsNewBatch = true;
    }
  } else {
    // 新しいバッチを始めるときは、**前のバッチが完全に片付いている**ことを要求する
    if (outstanding > 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.WAITING_PREVIOUS };
    batchRoom = batchSize;
    startsNewBatch = true;
  }

  // ⑤ 対象が読めない / いない
  const remaining = num(remainingCandidates);
  if (remaining === null) return { ...base, ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE };
  if (remaining <= 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.NO_CANDIDATES };

  // ⑥ 今日の残り枠（**1 日 1 回ではなく、1 日の合計人数**で止める）
  if (dailyLimit <= 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED };
  const already = grantedToday(s, nowMs);
  const dailyRoom = dailyRoomToday(s, nowMs);
  if (dailyRoom <= 0) {
    return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED, grantedToday: already };
  }

  const allowance = Math.min(batchRoom, dailyRoom, remaining);
  if (allowance <= 0) {
    return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED, grantedToday: already };
  }

  return {
    ...base,
    ok: true,
    allowance,
    reason: null,
    grantedToday: already,
    batchRoom,
    /** この付与でバッチを新しく始めるか（`applyRolloutRun` が集計を 0 から数え直す） */
    startsNewBatch,
    /** この付与の通し番号（`operationId` の枝番になる。1 日の中で必ず増える） */
    batchSeq: (s.lastRunDay === day ? s.batchSeq : 0) + 1,
  };
}

/** 実行後の状態（**同じ日にもう一度走らせない**印を必ず付ける） */
export function applyRolloutRun({
  state, nowMs, granted, batchSeq, startsNewBatch = false, closeBatch = false,
}) {
  const s = normalizeRolloutState(state);
  const day = jstDay(nowMs);
  const n = Math.max(0, num(granted) ?? 0);
  // 論理バッチの進み具合。新しいバッチなら 0 から数え直す
  const batchBase = startsNewBatch === true ? 0 : Math.max(0, s.batchGrantedCount);
  // 日付が変われば今日の集計は 0 から数え直す
  const already = s.lastRunDay === day ? s.dayGrantedCount : 0;
  const seq = num(batchSeq);
  return {
    ...s,
    lastRunDay: day,
    lastRunCount: n,
    dayGrantedCount: already + n,
    // `closeBatch` = 候補が尽きたのでこのバッチはここまで（queue へ進ませる）
    batchGrantedCount: closeBatch === true
      ? Math.max(resolveBatchSize(s), batchBase + n)
      : batchBase + n,
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
