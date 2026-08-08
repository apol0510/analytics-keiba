/**
 * admin-customer-import-redis-canary.js — 取り込みジョブ Redis 版の Phase 0 / 1 / 2 canary
 *
 * ── どこで動かすのか（2026-08-08 変更）──────────────────────────
 * **AK 本番 Redis からは完全に分離した専用 Upstash** に対して、**非本番 context だけ**で動かす。
 * 接続に使うのは canary 専用の env 名 `CANARY_UPSTASH_REDIS_REST_URL` / `_TOKEN` のみで、
 * 本番の `UPSTASH_REDIS_REST_*` は接続に一切使わない（`checkCanaryIsolation` 参照）。
 * これらは secret（`is_secret: true`）で、値を持つ context は `deploy-preview` だけ。
 *
 * ── なぜ Function なのか ──────────────────────────────────────
 * secret は作成後 API でも CLI でも値を取り出せない。**secret を Netlify の外へ
 * 持ち出さずに**実 Redis を検証する唯一の方法が、この専用 Function を
 * Deploy Preview へ置いて叩くこと。
 *
 * ⚠️ 手順・合否条件・後始末は `docs/customer-import-canary-runbook.md` を参照。
 *
 * ── 実行実績 ────────────────────────────────────────────────
 * 2026-08-08 に隔離 Upstash に対して実行し、Phase 0 (3/3) / Phase 1 (19/19) /
 * Phase 2 (10/10) がすべて PASS。cleanup 残存 0、finalize で墓標を含め完全 0。
 * 実行後に deploy-preview の env 3 件は撤収済み（この Function は既定で 403）。
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
  createCanaryRunner, runPhase0, runPhase1, runPhase2, cleanupCanary, scanCanaryKeys, finalizeCanary,
  buildCanaryId, buildCanaryConfirmation, buildFinalizeConfirmation, isValidCanaryId,
  canaryPrefix, dataPrefix, runMarkerKey,
  CanaryGuardError, CANARY_STOP,
  MAX_CANARY_KEYS, MAX_REDIS_COMMANDS, CANARY_TTL_SEC, RUN_MARKER_TTL_SEC,
} from '../../src/lib/crm/importRedisCanary.js';
import {
  CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA,
  emailClaimKey, emailHash,
} from '../../src/lib/crm/importClaimStore.js';
import { SAVE_FENCED_LUA } from '../../src/lib/crm/importJobAuthority.js';
import { canReleaseClaim } from '../../src/lib/crm/importJobReconcile.js';
import { isProductionContext } from '../../src/lib/auth/originPolicy.js';

const LUA = { CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA, SAVE_FENCED_LUA };

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

/**
 * canary が接続してよい Redis の認証情報。
 *
 * ⚠️ **本番の `UPSTASH_REDIS_REST_URL` / `_TOKEN` は読まない。**
 *    canary 専用の別インスタンスを別の env 名で渡す。名前を分けることで、
 *    「production context に env を入れ忘れた／間違えた」ときでも
 *    **構造的に本番 Redis へ到達できない**（本番の名前を参照するコードが無い）。
 */
export const CANARY_REDIS_URL_ENV = 'CANARY_UPSTASH_REDIS_REST_URL';
export const CANARY_REDIS_TOKEN_ENV = 'CANARY_UPSTASH_REDIS_REST_TOKEN';

/** 本番 Redis の env 名。**参照するのは「一致していないか」の検査だけ。** */
const PROD_REDIS_URL_ENV = 'UPSTASH_REDIS_REST_URL';

/**
 * canary を動かしてよい実行環境か。
 *
 * - production context では**常に拒否**（`isProductionContext` は未設定・未知値も本番扱い）
 * - canary 専用 env が無ければ拒否
 * - canary の URL が本番の URL と**一致していたら拒否**（env の貼り間違い検知）
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: boolean, code: string|null }}
 */
/**
 * 実行環境が非本番かを判定する。
 *
 * ⚠️ Netlify Functions の**実行時**には `process.env.CONTEXT` が入っていないことがある
 *    （2026-08-08 の Deploy Preview 実測で undefined）。CONTEXT だけを見ると
 *    fail-closed で常に拒否になり canary が動かせない。そこでホスト名も信号に使う。
 *
 * ⚠️ ホスト名は理屈の上では詐称できるが、**主防御はここではない**。
 *    production context には canary 専用 env の値が入っていない（空）ため、
 *    仮にホストを詐称しても `canary_redis_not_configured` で止まる。
 *    さらに production では `CUSTOMER_IMPORT_CANARY_ENABLED` が未定義で 403 になる。
 *    ホスト判定は多層防御の 1 枚目にすぎない。
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} [host] リクエストの Host ヘッダ
 */
