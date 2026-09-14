/**
 * drmResponseInputs.js — **実配信の事実から** `responseByEmail` を組み立てる（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `sequenceProgress.resolveRecipientProgress` は `responseByEmail`（Map）を受け取れるが、
 * **それを作る単一源が無かった**ため、実経路（`cron-campaign-sequence` /
 * `admin-marketing` の `action=sequence`）は誰も渡しておらず、
 * `campaign.sequence.responseRoutes` を宣言しても **常に線形**のままだった。
 * ここがその欠けていた 1 枚で、材料は既存の正本だけを使う:
 *
 *   送った事実   … `sequenceProgress.indexDeliveries()`（`CampaignDeliveries`）
 *   到達 / 開封  … `webhooks/deliveryEventIndex.js`（DeliveryKey 単位の索引）
 *   購入 / 停止  … `customerMarketingAudience.resolveCustomerMarketing()` の戻り
 *   反応の畳み方 … `drmResponseState.resolveResponseState()`
 *
 * **新しい正本を作らない。** ここは既存の値を 1 人 1 state へ束ねるだけ。
 *
 * ── 測っていないものを 0 にしない（fail closed）────────────────
 * ⚠️ 索引が読めない（Redis 不通・鍵が多すぎる）ときは **`ok: false`** を返す。
 *    呼び出し側は `responseByEmail` を **渡さない**＝従来どおり完全に線形。
 *    「開封イベントが無い」を「開いていない」と読み替えない。
 * ⚠️ 索引は読めたがその鍵の記録が無い場合、`delivered` は `false` ではなく **`null`**
 *    （webhook の畳み込みが届いていないだけかもしれない）。結果として
 *    `resolveResponseState` は `unknown` を返し、routing は線形へ落ちる。
 * ⚠️ `clicked` は **常に `null`**。provider 側の click tracking が OFF
 *    （有効化するとアカウント全体に掛かりマジックリンクが壊れる）。
 *
 * ── 読み取りは必ず bounded ────────────────────────────────────
 * `deliveryEventIndex.read()` は 1 鍵 1 往復・上限 500 鍵。全員ぶんを無条件に読むと
 * Function が時間を使い切るので、**受信者単位**で予算に収まる人だけを読む
 * （`planResponseKeyReads`）。予算から溢れた人は `unknown` = 線形へ落ちるだけで、
 * 誤った反応で分岐することはない。
 */

import {
  isSequenceCampaign, getSequenceSteps, resolveSequenceStep,
} from '../marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveResponseState } from './drmResponseState.js';

/** 反応を作れなかった理由（**画面とログにそのまま出す**。黙って線形にしない） */
export const RESPONSE_INPUT_FAIL = Object.freeze({
  NOT_SEQUENCE: 'not_a_sequence',
  NO_ROUTES: 'no_response_routes',
  NO_RECIPIENTS: 'no_recipients',
  NOTHING_SENT: 'nothing_sent_yet',
  OPEN_NOT_MEASURED: 'open_not_measured',
});

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * この campaign は **反応別 routing を宣言しているか**。
 * 宣言が無い campaign では索引を 1 鍵も読まない（既存挙動・既存コストのまま）。
 */
export function campaignDeclaresRoutes(campaign) {
  const routes = campaign && campaign.sequence && campaign.sequence.responseRoutes;
  return Array.isArray(routes) && routes.length > 0;
}

/** 受信者 1 人の「step → DeliveryKey」（**送った / 送っていないは問わない**） */
export function deliveryKeysForRecipient({ campaign, email, brand, fromEmail }) {
  const out = [];
  if (!isSequenceCampaign(campaign) || !email) return out;
  for (const s of getSequenceSteps(campaign)) {
    const effective = resolveSequenceStep(campaign, s.stepNumber);
    if (!effective) continue;
    const key = computeCampaignDeliveryKey({
      campaign: effective, recipientEmail: email, brand, fromEmail,
    });
    if (key) out.push({ step: s.stepNumber, key });
  }
  return out;
}

/**
 * **どの鍵を索引から読むか**を決める（bounded）。
 *
 * - 読むのは **実際に送った鍵だけ**（`deliveredIndex` にある鍵）。
 *   送っていない step の索引を引いても記録は無い。
 * - 予算は**受信者単位**で使う。1 人ぶんが丸ごと入らなければ **その人は読まない**
 *   （半分だけ読んで「開封 0 件」と誤認するのを防ぐ）。
 * - 並びはアドレス昇順で固定（実行ごとに対象が入れ替わらない）。
 *
 * @returns {{keys: string[], covered: string[], skipped: string[], stepByKey: Map<string, number>}}
 */
