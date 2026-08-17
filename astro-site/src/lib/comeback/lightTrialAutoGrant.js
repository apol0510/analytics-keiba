/**
 * lightTrialAutoGrant.js — Light 30日無料体験の**入口を自動化する計画**（純粋・I/O なし）
 *
 * ── 新しい付与の実装を作らない ────────────────────────────────
 * 付与の形（どの列に何を書くか）・冪等性・除外理由は
 * **`comebackGrantPlan.js`（`buildComebackPlan`）が単一源**。ここがやるのは
 *   1. 対象コホート（CSV 取り込み）に絞る
 *   2. **過去に同じ無料体験を受けた人を外す**
 *   3. 既存 planner へ渡して計画を作る
 *   4. 付与に成功した人だけを Step1 の送信対象として返す
 * だけ。付与フィールドの組み立ては 1 バイトも複製しない。
 *
 * ── 付与と送信は**完全に分離**する ───────────────────────────
 *   この経路は **Light の無料権利を付けるだけ**で、メールを 1 通も作らない。
 *   したがって配信系ゲート（`MARKETING_CAMPAIGN_ENABLED` /
 *   `MARKETING_CAMPAIGN_DISPATCH_ENABLED`）は**要求しない**。
 *   Step1 の送信は別工程（管理画面の dry-run → キュー登録）で、
 *   **付与に成功して無料期間中になった人だけ**が対象になる
 *   （`requiresActiveGrant` の判定が構造的に保証する）。
 *   付与に失敗した人は権利が無いので、Step1 の対象に**入りようがない**。
 *
 * ── 段階実行（14,000 件規模でも全体 abort しない）──────────────
 *   1 回の実行では**未付与の候補の先頭 N 件だけ**を処理する（既定 100）。
 *   **offset の正本は作らない。** 付与した人は次回の候補判定で
 *   `grant_active` / `granted_before` に落ちるため、**再実行すると自然に次の N 件へ進む**。
 *   失敗した人は候補に残るので、次回そのまま再評価される。
 *   並び順は recordId 昇順で決めるので、同じ入力なら**毎回同じ 100 件**になる。
 *
 * ── 冪等性 ──────────────────────────────────────────────────
 *   付与 … `operationId` が同じなら同じ結果（`buildGrantFields` が
 *          `LightGrantOp` を見て `already_applied` を返す）。
 *          さらに現に有効な付与を持つ人は `already_granted` で落ちる
 *   送信 … DeliveryKey（campaign × version × step × 受信者）で 1 通だけ
 *
 * ── ゲート（1 つでも欠ければ**何も書かない**）────────────────────
 *   1. `COMEBACK_GRANT_FIELDS_READY=1`      … 既存の付与ゲート（列の実在）
 *   2. `COMEBACK_GRANT_ENABLED=true`        … 既存の付与ゲート（実行許可）
 *   3. `LIGHT_TRIAL_AUTOGRANT_ENABLED=true` … 自動化そのものの許可
 *   4. `LIGHT_TRIAL_AUTOGRANT_ARMED=<今日の JST 日付>`（翌日には自動的に閉じる）
 *
 * ⚠️ 1・2 は**手動付与と同じゲート**を再利用する（自動化のために別の抜け道を作らない）。
 * ⚠️ **配信系ゲートは要求しない。** 付与はメールを 1 通も作らないので、
 *    権利を配るために配信を開ける必要はない（開けると事故の範囲が広がる）。
 */

import { jstDateString } from '../marketing/campaignSend.js';
import { buildComebackPlan, MAX_GRANT_RECORDS } from './comebackGrantPlan.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';
import { evaluateStep1Barrier, barrierToken } from './lightTrialBarrier.js';
import { createHash } from 'node:crypto';
import { matchesImportCohort, summarizeCohort, assertCohortObservable } from '../crm/importedCohort.js';
import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';
import { resolveFreeGrantHistory } from '../entitlements/freeGrantStatus.js';

