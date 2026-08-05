/**
 * admin-customer-import-redis-canary.js — 取り込みジョブ Redis 版の Phase 0 / Phase 1 canary
 *
 * ── なぜ Function なのか ──────────────────────────────────────
 * `UPSTASH_REDIS_REST_URL` / `_TOKEN` は Netlify の **secret（`is_secret: true`）**で、
 * scope は `functions`・値を持つ context は `production` だけ。作成後は API でも CLI でも
 * 値を取り出せない。**secret を Netlify の外へ持ち出さずに** production Redis を検証する
 * 唯一の方法が、この専用 Function を production へ置いて叩くこと。
 *
 * ⚠️ **この Function は Airtable に触れない。メールを送らない。**（依存が存在しない）
 * ⚠️ **書き込み・削除は `customer-import:canary:<canaryId>:` 配下だけ。**
 *    `customer-import:lock:global` / `customer-import:fence` / `customer-import:email:*` /
 *    `customer-import:job:*` / `payemail:*` には **1 バイトも触れない**（`createCanaryRunner` が構造的に拒否）。
 * ⚠️ URL / token / Redis の値 / メール / hash 全文を**返さない・ログにも出さない**。
 * ⚠️ 全キー列挙（`KEYS *`）は禁止。走査は `SCAN MATCH <prefix>*` のみ。
 *
 * ── 事故防止 ──────────────────────────────────────────────────
 *   - POST のみ。AK 管理シークレット（`x-admin-secret`）必須
 *   - canaryId は**サーバー側生成**（`preview` で発行）
 *   - `run` には確認文字列 `REDIS-CANARY <canaryId>` が要る
 *   - **1 つの canaryId につき run はちょうど 1 回**（実行済みマーカーを `SET NX`）。
 *     timeout しても同じ canaryId では再実行できない。以後は `status` / `cleanup` のみ
 *   - 最大キー数 32 / 最大コマンド数 150 を超えたら即停止
 *   - canary キーには **TTL 15 分**（cleanup 漏れでも自動消滅）
 *
 * ── 使い終わったら ────────────────────────────────────────────
 *   `CUSTOMER_IMPORT_CANARY_ENABLED=true` が無ければ **常時 403**（既定は無効）。
 *   検証完了後は env を消す（deploy 不要で無効化）。その後コードごと削除する。
 */

import { randomBytes } from 'node:crypto';
import {
  createCanaryRunner, runPhase0, runPhase1, cleanupCanary, scanCanaryKeys,
  buildCanaryId, buildCanaryConfirmation, isValidCanaryId,
  canaryPrefix, dataPrefix, runMarkerKey,
  CanaryGuardError, CANARY_STOP,
  MAX_CANARY_KEYS, MAX_REDIS_COMMANDS, CANARY_TTL_SEC, RUN_MARKER_TTL_SEC,
} from '../../src/lib/crm/importRedisCanary.js';
import {
  CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA,
  emailClaimKey, emailHash,
} from '../../src/lib/crm/importClaimStore.js';
import { canReleaseClaim } from '../../src/lib/crm/importJobReconcile.js';

const LUA = { CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA };

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

/** Upstash REST。**URL / token をレスポンスにもログにも出さない** */
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
  const j = await res.json();
  return j.result;
}

const guardBody = (e) => ({
  error: 'canary を中断しました（名前空間・上限・応答の異常）。',
  code: e.code || CANARY_STOP.UNKNOWN_RESULT,
  detail: e.detail || null,
});

// ── preview: canaryId を発行するだけ（Redis に触れない）────────
function handlePreview({ now }) {
  const canaryId = buildCanaryId({
    nowIso: new Date(now).toISOString(),
    randomHex: randomBytes(4).toString('hex'),
  });
  return json(200, {
    mode: 'redis-canary-preview',
    sideEffects: 'none',
    canaryId,
    confirmationPhrase: buildCanaryConfirmation(canaryId),
    namespace: canaryPrefix(canaryId),
    limits: {
      最大キー数: MAX_CANARY_KEYS,
      最大コマンド数: MAX_REDIS_COMMANDS,
      canaryキーTTL秒: CANARY_TTL_SEC,
      実行済みマーカーTTL秒: RUN_MARKER_TTL_SEC,
    },
    notice: 'まだ Redis へ 1 コマンドも送っていません。run には確認文字列が要ります。',
  });
}

