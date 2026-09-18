/**
 * admin-sendgrid-migration.js — prospect 選別配信を **SendGrid Marketing Campaigns へ移す**
 * ための管理 API
 *
 * ⚠️ **メールを送らない。** 送信 API（mail send）を呼ぶコードを持たない。
 *    送るのは移行後の SendGrid Automation で、ここがやるのは
 *    「誰が次に何通目か」を数え、contact を投入し、反応した人を list から外すことだけ。
 *
 * ## action
 *
 * | action | 副作用 | 何をするか |
 * |---|---|---|
 * | `scan` | **なし** | prospect 索引を窓で読み、通し番号別の件数を返す（アドレスなし）|
 * | `plan` | **なし** | 通し番号別件数 → list / Automation 移行計画 |
 * | `content` | **なし** | 10 通の件名（`full:true` で本文も）|
 * | `preflight` | **なし** | SendGrid 側の前提（custom field / list / contact 数 / unsubscribe group）|
 * | `import` | **書き込み** | contact の upsert（**二重ゲート + `apply:true`**）|
 * | `exit` | **書き込み** | 反応・抑止した人を list から外す（同上）|
 *
 * ## ゲート（write は既定で閉じている）
 *
 *   - `SENDGRID_MIGRATION_WRITE_ENABLED=true`（env）
 *   - `confirm` が合言葉と一致
 *   - `apply: true`（省略時は**下見**。1 リクエストも書かない）
 *
 * ⚠️ 応答に**アドレスを載せない**（件数と通し番号だけ）。
 * ⚠️ ゲートが閉じているときは **SendGrid へ 1 リクエストも出さない**。
 */

import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import { createDeliveryKeyStore } from '../../src/lib/marketing/deliveryKeyStore.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';
import {
  scanMigrationWindow, mergeScanSummaries, toExportEntries, resolveScanLimit,
} from '../../src/lib/marketing/sendgridMigrationScan.js';
import { buildMessagePlan } from '../../src/lib/marketing/sendgridMessagePlan.js';
import {
  buildAutomationPlan, buildExitPlan, listNameFor,
} from '../../src/lib/marketing/sendgridAutomationPlan.js';
import {
  buildContactUpserts, summarizeContactExport, resolveFieldIds, CONTACT_FIELD_NAMES,
} from '../../src/lib/marketing/sendgridContactExport.js';
import {
  buildMessageContents, summarizeMessageContents,
} from '../../src/lib/marketing/sendgridContentExport.js';
import {
  createSendGridMarketingApi, isWriteEnabled, WRITE_GATE_ENV, WRITE_CONFIRM,
} from '../../src/lib/marketing/sendgridMarketingApi.js';
import {
  resolveProspectEngine, assertSingleEngine, CUTOVER_STEPS, ROLLBACK_STEPS,
} from '../../src/lib/marketing/sendgridCutover.js';

const BRAND = 'analytics-keiba';
/** 1 回の import で投入してよい contact 数（**上限を越える指示は拒否**） */
const IMPORT_MAX_CONTACTS = 2000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

function redisCmd(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return Promise.reject(new Error('upstash_not_configured'));
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`upstash_http_${res.status}`);
    return (await res.json()).result;
  });
}

function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return Promise.reject(new Error('upstash_not_configured'));
  return fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`upstash_http_${res.status}`);
    const body = await res.json();
    return (Array.isArray(body) ? body : []).map((r) => (r ? r.result : undefined));
  });
}

/** 走査 1 回ぶん（窓）。`results` はアドレスを持つので**呼び出し内で閉じる** */
async function runScan(req) {
  const store = createProspectStore({ cmd: redisCmd, pipeline: redisPipeline });
  const ledger = createDeliveryKeyStore({ redisCmd, redisPipeline });
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  return scanMigrationWindow({
    store,
    deliveryKeyStore: ledger,
    brand: BRAND,
    fromEmail,
    offset: Number(req.offset) || 0,
    limit: resolveScanLimit(req.limit),
    expectDigest: String(req.digest || '').trim() || undefined,
  });
}