/** 1 回の実行で付与する既定の件数 */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * 1 回の実行で付与してよい**絶対上限**。
 * env でこれを超える値を指定したら**実行しない**（fail closed）。
 * 大きくするほど 1 回の事故の範囲が広がるので、コード側の歯止めとして固定する。
 */
export const HARD_MAX_BATCH_SIZE = 500;

/** 後方互換（既定値の別名） */
export const MAX_GRANTS_PER_RUN = DEFAULT_BATCH_SIZE;

/**
 * **1 回の付与操作で実際に扱える人数の上限**（＝呼び出し側が 1 回に依頼してよい最大）。
 *
 * ⚠️ 上限は 1 つではない。**低い方が勝つ**:
 *   - `HARD_MAX_BATCH_SIZE`（この Function の歯止め・500）
 *   - `MAX_GRANT_RECORDS`（`buildComebackPlan` が計画を作る上限・200）
 *     → これを超えると **計画自体が作られず** `too_many_records:N>200` で 0 件になる
 *
 * ⚠️ **ここで数値を再定義しない**（正本は各モジュール）。2026-08-17 の事故:
 *    `batchSize=500` から allowance 400 を 1 回で依頼し、`too_many_records:400>200` で
 *    毎 tick 付与 0 のまま空回りした。以後、依頼人数はこの値で刻む。
 * ⚠️ 論理的な「1 バッチの人数」（展開状態の `batchSize` = 500 / 1000 など）を
 *    **狭める意味ではない**。バッチはこの単位に分割して進む。
 */
export const GRANT_OPERATION_MAX = Math.min(HARD_MAX_BATCH_SIZE, MAX_GRANT_RECORDS);

/** 自動付与に使う特典（カタログの正本。ここで日数を書かない） */
export const TRIAL_OFFER_ID = 'light-30d-free';

/**
 * 付与のあとに案内する連続配信。**cron と管理画面の下見が同じキャンペーンを見る**ための単一源。
 * ここが割れると「下見では関所が開いているのに cron は閉じている」のような食い違いが出る。
 */
export const TRIAL_SEQUENCE_ID = 'light-trial-to-premium-sequence';

export const AUTOGRANT_ENV = Object.freeze({
  /** 既存の手動付与と同じゲート（自動化のために別の抜け道を作らない） */
  FIELDS_READY: 'COMEBACK_GRANT_FIELDS_READY',
  GRANT_ENABLED: 'COMEBACK_GRANT_ENABLED',
  ENABLED: 'LIGHT_TRIAL_AUTOGRANT_ENABLED',
  ARMED: 'LIGHT_TRIAL_AUTOGRANT_ARMED',
  /** 1 回の件数（任意。未設定なら既定 100） */
  BATCH_SIZE: 'LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE',
});

export const AUTOGRANT_ABORT = Object.freeze({
  GATES_CLOSED: 'gates_closed',
  COHORT_UNVERIFIABLE: 'cohort_unverifiable',
  NO_CANDIDATES: 'no_candidates',
  /** 前回付与ぶんの Step1 がまだ片付いていない（関所） */
  WAITING_FOR_STEP1: 'waiting_for_step1',
  /** env の件数指定が絶対上限を超えている / 壊れている（**実行しない**） */
  BATCH_SIZE_REJECTED: 'batch_size_rejected',
  OFFER_UNAVAILABLE: 'offer_unavailable',
});

/** 自動付与の対象外理由（dry-run に必ず件数で出す） */
export const AUTOGRANT_SKIP = Object.freeze({
  NOT_IN_COHORT: 'not_in_cohort',
  PAID_MEMBER: 'paid_member',
  GRANT_ACTIVE: 'grant_active',
  GRANT_LIFETIME: 'grant_lifetime',
  GRANTED_BEFORE: 'granted_before',
  NOT_SENDABLE: 'not_sendable',
});

export const AUTOGRANT_SKIP_LABEL = Object.freeze({
  not_in_cohort: 'CSV 取り込みの会員ではない',
  paid_member: '有料契約が有効（無料体験は不要）',
  grant_active: 'すでに無料期間中',
  grant_lifetime: '期限なしの無料付与を保有',
  granted_before: '過去に無料付与を受けた記録がある（再付与しない）',
  not_sendable: '配信停止・バウンス・停止アカウント等',
});

