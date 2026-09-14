/**
 * drmFunnel.js — **DRM の事業目的（ファネル）の単一源**（純粋・I/O なし）
 *
 * ── 何のためにあるか ──────────────────────────────────────────
 * DRM の目的は「配信の仕組みを持つこと」ではなく、
 * **メルマガ無料登録者を自動で育成し、段階的に有料へ転換すること**。
 *
 *   無料登録者 ──▶ Light / Premium ──▶ Premium ──▶ 三連複（買い切り）
 *
 * ところがこの道のりは、これまで**どこにも 1 つの形で書かれていなかった**。
 * campaign 定義・automation プリセット・ステップメール・journeyModel に分散し、
 * 「どの段が誰の担当で、どこが欠けているか」を機械的に言える場所が無かった。
 * その結果、**部品が揃っていることを「完成」と読み違える**事故が起きた
 * （2026-08-19 の「DRM 基盤完成・クローズ」）。
 *
 * ここは**宣言だけ**を持つ。誰に送るか・止めるかは既存の単一源が決める:
 *   進行 `sequenceProgress.js` / 停止 `sequencePurchaseStop.js` +`sequencePolicy.js` /
 *   反応 `drmResponseState.js` / 行き先 `drmRouting.js`
 *
 * ⚠️ **ここで送信条件・停止条件を作らない。** 作ると判定が二重化する。
 *    このファイルがするのは「宣言と実装が食い違っていないか」を言うことだけ。
 *
 * ── なぜ「段」を宣言すると事故が減るか（実例）──────────────────
 * 2026-09-08 の障害は、**宛先条件と停止条件が一致**したために起きた
 * （Light 会員へ Premium を案内する campaign が、既定の「Light が有効なら停止」で
 * 1 通目の直後に全員恒久停止）。段を宣言すれば
 * 「**入口のプランを購入停止シグナルに入れてはいけない**」が機械的に検査できる。
 */

import { MK_CONTRACT, MK_PLAN } from '../marketing/customerMarketingAudience.js';
import { resolvePurchaseStopSignals, PURCHASE_SIGNAL } from '../marketing/sequencePurchaseStop.js';
import { isSequenceCampaign, getSequenceSteps, resolveAutoStart } from '../marketing/campaignSequence.js';
import { campaignDeclaresRoutes } from './drmResponseInputs.js';

/** この道のりの識別子（画面・集計で使う） */
export const FUNNEL_ID = 'ak-drm-funnel-v1';

/** 段（**1 人は同時に 1 段にしか居ない**） */
export const FUNNEL_STAGE = Object.freeze({
  /** メルマガ無料登録者・有料の閲覧権が無い方 → 最初の有料へ */
  FREE_TO_PAID: 'free_to_paid',
  /** Light ご利用中 → Premium へ */
  LIGHT_TO_PREMIUM: 'light_to_premium',
  /** Premium ご利用中 → 三連複（買い切り）へ */
  PREMIUM_TO_SANRENPUKU: 'premium_to_sanrenpuku',
  /** 三連複まで到達（**この道のりの終点**。販促を続けない） */
  COMPLETED: 'completed',
});

export const STAGE_LABEL = Object.freeze({
  free_to_paid: '無料登録者 → 有料（Light / Premium）',
  light_to_premium: 'Light ご利用中 → Premium',
  premium_to_sanrenpuku: 'Premium ご利用中 → 三連複',
  completed: '三連複まで到達（販促しない）',
});

/** 欠けているものの種類（**画面とテストにそのまま出す**） */
export const FUNNEL_GAP = Object.freeze({
  /** 段を担当する campaign が 1 本も無い */
  NO_CAMPAIGN: 'no_campaign',
  /** 宣言された campaign がカタログに無い */
  CAMPAIGN_MISSING: 'campaign_missing',
  /** 連続配信ではない（1 通で終わる＝育成にならない） */
  NOT_A_SEQUENCE: 'not_a_sequence',
  /** 反応別 routing を宣言していない（＝線形配信のまま） */
  NO_RESPONSE_ROUTES: 'no_response_routes',
  /** この段に**常時稼働の育成 campaign** が無い（オファーだけでは育成にならない） */
  NO_NURTURE_CAMPAIGN: 'no_nurture_campaign',
  /**
   * 分岐できるだけの step 数が無い。
   * ⚠️ **「宣言し忘れ」ではない。** 2 通の期限案内に分岐先は作れないので、
   *    直すには**新しい文面**が要る（＝運営の判断が要る）。
   */
  SEQUENCE_TOO_SHORT_TO_BRANCH: 'sequence_too_short_to_branch',
  /** 入口のプランを購入停止シグナルに入れている（1 通目直後に全員停止する） */
  PURCHASE_STOP_BLOCKS_ENTRY: 'purchase_stop_blocks_entry',
  /** 到達目標を購入停止シグナルに入れていない（買った人へ売り続ける） */
  PURCHASE_STOP_MISSES_GOAL: 'purchase_stop_misses_goal',
  /** 期間限定でしか動かない（常時稼働の育成にならない） */
  WINDOW_LIMITED: 'window_limited',
  /** 入口で自動的に開始する経路が無い（人が手で撃つまで 1 通も出ない） */
  NO_AUTO_START: 'no_auto_start',
});