// ── run: Phase 0 + Phase 1（canary 名前空間のみ）───────────────
async function handleRun({ req, now }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) {
    return json(400, { error: 'canaryId の形式が不正です（preview で発行したものを使ってください）。' });
  }
  if (String(req.confirmation || '').trim() !== buildCanaryConfirmation(canaryId)) {
    return json(409, {
      error: '確認文字列が一致しません。', code: CANARY_STOP.CONFIRMATION_MISMATCH,
      confirmationPhrase: buildCanaryConfirmation(canaryId),
    });
  }

  let runner;
  try { runner = createCanaryRunner({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }

  // ── exactly-once: 実行済みマーカーを SET NX ──
  // ⚠️ timeout しても同じ canaryId では二度と run できない（cleanup でも消さない）
  let marker;
  try {
    marker = await runner.run(['SET', runMarkerKey(canaryId), String(now), 'NX', 'EX', String(RUN_MARKER_TTL_SEC)]);
  } catch (e) {
    return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e));
  }
  if (marker.result !== 'OK') {
    return json(409, {
      mode: 'redis-canary-run',
      error: 'この canaryId は既に実行済みです。再実行はできません（status / cleanup のみ）。',
      code: CANARY_STOP.ALREADY_RUN,
    });
  }

  const out = { mode: 'redis-canary-run', canaryId, namespace: dataPrefix(canaryId) };
  try {
    const p0 = await runPhase0(runner);
    out.phase0 = { ok: p0.ok, checks: p0.checks, dbsizeBefore: p0.dbsize };

    const p1 = await runPhase1({
      runner, lua: LUA, now,
      emailClaimKeyFn: emailClaimKey, emailHashFn: emailHash, canReleaseClaimFn: canReleaseClaim,
    });
    out.phase1 = { ok: p1.ok, checks: p1.checks };

    // cleanup は成功・失敗どちらでも行う
    const clean = await cleanupCanary(runner);
    out.cleanup = clean;

    const dbsizeAfter = Number((await runner.run(['DBSIZE'])).result);
    out.dbsize = { before: p0.dbsize, after: dbsizeAfter, 差: dbsizeAfter - p0.dbsize };
    // 実行済みマーカー 1 件だけは意図的に残す（再実行を塞ぐため。TTL で自動消滅）
    out.dbsize.想定差 = 1;
    out.既存キー影響なし = (dbsizeAfter - p0.dbsize) === 1 && clean.remaining === 0;

    out.stats = runner.stats();
    out.ok = p0.ok && p1.ok && clean.remaining === 0 && out.既存キー影響なし;
    out.notice = out.ok
      ? 'Phase 0 / Phase 1 すべて通過。canary データキーは削除済み（実行済みマーカーのみ TTL 付きで残ります）。'
      : '未達があります。Phase 2 へ進まないでください。';
    return json(200, out);
  } catch (e) {
    // ⚠️ 失敗しても cleanup は行う。追加 run はしない
    try { out.cleanup = await cleanupCanary(runner); }
    catch (e2) { out.cleanup = { error: 'cleanup 失敗', code: e2.code || null }; }
    out.ok = false;
    out.stats = runner.stats();
    console.error('❌ [redis-canary] 中断:', e.code || 'error');
    return json(e instanceof CanaryGuardError ? 409 : 503, { ...out, ...guardBody(e) });
  }
}

// ── status / cleanup（Redis は prefix 限定でしか触らない）───────
async function handleStatus({ req }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let runner;
  try { runner = createCanaryRunner({ cmd: redisCmd, canaryId }); }
  catch (e) { return json(400, guardBody(e)); }
  try {
    // ⚠️ status は**数えるだけ**。削除しない
    const marker = await runner.run(['EXISTS', runMarkerKey(canaryId)]);
    const found = await scanCanaryKeys(runner);
    return json(200, {
      mode: 'redis-canary-status',
      sideEffects: 'none',
      canaryId,
      実行済み: Number(marker.result) === 1,
      残存キー数: found.length,
      stats: runner.stats(),
    });
  } catch (e) {
    return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e));
  }
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
      mode: 'redis-canary-cleanup', canaryId, cleanup: clean,
      note: clean.remaining === 0
        ? 'canary データキーは残っていません（実行済みマーカーは TTL で自動消滅します）。'
        : '残存があります。追加 run はせず、内容を確認してください。',
      stats: runner.stats(),
    });
  } catch (e) {
    return json(e instanceof CanaryGuardError ? 409 : 503, guardBody(e));
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  // ⚠️ GET 不可。POST のみ
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // ⚠️ 既定は無効。env が無ければ**常時 403**（使い終わったら env を消すだけで無効化できる）
  if (process.env.CUSTOMER_IMPORT_CANARY_ENABLED !== 'true') {
    return json(403, { error: 'canary は無効です（CUSTOMER_IMPORT_CANARY_ENABLED）。', code: 'canary_disabled' });
  }

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'preview';
  const now = Date.now();

  try {
    if (action === 'preview') return handlePreview({ now });
    if (action === 'run') return await handleRun({ req, now });
    if (action === 'status') return await handleStatus({ req });
    if (action === 'cleanup') return await handleCleanup({ req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外の中身をそのまま返さない（URL / token が混ざりうる）
    console.error('❌ [redis-canary] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
