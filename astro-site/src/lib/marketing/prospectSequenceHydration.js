/**
 * prospectSequenceHydration.js — prospect プールの状態を、連続配信が読む形へ**復元**する
 * （純粋・I/O なし）
 *
 * ## 何を復元するのか
 *
 * Customers 経路では、連続配信の入力は Airtable から来ていた:
 *
 * | 入力 | Customers 経路 | prospect 経路（ここで作る）|
 * |---|---|---|
 * | 既送信の step | `CampaignDeliveries` の行 | Redis の `DeliveryKey` 集合 + `lastSentAt` |
 * | 反応（open / click）| Redis の signal store | prospect の `opens` / `clicks` |
 * | 配信成功（delivered）| `CampaignDeliveries` の集計 | prospect の `delivered` |
 * | 配信停止 | `EmailBlacklist` / provider | prospect の `SUPPRESSED` 状態 |
 *
 * 復元したものは **そのまま `buildSequenceProgress()` へ渡す**。
 * 進行の導出も停止条件も既存の関数がやる（判定を二重に持たない）。
 *
 * ## 送信時刻をどう復元するか（ここが唯一の近似）
 *
 * Redis の集合が持つのは `DeliveryKey` だけで、**送った時刻を持たない**。
 * しかし `sequenceProgress` が時刻を使うのは
 * 「**最後に送った時刻 + 次 step の delayDays**」の 1 か所だけで、
 * 必要なのは **最大値**（＝最後の送信時刻）だけ。
 * prospect レコードの `lastSentAt` がまさにその値なので、
 * 復元した各行に同じ `lastSentAt` を入れれば、
 * `indexDeliveries` → 最大値 の経路で**同じ答え**になる。
 *
 * ⚠️ したがって step ごとの正確な送信時刻は復元できない（**する必要も無い**）。
 *    もし将来 step 別の時刻が要る判定を足すなら、prospect 側に step 別の時刻を
 *    持たせてからにすること。**ここで推測で埋めない。**
 *
 * ## fail closed
 *
 * `DeliveryKey` の集合を**読めなかったとき**に「まだ送っていない」と見なすと、
 * 全員へもう一度送る。読めなければ `ok:false` を返し、**呼び出し側は中止する**。
 */

import { getSequenceSteps, resolveSequenceStep, resolveMaxSends } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { PROSPECT_STATE, normalizeEmail } from './prospectPolicy.js';
import { prospectEngagementStats } from './prospectEngagement.js';

/** 復元できない理由（**0 件と区別する**） */
export const HYDRATION_FAIL = Object.freeze({
  LEDGER_UNAVAILABLE: 'delivered_ledger_unavailable',
  NOT_A_SEQUENCE: 'not_a_sequence',
});

/**
 * prospect ごとの `DeliveryKey`（step 別）。
 * **鍵の作り方は変えない**（`computeCampaignDeliveryKey` が唯一の生成元）。
 *
 * @returns {Map<string, Map<number,string>>} email → (step → key)
 */
export function buildProspectDeliveryKeys({ prospects, campaign, brand, fromEmail } = {}) {
  const out = new Map();
  const steps = getSequenceSteps(campaign);
  for (const p of Array.isArray(prospects) ? prospects : []) {
    const email = normalizeEmail(p && p.email);
    if (!email || out.has(email)) continue;
    const byStep = new Map();
    for (const s of steps) {
      const effective = resolveSequenceStep(campaign, s.stepNumber);
      if (!effective) continue;
      const key = computeCampaignDeliveryKey({
        campaign: effective, recipientEmail: email, brand, fromEmail,
      });
      if (key) byStep.set(s.stepNumber, key);
    }
    out.set(email, byStep);
  }
  return out;
}

/**
 * Redis の `DeliveryKey` 集合 → `CampaignDeliveries` 相当の行。
 *
 * @param {{prospects, campaign, brand, fromEmail, deliveredKeys: Set<string>}} input
 * @returns {{ok:boolean, reason?:string, deliveries:object[], counts:object}}
 */