export const GAP_LABEL = Object.freeze({
  no_campaign: 'この段を担当する連続配信が無い',
  campaign_missing: '宣言された campaign がカタログに存在しない',
  not_a_sequence: '1 通で終わる単発キャンペーン（育成にならない）',
  no_response_routes: '反応別 routing を宣言していない（線形配信のまま）',
  no_nurture_campaign: '常時稼働の育成シーケンスが無い（期間限定のオファーだけ）',
  sequence_too_short_to_branch: '分岐できる step 数が無い（新しい文面が要る＝運営判断）',
  purchase_stop_blocks_entry: '入口のプランを購入停止に入れている（2 通目が永久に出ない）',
  purchase_stop_misses_goal: '到達目標を購入停止に入れていない（買った方へ売り続ける）',
  window_limited: 'キャンペーン期間中しか動かない（常時稼働ではない）',
  no_auto_start: '入口で自動開始する経路が無い（手動で撃つまで 1 通も出ない）',
});

/**
 * 入口で自動的にシーケンスが始まる仕組み。
 *
 * ⚠️ `cron-campaign-sequence` は **step1（初回接触）を自動では撃たない**
 *    （母集団が最大になるため。`cron-campaign-sequence.js` 冒頭の注記）。
 *    つまり連続配信は「すでに 1 通受け取った人」しか進まない。
 *    **入口を自動で開ける仕組みは、現時点でどの段にも無い。**
 */
export const AUTO_START = Object.freeze({
  /** 無い（人が step1 を撃つまで誰も入らない） */
  NONE: 'none',
  /** 無料登録時にステップメールへ enroll される（`newsletter/step-enroll.js`） */
  SIGNUP_ENROLL: 'signup_enroll',
});

/**
 * 段の宣言。
 *
 * - `entry`      … その段に居る人（`resolveCustomerMarketing()` の plan / contract）
 * - `goal`       … 何を買ったらこの段を卒業するか（`PURCHASE_SIGNAL`）
 * - `campaignIds`… その段を担当する**連続配信**
 * - `autoStart`  … 入口が自動で開くか
 *
 * ⚠️ `entryPlans` は「その段の入口のプラン」。**`goal` に入れてはいけない**
 *    （宛先条件と停止条件が一致し、2 通目が永久に出なくなる）。
 */
export const FUNNEL_STAGES = Object.freeze([
  Object.freeze({
    stage: FUNNEL_STAGE.FREE_TO_PAID,
    order: 1,
    label: STAGE_LABEL.free_to_paid,
    entry: Object.freeze({
      plans: Object.freeze([MK_PLAN.FREE]),
      contracts: Object.freeze([MK_CONTRACT.NONE, MK_CONTRACT.EXPIRED]),
    }),
    /** 最初の有料が成立したら卒業（Light でも Premium でも三連複でもよい） */
    goal: Object.freeze([PURCHASE_SIGNAL.LIGHT, PURCHASE_SIGNAL.PREMIUM, PURCHASE_SIGNAL.SANRENPUKU]),
    /** **常時稼働の育成**（入口が自動で開く / 反応別 routing を持つ） */
    nurtureCampaignId: 'free-signup-onboarding',
    /** 期間限定のオファー（育成の代わりにはならない） */
    offerCampaignIds: Object.freeze(['campaign-discount-free']),
    autoStart: AUTO_START.SIGNUP_ENROLL,
    nextStage: FUNNEL_STAGE.LIGHT_TO_PREMIUM,
  }),
  Object.freeze({
    stage: FUNNEL_STAGE.LIGHT_TO_PREMIUM,
    order: 2,
    label: STAGE_LABEL.light_to_premium,
    entry: Object.freeze({
      plans: Object.freeze([MK_PLAN.LIGHT]),
      contracts: Object.freeze([MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON]),
    }),
    goal: Object.freeze([PURCHASE_SIGNAL.PREMIUM, PURCHASE_SIGNAL.SANRENPUKU]),
    /**
     * ⚠️ **育成シーケンスが無い。** 既存の Light → Premium は
     *    `campaign-discount-light`（2 通・期間限定の期限案内）だけで、
     *    分岐できる step 数が無い。埋めるには**新しい文面**が要る（運営判断）。
     */
    nurtureCampaignId: null,
    offerCampaignIds: Object.freeze(['campaign-discount-light']),
    autoStart: AUTO_START.NONE,
    nextStage: FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU,
  }),
  Object.freeze({
    stage: FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU,
    order: 3,
    label: STAGE_LABEL.premium_to_sanrenpuku,
    entry: Object.freeze({
      plans: Object.freeze([MK_PLAN.PREMIUM]),
      contracts: Object.freeze([MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON]),
    }),
    goal: Object.freeze([PURCHASE_SIGNAL.SANRENPUKU]),
    /**
     * ⚠️ **育成シーケンスが無い。** 常時稼働の候補 `sanrenpuku-offer` は
     *    **三連複を説明・販売する公開ページが無い**ため使用停止（`ctaUrl` が空）。
     *    「推測で URL を作らない」ルールがあるので、ここでは繋がない。
     *    残るのは `campaign-discount-premium`（2 通・期間限定）だけ。
     */
    nurtureCampaignId: null,
    offerCampaignIds: Object.freeze(['campaign-discount-premium', 'sanrenpuku-offer']),
    autoStart: AUTO_START.NONE,
    nextStage: FUNNEL_STAGE.COMPLETED,
  }),
]);

