/**
 * drmResponseLoader.js — 実経路が `responseByEmail` を **同じやり方で**手に入れる 1 か所
 *
 * 管理画面（`admin-marketing` の `action=sequence`）と自動配信（`cron-campaign-sequence`）が
 * 別々に索引を読むと、**画面に出る「次の 1 通」と実際に送る 1 通がズレる**。
 * 読み方・予算・fail closed の扱いをここへ閉じ込める。
 *
 * ⚠️ **1 バイトも書かない。** 読むのは `deliveryEventIndex`（Redis）だけ。
 * ⚠️ 索引を作る関数（`makeIndex`）は呼び出し側から渡す（この層は env を触らない）。
 * ⚠️ 反応が作れない理由は必ず `reason` で返す。**黙って線形へ落ちない**
 *    （落ちたこと自体が運用で見えないと「DRM が効いている」と誤認する）。
 */

import { indexDeliveries } from '../marketing/sequenceProgress.js';
import { MAX_READ_KEYS } from '../webhooks/deliveryEventIndex.js';
import {
  campaignDeclaresRoutes, planResponseKeyReads, buildResponseByEmail, RESPONSE_INPUT_FAIL,
} from './drmResponseInputs.js';

export const LOADER_FAIL = Object.freeze({
  ...RESPONSE_INPUT_FAIL,
  INDEX_UNREADABLE: 'delivery_event_index_unreadable',
});

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * @param {{
 *   campaign: object,
 *   recipients: Array<{email?:string, marketing?:object, fields?:object}>,
 *   deliveries?: object[],                    // `CampaignDeliveries` の生行
 *   deliveredIndex?: Map,                     // 既に索引済みならこちら
 *   brand: string, fromEmail: string,
 *   providerSuppressed?: Set<string>|null, softBounced?: Set<string>|null,
 *   makeIndex: () => {read: (keys:string[]) => Promise<{ok:boolean, byKey:Map}>},
 *   budget?: number,
 * }} input
 * @returns {Promise<{ok:boolean, reason:string|null, byEmail:Map|null,
 *                    measured:{open:boolean, click:boolean},
 *                    counts:{recipients:number, measured:number, skipped:number, keys:number}}>}
 */
export async function loadResponseByEmail({
  campaign, recipients, deliveries, deliveredIndex, brand, fromEmail,
  providerSuppressed = null, softBounced = null, makeIndex, budget = MAX_READ_KEYS,
}) {
  const fail = (reason, counts = {}) => ({
    ok: false, reason, byEmail: null,
    measured: { open: false, click: false },
    counts: { recipients: 0, measured: 0, skipped: 0, keys: 0, ...counts },
  });

  // 宣言が無い campaign では索引を **1 鍵も読まない**（既存のコストと挙動のまま）
  if (!campaignDeclaresRoutes(campaign)) return fail(LOADER_FAIL.NO_ROUTES);

  const list = (Array.isArray(recipients) ? recipients : []).map((r) => ({
    email: lower(r && (r.email || (r.marketing && r.marketing.email)
      || (r.fields && r.fields.Email))),
    marketing: (r && r.marketing) || null,
  })).filter((r) => r.email);
  if (list.length === 0) return fail(LOADER_FAIL.NO_RECIPIENTS);

  const index = deliveredIndex instanceof Map ? deliveredIndex : indexDeliveries(deliveries);
  const plan = planResponseKeyReads({
    campaign, emails: list.map((r) => r.email), deliveredIndex: index,
    brand, fromEmail, budget,
  });
  if (plan.keys.length === 0) {
    // 誰も 1 通も受け取っていない = 反応の材料が無い（線形で正しい）
    return fail(LOADER_FAIL.NOTHING_SENT, { recipients: list.length, skipped: plan.skipped.length });
  }

  let eventByKey = null;
  try {
    const read = await makeIndex().read(plan.keys);
    if (read && read.ok === true) eventByKey = read.byKey || new Map();
  } catch { eventByKey = null; }
  // ⚠️ 読めない = **未計測**。「開封 0 件」として分岐しない
  if (!eventByKey) {
    return fail(LOADER_FAIL.INDEX_UNREADABLE, { recipients: list.length, keys: plan.keys.length });
  }

  const built = buildResponseByEmail({
    campaign, recipients: list, deliveredIndex: index, eventByKey,
    brand, fromEmail, providerSuppressed, softBounced, coveredEmails: plan.covered,
  });
  return {
    ...built,
    counts: { ...built.counts, skipped: plan.skipped.length, keys: plan.keys.length },
  };
}

export default loadResponseByEmail;