const str = (v) => String(v ?? '').trim();

/**
 * 1 回の件数を決める。**壊れた値・上限超えは実行しない**（fail closed）。
 *
 * @returns {{ok: true, size: number, source: string} | {ok: false, reason: string, requested: string}}
 */
export function resolveBatchSize(env = process.env) {
  const raw = str((env || {})[AUTOGRANT_ENV.BATCH_SIZE]);
  if (!raw) return { ok: true, size: DEFAULT_BATCH_SIZE, source: 'default' };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, reason: 'not_a_positive_integer', requested: raw };
  }
  if (n > HARD_MAX_BATCH_SIZE) {
    return { ok: false, reason: `over_hard_max:${HARD_MAX_BATCH_SIZE}`, requested: raw };
  }
  return { ok: true, size: n, source: 'env' };
}

/** ゲートの状態。**env の値は返さない**（不足している名前だけ） */
export function readAutoGrantGates(env, nowMs) {
  const e = env || {};
  const fieldsReady = str(e[AUTOGRANT_ENV.FIELDS_READY]) === '1';
  const grantEnabled = e[AUTOGRANT_ENV.GRANT_ENABLED] === 'true';
  const enabled = e[AUTOGRANT_ENV.ENABLED] === 'true';
  const today = jstDateString(Number.isFinite(nowMs) ? nowMs : 0);
  const armed = str(e[AUTOGRANT_ENV.ARMED]) === today;
  const missing = [
    !fieldsReady ? AUTOGRANT_ENV.FIELDS_READY : null,
    !grantEnabled ? AUTOGRANT_ENV.GRANT_ENABLED : null,
    !enabled ? AUTOGRANT_ENV.ENABLED : null,
    !armed ? AUTOGRANT_ENV.ARMED : null,
  ].filter(Boolean);
  return {
    fieldsReady, grantEnabled, enabled, armed, today,
    allOpen: missing.length === 0, missing,
  };
}

/**
 * 1 人ぶんの自動付与可否（**コホートと履歴だけ**を見る）。
 *
 * 退会・強制ログアウト・重複アドレス・アカウント停止などの判定は
 * **`buildComebackPlan` 側の `checkGrantable` が単一源**なので、ここでは重ねない
 * （二重に判定すると理由がズレる）。ここで落とすのは planner が見ない条件だけ。
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function checkAutoGrantCandidate({ fields, marketing, batchIds, nowMs }) {
  const f = fields || {};
  const m = marketing || {};

  if (!matchesImportCohort(f, { batchIds }).ok) {
    return { ok: false, reason: AUTOGRANT_SKIP.NOT_IN_COHORT };
  }
  if (m.sendable !== true) return { ok: false, reason: AUTOGRANT_SKIP.NOT_SENDABLE };
  // 有料契約が有効な人に無料体験は配らない（marketing の paid* は課金契約のみ）
  if (m.premiumActive === true || m.lightActive === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.PAID_MEMBER };
  }

  const grants = resolvePromotionalGrants(f, nowMs);
  if (grants.light.lifetime === true || grants.premium.lifetime === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.GRANT_LIFETIME };
  }
  if (grants.light.active === true || grants.premium.active === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.GRANT_ACTIVE };
  }
  // **過去に受けた人へは原則として再付与しない**（履歴の正本は freeGrantStatus）
  const history = resolveFreeGrantHistory(f, nowMs);
  if (history.light.granted === true || history.premium.granted === true) {
    return { ok: false, reason: AUTOGRANT_SKIP.GRANTED_BEFORE };
  }
  return { ok: true, reason: null };
}

/**
 * 候補の抽出（**書き込みはしない**。dry-run と本実行が同じこの関数を通る）。
 *
 * @param {{ records: Array<{recordId, fields, marketing}>, batchIds?: string[]|null,
 *           nowMs: number, maxGrants?: number }} input
 */
