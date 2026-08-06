/**
 * prospectPipeline.js — prospect を**毎日の配信**と**昇格**へつなぐ（純粋・I/O なし）
 *
 * ── 2 つの流れ ────────────────────────────────────────────────
 *   配信: prospect（送信候補）→ 送ってよい人だけ → 既存 enqueue 契約へ渡す形にする
 *   昇格: 反応した prospect → Airtable Customers へ **CREATE 1 件**の計画を作る
 *
 * ⚠️ ここでは **Airtable も Redis も触らない**。計画を返すだけ。
 *    実際の書き込みは呼び出し側（Function）が env ゲートの内側で行う。
 *
 * ── 二重送信・重複登録を防ぐ 3 つの層 ──────────────────────────
 *   1. **Customers に居る人は prospect として扱わない**（取り込み時と送信時の両方で確認）
 *   2. **deliveryKey** を既存と同じ規則で作り、同じ配信回で 2 度作らない
 *   3. 昇格は **ENGAGED のときだけ**。昇格したら prospect 側は PROMOTED になり送信候補から外れる
 */

import {
  evaluateProspectForSend, evaluateForPromotion, normalizeEmail,
  SKIP_REASON, PROSPECT_STATE, MAX_SENDS_WITHOUT_ENGAGEMENT,
} from './prospectPolicy.js';
import { buildCreateFields, assertOnlyCreateFields } from '../crm/importWritePlan.js';

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** prospect 配信の出所を Customers 側と区別する目印 */
export const PROSPECT_SOURCE_PREFIX = 'prospect';

/**
 * 今日の prospect 配信対象を決める。
 *
 * @param {{prospects, customerEmails, blacklistEmails, nowMs, runId,
 *          buildKey, maxRecipients, maxSends, minDaysBetweenSends}} args
 * @returns {{recipients, skipped, counts}}
 */
export function buildProspectAudience({
  prospects, customerEmails, blacklistEmails, nowMs, runId,
  buildKey, maxRecipients, maxSends, minDaysBetweenSends,
} = {}) {
  const customers = customerEmails instanceof Set ? customerEmails : new Set();
  const blacklist = blacklistEmails instanceof Set ? blacklistEmails : new Set();
  const cap = int(maxRecipients);
  const seenKeys = new Set();

  const recipients = []; const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  let capped = 0;

  for (const p of (prospects || [])) {
    const email = normalizeEmail(p && p.email);
    if (!email) { bump('invalid_address'); continue; }

    // ⚠️ 配信停止・バウンス済みは即除外（Redis の状態より **今の blacklist を優先**）
    if (blacklist.has(email)) { bump(SKIP_REASON.SUPPRESSED); continue; }

    const key = typeof buildKey === 'function' ? buildKey(email) : `${runId}:${email}`;
    const v = evaluateProspectForSend({
      prospect: p, nowMs, isCustomer: customers.has(email),
      sentKeysThisRun: seenKeys, deliveryKey: key,
      maxSends, minDaysBetweenSends,
    });
    if (!v.send) { bump(v.reason); continue; }

    // 上限は**切り捨てず記録**する（何人分を送らなかったかが分かるように）
    if (cap > 0 && recipients.length >= cap) { capped += 1; continue; }

    seenKeys.add(key);
    recipients.push({ email, deliveryKey: key, hash: p.hash || null, sends: int(p.sends) });
  }

  if (capped > 0) skipped.over_max_recipients = capped;
  return {
    recipients, skipped,
    counts: {
      母数: (prospects || []).length,
      対象: recipients.length,
      除外: (prospects || []).length - recipients.length,
      上限超過: capped,
    },
  };
}

/**
 * Customers 由来と prospect 由来を**1 つの配信対象**にまとめる。
 * 同じアドレスが両方に居たら **Customers を優先**し、prospect 側を落とす（二重送信の防止）。
 */
