/**
 * admin-marketing-automation-def-canary.js — Definition 保存 canary
 *
 * ⚠️ **canary 専用 Definition を 1 件だけ**作って一連の操作を確かめる。
 *    automationId は `canary-<canaryId>` 固定で、**他の Definition には触れない**。
 * ⚠️ **Airtable に触れない。メールを送らない。Customers を参照しない。**（依存が無い）
 * ⚠️ 実顧客・実 campaign を使わない。**PII なし**（campaignId は `canary-campaign` の固定ダミー）。
 * ⚠️ URL / token / Redis の値を返さない・ログにも出さない。
 *
 * ── index:active は共有キー ────────────────────────────────────
 * SADD / SREM は **canary の member 1 つだけ**を対象にし、
 * 実行前後で**他の member が変わっていないこと**を突き合わせる。
 *
 * ── action 別ゲート（窓を作らない順序）────────────────────────
 *   | action          | ENABLED=true | false / unset |
 *   | preview / run   | 許可         | **403**       |
 *   | status/cleanup  | 許可         | 許可          |
 *   | finalize        | **403**      | 許可          |
 *
 * ⚠️ `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は**参照しない**（production へ追加しない）。
 */

import { randomBytes } from 'node:crypto';
import {
  createDefCanaryStore, compareIndexExcludingCanary, canaryAutomationId,
  DefCanaryError, DEF_FAIL, RESULT_SCHEMA_VERSION,
} from '../../src/lib/marketing/automationDefCanaryStore.js';

export const DEF_CANARY_GATE_ENV = 'MARKETING_AUTOMATION_DEF_CANARY_ENABLED';
/** 実 campaign を使わない固定ダミー */
export const CANARY_CAMPAIGN_ID = 'canary-campaign';

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