/**
 * 反応別 routing が**意味を持つ**ための最小 step 数。
 *
 * 分岐には「入口 → 分かれ目 → 行き先が 2 つ」が要る。2〜3 通の期限案内で
 * 途中を飛ばすと、単に案内が 1 通減るだけで訴求が変わらない。
 * ⚠️ この数を下げて gap を消さないこと（**欠けを隠すことになる**）。
 */
export const MIN_ROUTABLE_STEPS = 4;

const ACTIVE_CONTRACTS = new Set([MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON]);

/**
 * その人がいまどの段に居るか（**排他**。1 人 1 段）。
 *
 * ⚠️ ここで送信可否を見ない（退会・バウンスは送信側の単一源が止める）。
 *    「どの段の人か」と「送ってよいか」を混ぜない。
 * ⚠️ 判定できない（`contract: unknown` 等）ときは **`null`**。
 *    推測でどこかの段へ入れない。
 */
export function resolveFunnelStage(marketing) {
  const m = marketing || {};
  const plan = String(m.plan ?? '').trim();
  const contract = String(m.contract ?? '').trim();

  // 三連複を持っていれば終点（`plan` が premium_sanrenpuku でも同じ）
  if (m.hasSanrenpuku === true || plan === MK_PLAN.PREMIUM_SANRENPUKU) return FUNNEL_STAGE.COMPLETED;

  if (plan === MK_PLAN.PREMIUM && ACTIVE_CONTRACTS.has(contract)) return FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU;
  if (plan === MK_PLAN.LIGHT && ACTIVE_CONTRACTS.has(contract)) return FUNNEL_STAGE.LIGHT_TO_PREMIUM;
  // 無料・期限切れ（＝いま有料の閲覧権が無い方）は最初の段
  if (contract === MK_CONTRACT.NONE || contract === MK_CONTRACT.EXPIRED) return FUNNEL_STAGE.FREE_TO_PAID;
  return null;   // unknown 等は推測しない
}

/** 段の宣言を取り出す */
export function getFunnelStage(stage) {
  return FUNNEL_STAGES.find((s) => s.stage === stage) || null;
}

/**
 * 1 段ぶんの実装状況を、**カタログの実物から**判定する。
 *
 * ⚠️ 「無い」を黙って省略しない。欠けは `gaps` に必ず出す
 *    （出さないと、欠けたまま「完成」と読める画面になる）。
 */
