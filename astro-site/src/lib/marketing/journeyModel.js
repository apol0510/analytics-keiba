/**
 * journeyModel.js — 2 つのキャンペーンを **1 本の道のり（journey）**として扱う（純粋）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 「1 人あたり最大 24 接点」は**商品側の約束**だが、実装は 2 キャンペーンに分かれる:
 *
 *   体験中     `light-trial-to-premium-sequence`      Step1〜6   → 接点 1〜6
 *   体験終了後 `light-trial-post-expiry-sequence`     Step1〜18  → 接点 7〜24
 *
 * 分かれている理由は**事実に合わせるため**（体験中の文面は権利が有効である前提で書いてある）。
 * だが運用者が見たいのは「この人はいま何通目か」なので、
 * **通し番号（touch）へ変換する単一源**をここに置く。
 *
 * ⚠️ ここは**変換だけ**。誰に送るか・止めるかは既存の単一源
 *    （`sequenceProgress` / `sequencePolicy` / `resolveSendability`）が持つ。
 *    ここで停止判定を作らない。
 */

/** この道のりの識別子（画面・集計・状態で使う） */
export const JOURNEY_ID = 'light-trial-to-premium-v1';

/** 1 人あたりの上限。**両フェーズの合計** */
export const MAX_TOUCHES = 24;

/** フェーズ */
export const JOURNEY_PHASE = Object.freeze({
  ACTIVE: 'active',
  POST_EXPIRY: 'post_expiry',
});

export const PHASE_LABEL = Object.freeze({
  [JOURNEY_PHASE.ACTIVE]: '体験中',
  [JOURNEY_PHASE.POST_EXPIRY]: '体験終了・フォロー中',
});

/**
 * フェーズの定義。**接点の範囲が重ならない**ことをテストで固定する。
 *
 * `offset` は「このフェーズの Step1 が通し番号で何番か − 1」。
 */
export const JOURNEY_PHASES = Object.freeze([
  Object.freeze({
    phase: JOURNEY_PHASE.ACTIVE,
    campaignId: 'light-trial-to-premium-sequence',
    steps: 6,
    offset: 0,          // Step1 → 接点 1
    label: PHASE_LABEL[JOURNEY_PHASE.ACTIVE],
  }),
  Object.freeze({
    phase: JOURNEY_PHASE.POST_EXPIRY,
    campaignId: 'light-trial-post-expiry-sequence',
    steps: 18,
    offset: 6,          // Step1 → 接点 7
    label: PHASE_LABEL[JOURNEY_PHASE.POST_EXPIRY],
  }),
]);

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/** campaignId → フェーズ定義。知らない campaign は null（**推測しない**） */
export function findPhase(campaignId) {
  const id = String(campaignId ?? '').trim();
  return JOURNEY_PHASES.find((p) => p.campaignId === id) || null;
}

/** この campaign はこの道のりの一部か */
export function isJourneyCampaign(campaignId) {
  return findPhase(campaignId) !== null;
}

/**
 * (campaignId, step) → **通し番号（1〜24）**。
 * 範囲外・未知の campaign は null（0 や 1 で埋めない）。
 */
export function toTouch(campaignId, step) {
  const phase = findPhase(campaignId);
  const n = int(step);
  if (!phase || n === null || n < 1 || n > phase.steps) return null;
  return phase.offset + n;
}

/**
 * 通し番号 → `{campaignId, step, phase}`。範囲外は null。
 */
export function fromTouch(touch) {
  const t = int(touch);
  if (t === null || t < 1 || t > MAX_TOUCHES) return null;
  for (const p of JOURNEY_PHASES) {
    if (t > p.offset && t <= p.offset + p.steps) {
      return { campaignId: p.campaignId, step: t - p.offset, phase: p.phase };
    }
  }
  return null;
}

/** 定義の総数（**24 と一致していること**をテストで固定する） */
export function totalTouches() {
  return JOURNEY_PHASES.reduce((a, p) => a + p.steps, 0);
}

/**
 * その人が**いま何通目まで受け取ったか**を、フェーズ別の送信済み Step から出す。
 *
 * @param {{active?: number[], post_expiry?: number[]}} sentStepsByPhase
 * @returns {{touches: number[], current: number, remaining: number, completed: boolean}}
 */
export function summarizeTouches(sentStepsByPhase) {
  const src = sentStepsByPhase && typeof sentStepsByPhase === 'object' ? sentStepsByPhase : {};
  const touches = [];
  for (const p of JOURNEY_PHASES) {
    const steps = Array.isArray(src[p.phase]) ? src[p.phase] : [];
    for (const s of steps) {
      const t = toTouch(p.campaignId, s);
      if (t !== null && !touches.includes(t)) touches.push(t);
    }
  }
  touches.sort((a, b) => a - b);
  const current = touches.length ? touches[touches.length - 1] : 0;
  return {
    touches,
    current,
    // ⚠️ 「あと何通」は**実際に届いた数**から引く（番号の最大値からではない）。
    //    途中の通が飛んでいても、上限 24 を超えないことだけは守る。
    remaining: Math.max(0, MAX_TOUCHES - touches.length),
    completed: touches.length >= MAX_TOUCHES,
  };
}

/**
 * **これ以上送ってよいか**（上限だけの判定）。
 * 止める理由は他にもあるが、それらは既存の単一源が持つ。ここは 24 の天井だけ。
 */
export function canSendMore(sentStepsByPhase) {
  return summarizeTouches(sentStepsByPhase).remaining > 0;
}

/**
 * 画面へ出すフェーズ要約（**件数だけ**。PII を入れない）。
 */
export function describeJourney() {
  return {
    journeyId: JOURNEY_ID,
    maxTouches: MAX_TOUCHES,
    phases: JOURNEY_PHASES.map((p) => ({
      phase: p.phase,
      label: p.label,
      campaignId: p.campaignId,
      steps: p.steps,
      touchFrom: p.offset + 1,
      touchTo: p.offset + p.steps,
    })),
  };
}

export default describeJourney;