async function redisCmd(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('upstash_not_configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`upstash_http_${res.status}`);
  return (await res.json()).result;
}

const isValidCanaryId = (id) => /^\d{14}-[a-f0-9]{8}$/.test(String(id ?? ''));
const buildCanaryId = (nowIso, hex) =>
  `${String(nowIso).replace(/[-:.TZ]/g, '').slice(0, 14)}-${hex}`;
export const buildRunConfirmation = (id) => `DEF-CANARY ${id}`;
export const buildFinalizeConfirmation = (id) => `DEF-CANARY-FINALIZE ${id}`;

const guardBody = (e) => ({
  error: 'canary を中断しました（名前空間・応答の異常）。',
  code: e.code || DEF_FAIL.UNKNOWN_RESULT, detail: e.detail || null,
});

/** canary 用 Definition（**PII なし・実 campaign を使わない**） */
function canaryDefinition({ canaryId, nowIso, status, configVersion }) {
  return {
    automationId: canaryAutomationId(canaryId),
    presetId: 'canary-preset',
    name: 'canary definition',
    status,
    campaignId: CANARY_CAMPAIGN_ID,
    campaignVersion: '1',
    schedule: 'never',
    timezone: 'Asia/Tokyo',
    quietHours: { start: 21, end: 8 },
    maxRecipients: 1,
    trigger: { kind: 'manual_condition' },
    audience: { contracts: [], plans: [], enforce: false },
    createdAt: nowIso,
    updatedAt: nowIso,
    configVersion,
    lastRunAt: null,
    nextRunAt: null,
  };
}

function handlePreview({ now }) {
  const canaryId = buildCanaryId(new Date(now).toISOString(), randomBytes(4).toString('hex'));
  return json(200, {
    mode: 'def-canary-preview', sideEffects: 'none', canaryId,
    automationId: canaryAutomationId(canaryId),
    confirmationPhrase: buildRunConfirmation(canaryId),
    campaignId: CANARY_CAMPAIGN_ID,
    notice: 'まだ Redis へ 1 コマンドも送っていません。',
  });
}

async function handleRun({ req, now }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  if (String(req.confirmation || '').trim() !== buildRunConfirmation(canaryId)) {
    return json(409, { error: '確認文字列が一致しません。', code: 'confirmation_mismatch' });
  }
  let store;
  try { store = createDefCanaryStore({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }

  const nowIso = new Date(now).toISOString();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: detail ?? null });
  const out = { mode: 'def-canary-run', canaryId, automationId: store.automationId };

  try {
    // 0) 既に存在しないこと（exactly once）
    if (await store.exists()) {
      return json(409, { ...out, error: 'この canaryId の Definition が既に存在します。', code: 'already_exists' });
    }
    const indexBefore = await store.indexMembers();

    // 1) 作成（expectedVersion='' = まだ無いはず）
    const c1 = await store.save({
      definition: canaryDefinition({ canaryId, nowIso, status: 'DRAFT', configVersion: 1 }),
      expectedVersion: '',
    });
    add('1. Definition を作成できる', c1.ok === true);

    // 2) get
    const got = await store.load();
    add('2. get で読み戻せる', !!got && got.automationId === store.automationId && got.configVersion === 1);
    add('2b. PII を含まない', !!got && !JSON.stringify(got).match(/@[a-z0-9.-]+\.[a-z]{2,}/i));

    // 3) version 一致 update
    const c2 = await store.save({
      definition: canaryDefinition({ canaryId, nowIso, status: 'DRAFT', configVersion: 2 }),
      expectedVersion: '1',
    });
    add('3. version 一致なら更新できる', c2.ok === true);

    // 4) version 不一致は CONFLICT
    const c3 = await store.save({
      definition: canaryDefinition({ canaryId, nowIso, status: 'DRAFT', configVersion: 3 }),
      expectedVersion: '1',
    });
    add('4. version 不一致は CONFLICT で拒否', c3.ok === false && c3.reason === 'cas_conflict');

    // 5) index 追加（ACTIVE 相当）
    await store.indexAdd();
    const idxAfterAdd = await store.indexMembers();
    add('5. index:active へ追加できる', idxAfterAdd.includes(store.automationId));

    // 6) pause（status 変更）
    const c4 = await store.save({
      definition: canaryDefinition({ canaryId, nowIso, status: 'PAUSED', configVersion: 3 }),
      expectedVersion: '2',
    });
    const paused = await store.load();
    add('6. pause（PAUSED へ遷移）できる', c4.ok === true && paused?.status === 'PAUSED');

    // 7) cancel（status 変更 + index 除去）
    const c5 = await store.save({
      definition: canaryDefinition({ canaryId, nowIso, status: 'CANCELLED', configVersion: 4 }),
      expectedVersion: '3',
    });
    await store.indexRemove();
    const cancelled = await store.load();
    const idxAfterRemove = await store.indexMembers();
    add('7. cancel（CANCELLED へ遷移）できる', c5.ok === true && cancelled?.status === 'CANCELLED');
    add('8. index:active から除去できる', !idxAfterRemove.includes(store.automationId));

    // 9) 他の member を変えていない
    const cmp = compareIndexExcludingCanary({
      before: indexBefore, after: idxAfterRemove, canaryMember: store.automationId,
    });
    add('9. index の他 member を変えていない', cmp.same, `${cmp.beforeCount} -> ${cmp.afterCount}`);

    out.checks = checks;
    out.indexOtherMembers = { before: cmp.beforeCount, after: cmp.afterCount, same: cmp.same };
    out.ok = checks.every((c) => c.ok);
    // 3 経路をそのまま突き合わせられるよう、保存結果・ログと同じキー名も持たせる
    out.overallOk = out.ok;

    // ⚠️ 2 経路目。HTTP 応答を取り逃しても PASS/FAIL を復元できるようにする
    const summary = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      event: 'marketing_automation_def_canary_result',
      canaryIdSuffix: canaryId.slice(-8),
      overallOk: out.ok,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
      indexOtherMembers: out.indexOtherMembers,
      runCount: 1, retryCount: 0,
      finishedAt: nowIso,
    };
    let resultSaved = false;
    try { await store.saveResult(summary); resultSaved = true; }
    catch { /* 保存に失敗しても HTTP 応答とログの 2 経路は残す */ }

    out.resultSaved = resultSaved;
    out.stats = store.stats();
    out.notice = out.ok
      ? 'すべて通過。**Definition と結果はまだ残っています**。status で 3 経路一致を確認してから cleanup してください。'
      : '未達があります。cleanup せず status とログを取得してください。';

    // ⚠️ 3 経路目。PII なし・canaryId 全文を出さない
    try {
      console.log(JSON.stringify({ ...summary, commandCount: out.stats.commands, resultSaved }));
    } catch { /* ログ失敗で止めない */ }

    return json(200, out);
  } catch (e) {
    out.ok = false; out.checks = checks;
    console.error('❌ [def-canary] 中断:', e.code || 'error');
    return json(e instanceof DefCanaryError ? 409 : 503, { ...out, ...guardBody(e) });
  }
}

