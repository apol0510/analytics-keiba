/**
 * handoffQueueProof.js — 「この付与 operation は**全員解決済み**」を正の証拠で確かめる（read-only）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 引き継ぎ（`grantOperationId`）を消してよいのは、その回に付与した人が
 * **全員「解決済み」**と確認できたときだけ。使ってはいけない根拠:
 *   - dry-run の「対象 0 件」          … まだ Airtable に見えていないことがある
 *   - 関所 `outstandingStep1 === 0`    … 同じ読み取り遅延で 0 に見える（#362 で実証）
 *   - 「救済経路があるから大丈夫」      … 引き継ぎの責任を推測で手放さない
 *
 * ── 「解決済み」の定義は**既存の単一源に任せる** ────────────────
 * `evaluateStep1Barrier`（`lightTrialBarrier.js`）が既に決めている:
 *
 *   step1_queued        … Step1 の DeliveryKey が台帳にある（queued / sent）
 *   not_sendable        … 配信停止・バウンス等で送信対象外（`resolveCustomerMarketing`）
 *   provider_suppressed … 配信基盤の停止リスト（`fetchProviderSuppression`）
 *   purchased           … 有料契約が成立（案内不要）
 *   grant_ended         … 無料体験が終わっている / 取り消された
 *
 * ⚠️ **除外理由をここで新しく作らない。** 送ってよい / いけないの判断は
 *    `campaignSend` / suppression / audience の既存単一源がすでに持っている。
 *    ここはそれを **この operation の対象者だけに適用して数え直す**だけ。
 * ⚠️ 「全員 queued/sent」を条件にすると、**正当に除外された 1 名**（停止リスト等）で
 *    永久に解決しなくなる（2026-08-18 の指摘）。除外も**解決**として数える。
 * ⚠️ 材料（対象者・配信行・停止リスト・ブラックリスト）が 1 つでも読めなければ
 *    **証明しない**（`ok: false`）。引き継ぎは消さない。
 * ⚠️ ブラックリストは**空 Set が返ってきても「読めた」とは限らない**。
 *    `loadBlacklistEmails()` は失敗時も例外を投げず `{ emails: new Set(), status: <理由> }`
 *    を返すため、`status` を正に確認する（`acceptBlacklistResult`）。
 * ⚠️ アドレスは判定にだけ使い、**戻り値にもログにも出さない**。読むだけ・新 schema なし。
 */

import { buildGrantOperationFormula } from './campaignAudienceFormula.js';
import { buildDeliveryKeyFormula } from './marketingTargetedLoad.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { evaluateStep1Barrier } from '../comeback/lightTrialBarrier.js';
import { loadBlacklistEmails, BRAND_HAS_BLACKLIST_TABLE } from '../newsletter/airtable-fetch.js';
import { fetchProviderSuppression } from './providerSuppression.js';

export const CUSTOMERS_TABLE = 'Customers';
export const DELIVERIES_TABLE = 'CampaignDeliveries';
/** 1 回の formula に入れる鍵の数 */
export const KEY_CHUNK = 40;
/** 走査してよいページ数（1 op は最大 200 名なので通常 2〜3 ページ） */
export const MAX_PAGES = 12;

export const PROOF_FAIL = Object.freeze({
  NO_OPERATION: 'no_operation',
  MEMBERS_UNREADABLE: 'members_unreadable',
  NO_MEMBERS: 'no_members',
  DELIVERIES_UNREADABLE: 'deliveries_unreadable',
  /** 停止リスト・ブラックリストが読めない = 除外の正当性を確認できない */
  EXCLUSIONS_UNREADABLE: 'exclusions_unreadable',
  NOT_ALL_RESOLVED: 'not_all_resolved',
  NO_STEP: 'no_step',
});

const str = (v) => String(v ?? '').trim();

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

async function readAll({ fetchImpl, apiKey, baseId, table, formula, fields }) {
  const rows = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (formula) url.searchParams.set('filterByFormula', formula);
    for (const f of fields || []) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res || !res.ok) return null;
      // eslint-disable-next-line no-await-in-loop
      data = await res.json();
    } catch { return null; }
    if (!data) return null;
    rows.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) return null;   // 取り切れない = 証明しない
  } while (offset);
  return rows;
}

/** `loadBlacklistEmails()` が「読めた」ときだけ返す status */
export const BLACKLIST_STATUS_ENABLED = 'enabled';
/** テーブルを持たないブランドで返る status（AK は**該当しない**） */
export const BLACKLIST_STATUS_NOT_APPLICABLE = 'not-applicable';

/**
 * `loadBlacklistEmails()` の戻り値を**証明に使ってよいか**判定する（純粋・fail closed）。
 *
 * ⚠️ この関数が要る理由: `loadBlacklistEmails()` は**読めなくても例外を投げない**。
 *    `missing` / `permission-error` / `network-error` / `read-error` のいずれでも
 *    `{ emails: new Set(), status: <理由> }` を返す。空 Set は truthy なので
 *    `if (!bl.emails)` で見ると **読み取り失敗が「ブラックリスト 0 件」として通る**。
 *    そのまま数えると、本当はブラックリストで除外されるはずの人が
 *    「まだ案内していない人」から漏れ、引き継ぎを誤って畳む（fail open）。
 *
 * 使ってよいのは **正に確認できた** 2 通りだけ:
 *   1. `status === 'enabled'` かつ `emails` が Set … 実際に読めた
 *   2. `status === 'not-applicable'` かつ **そのブランドが本当にテーブル非対象**
 *      （`BRAND_HAS_BLACKLIST_TABLE[brand] === false`）。AK は `true` なので該当しない。
 *      未知・未指定のブランドも「非対象と確認できた」ことにはしない。
 *
 * @returns {Set<string>|null} 使ってよい Set。使えないときは `null`
 */