export function assessFunnelStage(stageDecl, campaigns) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const gaps = new Set();
  const found = [];
  const notes = [];

  const nurtureId = stageDecl.nurtureCampaignId || null;
  const offerIds = [...(stageDecl.offerCampaignIds || [])];
  const allIds = [...(nurtureId ? [nurtureId] : []), ...offerIds];

  if (allIds.length === 0) gaps.add(FUNNEL_GAP.NO_CAMPAIGN);
  // ⚠️ **オファーがあるだけでは育成にならない**。常時稼働の育成が無いことを欠けとして出す
  if (!nurtureId) gaps.add(FUNNEL_GAP.NO_NURTURE_CAMPAIGN);

  for (const id of allIds) {
    const c = list.find((x) => x && x.campaignId === id);
    if (!c) { gaps.add(FUNNEL_GAP.CAMPAIGN_MISSING); continue; }
    found.push(c);
    const isNurture = id === nurtureId;
    const steps = isSequenceCampaign(c) ? getSequenceSteps(c).length : 0;

    if (isNurture) {
      // 育成に求めるもの: 連続配信 / 反応別 routing / 入口の自動開始 / 常時稼働
      if (!isSequenceCampaign(c)) gaps.add(FUNNEL_GAP.NOT_A_SEQUENCE);
      if (steps > 0 && steps < MIN_ROUTABLE_STEPS) gaps.add(FUNNEL_GAP.SEQUENCE_TOO_SHORT_TO_BRANCH);
      else if (!campaignDeclaresRoutes(c)) gaps.add(FUNNEL_GAP.NO_RESPONSE_ROUTES);
      if (!resolveAutoStart(c)) gaps.add(FUNNEL_GAP.NO_AUTO_START);
      if (isWindowLimited(c)) gaps.add(FUNNEL_GAP.WINDOW_LIMITED);
    } else if (steps > 0 && steps < MIN_ROUTABLE_STEPS) {
      // オファーは期間限定で構わないが、**分岐できない理由は記録する**
      notes.push(`${id}: step ${steps} 通（分岐には ${MIN_ROUTABLE_STEPS} 通以上が要る）`);
    }

    // ── 購入停止シグナルの整合（2026-09-08 障害の構造的な検査）──────────
    // ⚠️ **連続配信にだけ効く検査**。単発キャンペーンは `sequenceProgress` を
    //    通らないので `stopOnPurchase` を読まない（読むと嘘の欠けが出る）。
    if (!isSequenceCampaign(c)) continue;
    const signals = resolvePurchaseStopSignals(c);
    for (const p of stageDecl.entry.plans) {
      if (p === MK_PLAN.LIGHT && signals.includes(PURCHASE_SIGNAL.LIGHT)) {
        gaps.add(FUNNEL_GAP.PURCHASE_STOP_BLOCKS_ENTRY);
      }
      if (p === MK_PLAN.PREMIUM && signals.includes(PURCHASE_SIGNAL.PREMIUM)) {
        gaps.add(FUNNEL_GAP.PURCHASE_STOP_BLOCKS_ENTRY);
      }
    }
    if (!stageDecl.goal.some((g) => signals.includes(g))) {
      gaps.add(FUNNEL_GAP.PURCHASE_STOP_MISSES_GOAL);
    }
  }

  return {
    stage: stageDecl.stage,
    order: stageDecl.order,
    label: stageDecl.label,
    nurtureCampaignId: nurtureId,
    offerCampaignIds: offerIds,
    resolvedCampaigns: found.map((c) => c.campaignId),
    goal: [...stageDecl.goal],
    autoStart: stageDecl.autoStart,
    gaps: [...gaps],
    /** 欠けではないが、運営が知っておくべきこと */
    notes,
    /** この段が**実運用として**成立しているか（1 つでも欠ければ false） */
    ready: gaps.size === 0,
  };
}

/** 期間限定でしか動かない campaign か（`disabledReason` が期間外を指す） */
function isWindowLimited(campaign) {
  return String((campaign && campaign.disabledReason) ?? '').includes('キャンペーン期間外');
}

/**
 * ファネル全体の実装状況。**運営画面とテストが同じ答えを見る**。
 *
 * ⚠️ `ready` は「全段に欠けが無い」だけを意味する。
 *    **実配信で反応別に出し分けた実績があるか**は、ここでは判定できない
 *    （それは本番の観測で埋める。`docs/spec.md` の完成条件を参照）。
 */
export function assessFunnel(campaigns) {
  const stages = FUNNEL_STAGES.map((s) => assessFunnelStage(s, campaigns));
  const blocking = [];
  for (const s of stages) for (const g of s.gaps) blocking.push({ stage: s.stage, gap: g, label: GAP_LABEL[g] });
  return {
    funnelId: FUNNEL_ID,
    stages,
    blocking,
    /** 画面がそのまま出せる説明（**欠けを英語コードのまま見せない**） */
    gapLabels: GAP_LABEL,
    /** 宣言と実装が揃っているか（**実配信の実績は含まない**） */
    declarationsReady: blocking.length === 0,
    notice: '`declarationsReady` は宣言と実装の整合だけを見ます。'
      + '実配信で層ごとに別の 1 通が出た実績は含みません（完成条件は docs/spec.md）。',
  };
}

export default assessFunnel;
