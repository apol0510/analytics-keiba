/**
 * prospectIntakePlan.js — Customers 1 ページぶんを **prospect レコードへ組み直す**
 * （純粋・I/O なし）
 *
 * ## これが答える問い
 *
 * 「この Customers レコードを prospect プールへ移すとき、**何を引き継ぐのか**」
 *
 * | 引き継ぐもの | どこから |
 * |---|---|
 * | アドレス・取り込みバッチ | Customers の `Email` / `Source` |
 * | 送信試行（`sends`）| その人の `CampaignDeliveries` 行数（campaign 種別）|
 * | **配信成功（`delivered`）** | `Status='sent'` の行数（**打ち切りの分母**）|
 * | 最終送信時刻（`lastSentAt`）| `SentAt` の最大値（次 step の間隔計算に使う）|
 * | 開封・クリック | 反応の集計（Redis）に hash が載っているか |
 * | 既送信の `DeliveryKey` | その人の行にある鍵（**そのまま Redis 台帳へ入れる**）|
 *
 * ⚠️ **`delivered` に `queued` を数えない。** まだ届いていないものを分母に入れると
 *    打ち切り（delivered 10 / 開封 0）が早まる。
 * ⚠️ **移行対象（`migrate`）以外は 1 件も作らない。** 判定は `prospectMigrationPlan.js`。
 * ⚠️ 引き継ぐ値が 1 つでも作れなければ**その 1 件を落とし、理由を数える**
 *    （黙って欠けた状態で投入しない）。
 */

import { decideForRecord, MIGRATION_DECISION } from './prospectMigrationPlan.js';
import { buildProspect, PROSPECT_STATE } from './prospectPolicy.js';
import { importBatchId } from './importCohort.js';

const lower = (v) => String(v ?? '').trim().toLowerCase();

/** 送信済みとみなす配信行の状態（`sequenceProgress.js` と同じ集合） */
const SENT_STATUSES = new Set(['sent', 'queued']);

/**
 * 配信行 → email 別の引き継ぎ材料。
 *
 * @param {Array<{fields?:object}>} deliveries
 * @returns {Map<string,{keys:Set<string>, sends:number, delivered:number, lastSentAtMs:number|null}>}
 */
export function summarizeDeliveriesForIntake(deliveries) {
  const out = new Map();
  for (const rec of Array.isArray(deliveries) ? deliveries : []) {
    const f = (rec && rec.fields) || {};
    if (String(f.EmailType ?? '').trim() !== 'campaign') continue;
    const email = lower(f.RecipientEmail);
    if (!email) continue;
    const status = lower(f.Status);
    if (!SENT_STATUSES.has(status)) continue;
    const cur = out.get(email) || { keys: new Set(), sends: 0, delivered: 0, lastSentAtMs: null };
    const key = String(f.DeliveryKey ?? '').trim();
    if (key) cur.keys.add(key);
    cur.sends += 1;
    // ⚠️ 届いた証拠があるのは `sent` だけ。`queued` は数えない
    if (status === 'sent') cur.delivered += 1;
    const at = Date.parse(String(f.SentAt || f.QueuedAt || ''));
    if (Number.isFinite(at) && (cur.lastSentAtMs === null || at > cur.lastSentAtMs)) cur.lastSentAtMs = at;
    out.set(email, cur);
  }
  return out;
}

/**
 * 1 ページぶんの投入計画。
 *
 * ⚠️ **台帳へ引き継ぐ鍵は「その campaign の鍵」だけ**にする。その人の配信行には
 *    別キャンペーンの鍵も混ざっており、まとめて入れると別 campaign の鍵が
 *    この campaign の集合に紛れ込む（判定に影響はしないが、突合のとき数が合わなくなる）。
 *    `campaignKeys` を渡すと、その集合に含まれる鍵だけを引き継ぐ。
 *
 * @param {{records: Array<{id:string, fields:object}>,
 *          deliveries: Array<object>,
 *          campaignKeys?: Set<string>,
 *          openHashes?: Set<string>, clickHashes?: Set<string>,
 *          hashEmail: (email:string) => string,
 *          signalHash: (email:string) => string,
 *          engagedEmails?: Set<string>,
 *          nowMs: number}} input
 * @returns {{prospects: object[], ledgerKeys: string[], skipped: object, counts: object}}
 */
