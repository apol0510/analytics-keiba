/**
 * admin-marketing-automation-redis-canary.js — 自動化 Redis primitive の canary
 *
 * ⚠️ **この Function は Airtable に触れない。メールを送らない。Customers を参照しない。**
 * ⚠️ 書き込み・削除は `ak:marketing-automation:canary:<canaryId>:` 配下と
 *    墓標 `ak:marketing-automation:canary-run:<canaryId>` だけ。
 *    本番の `def:` / `run:` / `recipient:` / `index:active` / `lock:` / `fence` /
 *    `payemail:*` / `customer-import:*` / KMA 系には **1 バイトも触れない**。
 * ⚠️ URL / token / Redis の値 / hash 全文を**返さない・ログにも出さない**。
 * ⚠️ `KEYS` 禁止。走査は `SCAN MATCH <prefix>*` のみ。
 *
 * ── action 別ゲート（窓を作らない順序）────────────────────────
 *   | action          | ENABLED=true | false / unset |
 *   | preview / run   | 許可         | **403**       |
 *   | status/cleanup  | 許可         | 許可          |
 *   | finalize        | **403**      | 許可          |
 *
 *   `finalize`（墓標の削除）は **env を無効化し、その反映 deploy を終えた後**にしか通らない。
 *   これにより「墓標が無いのに run できる時間帯」が構造的に生じない。
 *
 * ⚠️ `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は**参照しない**（今回は触らない）。
 */

import { randomBytes } from 'node:crypto';
import {
  createCanaryRunner, runPhase0, runPhase1, cleanupCanary, scanCanaryKeys, finalizeCanary,
  buildCanaryId, buildRunConfirmation, buildFinalizeConfirmation, isValidCanaryId,
  canaryPrefix, dataPrefix, markerKey, CanaryGuardError, CANARY_STOP,
  MAX_CANARY_KEYS, MAX_REDIS_COMMANDS, CANARY_TTL_SEC, MARKER_TTL_SEC,
  buildResultSummary, assertResultSafe, validateResult, buildLogLine,
  resultKey, RESULT_SCHEMA_VERSION,
} from '../../src/lib/marketing/automationRedisCanary.js';

export const CANARY_GATE_ENV = 'MARKETING_AUTOMATION_REDIS_CANARY_ENABLED';

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

/** Upstash REST（AK 既存 env のみ）。URL / token は返さない・出さない */
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

const guardBody = (e) => ({
  error: 'canary を中断しました（名前空間・上限・応答の異常）。',
  code: e.code || CANARY_STOP.UNKNOWN_RESULT, detail: e.detail || null,
});

/** preview: canaryId を発行するだけ（**Redis に触れない**） */
function handlePreview({ now }) {
  const canaryId = buildCanaryId({
    nowIso: new Date(now).toISOString(), randomHex: randomBytes(4).toString('hex'),
  });
  return json(200, {
    mode: 'mkauto-canary-preview', sideEffects: 'none', canaryId,
    confirmationPhrase: buildRunConfirmation(canaryId),
    namespace: canaryPrefix(canaryId),
    limits: {
      最大キー数: MAX_CANARY_KEYS, 最大コマンド数: MAX_REDIS_COMMANDS,
      canaryキーTTL秒: CANARY_TTL_SEC, 墓標TTL秒: MARKER_TTL_SEC,
    },
    notice: 'まだ Redis へ 1 コマンドも送っていません。',
  });
}

async function handleRun({ req, now }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  if (String(req.confirmation || '').trim() !== buildRunConfirmation(canaryId)) {
    return json(409, {
      error: '確認文字列が一致しません。', code: CANARY_STOP.CONFIRMATION_MISMATCH,
      confirmationPhrase: buildRunConfirmation(canaryId),
    });
  }
  let runner;
  try { runner = createCanaryRunner({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }

  // exactly-once: 墓標を SET NX（timeout しても同じ canaryId では再実行できない）
  let marker;
  try {
    marker = await runner.run(['SET', markerKey(canaryId), String(now), 'NX', 'EX', String(MARKER_TTL_SEC)]);
  } catch (e) { return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e)); }
  if (marker.result !== 'OK') {
    return json(409, {
      mode: 'mkauto-canary-run', code: CANARY_STOP.ALREADY_RUN,
      error: 'この canaryId は既に実行済みです（status / cleanup のみ）。',
    });
  }

  const out = { mode: 'mkauto-canary-run', canaryId, namespace: dataPrefix(canaryId) };
  try {
    const p0 = await runPhase0(runner);
    out.phase0 = { ok: p0.ok, checks: p0.checks, dbsize参考値: p0.dbsize };
    const p1 = await runPhase1({ runner, now });
    out.phase1 = { ok: p1.ok, checks: p1.checks };
    // ⚠️ **cleanup しない。** run の応答を取り逃しても復元できるよう、
    //    まず結果を Redis へ保存し、3 経路の一致を確認してから別 action で cleanup する。
    const finishedAt = new Date(Date.now()).toISOString();
    const summary = buildResultSummary({
      canaryId, phase0: p0, phase1: p1,
      cleanup: { found: 0, deleted: 0, remaining: 0 },   // cleanup はまだ行わない
      stats: runner.stats(), startedAt: new Date(now).toISOString(), finishedAt,
      outOfNamespaceCount: 0, retryCount: 0, runCount: 1,
    });
    if (!assertResultSafe(summary)) {
      out.ok = false; out.resultSaved = false; out.resultError = 'result_unsafe';
      out.stats = runner.stats();
      return json(500, out);
    }
    let resultSaved = false;
    try {
      await runner.run(['SET', resultKey(canaryId), JSON.stringify(summary), 'EX', String(CANARY_TTL_SEC)]);
      resultSaved = true;
    } catch (e) {
      // ⚠️ 保存に失敗したら **overall 成功にしない**（復元経路が欠ける）
      out.resultError = e.code || 'result_save_failed';
    }
    out.resultSaved = resultSaved;
    out.result = summary;

    // ⚠️ 3 経路目。**PII なし・canaryId 全文を出さない** 1 行 JSON
    try { console.log(JSON.stringify(buildLogLine(summary))); } catch { /* ログ失敗で止めない */ }

    out.stats = runner.stats();
    out.ok = p0.ok && p1.ok && resultSaved && summary.overallOk === true;
    out.notice = out.ok
      ? 'Phase 0 / Phase 1 すべて通過。**結果を Redis へ保存済み**。3 経路の一致を確認してから cleanup してください。'
      : '未達があります。cleanup せず status と Function ログを取得してください。';
    out.次の手順 = [
      '1) この HTTP 応答を専用ファイルへ保存（-o と -w を混ぜない）',
      '2) action:"status" で保存済み result を取得し、HTTP 応答と一致を確認',
      '3) Function ログの 1 行 JSON で overallOk とチェック数を確認',
      '4) 3 経路が一致してから action:"cleanup"',
    ];
    return json(200, out);
  } catch (e) {
    try { out.cleanup = await cleanupCanary(runner); }
    catch (e2) { out.cleanup = { error: 'cleanup 失敗', code: e2.code || null }; }
    out.ok = false; out.stats = runner.stats();
    console.error('❌ [mkauto-canary] 中断:', e.code || 'error');
    return json(e instanceof CanaryGuardError ? 409 : 503, { ...out, ...guardBody(e) });
  }
}

