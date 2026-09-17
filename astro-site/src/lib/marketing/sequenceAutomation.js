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
/**
 * **同期 tick（`cron-campaign-sequence`）で 1 campaign が積める上限**（安全の要）。
 *
 * ## なぜ上限が要るか（2026-09-17 実測・構造解析）
 *
 * 同期の scheduled function は **60 秒**で打ち切られ、#563 の契約は
 * **1 campaign 30 秒**（`MAX_CAMPAIGN_MS`）。キュー登録の往復回数は人数にほぼ比例する。
 *
 * ## 2026-09-17 の再ベンチ（upsert を上限つき並行にした後）
 *
 * 前提: 1 往復 **約 1.1 秒**（実測）／読み取り phase **13 秒**（実測）／
 * 並行度 **3**（Airtable の 5 req/秒 に余裕を残す）。
 * rate 下限（`往復 ÷ 5 req/秒`）も同時に見て、**遅い方**を採る。
 *
 * | 人数 | 往復 | 逐次(旧) | **並行(新)** | 30 秒契約 | 60 秒打ち切り |
 * |---|---|---|---|---|---|
 * | 50  |  9 |  23 秒 | **19 秒** | ✅ | ✅ |
 * | 75  | 14 |  28 秒 | **23 秒** | ✅ | ✅ |
 * | **100** | 17 |  32 秒 | **24 秒** | ✅（余裕 5.6 秒）| ✅ |
 * | 200 | 34 |  50 秒 | **36 秒** | ❌ | ✅ |
 * | 500 | 85 | 107 秒 | **70 秒** | ❌ | ❌ |
 *
 * 契約に収まる最大は計算上 **140** だが、そこでは余裕が 1 秒を切る。
 * 予測式には誤差があるので、**余裕 5 秒以上**を残す方針（`HARD_LIMIT_SAFETY_MARGIN_MS`
 * と同じ考え方）に合わせて **100** を採る。
 *
 * ⚠️ **打ち切りは「遅くなる」では済まない。** 予約（`claimDelivered`）は
 *    キュー登録の**前**に取るので、登録の途中で殺されると鍵だけが配信済み集合に残り
 *    **その人へは二度と送られない**（送信漏れ）。人数を上げるほどこの窓が広がる。
 *
 * ## 500 にしたいなら
 *
 * `MAX_RECIPIENTS_PER_TICK`（= 500）は**正本の設計値**だが、並行化しても
 * **同期 tick では 70 秒**かかり打ち切りを超える。500 を使うなら一括登録を
 * Background function（15 分）へ移すこと（既存パターン:
 * `drm-entry-background` / `marketing-campaign-dispatch-background`）。
 * **env だけ上げてはいけない。**
 */
export const SYNC_TICK_MAX_RECIPIENTS = 100;

/**
 * env から 1 tick の上限を読む（壊れた値は既定へ。0 や負数で止めない）。
 *
 * ⚠️ **同期 tick の安全上限で頭打ちにする。** env に 500 を入れても
 *    `SYNC_TICK_MAX_RECIPIENTS` を超えない（超えると打ち切り → 送信漏れ）。
 *    上限を上げたいときは `cap` を明示的に渡す経路（Background）を使う。
 */
export function resolveMaxRecipientsPerTick(env = process.env, { cap = SYNC_TICK_MAX_RECIPIENTS } = {}) {
  const n = Number(env?.MARKETING_SEQUENCE_MAX_PER_TICK);
  const wanted = Number.isInteger(n) && n > 0 && n <= 5000 ? n : MAX_RECIPIENTS_PER_TICK;
  const limit = Number.isInteger(cap) && cap > 0 ? cap : SYNC_TICK_MAX_RECIPIENTS;
  return Math.min(wanted, limit);
}

export const SEQUENCE_ENV = Object.freeze({
  SCHEDULER: 'MARKETING_SEQUENCE_SCHEDULER_ENABLED',
  ARMED: 'MARKETING_SEQUENCE_ARMED',
  ENQUEUE: 'MARKETING_CAMPAIGN_ENABLED',
  DISPATCH: 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
});

import { DEFAULT_MAX_SCAN as REFILL_MAX_SCAN } from './sequenceTickRefill.js';

