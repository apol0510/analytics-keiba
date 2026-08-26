/**
 * sequenceAutomation.js — 連続配信を**自動で 1 ステップだけ進める**計画（純粋・I/O なし）
 *
 * ── 何をして、何をしないか ────────────────────────────────────
 *   する   … 「いま送れる受信者」を進行状態（`sequenceProgress.js`）から選び、
 *            既存の enqueue 契約が要求する形（ScheduledEmails の PENDING 行）を返す
 *   しない … メール送信・Customers への書き込み・新しい送信経路の追加
 *
 * 実送信は既存 dispatcher が担う（**送信経路は 1 本のまま**）。
 *
 * ── 1 回の実行で 1 ステップだけ ───────────────────────────────
 * 複数ステップを同じ実行で流すと、1 人に 2 通が同時に届きうる。
 * `selectNextDueStep` が返す**いちばん小さい due ステップ**だけを流す。
 *
 * ── 初回接触（step1）は自動で送らない ─────────────────────────
 * step1 は「まだ 1 通も送っていない人」への最初の 1 通で、母集団が最大になる。
 * 自動で撃つと事故の規模が最大化するため、**step1 は管理画面から明示的に開始**し、
 * 自動化が進めるのは step2 以降に限る（`allowFirstStep` で明示的に上書きしない限り）。
 *
 * ── ゲート（1 つでも欠ければ何も起きない）────────────────────
 *   1. `MARKETING_SEQUENCE_SCHEDULER_ENABLED=true` … 自動化を動かす意思
 *   2. `MARKETING_SEQUENCE_ARMED=<今日の JST 日付>` … 当日ぶんの明示的な武装
 *      （置きっぱなしでも翌日には自動的に閉じる）
 *   3. `MARKETING_CAMPAIGN_ENABLED=true`          … 既存の live enqueue ゲート
 *   4. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` … 既存の実送信ゲート
 */

import { jstDateString } from './campaignSend.js';
import { selectNextDueStep, SEQ_STATUS } from './sequenceProgress.js';

/** 1 回の実行で進める最大人数（暴走防止。超えたら**切り捨てずに中止**） */
/**
 * 1 tick で扱う上限。
 *
 * ⚠️ **200 → 500 へ引き上げ（2026-08-26 MK 確定）。**
 *    cron を 10 分間隔にしたので 500 × 6 回/時 = **3,000 通/時**。
 *    15,000 名でも同じ日のうちに配り切れる（従来は 1 日 1 回 200 通で 75 日かかった）。
 * ⚠️ 1 回の実行で書き切れる量に収める必要がある（Function の実行時間）。
 *    増やしすぎると途中で落ちるので、**env で下げられる**ようにしてある。
 */
export const MAX_RECIPIENTS_PER_TICK = 500;

/** env から 1 tick の上限を読む（壊れた値は既定へ。0 や負数で止めない） */
export function resolveMaxRecipientsPerTick(env = process.env) {
  const n = Number(env?.MARKETING_SEQUENCE_MAX_PER_TICK);
  return Number.isInteger(n) && n > 0 && n <= 5000 ? n : MAX_RECIPIENTS_PER_TICK;
}

export const SEQUENCE_ENV = Object.freeze({
  SCHEDULER: 'MARKETING_SEQUENCE_SCHEDULER_ENABLED',
  ARMED: 'MARKETING_SEQUENCE_ARMED',
  ENQUEUE: 'MARKETING_CAMPAIGN_ENABLED',
  DISPATCH: 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
});

export const TICK_ABORT = Object.freeze({
  GATES_CLOSED: 'gates_closed',
  NOT_A_SEQUENCE: 'not_a_sequence',
  NO_DUE: 'no_due_recipients',
  FIRST_STEP_MANUAL: 'first_step_is_manual',
  OVER_MAX: 'over_max_recipients',
});

/**
 * ゲートの状態。**値は返さない**（env の中身をログにも応答にも出さない）。
 * @returns {{scheduler, armed, enqueue, dispatch, allOpen, today, missing: string[]}}
 */
/**
 * ゲートを読む。
 *
 * ── 日付 ARM は必須ではない（2026-08-26 MK 確定）────────────────────
 * 以前は `MARKETING_SEQUENCE_ARMED=<今日の JST 日付>` を**毎日書き換えないと**
 * 自動配信が動かなかった。人が毎日 env を触る運用は続かないので必須から外す。
 *
 *   - 未設定 … 武装済みとして扱う（**完全自動運用**）
 *   - 日付が入っている … その日だけ動く（**従来どおりの一日限定運用**も残す）
 *   - 壊れた値 … 動かさない（推測で動かさない）
 *
 * ⚠️ **止める手段は減らしていない**。`MARKETING_SEQUENCE_SCHEDULER_ENABLED` を
 *    外せば即停止し、`MARKETING_CAMPAIGN_DISPATCH_ENABLED` を外せば実送信が止まる。
 *    キャンペーン期間外は `getCampaign()` が null を返して送れない（fail closed）。
 */
