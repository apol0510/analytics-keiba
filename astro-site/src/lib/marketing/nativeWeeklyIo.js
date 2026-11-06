/**
 * nativeWeeklyIo.js — 元々の会員の週次 list づくりの **I/O**（判定は `nativeWeeklySync.js`）。
 *
 * 触るもの（これ以外へは出さない。guard テストで固定）:
 *   Airtable  … Customers / EmailBlacklist / CampaignDeliveries を **GET だけ**
 *   SendGrid  … `ak-native-weekly-*` list の作成・人数読み取り・削除（contact は消さない）/
 *                その list への contact upsert / upsert job の読み取り / list 一覧
 *   Redis     … `ak:native-weekly:v1:` の状態（GET / SET）と、見込み客レコードの読み取り（MGET）
 *
 * ⚠️ アドレス・鍵をログ・例外メッセージへ出さない。例外は固定コードだけ。
 */

import { buildNativeMemberFormula } from './nativeMemberMailAudit.js';
import { buildBlacklistEmailSet } from '../newsletter/airtable-fetch.js';
import { indexDeliveries } from './sequenceProgress.js';
import { emailHash, PROSPECT_ROOT } from './prospectStore.js';
import { CONTINUATION_STATES } from './sendgridContinuation.js';
import {
  NATIVE_LIST_PREFIX, NATIVE_STATE_PREFIX, NATIVE_STATE_LATEST_KEY, NATIVE_STATE_TTL_SEC,
  UPSERT_CHUNK, nativeStateKey,
} from './nativeWeeklySync.js';

export class NativeWeeklyIoError extends Error {
  constructor(code) { super(`native_weekly:${code}`); this.code = code; }
}

const MAX_PAGES = 40;

// ─── Airtable（GET だけ）──────────────────────────────────────────

async function airtableAll({ fetchImpl, KEY, BASE, table, formula, fields }) {
  const out = [];
  let offset = '';
  let pages = 0;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize', '100');
    if (formula) u.searchParams.set('filterByFormula', formula);
    for (const f of fields || []) u.searchParams.append('fields[]', f);
    if (offset) u.searchParams.set('offset', offset);
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const r = await fetchImpl(u.toString(), { method: 'GET', headers: { Authorization: `Bearer ${KEY}` } });
    if (!r.ok) throw new NativeWeeklyIoError(`airtable_${table}_${r.status}`);
    // eslint-disable-next-line no-await-in-loop
    const d = await r.json();
    out.push(...(Array.isArray(d.records) ? d.records : []));
    offset = d.offset || '';
    pages += 1;
    // **黙って打ち切らない**（少ない人数を正しい人数として扱わない）
    if (offset && pages >= MAX_PAGES) throw new NativeWeeklyIoError(`airtable_${table}_scan_limit`);
  } while (offset);
  return out;
}

/** 元々の会員（`importCohort` の単一源から組んだ formula で絞る）*/
export function loadNativeCustomers(ctx) {
  return airtableAll({ ...ctx, table: 'Customers', formula: buildNativeMemberFormula() });
}

/** EmailBlacklist → hard（HARD_BOUNCE / COMPLAINT）と soft（全行）*/
export async function loadBlacklist(ctx) {
  const rows = await airtableAll({ ...ctx, table: 'EmailBlacklist', fields: ['Email', 'Status'] });
  return {
    hard: buildBlacklistEmailSet(rows),
    soft: new Set(rows.map((r) => String((r.fields || {}).Email || '').trim().toLowerCase()).filter(Boolean)),
  };
}

/** 育成 campaign の配信行だけ → `DeliveryKey → {status, atMs}`（進行の単一源へ渡す）*/
export async function loadOnboardingDeliveredIndex(ctx, campaignId) {
  const id = String(campaignId || '');
  if (!/^[a-z0-9-]+$/.test(id)) throw new NativeWeeklyIoError('bad_campaign_id');
  const formula = `LEFT({CampaignType}, ${id.length + 2}) = '${id}:v'`;
  const rows = await airtableAll({
    ...ctx, table: 'CampaignDeliveries', formula,
    fields: ['DeliveryKey', 'EmailType', 'Status', 'SentAt', 'QueuedAt', 'RecipientEmail', 'CampaignType'],
  });
  return indexDeliveries(rows);
}