export function selectAutoGrantCandidates({ records, batchIds, nowMs, maxGrants = MAX_GRANTS_PER_RUN }) {
  const rows = Array.isArray(records) ? records : [];
  const cohort = summarizeCohort(rows.map((r) => ({ fields: r.fields })), { batchIds });

  const byReason = {};
  const candidates = [];
  const seenEmail = new Set();
  for (const r of rows) {
    const email = str((r.marketing && r.marketing.email) || (r.fields && r.fields.Email)).toLowerCase();
    const check = checkAutoGrantCandidate({ fields: r.fields, marketing: r.marketing, batchIds, nowMs });
    if (!check.ok) { byReason[check.reason] = (byReason[check.reason] || 0) + 1; continue; }
    // 同一アドレスの重複レコードは 1 人ぶんだけ（planner 側でも弾くが、件数を合わせる）
    if (email && seenEmail.has(email)) continue;
    if (email) seenEmail.add(email);
    candidates.push({ recordId: r.recordId, fields: r.fields });
  }

  // **決定的な順序**（recordId 昇順）。同じ入力なら毎回同じ先頭 N 件になる
  candidates.sort((a, b) => String(a.recordId).localeCompare(String(b.recordId)));
  const size = Number.isInteger(maxGrants) && maxGrants > 0 ? maxGrants : DEFAULT_BATCH_SIZE;
  const batch = candidates.slice(0, size);

  return {
    cohort,
    candidates,
    /** 今回処理する先頭 N 件（**offset は持たない**。付与済みは次回の候補から自然に消える） */
    batch,
    counts: {
      scanned: rows.length,
      cohortTotal: cohort.inCohort,
      candidates: candidates.length,
      /** 今回処理する件数 */
      batchSize: batch.length,
      /** 今回のぶんを処理したあとに残る件数 */
      remaining: Math.max(0, candidates.length - batch.length),
      byReason,
      cap: size,
      hardMax: HARD_MAX_BATCH_SIZE,
    },
  };
}

/**
 * 実行 1 回ぶんの計画。**ここでも何も書かない**（呼び出し側がゲートの内側で実行する）。
 *
 * @param {{ selection: object, gates: object, offer: object|null, maxGrants?: number }} input
 * @returns {{ok: boolean, abort?: string, candidates?: Array, counts?: object}}
 */
export function planAutoGrantRun({ selection, gates, offer, batchSize } = {}) {
  if (!gates || gates.allOpen !== true) {
    return { ok: false, abort: AUTOGRANT_ABORT.GATES_CLOSED, missing: (gates && gates.missing) || [] };
  }
  if (!offer || offer.offerId !== TRIAL_OFFER_ID) {
    return { ok: false, abort: AUTOGRANT_ABORT.OFFER_UNAVAILABLE };
  }
  const sel = selection || {};
  // **コホートを観測できていなければ誰にも付与しない**
  const observable = assertCohortObservable(sel.cohort || {});
  if (!observable.ok) return { ok: false, abort: AUTOGRANT_ABORT.COHORT_UNVERIFIABLE, counts: sel.counts };

  const all = Array.isArray(sel.candidates) ? sel.candidates : [];
  if (all.length === 0) return { ok: false, abort: AUTOGRANT_ABORT.NO_CANDIDATES, counts: sel.counts };

  // ⚠️ **候補が多くても全体を中止しない**（14,000 件規模でも段階実行で進む）。
  //    今回のぶん（先頭 N 件）だけを返し、残りは次回の実行が拾う。
  const size = Number.isInteger(batchSize) && batchSize > 0
    ? Math.min(batchSize, HARD_MAX_BATCH_SIZE)
    : (sel.batch ? sel.batch.length : DEFAULT_BATCH_SIZE);
  const batch = (sel.batch && sel.batch.length === size) ? sel.batch : all.slice(0, size);

  return {
    ok: true,
    candidates: batch,
    recipients: batch.length,
    remaining: Math.max(0, all.length - batch.length),
    counts: sel.counts,
  };
}