export function resolveNonProduction(env = {}, host = '') {
  const ctx = env.CONTEXT;
  // CONTEXT が既知の非本番値なら、それが最も強い信号
  if (!isProductionContext(ctx)) return { nonProd: true, via: 'CONTEXT' };
  // CONTEXT が **明示的に production** ならホストで覆さない
  if (String(ctx || '') === 'production') return { nonProd: false, via: 'CONTEXT:production' };
  // ここへ来るのは CONTEXT が未設定・空・未知値のときだけ。ホストを補助信号にする。
  const h = String(host || '').toLowerCase().split(':')[0];
  if (/^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/.test(h)) return { nonProd: true, via: 'host:deploy-preview' };
  if (/^[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(h)) return { nonProd: true, via: 'host:branch-deploy' };
  if (h === 'localhost' || h.startsWith('127.0.0.1')) return { nonProd: true, via: 'host:local' };
  return { nonProd: false, via: 'production' };
}

export function checkCanaryIsolation(env = {}, host = '') {
  const ctx = resolveNonProduction(env, host);
  if (!ctx.nonProd) return { ok: false, code: 'production_context', via: ctx.via };
  const url = env[CANARY_REDIS_URL_ENV];
  const token = env[CANARY_REDIS_TOKEN_ENV];
  if (!url || !token) return { ok: false, code: 'canary_redis_not_configured' };
  const prodUrl = env[PROD_REDIS_URL_ENV];
  if (prodUrl && String(prodUrl) === String(url)) return { ok: false, code: 'canary_points_at_production', via: ctx.via };
  return { ok: true, code: null, via: ctx.via };
}

/** Upstash REST。**URL / token をレスポンスにもログにも出さない** */
async function redisCmd(args, host) {
  const iso = checkCanaryIsolation(process.env, host);
  if (!iso.ok) throw new Error(`canary_isolation_${iso.code}`);
  const url = process.env[CANARY_REDIS_URL_ENV];
  const token = process.env[CANARY_REDIS_TOKEN_ENV];
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
async function handleRun({ req, now, host }) {
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
  try { runner = createCanaryRunner({ cmd: (a) => redisCmd(a, host), canaryId }); }
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

    // Phase 2: SAVE_FENCED_LUA を実 Redis で検証する。
    // fake は識別子で分岐して意味論を再現しているだけなので、**Lua 本文が
    // Upstash 上で本当に同じ判定をするか**はここでしか確かめられない。
    const p2 = await runPhase2({ runner, lua: LUA, now });
    out.phase2 = { ok: p2.ok, checks: p2.checks };

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
    out.ok = p0.ok && p1.ok && p2.ok && clean.remaining === 0;
    out.notice = out.ok
      ? 'Phase 0 / 1 / 2 すべて通過。canary データキーは削除済み（実行済みマーカーのみ TTL 付きで残ります）。'
      : '未達があります。本実行へ進まないでください。';
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
async function handleStatus({ req, host }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let runner;
  try { runner = createCanaryRunner({ cmd: (a) => redisCmd(a, host), canaryId }); }
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
async function handleFinalize({ req, host }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  if (String(req.confirmation || '').trim() !== buildFinalizeConfirmation(canaryId)) {
    return json(409, {
      error: 'finalize の確認文字列が一致しません。', code: CANARY_STOP.CONFIRMATION_MISMATCH,
      confirmationPhrase: buildFinalizeConfirmation(canaryId),
    });
  }
  let runner;
  try { runner = createCanaryRunner({ cmd: (a) => redisCmd(a, host), canaryId }); }
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

async function handleCleanup({ req, host }) {
  const canaryId = String(req.canaryId || '').trim();
  if (!isValidCanaryId(canaryId)) return json(400, { error: 'canaryId の形式が不正です。' });
  let runner;
  try { runner = createCanaryRunner({ cmd: (a) => redisCmd(a, host), canaryId }); }
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

  // ⚠️ 既定は無効。env が無ければ**常時 403**（使い終わったら env を消すだけで無効化できる）
  if (process.env.CUSTOMER_IMPORT_CANARY_ENABLED !== 'true') {
    return json(403, { error: 'canary は無効です（CUSTOMER_IMPORT_CANARY_ENABLED）。', code: 'canary_disabled' });
  }

  // ⚠️ **隔離の最終ガード**。production context / 本番 Redis を指す設定では 1 コマンドも送らない。
  const reqHost = event.headers?.host || event.headers?.Host || '';
  const isolation = checkCanaryIsolation(process.env, reqHost);
  if (!isolation.ok) {
    return json(403, {
      error: 'canary は非本番 context の専用 Redis でのみ実行できます。',
      code: isolation.code,
      via: isolation.via,
    });
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
    if (action === 'run') return await handleRun({ req, now, host: reqHost });
    if (action === 'status') return await handleStatus({ req, host: reqHost });
    if (action === 'cleanup') return await handleCleanup({ req, host: reqHost });
    if (action === 'finalize') return await handleFinalize({ req, host: reqHost });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外の中身をそのまま返さない（URL / token が混ざりうる）
    console.error('❌ [redis-canary] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