export function planProspectIntakeFromCustomers({
  records, deliveries, openHashes, clickHashes, hashEmail, signalHash, engagedEmails, nowMs,
  campaignKeys,
} = {}) {
  const onlyThisCampaign = campaignKeys instanceof Set ? campaignKeys : null;
  const byEmail = summarizeDeliveriesForIntake(deliveries);
  const opens = openHashes instanceof Set ? openHashes : null;
  const clicks = clickHashes instanceof Set ? clickHashes : null;
  const prospects = []; const ledgerKeys = new Set(); const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  let considered = 0;

  for (const rec of Array.isArray(records) ? records : []) {
    considered += 1;
    const fields = (rec && rec.fields) || {};
    const { decision } = decideForRecord({ fields, engagedEmails });
    if (decision !== MIGRATION_DECISION.MIGRATE) { bump(decision); continue; }

    const email = lower(fields.Email);
    if (!email) { bump('no_email'); continue; }
    const batchId = importBatchId(fields.Source);
    // ⚠️ batchId が無いと `Source` を復元できず、コホート判定が効かなくなる
    if (!batchId) { bump('no_batch_id'); continue; }
    if (typeof hashEmail !== 'function') { bump('no_hash_fn'); continue; }

    const seen = byEmail.get(email) || { keys: new Set(), sends: 0, delivered: 0, lastSentAtMs: null };
    const p = buildProspect({ email, nowMs, batchId, source: 'csv' });
    p.hash = hashEmail(email);
    p.sends = seen.sends;
    p.delivered = seen.delivered;
    p.lastSentAt = seen.lastSentAtMs ? new Date(seen.lastSentAtMs).toISOString() : null;
    p.lastDeliveredAt = p.lastSentAt;

    // 反応。**集計を渡されていないときは 0 のままにせず、その 1 件を落とす**
    // （開封した人を「無反応」として移すと、本来 Customers へ残す人を失う）
    if (opens === null || clicks === null) { bump('engagement_unavailable'); continue; }
    const sh = typeof signalHash === 'function' ? signalHash(email) : '';
    p.opens = sh && opens.has(sh) ? 1 : 0;
    p.clicks = sh && clicks.has(sh) ? 1 : 0;
    p.state = p.sends > 0 ? PROSPECT_STATE.SENDING : PROSPECT_STATE.NEW;

    prospects.push(p);
    // ⚠️ その campaign の鍵だけを引き継ぐ（別 campaign の鍵を混ぜない）
    for (const k of seen.keys) {
      if (onlyThisCampaign && !onlyThisCampaign.has(k)) continue;
      ledgerKeys.add(k);
    }
  }

  return {
    prospects,
    ledgerKeys: [...ledgerKeys],
    skipped,
    counts: {
      対象: considered,
      投入: prospects.length,
      除外: considered - prospects.length,
      台帳鍵: ledgerKeys.size,
    },
  };
}

/**
 * 投入してよい状態か。**1 つでも欠けたら投入しない**（fail closed）。
 *
 * @param {{writeEnabled:boolean, confirmed:boolean, engagementApplied:boolean,
 *          parityOk:boolean, plan:object}} input
 */
export const INTAKE_BLOCK = Object.freeze({
  WRITE_DISABLED: 'write_disabled',
  NOT_CONFIRMED: 'not_confirmed',
  ENGAGEMENT_UNAVAILABLE: 'engagement_unavailable',
  PARITY_NOT_PROVEN: 'parity_not_proven',
  NOTHING_TO_WRITE: 'nothing_to_write',
});

export const INTAKE_BLOCK_LABEL = Object.freeze({
  write_disabled: '書き込みが有効化されていません（env）',
  not_confirmed: '確認文字列がありません',
  engagement_unavailable: '反応（開封）の集計を読めていません（開封した人を移してしまうため中止）',
  parity_not_proven: '両経路の一致が証明されていません（送信漏れ・二重送信になるため中止）',
  nothing_to_write: '投入対象が 0 件です',
});

export function canIntake({
  writeEnabled, confirmed, engagementApplied, parityOk, plan,
} = {}) {
  const reasons = [];
  if (writeEnabled !== true) reasons.push(INTAKE_BLOCK.WRITE_DISABLED);
  if (confirmed !== true) reasons.push(INTAKE_BLOCK.NOT_CONFIRMED);
  if (engagementApplied !== true) reasons.push(INTAKE_BLOCK.ENGAGEMENT_UNAVAILABLE);
  if (parityOk !== true) reasons.push(INTAKE_BLOCK.PARITY_NOT_PROVEN);
  if (!plan || !Array.isArray(plan.prospects) || plan.prospects.length === 0) {
    reasons.push(INTAKE_BLOCK.NOTHING_TO_WRITE);
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    labels: reasons.map((r) => INTAKE_BLOCK_LABEL[r] || r),
  };
}

export default planProspectIntakeFromCustomers;
