/**
 * drmAutoStart.js — **入口を自動で開ける**（無料登録 → DRM の第 1 通）と**次段へ繋ぐ**（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `cron-campaign-sequence` は既定で **step1（初回接触）を自動で撃たない**。
 * 母集団が最大になるためで、これ自体は正しい安全策だが、結果として
 * **「無料登録した人が DRM に入る経路が 1 つも無い」**状態が続いていた
 * （人が管理画面から step1 を撃つまで、誰も育成されない）。
 *
 * ここは「**誰を入口に入れてよいか**」だけを決める。
 * 送るかどうか・いつ送るか・次に何通目かは既存の単一源が決める:
 *   `sequenceProgress` / `sequencePolicy` / `sequenceAutomation` / `campaignSend`
 *
 * ⚠️ **新しい停止条件を作らない。** 除外は既存の判定の結果をそのまま使う。
 * ⚠️ **推測で入口を開けない。** 判定材料が欠けている人は入れない（fail closed）。
 * ⚠️ 入口は **campaign が `sequence.autoStart` を宣言したときだけ**開く。
 *    宣言の無い campaign は 1 ミリも挙動が変わらない。
 */

import {
  isSequenceCampaign, getSequenceSteps, resolveSequenceStep,
  resolveAutoStart,
} from '../marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { matchesCampaignAudience, isCampaignUsable } from '../marketing/campaignCatalog.js';
import { hasPurchasedForCampaign } from '../marketing/sequencePurchaseStop.js';
import { resolveFunnelStage, getFunnelStage, FUNNEL_STAGE } from './drmFunnel.js';

/** 入口に入れなかった理由（**件数で運用に出す**。黙って落とさない） */
export const AUTOSTART_SKIP = Object.freeze({
  NOT_SENDABLE: 'not_sendable',
  PURCHASED: 'purchased',
  AUDIENCE_MISMATCH: 'audience_mismatch',
  ALREADY_STARTED: 'already_started',
  OUTSIDE_WINDOW: 'outside_window',
  STAGE_MISMATCH: 'stage_mismatch',
  NO_REGISTRATION_TIME: 'no_registration_time',
  NO_EMAIL: 'no_email',
});

export const AUTOSTART_SKIP_LABEL = Object.freeze({
  not_sendable: '配信停止・バウンス・停止アカウント等で送れない',
  purchased: 'すでに有料（この入口の目的を達成済み）',
  audience_mismatch: '対象条件に合わない',
  already_started: 'すでにこのシーケンスを受け取っている',
  outside_window: '登録から時間が経ちすぎている（遡って撃たない）',
  stage_mismatch: 'ファネルの段が違う',
  no_registration_time: '登録時刻が読めない（推測で入れない）',
  no_email: 'アドレスが無い',
});

/** 入口を開けられない理由（campaign 側） */
export const AUTOSTART_ABORT = Object.freeze({
  NOT_A_SEQUENCE: 'not_a_sequence',
  NO_AUTOSTART: 'no_autostart_declared',
  CAMPAIGN_UNUSABLE: 'campaign_unusable',
  GATE_CLOSED: 'gate_closed',
});

/** 入口の自動開始を許す env（**既定は閉**） */
export const AUTOSTART_ENV = 'MARKETING_DRM_AUTOSTART_ENABLED';

const DAY_MS = 86400_000;
const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 入口ゲート。**既存の 4 ゲート（`readSequenceGates`）に追加で**必要な 1 枚。
 *
 * ⚠️ これ単独では何も開かない。送信系ゲートが閉じていれば 1 通も出ない。
 */
export function readAutoStartGate(env = {}) {
  const open = str(env[AUTOSTART_ENV]) === 'true';
  return { open, missing: open ? [] : [AUTOSTART_ENV] };
}

/** その campaign で入口を開けるか（理由つき） */
export function canAutoStart(campaign) {
  if (!isSequenceCampaign(campaign)) return { ok: false, reason: AUTOSTART_ABORT.NOT_A_SEQUENCE };
  const auto = resolveAutoStart(campaign);
  if (!auto) return { ok: false, reason: AUTOSTART_ABORT.NO_AUTOSTART };
  if (!isCampaignUsable(campaign)) return { ok: false, reason: AUTOSTART_ABORT.CAMPAIGN_UNUSABLE };
  return { ok: true, reason: null, autoStart: auto };
}

/** その人が既にこの campaign を 1 通でも受け取っているか */
export function hasStarted({ campaign, email, deliveredIndex, brand, fromEmail }) {
  if (!(deliveredIndex instanceof Map) || !email) return false;
  for (const s of getSequenceSteps(campaign)) {
    const effective = resolveSequenceStep(campaign, s.stepNumber);
    if (!effective) continue;
    const key = computeCampaignDeliveryKey({
      campaign: effective, recipientEmail: email, brand, fromEmail,
    });
    if (key && deliveredIndex.has(key)) return true;
  }
  return false;
}

/**
 * **入口に入れてよい人**を選ぶ（step1 の対象）。
 *
 * @param {{
 *   campaign: object,
 *   candidates: Array<{recordId:string, marketing:object, fields?:object, createdTimeMs:number|null}>,
 *   deliveredIndex: Map, brand: string, fromEmail: string, nowMs: number,
 *   expectedStage?: string|null,
 * }} input
 * @returns {{ok:boolean, abort?:string, campaignId:string|null, step:number,
 *            recordIds:string[], emails:string[], considered:number,
 *            skipped:object, capped:boolean}}
 */