export function planResponseKeyReads({
  campaign, emails, deliveredIndex, brand, fromEmail, budget,
}) {
  const cap = Math.max(0, num(budget) ?? 0);
  const stepByKey = new Map();
  const keys = [];
  const covered = [];
  const skipped = [];
  const list = [...new Set((Array.isArray(emails) ? emails : []).map(lower).filter(Boolean))].sort();

  for (const email of list) {
    const mine = deliveryKeysForRecipient({ campaign, email, brand, fromEmail })
      .filter(({ key }) => (deliveredIndex instanceof Map ? deliveredIndex.has(key) : false));
    if (mine.length === 0) {
      // 1 通も送っていない = 索引を読む必要が無い（`not_sent` は送信事実から分かる）
      covered.push(email);
      continue;
    }
    if (keys.length + mine.length > cap) { skipped.push(email); continue; }
    for (const { step, key } of mine) { keys.push(key); stepByKey.set(key, step); }
    covered.push(email);
  }
  return { keys, covered, skipped, stepByKey };
}

/**
 * 受信者 1 人の touch 列を作る（`resolveResponseState` の入力）。
 *
 * ⚠️ `deliveryKey` を入れるのは **送った鍵だけ**。`resolveResponseState` は
 *    `deliveryKey` の有無で `sentCount` を数えるので、未送信の step を入れると
 *    「送った」に化ける。
 */
export function buildTouches({
  campaign, email, deliveredIndex, eventByKey, brand, fromEmail,
}) {
  const touches = [];
  for (const { step, key } of deliveryKeysForRecipient({ campaign, email, brand, fromEmail })) {
    const sent = deliveredIndex instanceof Map ? deliveredIndex.get(key) : null;
    if (!sent) continue;                       // 送っていない step は touch ではない
    const ev = eventByKey instanceof Map ? eventByKey.get(key) : null;
    const deliveredAtMs = ev ? num(ev.deliveredAtMs) : null;
    const openedAtMs = ev ? num(ev.firstOpenAtMs) : null;
    touches.push({
      step,
      deliveryKey: key,
      sentAtMs: num(sent.atMs),
      // ⚠️ 記録が無い = **不明**（`false` を作らない）
      delivered: deliveredAtMs !== null ? true : null,
      opened: openedAtMs !== null ? true : null,
      // provider 側 tracking が OFF。**常に未計測**
      clicked: null,
    });
  }
  return touches;
}

/**
 * `buildSequenceProgress({ responseByEmail })` へそのまま渡せる Map を作る。
 *
 * @param {{
 *   campaign: object,
 *   recipients: Array<{email: string, marketing: object}>,
 *   deliveredIndex: Map<string, {status:string, atMs:number|null}>,
 *   eventByKey: Map<string, object>|null,   // **null = 索引を読めていない**
 *   brand: string, fromEmail: string,
 *   providerSuppressed?: Set<string>|null, softBounced?: Set<string>|null,
 *   coveredEmails?: string[]|null,          // 予算内で索引を読めた相手（省略時は全員）
 * }} input
 * @returns {{ok: boolean, reason: string|null, byEmail: Map<string, object>|null,
 *            measured: {open: boolean, click: boolean},
 *            counts: {recipients:number, measured:number, skipped:number}}}
 */
export function buildResponseByEmail({
  campaign, recipients, deliveredIndex, eventByKey, brand, fromEmail,
  providerSuppressed = null, softBounced = null, coveredEmails = null,
}) {
  const fail = (reason) => ({
    ok: false, reason, byEmail: null,
    measured: { open: false, click: false },
    counts: { recipients: 0, measured: 0, skipped: 0 },
  });

  if (!isSequenceCampaign(campaign)) return fail(RESPONSE_INPUT_FAIL.NOT_SEQUENCE);
  if (!campaignDeclaresRoutes(campaign)) return fail(RESPONSE_INPUT_FAIL.NO_ROUTES);
  // ⚠️ **索引が読めていないなら反応を作らない。** 「開封 0」と「未計測」を混ぜない
  if (!(eventByKey instanceof Map)) return fail(RESPONSE_INPUT_FAIL.OPEN_NOT_MEASURED);

  const list = Array.isArray(recipients) ? recipients : [];
  if (list.length === 0) return fail(RESPONSE_INPUT_FAIL.NO_RECIPIENTS);
  const covered = coveredEmails === null ? null : new Set(coveredEmails.map(lower));

  const byEmail = new Map();
  let measuredCount = 0;
  let skipped = 0;
  for (const r of list) {
    const email = lower(r && (r.email || (r.marketing && r.marketing.email)));
    if (!email || byEmail.has(email)) continue;
    if (covered && !covered.has(email)) { skipped += 1; continue; }   // 予算外 → 線形へ
    const touches = buildTouches({
      campaign, email, deliveredIndex, eventByKey, brand, fromEmail,
    });
    byEmail.set(email, resolveResponseState({
      marketing: (r && r.marketing) || null,
      touches,
      providerSuppressed,
      softBounced,
      // click は provider 側 OFF。open は索引が読めたので計測済み
      measured: { open: true, click: false },
    }));
    measuredCount += 1;
  }
  if (measuredCount === 0) return fail(RESPONSE_INPUT_FAIL.NO_RECIPIENTS);

  return {
    ok: true, reason: null, byEmail,
    measured: { open: true, click: false },
    counts: { recipients: list.length, measured: measuredCount, skipped },
  };
}

export default buildResponseByEmail;
