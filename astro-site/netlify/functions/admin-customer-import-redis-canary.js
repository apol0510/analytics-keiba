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
 * ── action 別ゲート（**窓を作らない順序**）────────────────────
 *   | action          | enabled=true | enabled=false / unset |
 *   |-----------------|--------------|-----------------------|
 *   | preview / run   | 許可         | **403**               |
 *   | status/cleanup  | 許可         | 許可                  |
 *   | finalize        | **403**      | 許可                  |
 *
 *   `finalize`（墓標の削除）は **env を無効化し、その反映 deploy を終えた後**にしか通らない。
 *   これにより「墓標が無いのに run できる時間帯」が構造的に生じない。
 *   env 変更は **redeploy 必須**（Netlify の仕様・AK の実績）なので、
 *   無効化は「env unset → 反映 deploy」で初めて成立する。
 *
 * ── 使い終わったら ────────────────────────────────────────────
 *   env を unset → 反映 deploy（ここで run は 403）→ finalize → コードごと削除 deploy。
 */

import { randomBytes } from 'node:crypto';
import {
  createCanaryRunner, runPhase0, runPhase1, cleanupCanary, scanCanaryKeys, finalizeCanary,
  buildCanaryId, buildCanaryConfirmation, buildFinalizeConfirmation, isValidCanaryId,
  canaryPrefix, dataPrefix, runMarkerKey,
  CanaryGuardError, CANARY_STOP,
  MAX_CANARY_KEYS, MAX_REDIS_COMMANDS, CANARY_TTL_SEC, RUN_MARKER_TTL_SEC,
} from '../../src/lib/crm/importRedisCanary.js';
import {
  CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA,
  emailClaimKey, emailHash, canReleaseClaim,
} from '../../src/lib/crm/importCanaryContracts.js';

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

    // ⚠️ DBSIZE は**参考値**。他の AK 機能（入金確認メール等）が同時に Redis へ書く
    //    可能性があるため、実行前と一致しないだけで異常とは断定しない。
    //    正本の判定は「canary prefix の作成数・削除数・残存 0」。
    const dbsizeAfter = Number((await runner.run(['DBSIZE'])).result);
    out.dbsize = {
      before: p0.dbsize, after: dbsizeAfter, 差: dbsizeAfter - p0.dbsize,
      注記: '参考値。他機能の同時書き込みで変動しうるため合否判定には使わない。墓標 1 件は意図的に残る。',
    };
    out.canary残存 = { データ: clean.remaining, 墓標: 1 };

    out.stats = runner.stats();
    // 合否は canary prefix の残存 0 で決める（DBSIZE は使わない）
    out.ok = p0.ok && p1.ok && clean.remaining === 0;
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

/** 最後の後始末。墓標も消して残存を完全に 0 にする（Function 無効化の直前に 1 回） */
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
      mode: 'redis-canary-finalize', canaryId, finalize: fin,
      残存: { データ: fin.rootRemaining ?? null, 墓標: fin.markerRemaining ?? null },
      warning: '墓標を消したため、この canaryId の再実行を Redis では拒否できません。直ちに CUSTOMER_IMPORT_CANARY_ENABLED を削除してください。',
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
        ? 'canary prefix の残存 0。実行済み墓標は別 prefix に残るため再実行は拒否されます（finalize で消します）。'
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

  // ⚠️ **すべての action で管理シークレット必須**（status / cleanup / finalize も含む）
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'preview';
  const now = Date.now();
  const enabled = process.env.CUSTOMER_IMPORT_CANARY_ENABLED === 'true';

  // ── action 別ゲート（**Redis 初期化より前**）─────────────────
  //
  // ⚠️ ここが「墓標を消した瞬間に run できてしまう窓」を塞ぐ核心。
  //    `finalize` は **env が無効化され、それが deploy で反映された後**にしか通らない。
  //    つまり墓標を消す時点で run/preview は必ず 403 になっている。
  //
  //   | action          | enabled=true | enabled=false / unset |
  //   |-----------------|--------------|-----------------------|
  //   | preview / run   | 許可         | **403**               |
  //   | status/cleanup  | 許可         | 許可                  |
  //   | finalize        | **403**      | 許可                  |
  //
  if (action === 'preview' || action === 'run') {
    if (!enabled) {
      return json(403, {
        error: 'canary は無効です（CUSTOMER_IMPORT_CANARY_ENABLED）。', code: 'canary_disabled', action,
      });
    }
  }
  if (action === 'finalize') {
    if (enabled) {
      // ⚠️ 有効なまま墓標を消すと、run が通る状態で exactly-once が失われる
      return json(403, {
        error: 'finalize は canary を無効化した後にのみ実行できます（CUSTOMER_IMPORT_CANARY_ENABLED を unset し、その反映 deploy を終えてから）。',
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
    // ⚠️ 例外の中身をそのまま返さない（URL / token が混ざりうる）
    console.error('❌ [redis-canary] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