export function planAutoStartEntries({
  campaign, candidates, deliveredIndex, brand, fromEmail, nowMs, expectedStage = null,
}) {
  const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  const gate = canAutoStart(campaign);
  if (!gate.ok) {
    return {
      ok: false, abort: gate.reason, campaignId: campaign ? campaign.campaignId : null,
      step: 1, recordIds: [], emails: [], considered: 0, skipped, capped: false,
    };
  }
  const { withinDays, maxPerTick } = gate.autoStart;
  const list = Array.isArray(candidates) ? candidates : [];
  const picked = [];

  // 並びは recordId 昇順で固定（同じ入力なら毎回同じ順・実行ごとに入れ替わらない）
  const ordered = [...list].sort((a, b) => str(a && a.recordId).localeCompare(str(b && b.recordId)));

  for (const c of ordered) {
    const mk = (c && c.marketing) || null;
    const email = lower(mk && mk.email);
    if (!email) { bump(AUTOSTART_SKIP.NO_EMAIL); continue; }

    // ── 停止条件は既存の単一源の結果をそのまま使う（強い順）──────────
    if (!mk || mk.sendable !== true) { bump(AUTOSTART_SKIP.NOT_SENDABLE); continue; }
    if (hasPurchasedForCampaign({ campaign, marketing: mk })) { bump(AUTOSTART_SKIP.PURCHASED); continue; }

    const audience = matchesCampaignAudience(campaign, mk);
    if (!audience.ok && audience.enforced) { bump(AUTOSTART_SKIP.AUDIENCE_MISMATCH); continue; }

    if (expectedStage && resolveFunnelStage(mk) !== expectedStage) {
      bump(AUTOSTART_SKIP.STAGE_MISMATCH); continue;
    }

    // ── 入口の窓（**遡って一斉に撃たない**）──────────────────────
    const created = num(c && c.createdTimeMs);
    if (created === null) { bump(AUTOSTART_SKIP.NO_REGISTRATION_TIME); continue; }
    if (Number(nowMs) - created > withinDays * DAY_MS) { bump(AUTOSTART_SKIP.OUTSIDE_WINDOW); continue; }

    // ── すでに受け取っている人は入口へ入れない（二重開始を作らない）────
    if (hasStarted({ campaign, email, deliveredIndex, brand, fromEmail })) {
      bump(AUTOSTART_SKIP.ALREADY_STARTED); continue;
    }

    picked.push({ recordId: str(c.recordId), email });
  }

  const capped = picked.length > maxPerTick;
  const take = picked.slice(0, maxPerTick);
  return {
    ok: true,
    campaignId: campaign.campaignId,
    step: 1,
    recordIds: take.map((p) => p.recordId).filter(Boolean),
    emails: take.map((p) => p.email),
    considered: ordered.length,
    skipped,
    /** 上限で切った分は次回へ回る（**黙って捨てない**） */
    capped,
    carriedOver: picked.length - take.length,
  };
}

/**
 * **次段へ繋ぐ**（例: Premium を買った人 → 三連複の段）。
 *
 * 段が変われば入口の campaign も変わる。ここはその対応だけを返す。
 * ⚠️ **送らない・書かない。** 「この人はいまどの段の、どの campaign の対象か」を返すだけ。
 * ⚠️ 段に育成 campaign が無いときは**作らない**。理由を返して止める
 *    （割引オファーは期間限定なので、育成の代わりに自動で撃たない）。
 *
 * @returns {{stage:string|null, campaignId:string|null, reason:string|null,
 *            offerCampaignIds:string[]}}
 */
export function resolveStageEntry({ marketing, campaigns, nowMs }) {
  const stage = resolveFunnelStage(marketing);
  if (!stage) return { stage: null, campaignId: null, reason: 'stage_unknown', offerCampaignIds: [] };
  if (stage === FUNNEL_STAGE.COMPLETED) {
    return { stage, campaignId: null, reason: 'funnel_completed', offerCampaignIds: [] };
  }
  const decl = getFunnelStage(stage);
  if (!decl) return { stage, campaignId: null, reason: 'stage_not_declared', offerCampaignIds: [] };

  const list = Array.isArray(campaigns) ? campaigns : [];
  const offerCampaignIds = [...(decl.offerCampaignIds || [])];
  if (!decl.nurtureCampaignId) {
    return { stage, campaignId: null, reason: 'no_nurture_campaign', offerCampaignIds };
  }
  const c = list.find((x) => x && x.campaignId === decl.nurtureCampaignId);
  if (!c) return { stage, campaignId: null, reason: 'nurture_campaign_missing', offerCampaignIds };
  const gate = canAutoStart(c);
  if (!gate.ok) return { stage, campaignId: null, reason: gate.reason, offerCampaignIds };
  if (nowMs !== undefined && nowMs !== null && !isCampaignUsable(c)) {
    return { stage, campaignId: null, reason: AUTOSTART_ABORT.CAMPAIGN_UNUSABLE, offerCampaignIds };
  }
  return { stage, campaignId: c.campaignId, reason: null, offerCampaignIds };
}

export default planAutoStartEntries;