export function readSequenceGates(env, nowMs) {
  const e = env || {};
  const scheduler = e[SEQUENCE_ENV.SCHEDULER] === 'true';
  const enqueue = e[SEQUENCE_ENV.ENQUEUE] === 'true';
  const dispatch = e[SEQUENCE_ENV.DISPATCH] === 'true';
  const today = jstDateString(Number.isFinite(nowMs) ? nowMs : 0);
  const armRaw = String(e[SEQUENCE_ENV.ARMED] ?? '').trim();
  // 未設定 = 常時武装（完全自動）。値があるときだけ「その日か」を見る。
  const armed = armRaw === '' ? true : armRaw === today;
  const missing = [
    !scheduler ? SEQUENCE_ENV.SCHEDULER : null,
    !armed ? SEQUENCE_ENV.ARMED : null,
    !enqueue ? SEQUENCE_ENV.ENQUEUE : null,
    !dispatch ? SEQUENCE_ENV.DISPATCH : null,
  ].filter(Boolean);
  return {
    scheduler, armed, enqueue, dispatch, today,
    /** 日付指定で運用しているか（未設定なら常時自動） */
    armMode: armRaw === '' ? 'always' : 'dated',
    allOpen: scheduler && armed && enqueue && dispatch,
    missing,
  };
}

/** 管理画面へ返す表示用（ON/OFF と、開いていない理由の env 名だけ） */
export function readSequenceAutoState(env, nowMs) {
  const g = readSequenceGates(env, nowMs);
  return {
    enabled: g.allOpen,
    label: g.allOpen ? '自動配信 ON（本日ぶん武装済み）' : '自動配信 OFF',
    missing: g.missing,
    today: g.today,
    note: g.allOpen
      ? '毎日 1 回、間隔が来た受信者に**次の 1 ステップだけ**をキュー登録します。'
      : '自動配信は停止中です。管理画面から確認して手動でキュー登録できます（下の人数はそのときの対象です）。',
  };
}

/**
 * 自動実行 1 回ぶんの計画。**何も書かない**（呼び出し側がゲートの内側で実行する）。
 *
 * @param {{progress: object, gates: object, allowFirstStep?: boolean,
 *          maxRecipients?: number}} input
 * @returns {{ok: boolean, abort?: string, step?: number, recordIds?: string[], counts?: object}}
 */
export function planSequenceTick({
  progress, gates, allowFirstStep = false, maxRecipients = MAX_RECIPIENTS_PER_TICK,
  /**
   * 上限を超えたときに**上限まで送って残りを次回へ回す**か（既定 true）。
   * false にすると従来どおり中止する（`over_max_recipients`）。
   */
  allowPartial = true,
} = {}) {
  if (!gates || gates.allOpen !== true) {
    return { ok: false, abort: TICK_ABORT.GATES_CLOSED, missing: (gates && gates.missing) || [] };
  }
  if (!progress || progress.ok !== true) return { ok: false, abort: TICK_ABORT.NOT_A_SEQUENCE };

  const next = selectNextDueStep(progress);
  if (!next.step || next.recordIds.length === 0) {
    return { ok: false, abort: TICK_ABORT.NO_DUE, counts: progress.summary.dueByStep };
  }
  // 初回接触は自動で撃たない（母集団が最大になるため）
  if (next.step === 1 && allowFirstStep !== true) {
    return { ok: false, abort: TICK_ABORT.FIRST_STEP_MANUAL, step: 1, counts: progress.summary.dueByStep };
  }
  // ── 上限を超えたときの扱い ────────────────────────────────────
  //
  // ⚠️ **2026-08-26 MK 確定で変更**。以前は「切り捨てずに中止」だったため、
  //    15,000 名規模のコホートでは **1 通目以降が永久に進まなかった**
  //    （毎回 over_max_recipients で中止し、1 人も送らない）。
  //
  // いまは **上限まで送って、残りは次の tick へ持ち越す**。
  //   - 誰に送ったかは配信台帳（DeliveryKey）が持つので、持ち越しても取りこぼさない
  //   - 同じ相手へ二度送らない（送信済みは次回 due から自動的に外れる）
  //   - `carriedOver` を返すので、残り人数を画面とログで追える
  //
  // ⚠️ **切り捨て（送らないまま黙って捨てる）にはしない**。
  //    残り人数を必ず返し、次の tick で続きから進む。
  if (allowPartial !== true && next.recordIds.length > maxRecipients) {
    return {
      ok: false, abort: TICK_ABORT.OVER_MAX, step: next.step,
      recipients: next.recordIds.length, max: maxRecipients,
    };
  }
  // 上限まで送り、残りは次の tick へ持ち越す
  const take = next.recordIds.slice(0, maxRecipients);
  const carriedOver = next.recordIds.length - take.length;
  return {
    ok: true,
    step: next.step,
    recordIds: take,
    recipients: take.length,
    /** 今回送らずに次回へ回した人数（0 なら完走） */
    carriedOver,
    /** その step で送るべき総数（進捗の分母） */
    dueTotal: next.recordIds.length,
    counts: progress.summary.dueByStep,
  };
}

/** 実行結果の要約（ログ・応答用。**アドレスも recordId も含めない**） */
export function summarizeSequenceTick({ campaignId, plan, enqueued = 0, failed = 0 }) {
  return {
    キャンペーン: String(campaignId || ''),
    ステップ: plan && plan.ok ? plan.step : null,
    対象: plan && plan.ok ? plan.recipients : 0,
    登録: enqueued,
    失敗: failed,
    中止: plan && plan.ok ? null : (plan && plan.abort) || 'unknown',
  };
}

export { SEQ_STATUS };