async function handleStatus({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let store;
  try { store = createDefCanaryStore({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    const def = await store.load();
    const members = await store.indexMembers();
    const restored = await store.loadResult();
    return json(200, {
      mode: 'def-canary-status', sideEffects: 'none', canaryId,
      automationId: store.automationId,
      Definition残存: def !== null,
      status: def ? def.status : null,
      configVersion: def ? def.configVersion : null,
      'index:active に含まれる': members.includes(store.automationId),
      index他member数: members.filter((m) => m !== store.automationId).length,
      // ⚠️ 復元できない / 壊れている / schema 違いは **PASS 扱いにしない**
      結果復元: restored.ok,
      結果復元不能理由: restored.ok ? null : restored.reason,
      result: restored.ok ? restored.result : null,
      stats: store.stats(),
    });
  } catch (e) { return json(e instanceof DefCanaryError ? 409 : 503, guardBody(e)); }
}

/** cleanup: canary Definition を削除し index からも除去する */
async function handleCleanup({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let store;
  try { store = createDefCanaryStore({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    const before = await store.indexMembers();
    await store.indexRemove();
    await store.del();
    await store.delResult();
    const stillDef = await store.exists();
    const stillResult = await store.resultExists();
    const after = await store.indexMembers();
    const cmp = compareIndexExcludingCanary({ before, after, canaryMember: store.automationId });
    return json(200, {
      mode: 'def-canary-cleanup', canaryId, automationId: store.automationId,
      Definition残存: stillDef,
      結果残存: stillResult,
      'index:active に含まれる': after.includes(store.automationId),
      index他member: { before: cmp.beforeCount, after: cmp.afterCount, same: cmp.same },
      残存0: stillDef === false && stillResult === false
        && !after.includes(store.automationId) && cmp.same,
      stats: store.stats(),
    });
  } catch (e) { return json(e instanceof DefCanaryError ? 409 : 503, guardBody(e)); }
}

/** finalize: 最終確認（削除済みであることの確認のみ。追加の破壊操作はしない） */
async function handleFinalize({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  if (String(req.confirmation || '').trim() !== buildFinalizeConfirmation(canaryId)) {
    return json(409, { error: 'finalize の確認文字列が一致しません。', code: 'confirmation_mismatch' });
  }
  let store;
  try { store = createDefCanaryStore({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    // 残っていれば消す（冪等）
    await store.indexRemove();
    await store.del();
    await store.delResult();
    const stillDef = await store.exists();
    const stillResult = await store.resultExists();
    const members = await store.indexMembers();
    const inIndex = members.includes(store.automationId);
    return json(200, {
      mode: 'def-canary-finalize', canaryId, automationId: store.automationId,
      finalized: stillDef === false && stillResult === false && inIndex === false,
      Definition残存: stillDef, 結果残存: stillResult, 'index:active に含まれる': inIndex,
      index他member数: members.filter((m) => m !== store.automationId).length,
      stats: store.stats(),
    });
  } catch (e) { return json(e instanceof DefCanaryError ? 409 : 503, guardBody(e)); }
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
  const action = req.action || 'preview';
  const now = Date.now();
  const enabled = process.env[DEF_CANARY_GATE_ENV] === 'true';

  // ── action 別ゲート（**Redis client 初期化より前**）──
  if (action === 'preview' || action === 'run') {
    if (!enabled) {
      return json(403, {
        error: 'Definition canary は無効です。', code: 'def_canary_disabled', action,
        必要なenv: DEF_CANARY_GATE_ENV, 接続: { redis: false, airtable: false },
      });
    }
  }
  if (action === 'finalize') {
    if (enabled) {
      return json(403, {
        error: 'finalize は canary を無効化した後にのみ実行できます。',
        code: 'def_canary_still_enabled', action,
      });
    }
  }

  try {
    if (action === 'preview') return handlePreview({ now });
    if (action === 'run') return await handleRun({ req, now });
    if (action === 'status') return await handleStatus({ req });
    if (action === 'cleanup') return await handleCleanup({ req });
    if (action === 'finalize') return await handleFinalize({ req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    console.error('❌ [def-canary] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