export function hydrateProspectDeliveries({
  prospects, campaign, brand, fromEmail, deliveredKeys,
} = {}) {
  if (!campaign || getSequenceSteps(campaign).length === 0) {
    return { ok: false, reason: HYDRATION_FAIL.NOT_A_SEQUENCE, deliveries: [], counts: {} };
  }
  // ⚠️ 読めなかったら中止する。空集合（本当に 0 件）とは区別する
  if (!(deliveredKeys instanceof Set)) {
    return { ok: false, reason: HYDRATION_FAIL.LEDGER_UNAVAILABLE, deliveries: [], counts: {} };
  }
  const keys = buildProspectDeliveryKeys({ prospects, campaign, brand, fromEmail });
  const deliveries = [];
  let matched = 0; let noTimestamp = 0;
  for (const p of Array.isArray(prospects) ? prospects : []) {
    const email = normalizeEmail(p && p.email);
    const byStep = keys.get(email);
    if (!byStep) continue;
    // 最後に送った時刻。無ければ**その行を作らない**（時刻を推測しない）
    const sentAt = p.lastSentAt || null;
    for (const [, key] of byStep) {
      if (!deliveredKeys.has(key)) continue;
      matched += 1;
      if (!sentAt) { noTimestamp += 1; continue; }
      deliveries.push({
        fields: {
          EmailType: 'campaign',
          DeliveryKey: key,
          RecipientEmail: email,
          Status: 'sent',
          SentAt: sentAt,
        },
      });
    }
  }
  return {
    ok: true,
    deliveries,
    counts: {
      母数: Array.isArray(prospects) ? prospects.length : 0,
      既送信: matched,
      復元: deliveries.length,
      時刻不明で除外: noTimestamp,
    },
  };
}

/**
 * prospect の反応 → `engagementByEmail`（`sequenceProgress` がそのまま読む形）。
 *
 * ⚠️ 統計の作り方は `prospectEngagement.js` と**同じ関数**を使う。
 *    こうしておくと、シーケンス側の `engagement_blocked` と
 *    prospect 側の打ち切り（EXHAUSTED）が**同じ条件で同時に**成立する。
 *    別々に作ると「配信は止まったが prospect は SENDING のまま」がありうる。
 */
export function hydrateProspectEngagement(prospects) {
  const m = new Map();
  for (const p of Array.isArray(prospects) ? prospects : []) {
    const email = normalizeEmail(p && p.email);
    if (!email) continue;
    m.set(email, prospectEngagementStats(p));
  }
  return m;
}

/**
 * 除外済み prospect のアドレス集合（`providerSuppressed` として渡す）。
 * SUPPRESSED は bounce / 苦情 / 配信停止なので、配信側でも必ず止める。
 */
export function hydrateProspectSuppression(prospects) {
  const s = new Set();
  for (const p of Array.isArray(prospects) ? prospects : []) {
    if (!p || p.state !== PROSPECT_STATE.SUPPRESSED) continue;
    const email = normalizeEmail(p.email);
    if (email) s.add(email);
  }
  return s;
}

/**
 * 1 回で全部そろえる。**どれか 1 つでも復元できなければ `ok:false`**（fail closed）。
 *
 * @returns {{ok, reason?, deliveries, engagementByEmail, providerSuppressed, maxSends, counts}}
 */
export function hydrateProspectSequenceInputs({
  prospects, campaign, brand, fromEmail, deliveredKeys,
} = {}) {
  const d = hydrateProspectDeliveries({ prospects, campaign, brand, fromEmail, deliveredKeys });
  if (!d.ok) return { ok: false, reason: d.reason, deliveries: [], counts: d.counts };
  return {
    ok: true,
    deliveries: d.deliveries,
    engagementByEmail: hydrateProspectEngagement(prospects),
    providerSuppressed: hydrateProspectSuppression(prospects),
    maxSends: resolveMaxSends(campaign),
    counts: d.counts,
  };
}

export default hydrateProspectSequenceInputs;