export function acceptBlacklistResult(result, brand, hasTableMap = BRAND_HAS_BLACKLIST_TABLE) {
  const emails = result && result.emails;
  if (!(emails instanceof Set)) return null;
  const status = str(result && result.status);
  if (status === BLACKLIST_STATUS_ENABLED) return emails;
  if (status === BLACKLIST_STATUS_NOT_APPLICABLE) {
    // **テーブルを持たないと分かっているブランドだけ**許可する（既存契約に従う）
    return (hasTableMap || {})[str(brand)] === false ? emails : null;
  }
  // missing / permission-error / network-error / read-error / 未知 → 証明しない
  return null;
}

/**
 * その付与 operation の対象者が**全員解決済み**であることを確かめる。
 *
 * @returns {Promise<{ok: boolean, reason: string|null, members: number,
 *                    resolved: number, outstanding: number, byReason: object}>}
 */
export async function proveHandoffQueued({
  apiKey, baseId, operationId, campaign, brand, fromEmail, step = 1, nowMs = Date.now(),
  /** 配信基盤の停止リストを読むための env。**運転手に鍵を持ち回らせない** */
  env = process.env, fetchImpl = fetch, deps = {},
} = {}) {
  const op = str(operationId);
  const fail = (reason, extra = {}) => ({
    ok: false, reason, members: 0, resolved: 0, outstanding: 0, byReason: {}, ...extra,
  });
  if (!op || !apiKey || !baseId) return fail(PROOF_FAIL.NO_OPERATION);

  const stepCampaign = campaign ? resolveSequenceStep(campaign, step) : null;
  if (!stepCampaign) return fail(PROOF_FAIL.NO_STEP);
  const campaignType = `${campaign.campaignId}:v${campaign.version}`;

  // ① その回に付与された人を**再導出**する（既存契約）
  const formula = buildGrantOperationFormula(op);
  if (!formula) return fail(PROOF_FAIL.NO_OPERATION);
  const members = await readAll({ fetchImpl, apiKey, baseId, table: CUSTOMERS_TABLE, formula });
  if (members === null) return fail(PROOF_FAIL.MEMBERS_UNREADABLE);
  // ⚠️ 0 人は「まだ見えていない」可能性がある。**証明にしない**
  if (members.length === 0) return fail(PROOF_FAIL.NO_MEMBERS);

  // ② 除外の材料（**既存の単一源**。読めなければ証明しない）
  const blacklistReader = deps.loadBlacklistEmails || loadBlacklistEmails;
  const suppressionReader = deps.fetchProviderSuppression || fetchProviderSuppression;
  let blacklistEmails = null;
  try {
    // ⚠️ `loadBlacklistEmails()` は失敗しても例外を投げず空 Set を返す。
    //    **status を正に確認**してからでないと、読み取り失敗を「0 件」と取り違える
    blacklistEmails = acceptBlacklistResult(await blacklistReader({ brand, baseId, apiKey }), brand);
  } catch {
    blacklistEmails = null;
  }
  if (blacklistEmails === null) {
    return fail(PROOF_FAIL.EXCLUSIONS_UNREADABLE, { members: members.length });
  }
  let providerSuppressed = null;
  try {
    const sup = await suppressionReader({ apiKey: (env || {}).SENDGRID_API_KEY, nowMs, now: nowMs });
    if (!sup || sup.ok !== true) return fail(PROOF_FAIL.EXCLUSIONS_UNREADABLE, { members: members.length });
    providerSuppressed = sup.emails;
  } catch {
    return fail(PROOF_FAIL.EXCLUSIONS_UNREADABLE, { members: members.length });
  }

  // ③ その人たちの Step1 鍵で配信行を名指し（**アドレスは戻さない**）
  const rows = members.map((r) => ({
    ...r,
    marketing: resolveCustomerMarketing({ fields: (r && r.fields) || {}, nowMs, blacklistEmails }),
  }));
  const keys = [];
  for (const r of rows) {
    const email = str((r.marketing && r.marketing.email) || (r.fields && r.fields.Email)).toLowerCase();
    if (!email) continue;   // 鍵を作れない人は barrier が `not_sendable` として解決する
    const k = computeCampaignDeliveryKey({ campaign: stepCampaign, recipientEmail: email, brand, fromEmail });
    if (k) keys.push(k);
  }
  const deliveries = [];
  for (const group of chunk(keys, KEY_CHUNK)) {
    const f = buildDeliveryKeyFormula({ campaignType, keys: group });
    if (!f) return fail(PROOF_FAIL.DELIVERIES_UNREADABLE, { members: rows.length });
    // eslint-disable-next-line no-await-in-loop
    const got = await readAll({
      fetchImpl, apiKey, baseId, table: DELIVERIES_TABLE, formula: f,
      fields: ['DeliveryKey', 'Status', 'CampaignType'],
    });
    if (got === null) return fail(PROOF_FAIL.DELIVERIES_UNREADABLE, { members: rows.length });
    deliveries.push(...got);
  }

  // ④ **解決済みの判定は既存の単一源へ**（除外理由をここで作らない）
  const barrier = evaluateStep1Barrier({
    records: rows, campaign, deliveries, providerSuppressed, brand, fromEmail, nowMs,
  });
  if (barrier.outstanding > 0) {
    return {
      ok: false, reason: PROOF_FAIL.NOT_ALL_RESOLVED,
      members: barrier.granted, resolved: barrier.resolved,
      outstanding: barrier.outstanding, byReason: barrier.byReason || {},
    };
  }
  return {
    ok: true, reason: null,
    members: barrier.granted, resolved: barrier.resolved,
    outstanding: 0, byReason: barrier.byReason || {},
  };
}

export default proveHandoffQueued;