/** list 名 → id（SendGrid から引く。**無い list は作らない**） */
function listIdsByMessage(lists) {
  const byName = new Map((lists || []).map((l) => [l.name, l.id]));
  const map = new Map();
  for (let n = 1; n <= 10; n += 1) {
    const id = byName.get(listNameFor(n));
    if (id) map.set(n, id);
  }
  return map;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = String(req.action || 'scan');
  const engine = resolveProspectEngine(process.env);

  try {
    // ── 読み取り ──────────────────────────────────────────
    if (action === 'scan') {
      const out = await runScan(req);
      if (!out.ok) {
        return json(out.reason === 'prospect_index_changed' ? 409 : 500, {
          mode: 'sendgrid-migration-scan', ok: false, reason: out.reason,
          detail: out.detail || null, sideEffects: 'none',
          notice: out.reason === 'prospect_index_changed'
            ? '読んでいる間に prospect の集合が変わりました。最初からやり直してください。'
            : '判定できませんでした（未送信とは見なしません）。',
        });
      }
      return json(200, {
        mode: 'sendgrid-migration-scan',
        ok: true,
        sideEffects: 'none',
        engine,
        window: out.window,
        summary: out.summary,
        notice: 'これは読み取りのみです。アドレスは含みません。',
      });
    }

    if (action === 'plan') {
      const plan = buildMessagePlan();
      if (!plan.ok) return json(500, { ok: false, reason: plan.reason, sideEffects: 'none' });
      const merged = Array.isArray(req.windows) ? mergeScanSummaries(req.windows) : null;
      const counts = merged ? merged['次に送る番号別'] : (req.countsByNextMessage || {});
      const built = buildAutomationPlan({ countsByNextMessage: counts, plan: plan.plan });
      return json(built.ok ? 200 : 400, {
        mode: 'sendgrid-migration-plan',
        sideEffects: 'none',
        ...built,
        merged,
      });
    }

    if (action === 'content') {
      const plan = buildMessagePlan();
      if (!plan.ok) return json(500, { ok: false, reason: plan.reason, sideEffects: 'none' });
      const built = buildMessageContents({ plan: plan.plan });
      if (!built.ok) {
        return json(500, {
          mode: 'sendgrid-migration-content', ok: false,
          reason: built.reason, detail: built.detail || null, sideEffects: 'none',
        });
      }
      return json(200, {
        mode: 'sendgrid-migration-content',
        ok: true,
        sideEffects: 'none',
        summary: summarizeMessageContents(built),
        ...(req.full === true ? { messages: built.messages } : {}),
      });
    }

    if (action === 'preflight') {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) return json(503, { ok: false, reason: 'sendgrid_api_key_missing', sideEffects: 'none' });
      const api = createSendGridMarketingApi({ apiKey });
      const [defs, lists, count, groups] = await Promise.all([
        api.getFieldDefinitions(), api.getLists(), api.getContactCount(), api.getUnsubscribeGroups(),
      ]);
      const fields = resolveFieldIds(defs);
      const ids = listIdsByMessage(lists);
      return json(200, {
        mode: 'sendgrid-migration-preflight',
        ok: true,
        sideEffects: 'none',
        engine,
        書き込みゲート: isWriteEnabled(process.env) ? 'open' : 'closed',
        customField: {
          必要: CONTACT_FIELD_NAMES,
          そろっている: fields.ok,
          不足: fields.missing,
        },
        list: {
          必要な名前: Array.from({ length: 10 }, (_, i) => listNameFor(i + 1)),
          作成済み: [...ids.keys()].sort((a, b) => a - b),
          件数: lists.length,
        },
        contacts: count,
        unsubscribeGroups: groups.map((g) => ({ id: g.id, name: g.name })),
        cutover: { steps: CUTOVER_STEPS, rollback: ROLLBACK_STEPS },
        notice: 'これは読み取りのみです。',
      });
    }

    // ── 書き込み（**二重ゲート + apply**）────────────────────
    if (action === 'import' || action === 'exit') {
      const gateOpen = isWriteEnabled(process.env);
      const confirmed = String(req.confirm || '') === WRITE_CONFIRM;
      const apply = req.apply === true;

      // 下見は誰でも見られる（**1 リクエストも書かない**）
      if (!apply) {
        if (action === 'exit') {
          return json(200, {
            mode: 'sendgrid-migration-exit', ok: true, sideEffects: 'none', dryRun: true,
            gate: gateOpen ? 'open' : 'closed',
            plan: buildExitPlan({ changes: req.changes || [], listIdByMessage: {} }).counts,
            notice: '下見です。list id は preflight で解決してから apply してください。',
          });
        }
        const out = await runScan(req);
        if (!out.ok) {
          return json(500, {
            mode: 'sendgrid-migration-import', ok: false, reason: out.reason, sideEffects: 'none',
          });
        }
        const entries = toExportEntries(out.results);
        return json(200, {
          mode: 'sendgrid-migration-import',
          ok: true,
          sideEffects: 'none',
          dryRun: true,
          gate: gateOpen ? 'open' : 'closed',
          window: out.window,
          summary: out.summary,
          投入予定: entries.length,
          notice: '下見です。SendGrid へは 1 リクエストも出していません。',
        });
      }

      if (!gateOpen) {
        return json(403, {
          ok: false, reason: 'write_gate_closed', gateEnv: WRITE_GATE_ENV, sideEffects: 'none',
        });
      }
      if (!confirmed) {
        return json(400, { ok: false, reason: 'confirm_mismatch', sideEffects: 'none' });
      }
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) return json(503, { ok: false, reason: 'sendgrid_api_key_missing', sideEffects: 'none' });

      // ⚠️ **二重稼働の検査**。AK がまだ prospect を送る設定のままなら書かない
      const single = assertSingleEngine({
        akProspectSending: engine !== 'sendgrid',
        sendgridAutomationLive: req.automationLive === true,
      });
      if (!single.ok) {
        return json(409, {
          ok: false, reason: single.violation, engine, sideEffects: 'none',
          notice: '旧 AK 配信と SendGrid Automation を同時に live にできません。',
        });
      }

      const api = createSendGridMarketingApi({ apiKey });
      const lists = await api.getLists();
      const ids = listIdsByMessage(lists);

      if (action === 'exit') {
        const plan = buildExitPlan({ changes: req.changes || [], listIdByMessage: ids });
        const emails = plan.removals.map((r) => r.email);
        const contactIds = await api.lookupContactIds(emails);
        let removed = 0;
        for (const [, listId] of ids) {
          const targets = [...contactIds.values()];
          if (targets.length === 0) break;
          // eslint-disable-next-line no-await-in-loop -- list は最大 10 本
          const r = await api.removeContactsFromList({
            listId, contactIds: targets, confirm: req.confirm,
          });
          removed += r.removed;
        }
        return json(200, {
          mode: 'sendgrid-migration-exit', ok: true, sideEffects: 'sendgrid_lists_only',
          対象: plan.counts, 引き当て: contactIds.size, 外した件数: removed,
        });
      }

      const fields = resolveFieldIds(await api.getFieldDefinitions());
      if (!fields.ok) {
        return json(409, {
          ok: false, reason: fields.reason, missing: fields.missing, sideEffects: 'none',
        });
      }
      const out = await runScan(req);
      if (!out.ok) {
        return json(500, { ok: false, reason: out.reason, sideEffects: 'none' });
      }
      const entries = toExportEntries(out.results);
      if (entries.length > IMPORT_MAX_CONTACTS) {
        return json(400, {
          ok: false, reason: 'too_many_contacts', 上限: IMPORT_MAX_CONTACTS, sideEffects: 'none',
        });
      }
      const built = buildContactUpserts({
        entries,
        fieldIds: fields.ids,
        listIdByMessage: ids,
        migratedAt: new Date().toISOString(),
      });
      if (!built.ok) {
        return json(409, {
          ok: false, reason: built.reason, missing: built.missing || [], sideEffects: 'none',
        });
      }
      const jobs = [];
      for (const batch of built.batches) {
        // eslint-disable-next-line no-await-in-loop -- 1 batch ずつ（上限つき）
        const r = await api.upsertContacts({ batch, confirm: req.confirm });
        jobs.push({ startMessage: batch.startMessage, count: r.count, status: r.status });
      }
      return json(200, {
        mode: 'sendgrid-migration-import',
        ok: true,
        sideEffects: 'sendgrid_contacts_only',
        window: out.window,
        summary: out.summary,
        export: summarizeContactExport(built),
        jobs,
      });
    }

    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外本文にアドレス・キーが混ざりうるので**固定の理由コードだけ**返す
    const reason = String((e && e.reason) || (e && e.code) || 'unexpected_error');
    console.error(`❌ [sendgrid-migration] ${action} 失敗: ${reason}`);
    return json(500, { ok: false, reason, sideEffects: 'unknown' });
  }
};

export default handler;