/**
 * 付与結果 → **Step1 を送ってよい recordId**。
 *
 * ⚠️ ここが順序保証の要。`buildComebackPlan` の targets のうち
 *    **実際に書き込みへ成功したもの**だけを返す。付与前・失敗分は 1 件も通さない。
 *
 * @param {{ targets: Array<{recordId}>, writtenRecordIds: Iterable<string> }} input
 */
export function recipientsAfterGrant({ targets, writtenRecordIds }) {
  const ok = new Set([...(writtenRecordIds || [])].map(str).filter(Boolean));
  return (Array.isArray(targets) ? targets : [])
    .map((t) => str(t && t.recordId))
    .filter((id) => id && ok.has(id));
}

/**
 * この実行（**1 バッチ**）の識別子。
 *
 * - `light-trial-2026-08-17`      … その日の 1 バッチ目（**従来と同じ値**）
 * - `light-trial-2026-08-17-b2`   … 同じ日の 2 バッチ目
 *
 * ⚠️ 同じ値なら**付与は冪等**（`buildGrantFields` が同じ結果を書く）。
 *    だから「同じバッチの再実行」は安全で、「別のバッチ」は必ず別の値になる。
 * ⚠️ 1 バッチ目を枝番なしにしているのは**既存データとの互換のため**
 *    （2026-08-15 / 08-16 の付与は枝番なしで記録されている）。
 */
export function buildTrialOperationId(nowMs, batchSeq) {
  const day = jstDateString(Number.isFinite(nowMs) ? nowMs : 0);
  const seq = Number(batchSeq);
  if (!Number.isInteger(seq) || seq <= 1) return `light-trial-${day}`;
  return `light-trial-${day}-b${seq}`;
}

/**
 * **下見と実行が同じ計画を作るための 1 本。**（選び方は問わない）
 *
 * `selection` は
 *   - 全件から選んだもの（`selectAutoGrantCandidates`。テスト・少数データ用）
 *   - Airtable 側で絞って必要な分だけ取ったもの（`selectCandidatesBounded`。**本番**）
 * のどちらでもよい。ここから先（関所・計画・指紋）は**完全に同じ経路**を通る。
 *
 * @param {{selection: object, env?: object, nowMs: number, gates?: object,
 *          barrierRecords?: object[]|null}} input
 */
export function buildPlanFromSelection({
  selection, env = process.env, nowMs, gates,
  sequenceCampaign, deliveries, providerSuppressed, brand, fromEmail,
  /** 関所の対象者。省略時は selection の元データを使わない（= 関所を評価しない） */
  barrierRecords = null,
  /** そのバッチの通し番号（1 日の 2 バッチ目以降は operationId の枝番になる） */
  batchSeq = 1,
} = {}) {
  const batch = resolveBatchSize(env);
  if (!batch.ok) {
    return {
      ok: false, abort: AUTOGRANT_ABORT.BATCH_SIZE_REJECTED,
      reason: batch.reason, requested: batch.requested, hardMax: HARD_MAX_BATCH_SIZE,
    };
  }
  const offerRes = resolveOffer(TRIAL_OFFER_ID);
  if (!offerRes.ok) return { ok: false, abort: AUTOGRANT_ABORT.OFFER_UNAVAILABLE };
  const offer = offerRes.offer;

  const g = gates || readAutoGrantGates(env, nowMs);
  const operationId = buildTrialOperationId(nowMs, batchSeq);
  /** Airtable 側で絞って必要な分だけ取ったか（= 全体の残数を知らない） */
  const bounded = !!(selection && selection.counts && selection.counts.bounded === true);

  const barrier = sequenceCampaign
    ? evaluateStep1Barrier({
      records: barrierRecords || [], campaign: sequenceCampaign, deliveries,
      providerSuppressed, brand, fromEmail, nowMs,
    })
    : { granted: 0, outstanding: 0, resolved: 0, byReason: {}, nextBatchAllowed: true, evaluated: false };

  const view = {
    offerId: TRIAL_OFFER_ID,
    operationId,
    batchSize: batch.size,
    batchSizeSource: batch.source,
    hardMax: HARD_MAX_BATCH_SIZE,
    cohort: selection.cohort,
    counts: selection.counts,
    gates: { allOpen: g.allOpen, missing: g.missing },
    barrier,
  };

  if (sequenceCampaign && barrier.nextBatchAllowed !== true) {
    return {
      ...view,
      ok: false,
      abort: AUTOGRANT_ABORT.WAITING_FOR_STEP1,
      outstandingStep1: barrier.outstanding,
      planFingerprint: '',
      targets: 0,
    };
  }

  const planned = planAutoGrantRun({ selection, gates: g, offer, batchSize: batch.size });
  if (!planned.ok) {
    const grantPlan = buildComebackPlan({
      grantOffers: [offer], purchaseOffer: null, selected: selection.batch || [],
      nowMs, operationId, actor: 'cron-light-trial', source: 'light-trial-autogrant',
    });
    return {
      ...view,
      ok: false,
      abort: planned.abort,
      missing: planned.missing,
      planFingerprint: grantPlan.ok ? withBarrier(grantPlan.planFingerprint, barrier) : '',
      targets: grantPlan.ok ? grantPlan.targets.length : 0,
    };
  }

  const grantPlan = buildComebackPlan({
    grantOffers: [offer], purchaseOffer: null, selected: planned.candidates,
    nowMs, operationId, actor: 'cron-light-trial', source: 'light-trial-autogrant',
  });
  if (!grantPlan.ok) return { ...view, ok: false, abort: grantPlan.error };

  return {
    ...view,
    ok: true,
    plan: grantPlan,
    targets: grantPlan.targets.length,
    // ⚠️ bounded 選択では**全体を数えていない**ので残数を出さない（嘘の 0 を出さない）
    remaining: bounded ? null : planned.remaining,
    planFingerprint: withBarrier(grantPlan.planFingerprint, barrier),
  };
}