export const TICK_ABORT = Object.freeze({
  GATES_CLOSED: 'gates_closed',
  NOT_A_SEQUENCE: 'not_a_sequence',
  NO_DUE: 'no_due_recipients',
  FIRST_STEP_MANUAL: 'first_step_is_manual',
  OVER_MAX: 'over_max_recipients',
  /**
   * 下見専用の step1 スイッチが live で渡された。**1 件も積まずに中止する**
   * （ゲートを迂回させないため。2026-09-15 の read-only 確認で必要になった経緯は
   *  `docs/CAMPAIGN_SEQUENCE.md` の `drmEntryAllowlistCheck` を参照）。
   */
  FIRST_STEP_OVERRIDE_IN_LIVE: 'first_step_override_in_live',
  /**
   * campaign が宣言している母集団と、呼び出しが求めた出所が食い違う。
   * **広げる方へは倒さず 1 件も積まない**（宣言は狭める方向にしか効かない）。
   */
  AUDIENCE_SOURCE_CONFLICT: 'audience_source_conflict',
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
/**
 * 候補を何人まで返すか（**送る人数の上限ではない**。上限は `maxRecipients`）。
 *
 * ⚠️ **補充側が見に行ける上限（`sequenceTickRefill.DEFAULT_MAX_SCAN`）と一致させる。**
 *    ここが少ないと、先頭が全部既登録のときに後続へ到達できない
 *    （供給 500 / 探索上限 1,000 だと 501 人目以降へ永久に届かない）。
 * ⚠️ 並び順は変えない。公平性は `sequenceAudiencePool` の責任。
 */
export const CANDIDATE_SUPPLY = REFILL_MAX_SCAN;

export function planSequenceTick({
  progress, gates, allowFirstStep = false, maxRecipients = MAX_RECIPIENTS_PER_TICK,
  /**
   * 上限を超えたときに**上限まで送って残りを次回へ回す**か（既定 true）。
   * false にすると従来どおり中止する（`over_max_recipients`）。
   */
  allowPartial = true,
  /**
   * **この tick で既に試して 0 人だった step**（任意 / 2026-09-17 の停滞対応）。
   *
   * `selectNextDueStep` は「いちばん小さい due step」だけを返すので、その step の
   * 候補が**後段の安全条件で全部落ちる**と、tick は毎回同じ step を選んで 0 人で終わり、
   * **後ろの step が永久に進まない**（本番実測: step2 の残り 36 件が `queued` のまま
   * 動かず、step3 の due 5,465 名が 1 通も出なかった）。
   *
   * 呼び出し側が「この step は 0 人だった」と伝えてきたら、その step を外して
   * **次に小さい due step** を選び直す。
   *
   * ⚠️ **省略時（既定の空配列）は挙動が 1 ミリも変わらない。**
   * ⚠️ 除外は**選ぶ step を後ろへずらすだけ**。安全条件・上限・並び順は一切触らない。
   */
  skipSteps = [],
} = {}) {
  if (!gates || gates.allOpen !== true) {
    return { ok: false, abort: TICK_ABORT.GATES_CLOSED, missing: (gates && gates.missing) || [] };
  }
  if (!progress || progress.ok !== true) return { ok: false, abort: TICK_ABORT.NOT_A_SEQUENCE };

  // ── 初回接触は自動で撃たない（母集団が最大になるため）─────────────
  //
  // ⚠️ **2026-09-08 の障害で「中止」から「除外」へ変更**。
  //    以前は最小 due step が 1 になった時点で `first_step_manual` を返し、
  //    **tick 全体を中止**していた。step1 未送信の人が 1 人でも混ざると
  //    step2 以降を待っている全員が巻き添えで止まる
  //    （本番: 328 名の step0 が居たために 11,648 名の step2 が永久に出なかった）。
  //
  //    いまは **step1 の人だけを候補から外し**、残りの最小 due step を進める。
  //    step1 しか居なければ従来どおり `first_step_manual` で止まる（既存挙動）。
  const excludeSteps = allowFirstStep === true ? [] : [1];
  /**
   * この tick で既に 0 人だった step も外す（既定は空＝従来どおり）。
   * ⚠️ step1 の扱いには**足すだけ**で、上書きしない。
   */
  const skip = (Array.isArray(skipSteps) ? skipSteps : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n));
  for (const n of skip) if (!excludeSteps.includes(n)) excludeSteps.push(n);
  const next = selectNextDueStep(progress, { excludeSteps });
  if (!next.step || next.recordIds.length === 0) {
    /**
     * ⚠️ 選び直しの途中でゼロになったときは `first_step_manual` と言わない。
     *    「step1 の人しか居ない」のではなく「**試せる step を使い切った**」ため。
     */
    if (skip.length > 0) {
      return {
        ok: false, abort: TICK_ABORT.NO_DUE, counts: progress.summary.dueByStep,
        skippedSteps: skip,
      };
    }
    // 除外した結果ゼロ = 「step1 の人しか居ない」。理由を区別して返す
    if (next.excludedOnly === true) {
      return {
        ok: false, abort: TICK_ABORT.FIRST_STEP_MANUAL, step: 1, counts: progress.summary.dueByStep,
      };
    }
    return { ok: false, abort: TICK_ABORT.NO_DUE, counts: progress.summary.dueByStep };
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
  /**
   * ⚠️ **候補は上限より多く返す**（2026-09-15 の逓減対策）。
   *
   * `recordIds` は「上限ぶん」だが、呼び出し側はこの後に安全条件
   * （既に `queued` / `sent` の人を外す・出所フィルタ・許可リスト）で候補を削る。
   * 上限ぶんしか渡さないと、削られた分だけ枠が空いたまま終わる
   * （本番実測: 50 → 20 → 13 → 4 と逓減し、due が 1,800 人以上残っているのに
   *  1 tick で 4 人しか進まなくなった）。
   *
   * `candidateIds` は**削られる前提の候補**。実際に積む人数の上限は
   * `recipients`（= `recordIds.length`）が持ち、呼び出し側はそれを超えて積まない。
   * ⚠️ 並び順は変えない（公平性は母集団側の責任）。
   */
  const candidateIds = next.recordIds.slice(0, CANDIDATE_SUPPLY);
  return {
    ok: true,
    step: next.step,
    recordIds: take,
    /** 安全条件で削られる前提の候補（`recipients` を超えて積んではいけない）*/
    candidateIds,
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