async function handleStatus({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let runner;
  try { runner = createCanaryRunner({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    const m = await runner.run(['EXISTS', markerKey(canaryId)]);
    const found = await scanCanaryKeys(runner);   // ⚠️ 数えるだけ・削除しない

    // 保存済み result を復元する。**無い / 壊れている / schema 違いは PASS 扱いにしない**
    let raw = null;
    try { raw = (await runner.run(['GET', resultKey(canaryId)])).result; }
    catch { raw = null; }
    const v = validateResult(raw);

    return json(200, {
      mode: 'mkauto-canary-status', sideEffects: 'none', canaryId,
      run実行済み: Number(m.result) === 1,
      result保存済み: v.ok,
      resultProblem: v.ok ? null : v.code,
      schemaVersion: v.ok ? v.result.schemaVersion : null,
      期待schemaVersion: RESULT_SCHEMA_VERSION,
      overallOk: v.ok ? v.result.overallOk === true : false,
      checks: v.ok ? [
        ...v.result.phase0.map((c) => ({ name: c.name, ok: c.ok, errorCode: c.errorCode, latencyMs: c.latencyMs })),
        ...v.result.phase1.map((c) => ({ name: c.name, ok: c.ok, errorCode: c.errorCode })),
      ] : [],
      commandCount: v.ok ? v.result.commandCount : null,
      retryCount: v.ok ? v.result.retryCount : null,
      runCount: v.ok ? v.result.runCount : null,
      データ残存数: found.length,
      墓標: Number(m.result) === 1,
      stats: runner.stats(),
      notice: v.ok ? '保存済み result を復元しました。'
        : 'result を復元できません。**PASS と判定しないでください。**',
    });
  } catch (e) { return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e)); }
}

async function handleCleanup({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let runner;
  try { runner = createCanaryRunner({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    const clean = await cleanupCanary(runner);
    return json(200, {
      mode: 'mkauto-canary-cleanup', canaryId, cleanup: clean, stats: runner.stats(),
      note: clean.remaining === 0
        ? 'canary prefix の残存 0。墓標は別 prefix に残るため再実行は拒否されます（finalize で消します）。'
        : '残存があります。追加 run はせず内容を確認してください。',
    });
  } catch (e) { return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e)); }
}

async function handleFinalize({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  if (String(req.confirmation || '').trim() !== buildFinalizeConfirmation(canaryId)) {
    return json(409, {
      error: 'finalize の確認文字列が一致しません。', code: CANARY_STOP.CONFIRMATION_MISMATCH,
      confirmationPhrase: buildFinalizeConfirmation(canaryId),
    });
  }
  let runner;
  try { runner = createCanaryRunner({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    const fin = await finalizeCanary(runner);
    return json(200, {
      mode: 'mkauto-canary-finalize', canaryId, finalize: fin,
      残存: { データ: fin.rootRemaining ?? null, 墓標: fin.markerRemaining ?? null },
      warning: '墓標を消しました。直ちに Function を本番から削除してください。',
      stats: runner.stats(),
    });
  } catch (e) { return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e)); }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // ⚠️ すべての action で管理シークレット必須
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'preview';
  const now = Date.now();
  const enabled = process.env[CANARY_GATE_ENV] === 'true';

  // ── action 別ゲート（**Redis client 初期化より前**）──
  if (action === 'preview' || action === 'run') {
    if (!enabled) {
      return json(403, {
        error: 'canary は無効です。', code: 'canary_disabled', action,
        必要なenv: CANARY_GATE_ENV, 接続: { redis: false, airtable: false },
      });
    }
  }
  if (action === 'finalize') {
    if (enabled) {
      return json(403, {
        error: 'finalize は canary を無効化した後にのみ実行できます（env を unset し反映 deploy を終えてから）。',
        code: 'canary_still_enabled', action,
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
    console.error('❌ [mkauto-canary] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