// ─── Redis ─────────────────────────────────────────────────────────

const REDIS_READ = new Set(['GET', 'MGET']);

/** 読み取り（GET / MGET）と native 状態の SET だけを通す Redis */
export function createNativeRedis(redisCmd) {
  if (typeof redisCmd !== 'function') return null;
  return async (args) => {
    const cmd = String(args[0] || '').toUpperCase();
    const keys = cmd === 'MGET' ? args.slice(1) : [args[1]];
    const okRead = REDIS_READ.has(cmd)
      && keys.every((k) => String(k).startsWith(NATIVE_STATE_PREFIX) || String(k).startsWith(`${PROSPECT_ROOT}p:`));
    const okWrite = cmd === 'SET' && String(args[1]).startsWith(NATIVE_STATE_PREFIX);
    if (!okRead && !okWrite) throw new NativeWeeklyIoError('redis_command_forbidden');
    return redisCmd(args);
  };
}

/**
 * 既に `ak-drm-engaged` に入っている（反応した見込み客）アドレス。
 * list の中身は SendGrid 側の contact 検索が要るので読まない。**入れる規則の単一源**
 * （`sendgridContinuation.CONTINUATION_STATES` の見込み客）を AK 側から引く。
 *
 * @returns {Promise<Set<string>>} 読めなければ例外（呼び出し側は list を作らない）
 */
export async function loadEngagedEmails({ redis, emails }) {
  if (typeof redis !== 'function') throw new NativeWeeklyIoError('redis_unavailable');
  const allow = new Set(CONTINUATION_STATES);
  const list = [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const out = new Set();
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    // eslint-disable-next-line no-await-in-loop
    const raw = await redis(['MGET', ...chunk.map((e) => `${PROSPECT_ROOT}p:${emailHash(e)}`)]);
    if (!Array.isArray(raw) || raw.length !== chunk.length) throw new NativeWeeklyIoError('redis_mget_shape');
    raw.forEach((v, j) => {
      if (v === null || v === undefined) return;
      let rec = null;
      try { rec = JSON.parse(String(v)); } catch { throw new NativeWeeklyIoError('prospect_record_corrupt'); }
      if (rec && allow.has(rec.state)) out.add(chunk[j]);
    });
  }
  return out;
}

export async function readNativeState(redis, dateKey) {
  const raw = await redis(['GET', nativeStateKey(dateKey)]);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(String(raw)); } catch { throw new NativeWeeklyIoError('state_corrupt'); }
}

/** 状態を保存（件数・id・digest だけ。アドレスは保存しない）*/
export async function writeNativeState(redis, dateKey, state) {
  const body = JSON.stringify({ ...state, dateKey });
  if (/@/.test(body)) throw new NativeWeeklyIoError('state_contains_address');
  await redis(['SET', nativeStateKey(dateKey), body, 'EX', String(NATIVE_STATE_TTL_SEC)]);
  await redis(['SET', NATIVE_STATE_LATEST_KEY, body, 'EX', String(NATIVE_STATE_TTL_SEC)]);
}

// ─── SendGrid（native list だけ）──────────────────────────────────

const isNativeName = (name) => String(name || '').startsWith(NATIVE_LIST_PREFIX);

/**
 * native 用の SendGrid 口。**許可した呼び出し以外は送る前に例外**。
 * @param {{apiKey: string, fetchImpl: Function}} deps
 */
