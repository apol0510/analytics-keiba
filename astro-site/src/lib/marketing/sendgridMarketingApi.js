/**
 * sendgridMarketingApi.js — SendGrid **Marketing Campaigns API** の薄い口（I/O は注入）
 *
 * ## 立場
 *
 * 2026-09-18 の移行で、**実際に送るのは SendGrid**。AK が Marketing Campaigns API へ
 * 触るのは次の 5 つだけで、**メールを送る API（`/v3/mail/send`）はここから呼ばない**。
 *
 *   1. 読み取り: custom field 定義 / list / contact 数 / unsubscribe group
 *   2. contact の upsert（移行の投入）
 *   3. list から contact を外す（**退出**。反応した人を Automation から抜く）
 *   4. contact の id 引き当て（退出に要る）
 *   5. contact の現状の引き当て（在籍 list / `ak_next_message`。**予約直前の突き合わせ**に要る）
 *
 * ## 書き込みは二重ゲート（**既定は何もできない**）
 *
 *   - `SENDGRID_MIGRATION_WRITE_ENABLED === 'true'`（env）
 *   - 呼び出しに `confirm` の合言葉（取り違え防止）
 *
 * どちらか一方でも欠ければ **1 リクエストも出さない**（例外にする。黙って読み取りへ倒さない）。
 *
 * ⚠️ **API キーをログ・応答・例外メッセージへ出さない。**
 * ⚠️ 応答の生データをそのままログへ出さない（アドレスが含まれる）。
 * ⚠️ ここは判定をしない。誰を入れる / 外すかは変換層（`sendgridContactExport.js` /
 *    `sendgridAutomationPlan.js`）が決めた結果をそのまま渡す。
 */

export const SENDGRID_API_BASE = 'https://api.sendgrid.com';

/** 書き込みを開ける env（**未設定 = 何も書けない**） */
export const WRITE_GATE_ENV = 'SENDGRID_MIGRATION_WRITE_ENABLED';
/** 取り違え防止の合言葉（呼び出し側が明示する） */
export const WRITE_CONFIRM = 'MIGRATE PROSPECTS TO SENDGRID';

export class SendGridApiError extends Error {
  constructor(reason, status) {
    // ⚠️ 値・アドレス・キーをメッセージへ載せない
    super(`sendgrid_api:${reason}`);
    this.name = 'SendGridApiError';
    this.reason = reason;
    this.status = Number.isInteger(status) ? status : null;
  }
}

export function isWriteEnabled(env = process.env) {
  return String((env && env[WRITE_GATE_ENV]) || '').trim() === 'true';
}

/**
 * @param {{apiKey: string, fetchImpl?: Function, env?: object}} deps
 */
