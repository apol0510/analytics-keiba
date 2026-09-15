/**
 * prospectPhase2Entry.js — **第 1 期を配り終えた prospect だけ**を第 2 期の入口へ入れる
 *
 * ## なぜ要るか（2026-09-15 / 実装ブロッカー）
 *
 * 第 2 期は**別 campaignId** なので進行はまっさらで、最初の 1 通は step1 になる。
 * ところが共有 cron は既定で **step1 を自動で撃たない**
 * （`planSequenceTick` の `allowFirstStep=false` → `first_step_is_manual`）。
 * catalog へ足しただけでは **第 2 期は 1 通も積まれない**。
 *
 * かといって `allowFirstStep` を素通しで true にすると、
 * **第 1 期が途中の人にも第 2 期が並走**してしまう。確定仕様は「第 1 期 3 通の**後段**」。
 *
 * ## ここで決めること
 *
 * 第 2 期の step1 を自動で撃ってよいのは、**その prospect について
 * 第 1 期（`campaign-discount-free`）の全 step が配り終わっている**ときだけ。
 *
 * ⚠️ **`delivered >= 3` で判定しない。** `delivered` は過去キャンペーンぶんも含む
 *    （2026-09-15 実測で既に `delivered = 4` の人が 30 名いる）。
 *    その人が第 1 期を終えたとは限らない。
 * ⚠️ 判定は **第 1 期固有の `DeliveryKey`**（`campaignId × version × step × 受信者`）で行う。
 *    鍵の作り方は変えない（`computeCampaignDeliveryKey` が唯一の生成元）。
 * ⚠️ **新しい進行台帳を作らない。** 既存の prospect 配信台帳をそのまま引く。
 * ⚠️ 他 campaign の「step1 は手動」契約は**広げない**。第 2 期だけの明示的な後段接続。
 */

import { getSequenceSteps } from './campaignSequence.js';
import { buildProspectDeliveryKeys } from './prospectSequenceHydration.js';
import { PROSPECT_STATE, normalizeEmail } from './prospectPolicy.js';

/** 入口へ入れなかった理由（**黙って 0 件にしない**） */
export const PHASE2_ENTRY_SKIP = Object.freeze({
  PRIOR_INCOMPLETE: 'prior_sequence_incomplete',
  NOT_SENDABLE: 'not_sendable_state',
  ALREADY_STARTED: 'already_started',
  NO_EMAIL: 'no_email',
});

/** 第 2 期へ入れてよい state（反応済み・抑止済み・打ち切り済みは入れない） */
const SENDABLE = new Set([PROSPECT_STATE.NEW, PROSPECT_STATE.SENDING]);

/**
 * 第 1 期を配り終えた prospect を選ぶ（純粋）。
 *
 * @param {{
 *   prospects: Array,              // prospect レコード（`email` / `state`）
 *   priorCampaign: object,         // 第 1 期の定義
 *   nextCampaign: object,          // 第 2 期の定義
 *   priorDeliveredKeys: Set<string>,  // 第 1 期の配信済み鍵（台帳から引いたもの）
 *   nextDeliveredKeys?: Set<string>,  // 第 2 期の配信済み鍵（既に始まっている人を外す）
 *   brand: string, fromEmail: string,
 *   maxPerTick?: number,
 * }} input
 * @returns {{ok: boolean, reason?: string, emails: string[],
 *            considered: number, skipped: object, capped: boolean, carriedOver: number}}
 */
export function planPhase2Entry({
  prospects, priorCampaign, nextCampaign, priorDeliveredKeys, nextDeliveredKeys,
  brand, fromEmail, maxPerTick,
} = {}) {
  const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  // ⚠️ **台帳を読めていないなら 1 人も入れない**（未送信と読むと第 1 期を飛ばす）
  if (!(priorDeliveredKeys instanceof Set)) {
    return {
      ok: false, reason: 'prior_ledger_unavailable',
      emails: [], considered: 0, skipped, capped: false, carriedOver: 0,
    };
  }
  const priorSteps = getSequenceSteps(priorCampaign);
  if (priorSteps.length === 0) {
    return {
      ok: false, reason: 'prior_not_a_sequence',
      emails: [], considered: 0, skipped, capped: false, carriedOver: 0,
    };
  }

  const list = Array.isArray(prospects) ? prospects : [];
  // email → (step → key)。**第 1 期の鍵**
  const priorKeys = buildProspectDeliveryKeys({
    prospects: list, campaign: priorCampaign, brand, fromEmail,
  });
  // email → (step → key)。**第 2 期の鍵**（もう始まっている人を外すため）
  const nextKeys = nextCampaign
    ? buildProspectDeliveryKeys({ prospects: list, campaign: nextCampaign, brand, fromEmail })
    : new Map();
  const started = nextDeliveredKeys instanceof Set ? nextDeliveredKeys : new Set();

  const eligible = [];
  let considered = 0;
  for (const p of list) {
    const email = normalizeEmail(p && p.email);
    if (!email) { bump(PHASE2_ENTRY_SKIP.NO_EMAIL); continue; }
    considered += 1;
    // ① 送れる状態か（ENGAGED / SUPPRESSED / EXHAUSTED / PROMOTED は入れない）
    if (!SENDABLE.has(p.state)) { bump(PHASE2_ENTRY_SKIP.NOT_SENDABLE); continue; }
    // ② **第 1 期の全 step が配り終わっているか**（鍵で照合。delivered の数は見ない）
    const byStep = priorKeys.get(email);
    const done = byStep && priorSteps.every((s) => {
      const k = byStep.get(s.stepNumber);
      return Boolean(k) && priorDeliveredKeys.has(k);
    });
    if (!done) { bump(PHASE2_ENTRY_SKIP.PRIOR_INCOMPLETE); continue; }
    // ③ 第 2 期が既に始まっていないか（始まっていれば通常の進行に任せる）
    const nb = nextKeys.get(email);
    const alreadyStarted = nb && [...nb.values()].some((k) => started.has(k));
    if (alreadyStarted) { bump(PHASE2_ENTRY_SKIP.ALREADY_STARTED); continue; }
    eligible.push(email);
  }

  const cap = Number.isInteger(maxPerTick) && maxPerTick > 0 ? maxPerTick : eligible.length;
  const take = eligible.slice(0, cap);
  return {
    ok: true,
    emails: take,
    considered,
    skipped,
    capped: eligible.length > take.length,
    carriedOver: eligible.length - take.length,
  };
}

export default planPhase2Entry;