/**
 * 全件を渡して計画まで作る（**テストと少数データ専用**）。
 *
 * ⚠️ 本番の cron / 管理画面の下見は**これを使わない**。Customers 全件走査は
 *    14,489 件規模で関数タイムアウトに収まらないため、`selectCandidatesBounded` を使う。
 *
 * @param {{records: object[], env?: object, nowMs: number, gates?: object}} input
 * @returns {{ok: boolean, abort?: string, ...}}
 */
export function buildTrialGrantPlan({
  records, env = process.env, nowMs, gates,
  sequenceCampaign, deliveries, providerSuppressed, brand, fromEmail,
} = {}) {
  const batch = resolveBatchSize(env);
  const selection = selectAutoGrantCandidates({
    records, nowMs, maxGrants: batch.ok ? batch.size : DEFAULT_BATCH_SIZE,
  });
  // 関所の対象は「自動付与で配った人」だけ。全件から絞るのはここ（少数データ前提）
  return buildPlanFromSelection({
    selection, env, nowMs, gates,
    sequenceCampaign, deliveries, providerSuppressed, brand, fromEmail,
    barrierRecords: records,
  });
}

/**
 * 指紋に**関所の状態**を混ぜる。
 * 「同じ 100 件」でも、関所が開いているかどうかで実行の意味が違うため、
 * 下見と実行の突き合わせにはその違いも含める。
 */
function withBarrier(fingerprint, barrier) {
  return createHash('sha256')
    .update(`${String(fingerprint)}|${barrierToken(barrier)}`, 'utf8')
    .digest('hex');
}

/** 実行結果の要約（**アドレスも recordId も含めない**） */
export function summarizeAutoGrantRun({ plan, granted = 0, failed = 0 }) {
  return {
    コホート: plan && plan.counts ? plan.counts.cohortTotal : 0,
    付与候補: plan && plan.counts ? plan.counts.candidates : 0,
    今回処理: plan && plan.ok ? plan.recipients : 0,
    付与成功: granted,
    付与失敗: failed,
    残り: plan && plan.ok ? plan.remaining : (plan && plan.counts ? plan.counts.remaining : 0),
    中止: plan && plan.ok ? null : (plan && plan.abort) || 'unknown',
    // ⚠️ この経路は**メールを 1 通も作らない**（Step1 は別工程）
    キュー登録: 0,
    送信: 0,
  };
}