export function createSendGridMarketingApi({ apiKey, fetchImpl, env } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new SendGridApiError('api_key_missing');
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const environment = env || process.env;

  const request = async (method, path, body) => {
    let res;
    try {
      res = await doFetch(`${SENDGRID_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SendGridApiError('unreachable');
    }
    if (!res || typeof res.status !== 'number') throw new SendGridApiError('bad_response');
    if (res.status === 401 || res.status === 403) throw new SendGridApiError('forbidden', res.status);
    if (res.status === 429) throw new SendGridApiError('rate_limited', res.status);
    if (res.status >= 400) throw new SendGridApiError('http_error', res.status);
    if (res.status === 204) return { status: res.status, body: null };
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };

  /** 書き込みの許可。**両方そろわなければ 1 リクエストも出さない** */
  const assertWritable = (confirm) => {
    if (!isWriteEnabled(environment)) throw new SendGridApiError('write_gate_closed');
    if (String(confirm || '') !== WRITE_CONFIRM) throw new SendGridApiError('confirm_mismatch');
  };

  return {
    // ── 読み取り ────────────────────────────────────────────
    async getFieldDefinitions() {
      const r = await request('GET', '/v3/marketing/field_definitions');
      return r.body || {};
    },
    /** list 一覧（**全ページ**。途中で切れたら例外）*/
    async getLists({ maxPages = 10 } = {}) {
      const out = [];
      let path = '/v3/marketing/lists?page_size=100';
      for (let i = 0; i < maxPages; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- ページ送り
        const r = await request('GET', path);
        const body = r.body || {};
        for (const l of body.result || []) {
          out.push({ id: String(l.id || ''), name: String(l.name || ''), contactCount: Number(l.contact_count) || 0 });
        }
        const next = body._metadata && body._metadata.next;
        if (!next) return out;
        const u = String(next);
        path = u.startsWith('http') ? u.slice(SENDGRID_API_BASE.length) : u;
      }
      throw new SendGridApiError('too_many_pages');
    },
    async getContactCount() {
      const r = await request('GET', '/v3/marketing/contacts/count');
      const b = r.body || {};
      return {
        contactCount: Number(b.contact_count) || 0,
        billableCount: Number(b.billable_count) || 0,
      };
    },
    async getUnsubscribeGroups() {
      const r = await request('GET', '/v3/asm/groups');
      const list = Array.isArray(r.body) ? r.body : [];
      return list.map((g) => ({ id: Number(g.id), name: String(g.name || ''), unsubscribes: Number(g.unsubscribes) || 0 }));
    },
    /** アドレス → contact id（**退出に要る**。応答をそのままログへ出さない）*/
    async lookupContactIds(emails) {
      const list = [...new Set((Array.isArray(emails) ? emails : []).map((e) => String(e || '').trim().toLowerCase()))]
        .filter(Boolean);
      if (list.length === 0) return new Map();
      const out = new Map();
      for (let i = 0; i < list.length; i += 50) {
        // eslint-disable-next-line no-await-in-loop -- 50 件ずつ（API の上限）
        const r = await request('POST', '/v3/marketing/contacts/search/emails', { emails: list.slice(i, i + 50) });
        const result = (r.body && r.body.result) || {};
        for (const [email, hit] of Object.entries(result)) {
          const id = hit && hit.contact && hit.contact.id;
          if (id) out.set(String(email).toLowerCase(), String(id));
        }
      }
      return out;
    },

    /**
     * アドレス → contact の**現状**（id / 在籍 list / custom field）。
     *
     * 予約の直前に「AK の状態と SendGrid の在籍が一致しているか」を全件で見るために要る。
     * ⚠️ 応答の生データをログへ出さない（アドレスが含まれる）。
     */
    async lookupContacts(emails, { fieldId } = {}) {
      const list = [...new Set((Array.isArray(emails) ? emails : []).map((e) => String(e || '').trim().toLowerCase()))]
        .filter(Boolean);
      const out = new Map();
      if (list.length === 0) return out;
      for (let i = 0; i < list.length; i += 50) {
        /**
         * ⚠️ **1 件も見つからないと 404 が返る**（2026-09-19 本番実測）。
         *    これは「居ない」であって失敗ではない。例外にすると
         *    「引けなかった」と「居ない」が混ざり、居ないだけの人を
         *    **外さずに入れてしまう**（＝両方の list に載って 2 通届く）。
         */
        let r;
        try {
          // eslint-disable-next-line no-await-in-loop -- 50 件ずつ（API の上限）
          r = await request('POST', '/v3/marketing/contacts/search/emails', { emails: list.slice(i, i + 50) });
        } catch (e) {
          if (e && e.reason === 'http_error' && e.status === 404) continue; // 1 件も居ない
          throw e;
        }
        const result = (r.body && r.body.result) || {};
        for (const [email, hit] of Object.entries(result)) {
          const c = hit && hit.contact;
          if (!c || !c.id) continue;
          const custom = (c.custom_fields && typeof c.custom_fields === 'object') ? c.custom_fields : {};
          const raw = fieldId ? custom[fieldId] : undefined;
          const n = Number(raw);
          out.set(String(email).toLowerCase(), {
            id: String(c.id),
            listIds: Array.isArray(c.list_ids) ? c.list_ids.map(String) : [],
            nextMessage: Number.isInteger(n) ? n : null,
          });
        }
      }
      return out;
    },

    // ── 書き込み（**二重ゲート**）────────────────────────────
    /** contact の upsert。1 回ぶんの batch（`buildContactUpserts` の出力）を渡す */
    async upsertContacts({ batch, confirm } = {}) {
      assertWritable(confirm);
      if (!batch || !Array.isArray(batch.contacts) || batch.contacts.length === 0) {
        throw new SendGridApiError('empty_batch');
      }
      const r = await request('PUT', '/v3/marketing/contacts', {
        list_ids: batch.list_ids,
        contacts: batch.contacts,
      });
      return { status: r.status, jobId: (r.body && r.body.job_id) || null, count: batch.contacts.length };
    },
    /** list から外す（**退出**）。id は `lookupContactIds` で引いたもの */
    async removeContactsFromList({ listId, contactIds, confirm } = {}) {
      assertWritable(confirm);
      const id = String(listId || '').trim();
      const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(String))].filter(Boolean);
      if (!id) throw new SendGridApiError('list_id_missing');
      if (ids.length === 0) throw new SendGridApiError('no_contacts');
      const r = await request(
        'DELETE',
        `/v3/marketing/lists/${encodeURIComponent(id)}/contacts?contact_ids=${encodeURIComponent(ids.join(','))}`,
      );
      return { status: r.status, removed: ids.length };
    },
    /** 移行用の list を作る（通し番号ごとに 1 本）*/
    async createList({ name, confirm } = {}) {
      assertWritable(confirm);
      const n = String(name || '').trim();
      if (!n) throw new SendGridApiError('list_name_missing');
      const r = await request('POST', '/v3/marketing/lists', { name: n });
      return { id: (r.body && String(r.body.id)) || null, name: n };
    },
  };
}

export default createSendGridMarketingApi;
