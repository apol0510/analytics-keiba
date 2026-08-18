/**
 * handoffQueueProof.js — 「この付与 operation の Step1 は**もう積んである**」を
 * **正の証拠**で確かめる（read-only）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 引き継ぎ（`grantOperationId`）を消してよいのは「その回に付与した人**全員**の Step1 が
 * 既に配信台帳へ載っている」と**確認できたときだけ**。
 *
 * 使ってはいけない根拠（本番で誤りが実証された）:
 *   - dry-run の「対象 0 件」… まだ Airtable に見えていないだけのことがある
 *   - 関所の `outstandingStep1 === 0` … **同じ読み取り遅延で 0 に見える**（2026-08-18）
 *
 * ── 正の証拠の作り方（既存契約だけを使う）───────────────────────
 *   1. `buildGrantOperationFormula(op)` … 付与時に Customers へ書かれた
 *      `LightGrantOp` / `PremiumGrantOp` から、その回の対象者を**再導出**する
 *      （`comebackEmailHandoff.js` の既存契約。引き継ぐのは operationId だけ）
 *   2. 対象者の Step1 `DeliveryKey` を計算し、`CampaignDeliveries` を**名指し**で引く
 *   3. **全員**が `queued` / `sent` の行を持っていれば「積み終わった」＝ CLEAR
 *
 * ⚠️ 1 人でも確認できなければ **証明できない**（`ok: false`）。引き継ぎは消さない。
 * ⚠️ 対象者が 0 人に見えるのも「まだ見えていない」可能性があるので**証明にしない**。
 * ⚠️ メールアドレスは鍵の計算にだけ使い、**戻り値にもログにも出さない**。
 * ⚠️ 読むだけ。新しいテーブルも schema も作らない。
 */

import { buildGrantOperationFormula } from './campaignAudienceFormula.js';
import { buildDeliveryKeyFormula } from './marketingTargetedLoad.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveSequenceStep } from './campaignSequence.js';

export const CUSTOMERS_TABLE = 'Customers';
export const DELIVERIES_TABLE = 'CampaignDeliveries';
/** 1 回の formula に入れる鍵の数 */
export const KEY_CHUNK = 40;
/** 走査してよいページ数（1 op は最大 200 名なので通常 2〜3 ページ） */
export const MAX_PAGES = 12;

/** 台帳で「もう積んである」とみなす状態（送信経路の `already_delivered` と同じ） */
export const QUEUED_STATUSES = Object.freeze(['queued', 'sent']);

export const PROOF_FAIL = Object.freeze({
  NO_OPERATION: 'no_operation',
  MEMBERS_UNREADABLE: 'members_unreadable',
  NO_MEMBERS: 'no_members',
  DELIVERIES_UNREADABLE: 'deliveries_unreadable',
  NOT_ALL_QUEUED: 'not_all_queued',
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

/**
 * その付与 operation の Step1 が**全員ぶん**積んであることを確かめる。
 *
 * @returns {Promise<{ok: boolean, reason: string|null, members: number, queued: number}>}
 */
export async function proveHandoffQueued({
  apiKey, baseId, operationId, campaign, brand, fromEmail, step = 1, fetchImpl = fetch,
} = {}) {
  const op = str(operationId);
  const fail = (reason, extra = {}) => ({ ok: false, reason, members: 0, queued: 0, ...extra });
  if (!op || !apiKey || !baseId) return fail(PROOF_FAIL.NO_OPERATION);

  const stepCampaign = campaign ? resolveSequenceStep(campaign, step) : null;
  if (!stepCampaign) return fail(PROOF_FAIL.NO_STEP);
  const campaignType = `${campaign.campaignId}:v${campaign.version}`;

  // ① その回に付与された人を**再導出**する（既存契約）
  const formula = buildGrantOperationFormula(op);
  if (!formula) return fail(PROOF_FAIL.NO_OPERATION);
  const members = await readAll({
    fetchImpl, apiKey, baseId, table: CUSTOMERS_TABLE, formula, fields: ['Email'],
  });
  if (members === null) return fail(PROOF_FAIL.MEMBERS_UNREADABLE);
  // ⚠️ 0 人は「まだ見えていない」可能性がある。**証明にしない**
  if (members.length === 0) return fail(PROOF_FAIL.NO_MEMBERS);

  // ② その人たちの Step1 鍵（**アドレスは戻さない**）
  const keys = [];
  for (const r of members) {
    const email = str((r && r.fields && r.fields.Email) || '').toLowerCase();
    if (!email) return fail(PROOF_FAIL.MEMBERS_UNREADABLE, { members: members.length });
    const k = computeCampaignDeliveryKey({ campaign: stepCampaign, recipientEmail: email, brand, fromEmail });
    if (!k) return fail(PROOF_FAIL.MEMBERS_UNREADABLE, { members: members.length });
    keys.push(k);
  }

  // ③ 台帳を名指しで引き、queued / sent を数える
  const seen = new Set();
  for (const group of chunk(keys, KEY_CHUNK)) {
    const f = buildDeliveryKeyFormula({ campaignType, keys: group });
    if (!f) return fail(PROOF_FAIL.DELIVERIES_UNREADABLE, { members: members.length });
    // eslint-disable-next-line no-await-in-loop
    const rows = await readAll({
      fetchImpl, apiKey, baseId, table: DELIVERIES_TABLE, formula: f,
      fields: ['DeliveryKey', 'Status'],
    });
    if (rows === null) return fail(PROOF_FAIL.DELIVERIES_UNREADABLE, { members: members.length });
    for (const r of rows) {
      const fl = (r && r.fields) || {};
      if (QUEUED_STATUSES.includes(str(fl.Status).toLowerCase())) seen.add(str(fl.DeliveryKey));
    }
  }

  const queued = keys.filter((k) => seen.has(k)).length;
  if (queued < keys.length) {
    return { ok: false, reason: PROOF_FAIL.NOT_ALL_QUEUED, members: keys.length, queued };
  }
  return { ok: true, reason: null, members: keys.length, queued };
}

export default proveHandoffQueued;
