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
 * | `reconcile` | 下見は**なし** | **予約の直前に AK を正本として list を合わせ直す**（二重ゲート + `apply:true` で書き込み）|
 * | `overview` | **なし** | 管理画面に出す数（選別の進み / 反応者 / 週次の予約 / 送信実績）|
 * | `weeklyPreflight` | **なし** | 週 2 回配信を開ける前の検査（宛先・文面・CTA・配信停止）|
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

import { createProspectStore, emailHash } from '../../src/lib/marketing/prospectStore.js';
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
import {
  buildReconcilePlan, summarizeReconcilePlan, assertReconcileSafety, reconcileSteps,
  RECONCILE_LIMITS, runWithSplit, REJECTED_INDEX_KEY,
} from '../../src/lib/marketing/sendgridListReconcile.js';
import { CONTINUATION_LIST_NAME } from '../../src/lib/marketing/sendgridContinuation.js';
import {
  planWeeklySend, validateWeeklyContent, summarizeWeeklyPlan,
} from '../../src/lib/marketing/weeklyNewsletterPlan.js';
import { buildWeeklyContent } from '../../src/lib/marketing/weeklyNewsletterContent.js';
import { buildLatestShowcase } from '../../src/lib/resultsShowcase.js';

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

    /**
     * ── overview（**管理画面に出す数**）─────────────────────────
     *
     * MK が毎日見るのはここ 1 か所。**新しい集計基盤は作らない**（既にある数を並べるだけ）。
     * 読み取りだけで、アドレスは 1 件も返さない。
     */
    if (action === 'overview') {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) return json(503, { ok: false, reason: 'sendgrid_api_key_missing', sideEffects: 'none' });
      const api = createSendGridMarketingApi({ apiKey });

      const [lists, sendsRaw, statsRaw] = await Promise.all([
        api.getLists(),
        fetch('https://api.sendgrid.com/v3/marketing/singlesends?page_size=100', {
          headers: { Authorization: `Bearer ${apiKey}` },
        }).then((r) => r.json()).catch(() => ({})),
        fetch('https://api.sendgrid.com/v3/marketing/stats/singlesends?page_size=100', {
          headers: { Authorization: `Bearer ${apiKey}` },
        }).then((r) => r.json()).catch(() => ({})),
      ]);

      const byName = new Map(lists.map((l) => [l.name, l.contactCount]));
      const selection = [1, 2, 3].map((n) => ({
        list: listNameFor(n), 人数: byName.get(listNameFor(n)) ?? null,
      }));
      const statById = new Map(((statsRaw && statsRaw.results) || []).map((x) => [String(x.id), x.stats || {}]));
      const sends = ((sendsRaw && sendsRaw.result) || []).map((x) => {
        const st = statById.get(String(x.id)) || {};
        return {
          name: String(x.name || ''),
          status: String(x.status || ''),
          send_at: x.send_at || null,
          requests: Number(st.requests) || 0,
          delivered: Number(st.delivered) || 0,
          opens: Number(st.unique_opens) || 0,
          bounces: Number(st.bounces) || 0,
          unsubscribes: Number(st.unsubscribes) || 0,
        };
      });
      const selectionSends = sends.filter((x) => /^AK Prospect Selection /.test(x.name));
      const weeklySends = sends.filter((x) => /^AK Weekly /.test(x.name));
      const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

      let akActive = null;
      let akEngaged = null;
      try {
        akActive = Number(await redisCmd(['SCARD', 'ak:prospect:index:active'])) || 0;
        akEngaged = Number(await redisCmd(['SCARD', 'ak:prospect:index:engaged'])) || 0;
      } catch { /* 読めなければ null のまま返す（推測しない） */ }

      return json(200, {
        mode: 'sendgrid-marketing-overview',
        ok: true,
        sideEffects: 'none',
        engine,
        選別: {
          list別: selection,
          list合計: selection.reduce((a, r) => a + (r.人数 || 0), 0),
          予約: selectionSends.filter((x) => x.status === 'scheduled').length,
          送信済み: selectionSends.filter((x) => x.status === 'triggered').length,
          実績: {
            requests: sum(selectionSends, 'requests'),
            delivered: sum(selectionSends, 'delivered'),
            開封: sum(selectionSends, 'opens'),
            bounce: sum(selectionSends, 'bounces'),
            配信停止: sum(selectionSends, 'unsubscribes'),
          },
          次の配信: selectionSends
            .filter((x) => x.status === 'scheduled' && x.send_at)
            .map((x) => x.send_at).sort()[0] || null,
        },
        反応: {
          AK送信候補: akActive,
          AK反応済み: akEngaged,
          継続list: byName.get(CONTINUATION_LIST_NAME) ?? null,
          継続list名: CONTINUATION_LIST_NAME,
        },
        週次: {
          有効: String(process.env.SENDGRID_WEEKLY_ENABLED || '').trim() === 'true',
          予約: weeklySends.filter((x) => x.status === 'scheduled').length,
          送信済み: weeklySends.filter((x) => x.status === 'triggered').length,
          次の配信: weeklySends
            .filter((x) => x.status === 'scheduled' && x.send_at)
            .map((x) => x.send_at).sort()[0] || null,
          実績: {
            delivered: sum(weeklySends, 'delivered'),
            開封: sum(weeklySends, 'opens'),
            配信停止: sum(weeklySends, 'unsubscribes'),
          },
        },
        notice: '読み取りのみ。アドレスは含みません。',
      });
    }

    /**
     * ── weeklyPreflight（**開ける前に見る**）────────────────────
     *
     * 週 2 回配信を有効にしてよいかを、**宛先・文面・CTA・配信停止**の 4 点で判定する。
     * 1 つでも欠ければ `ok:false`。**実際の作成・予約はしない**。
     */
    if (action === 'weeklyPreflight') {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) return json(503, { ok: false, reason: 'sendgrid_api_key_missing', sideEffects: 'none' });
      const api = createSendGridMarketingApi({ apiKey });
      const lists = await api.getLists();
      const cont = lists.find((l) => l.name === CONTINUATION_LIST_NAME) || null;

      const sendsRaw = await fetch('https://api.sendgrid.com/v3/marketing/singlesends?page_size=100', {
        headers: { Authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json()).catch(() => ({}));
      const existingNames = ((sendsRaw && sendsRaw.result) || []).map((x) => String(x.name || ''));

      const selectionEndsAt = String(process.env.SENDGRID_SELECTION_ENDS_AT || '').trim();
      const selectionEndsMs = Date.parse(selectionEndsAt);
      const plan = planWeeklySend({
        nowMs: Date.now(),
        selectionEndsMs: Number.isFinite(selectionEndsMs) ? selectionEndsMs : null,
        existingNames,
        audienceCount: cont ? cont.contactCount : 0,
        listId: cont ? cont.id : null,
      });

      /** 文面は**実データで**組んでみて、品質基準に通るかまで見る */
      let content = { ok: false, reason: 'not_built' };
      let copy = { ok: false, issues: ['not_evaluated'] };
      try {
        const mod = await import('../../src/data/archiveResults.json', { with: { type: 'json' } });
        const showcase = buildLatestShowcase((mod && (mod.default || mod)) || []);
        content = buildWeeklyContent({ dateKey: null, showcase });
        if (content.ok) copy = validateWeeklyContent(content.step);
      } catch { /* 下の判定で弾く */ }

      const groups = await api.getUnsubscribeGroups();
      const group = groups.find((g) => g.name === 'AK Marketing') || null;

      const checks = {
        宛先: {
          ok: !!cont && cont.contactCount > 0,
          list: CONTINUATION_LIST_NAME,
          人数: cont ? cont.contactCount : null,
          詳細: cont ? null : 'list_missing',
        },
        文面: { ok: content.ok === true, 詳細: content.ok ? null : content.reason },
        CTA: {
          ok: copy.ok === true,
          詳細: copy.ok ? null : (copy.issues || []).join(',') || 'copy_rejected',
        },
        配信停止: {
          ok: !!group,
          group: group ? group.name : null,
          詳細: group ? null : 'unsubscribe_group_missing',
        },
        枠: { ok: plan.ok === true, 詳細: plan.ok ? plan.slot.name : plan.reason },
      };
      const ok = Object.values(checks).every((c) => c.ok === true);
      return json(200, {
        mode: 'sendgrid-weekly-preflight',
        ok,
        sideEffects: 'none',
        有効: String(process.env.SENDGRID_WEEKLY_ENABLED || '').trim() === 'true',
        選別終了予定: selectionEndsAt || null,
        checks,
        次の枠: plan.ok ? summarizeWeeklyPlan(plan) : null,
        notice: '読み取りのみ。作成・予約はしていません。',
      });
    }

    /**
     * ── reconcile（**予約の直前に毎回**走らせる）────────────────
     *
     * 遅れて届いた `delivered` で AK の通し番号が進むと、投入時のままの list に
     * 残っている人へ**同じ号をもう一度**送ってしまう。反応して離脱した人が
     * list に残る取りこぼしも同じ形で起きる。だから **AK を正本**として
     * 在籍を貼り替える。**1 回限りの手修正にしない。**
     *
     * - `scope: 'active'`   … 送ってよい人（索引を窓で読む）
     * - `scope: 'excluded'` … 反応・抑止・打ち切り（**3 本すべてから外す**）
     * - `apply` 省略時は**下見**。SendGrid へ書き込みは 1 件も出さない
     */
    if (action === 'reconcile') {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) return json(503, { ok: false, reason: 'sendgrid_api_key_missing', sideEffects: 'none' });
      const api = createSendGridMarketingApi({ apiKey });
      const ids = listIdsByMessage(await api.getLists());
      const fields = resolveFieldIds(await api.getFieldDefinitions());
      if (!fields.ok) {
        return json(409, { ok: false, reason: fields.reason, missing: fields.missing, sideEffects: 'none' });
      }

      const scope = String(req.scope || 'active') === 'excluded' ? 'excluded' : 'active';
      let akEntries = [];
      let window = null;

      if (scope === 'active') {
        const out = await runScan(req);
        if (!out.ok) {
          return json(out.reason === 'prospect_index_changed' ? 409 : 500, {
            mode: 'sendgrid-migration-reconcile', ok: false, reason: out.reason, sideEffects: 'none',
          });
        }
        window = out.window;
        akEntries = toExportEntries(out.results).map((e) => ({
          email: e.email, nextMessageNumber: e.nextMessageNumber, sendable: true,
        }));
      } else {
        const store = createProspectStore({ cmd: redisCmd, pipeline: redisPipeline });
        const hashes = [...new Set([...(await store.engagedHashes()), ...(await store.blockedHashes())])].sort();
        const offset = Math.max(0, Number(req.offset) || 0);
        const limit = Math.min(Math.max(1, Number(req.limit) || 200), 500);
        const slice = hashes.slice(offset, offset + limit);
        let withoutEmail = 0;
        for (const h of slice) {
          // eslint-disable-next-line no-await-in-loop -- 窓で切ってある
          const rec = await store.loadByHash(h);
          // ⚠️ アドレスを持たないレコード（purge 済み）は**触れない**。数えるだけ
          if (!rec || !rec.email) { withoutEmail += 1; continue; }
          akEntries.push({ email: rec.email, state: rec.state, sendable: false });
        }
        window = {
          offset, limit, total: hashes.length, returned: slice.length,
          アドレス無し: withoutEmail,
          nextOffset: offset + slice.length < hashes.length ? offset + slice.length : null,
        };
      }

      /**
       * ⚠️ **壊れたアドレスが 1 件混ざると `search/emails` も 400 で全部落ちる**
       *    （2026-09-19 に本番で実測）。落ちたら割って、引けるものだけ引く。
       */
      const sgMap = new Map();
      const lookupSplit = await runWithSplit(
        akEntries.map((e) => e.email),
        async (chunk) => {
          const part = await api.lookupContacts(chunk, { fieldId: fields.ids.ak_next_message });
          for (const [email, v] of part.entries()) sgMap.set(email, v);
        },
        { minChunk: 1 },
      );
      /**
       * ⚠️ **状態を引けなかった人は触らない**（fail closed）。
       *    引けないまま「SendGrid に居ない」と見なすと、
       *    **間違った list に居る人を外さずに正しい list へ足す**ことになり、
       *    両方に載って 2 通届く。分からないなら何もしないほうが安全。
       */
      const unresolved = new Set(lookupSplit.rejected.map((e) => String(e).toLowerCase()));
      const targets = akEntries.filter((e) => !unresolved.has(String(e.email).toLowerCase()));

      /**
       * **SendGrid が受理しないと分かっている宛先には二度と足さない。**
       * 索引は `sha256(email)` だけを持つ（**アドレスは持たない**）。
       * ここに載っている人は選別配信の**対象外のまま**にする（AK 側の状態は変えない）。
       */
      let knownRejected = new Set();
      try {
        const raw = await redisCmd(['SMEMBERS', REJECTED_INDEX_KEY]);
        if (Array.isArray(raw)) knownRejected = new Set(raw.map(String));
      } catch { /* 読めなければ空。**足さない側**へは倒さない（下の addMissing:false が効く） */ }

      const plan = buildReconcilePlan({
        akEntries: targets,
        sendgridByEmail: sgMap,
        listIdByMessage: ids,
        knownRejected,
        hashOf: emailHash,
        /**
         * ⚠️ **reconcile は在籍の貼り替えに絞る**。SendGrid に居ない人を入れるのは
         *    `import` の仕事。ここで入れに行くと、受理されない宛先へ毎回試行してしまう。
         */
        addMissing: req.addMissing === true,
      });
      const safety = assertReconcileSafety(plan);
      const gateOpen = isWriteEnabled(process.env);
      const apply = req.apply === true;

      if (!apply) {
        return json(200, {
          mode: 'sendgrid-migration-reconcile',
          ok: true, sideEffects: 'none', dryRun: true,
          gate: gateOpen ? 'open' : 'closed',
          engine, scope, window,
          summary: summarizeReconcilePlan(plan),
          safety,
          引けなかった宛先: lookupSplit.rejected.length,
          notice: '下見です。SendGrid へは 1 リクエストも書き込んでいません。',
        });
      }

      if (!gateOpen) {
        return json(403, { ok: false, reason: 'write_gate_closed', gateEnv: WRITE_GATE_ENV, sideEffects: 'none' });
      }
      if (String(req.confirm || '') !== WRITE_CONFIRM) {
        return json(400, { ok: false, reason: 'confirm_mismatch', sideEffects: 'none' });
      }
      // ⚠️ 旧 AK がまだ prospect を送る設定なら**貼り替えない**（二重稼働の上で触らない）
      const single = assertSingleEngine({
        akProspectSending: engine !== 'sendgrid', sendgridAutomationLive: req.automationLive === true,
      });
      if (!single.ok) {
        return json(409, { ok: false, reason: single.violation, engine, sideEffects: 'none' });
      }
      if (!safety.ok) {
        return json(409, {
          ok: false, reason: safety.violation, changes: plan.changes,
          maxChanges: RECONCILE_LIMITS.maxChanges, sideEffects: 'none',
        });
      }

      // **remove → add の順**（両方の list に居る瞬間を作らない）
      const applied = { removed: 0, added: 0, requests: 0, providerRejected: 0 };
      for (const step of reconcileSteps(plan)) {
        if (step.op === 'remove') {
          const contactIds = step.emails.map((e) => (sgMap.get(e) || {}).id).filter(Boolean);
          if (contactIds.length === 0) continue;
          // eslint-disable-next-line no-await-in-loop -- 窓とチャンクで切ってある
          const r = await api.removeContactsFromList({ listId: step.listId, contactIds, confirm: req.confirm });
          applied.removed += r.removed; applied.requests += 1;
        } else {
          /**
           * ⚠️ 受理されない宛先が 1 件でも混ざると batch ごと落ちる。
           *    **良い宛先を巻き添えにしない**ため、落ちたら半分に割って通し、
           *    1 件まで割っても通らないものだけを `provider rejected` として数える。
           */
          // eslint-disable-next-line no-await-in-loop -- 窓とチャンクで切ってある
          const r = await runWithSplit(step.entries, async (chunk) => {
            await api.upsertContacts({
              batch: {
                list_ids: [step.listId],
                contacts: chunk.map((e) => ({
                  email: e.email, custom_fields: { [fields.ids.ak_next_message]: e.nextMessage },
                })),
              },
              confirm: req.confirm,
            });
          }, { minChunk: 1 });
          applied.added += r.ok;
          applied.requests += r.requests;
          applied.providerRejected += r.rejected.length;
          /**
           * 受理されなかった宛先を **hash で**覚える（アドレスは保存しない）。
           * 次回からは計画に載らず、**二度と試さない**。
           * ⚠️ AK 本体の状態（SUPPRESSED / blocked）は**変えない**。
           */
          if (r.rejected.length > 0) {
            try {
              await redisCmd(['SADD', REJECTED_INDEX_KEY, ...r.rejected.map((e) => emailHash(e.email))]);
            } catch { /* 覚えられなくても実行結果は変えない（次回また試すだけ） */ }
          }
        }
      }

      return json(200, {
        mode: 'sendgrid-migration-reconcile',
        ok: true,
        sideEffects: 'sendgrid_lists_only',
        engine, scope, window,
        summary: summarizeReconcilePlan(plan),
        applied,
        引けなかった宛先: lookupSplit.rejected.length,
        notice: applied.providerRejected > 0
          ? 'SendGrid が受理しない宛先がありました（provider rejected）。件数だけ数えています（AK 側は変更しません）。'
          : null,
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