export function createNativeSendgrid({ apiKey, fetchImpl }) {
  if (!apiKey || typeof fetchImpl !== 'function') throw new NativeWeeklyIoError('sendgrid_config_missing');
  const call = async (method, path, body) => {
    const r = await fetchImpl(`https://api.sendgrid.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!r.ok) throw new NativeWeeklyIoError(`sendgrid_${r.status}`);
    return json;
  };
  let nativeIds = null;   // 一覧で native と確かめた list id だけを書き込み対象にする

  return {
    async listLists() {
      const out = [];
      let path = '/v3/marketing/lists?page_size=100';
      for (let i = 0; i < 10 && path; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const d = await call('GET', path);
        out.push(...((d && d.result) || []).map((l) => ({ id: String(l.id), name: String(l.name), contactCount: Number(l.contact_count) })));
        const next = d && d._metadata && d._metadata.next;
        path = next && String(next).startsWith('https://api.sendgrid.com/') ? String(next).slice('https://api.sendgrid.com'.length) : null;
      }
      nativeIds = new Set(out.filter((l) => isNativeName(l.name)).map((l) => l.id));
      return out;
    },
    async createList(name) {
      if (!isNativeName(name)) throw new NativeWeeklyIoError('list_name_not_native');
      const d = await call('POST', '/v3/marketing/lists', { name });
      const id = String((d && d.id) || '');
      if (!id) throw new NativeWeeklyIoError('list_create_no_id');
      if (!nativeIds) nativeIds = new Set();
      nativeIds.add(id);
      return id;
    },
    /** native list へ contact を upsert（壊れたアドレスは割って弾く）。job id と件数だけ返す */
    async upsertToList({ listId, emails }) {
      if (!nativeIds || !nativeIds.has(String(listId))) throw new NativeWeeklyIoError('list_not_native');
      const jobIds = [];
      const chunks = [];
      for (let i = 0; i < emails.length; i += UPSERT_CHUNK) chunks.push(emails.slice(i, i + UPSERT_CHUNK));
      let accepted = 0;
      let rejected = 0;
      /**
       * 壊れたアドレスが 1 件混ざると SendGrid は**リクエスト全体を 400** で返す。
       * そのときだけ半分に割る。**400 以外（429 / 5xx 等）は割らずに中止**する
       * （一時的な失敗を「受理されないアドレス」と数えると、人を黙って落とす）。
       */
      const send = async (part) => {
        try {
          const d = await call('PUT', '/v3/marketing/contacts', {
            list_ids: [String(listId)],
            contacts: part.map((email) => ({ email })),
          });
          if (!d || !d.job_id) throw new NativeWeeklyIoError('upsert_no_job_id');
          jobIds.push(String(d.job_id));
          accepted += part.length;
        } catch (e) {
          if (!(e instanceof NativeWeeklyIoError) || e.code !== 'sendgrid_400') throw e;
          if (part.length === 1) { rejected += 1; return; }
          const mid = Math.floor(part.length / 2);
          await send(part.slice(0, mid));
          await send(part.slice(mid));
        }
      };
      for (const chunk of chunks) {
        // eslint-disable-next-line no-await-in-loop
        await send(chunk);
      }
      return { jobIds, accepted, rejected };
    },
    async getImportStatus(jobId) {
      if (!/^[A-Za-z0-9-]+$/.test(String(jobId))) throw new NativeWeeklyIoError('bad_job_id');
      const d = await call('GET', `/v3/marketing/contacts/imports/${encodeURIComponent(jobId)}`);
      return { status: String((d && d.status) || '') };
    },
    async getListCount(listId) {
      if (!nativeIds || !nativeIds.has(String(listId))) throw new NativeWeeklyIoError('list_not_native');
      const d = await call('GET', `/v3/marketing/lists/${encodeURIComponent(listId)}/contacts/count`);
      const n = Number(d && d.contact_count);
      return Number.isFinite(n) ? n : null;
    },
    /** 古い native list を消す（**contact は消さない**）*/
    async deleteList(listId) {
      if (!nativeIds || !nativeIds.has(String(listId))) throw new NativeWeeklyIoError('list_not_native');
      await call('DELETE', `/v3/marketing/lists/${encodeURIComponent(listId)}?delete_contacts=false`);
    },
  };
}

export default createNativeSendgrid;