export function mergeAudiences({ customerRecipients, prospectRecipients } = {}) {
  const out = []; const seen = new Set();
  const dropped = { prospect_duplicate_of_customer: 0, duplicate: 0 };

  for (const r of (customerRecipients || [])) {
    const email = normalizeEmail(r && r.email);
    if (!email) continue;
    if (seen.has(email)) { dropped.duplicate += 1; continue; }
    seen.add(email);
    out.push({ ...r, email, 出所: 'customer' });
  }
  for (const r of (prospectRecipients || [])) {
    const email = normalizeEmail(r && r.email);
    if (!email) continue;
    if (seen.has(email)) { dropped.prospect_duplicate_of_customer += 1; continue; }
    seen.add(email);
    out.push({ ...r, email, 出所: PROSPECT_SOURCE_PREFIX });
  }
  return {
    recipients: out, dropped,
    counts: {
      合計: out.length,
      customer: out.filter((r) => r['出所'] === 'customer').length,
      prospect: out.filter((r) => r['出所'] === PROSPECT_SOURCE_PREFIX).length,
    },
  };
}

/**
 * 反応した prospect の**昇格計画**。Airtable へは書かない。
 *
 * `buildCreateFields` は取り込みと同じものを使う（**書いてよい列の定義を二重に持たない**）。
 * `Source` は `customer-import:<batchId>` になるので、prospect 由来と分かる batchId を渡す。
 */
export function planPromotions({
  prospects, customerEmails, nowIso, batchId, availableFields, maxPerRun,
} = {}) {
  const customers = customerEmails instanceof Set ? customerEmails : new Set();
  const cap = int(maxPerRun) || 100;
  const promote = []; const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  let capped = 0;

  for (const p of (prospects || [])) {
    const email = normalizeEmail(p && p.email);
    if (!email) { bump('invalid_address'); continue; }
    const v = evaluateForPromotion({ prospect: p, isCustomer: customers.has(email) });
    if (!v.promote) { bump(v.reason); continue; }
    if (promote.length >= cap) { capped += 1; continue; }

    const fields = buildCreateFields({
      email, name: null, batchId: str(batchId), nowIso, availableFields,
    });
    // ⚠️ allow-list を通らないものは**計画に載せない**（fail-closed）
    if (!fields || !assertOnlyCreateFields(fields)) { bump('field_not_allowed'); continue; }
    promote.push({ email, hash: p.hash || null, fields, engagedKind: p.engagedKind || null });
  }
  if (capped > 0) skipped.over_max_per_run = capped;
  return {
    promote, skipped,
    counts: { 候補: (prospects || []).length, 登録予定: promote.length, 上限超過: capped },
  };
}

/**
 * webhook のイベント列を prospect の更新指示へ変える（**アドレスは呼び出し側で解決**）。
 * `classifyEvent` の結果ごとに 1 件ずつ。**同じアドレスの重複は最後の 1 つに畳む**が、
 * **除外は反応より優先**する（苦情の後の開封で復活させない）。
 */
export function planProspectEventUpdates({ events, classify } = {}) {
  const byEmail = new Map();
  for (const ev of (events || [])) {
    const email = normalizeEmail(ev && ev.email);
    if (!email) continue;
    const c = typeof classify === 'function' ? classify(ev && ev.event) : null;
    if (!c || c.kind === 'ignore') continue;
    const cur = byEmail.get(email);
    // 除外が 1 つでもあれば、その相手は除外に倒す
    if (c.kind === 'suppress') { byEmail.set(email, { email, action: 'suppress', reason: c.reason }); continue; }
    if (cur && cur.action === 'suppress') continue;
    byEmail.set(email, { email, action: 'engage', kind: c.engagement });
  }
  const updates = [...byEmail.values()];
  return {
    updates,
    counts: {
      反応: updates.filter((u) => u.action === 'engage').length,
      除外: updates.filter((u) => u.action === 'suppress').length,
    },
  };
}

/** 表示用（**アドレスを含めない**） */
export function summarizePipeline({ audience, promotions }) {
  return {
    配信: audience ? audience.counts : null,
    昇格: promotions ? promotions.counts : null,
    上限: { 送信回数: MAX_SENDS_WITHOUT_ENGAGEMENT },
    状態: Object.values(PROSPECT_STATE),
  };
}

export default buildProspectAudience;
