/**
 * importCanaryIsolation.guard.test.mjs — canary が本番 Redis / production context へ
 * 到達し得ないことを構造的に固定する
 *   node --test src/lib/crm/importCanaryIsolation.guard.test.mjs
 *
 * 方針（2026-08-08 決定）:
 *   canary は **AK 本番 Redis から完全に分離した専用 Upstash** で実行する。
 *   そのため canary 専用の env 名（`CANARY_UPSTASH_*`）だけを接続に使い、
 *   本番の env 名（`UPSTASH_*`）は「一致していないか」の検査にしか使わない。
 *   env の入れ先を間違えても**構造的に本番へ到達できない**ようにする。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  checkCanaryIsolation, CANARY_REDIS_URL_ENV, CANARY_REDIS_TOKEN_ENV,
} from '../../../netlify/functions/admin-customer-import-redis-canary.js';

const FN = fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-redis-canary.js', import.meta.url));
const raw = readFileSync(FN, 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ok = { CONTEXT: 'deploy-preview', [CANARY_REDIS_URL_ENV]: 'https://canary.invalid', [CANARY_REDIS_TOKEN_ENV]: 't' };

// ── 1. context ────────────────────────────────────────────────
test('production context では実行できない', () => {
  const r = checkCanaryIsolation({ ...ok, CONTEXT: 'production' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'production_context');
});

test('CONTEXT 未設定・空・未知値は本番扱いで拒否（fail closed）', () => {
  for (const CONTEXT of [undefined, '', 'unknown', 'prod', null]) {
    const r = checkCanaryIsolation({ ...ok, CONTEXT });
    assert.equal(r.ok, false, `CONTEXT=${String(CONTEXT)} を通してはいけない`);
    assert.equal(r.code, 'production_context');
  }
});

test('非本番 context では実行できる', () => {
  for (const CONTEXT of ['deploy-preview', 'branch-deploy', 'dev']) {
    const r = checkCanaryIsolation({ ...ok, CONTEXT });
    assert.equal(r.ok, true, `CONTEXT=${CONTEXT} が拒否された: ${r.code}`);
  }
});

// ── 2. 認証情報 ───────────────────────────────────────────────
test('canary 専用 env が無ければ実行できない', () => {
  for (const drop of [CANARY_REDIS_URL_ENV, CANARY_REDIS_TOKEN_ENV]) {
    const env = { ...ok }; delete env[drop];
    const r = checkCanaryIsolation(env);
    assert.equal(r.ok, false, `${drop} 欠落を通してはいけない`);
    assert.equal(r.code, 'canary_redis_not_configured');
  }
});

test('本番 Redis の env があっても、それだけでは実行できない（名前が違う）', () => {
  const r = checkCanaryIsolation({
    CONTEXT: 'deploy-preview',
    UPSTASH_REDIS_REST_URL: 'https://prod.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'prod-token',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'canary_redis_not_configured');
});

test('canary の URL が本番の URL と一致していたら拒否（貼り間違いの検知）', () => {
  const r = checkCanaryIsolation({
    CONTEXT: 'deploy-preview',
    [CANARY_REDIS_URL_ENV]: 'https://same.invalid',
    [CANARY_REDIS_TOKEN_ENV]: 't',
    UPSTASH_REDIS_REST_URL: 'https://same.invalid',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'canary_points_at_production');
});

// ── 3. 構造ガード（コードそのものを固定する）─────────────────
test('接続に本番 Redis の env 名を使っていない', () => {
  // 許されるのは「一致検査のための定数宣言」と「その定数経由の読み出し」だけ。
  const direct = code.match(/process\s*\.\s*env\s*\.\s*UPSTASH_REDIS_REST_(URL|TOKEN)/g) || [];
  assert.deepEqual(direct, [], `本番 env を直接読んでいる: ${direct.join(', ')}`);
  const bracket = code.match(/process\s*\.\s*env\s*\[\s*['"]UPSTASH_REDIS_REST_(URL|TOKEN)['"]\s*\]/g) || [];
  assert.deepEqual(bracket, [], `本番 env をブラケットで読んでいる: ${bracket.join(', ')}`);
  // token は一致検査にも使わない（URL だけで十分。token を触る理由が無い）
  assert.doesNotMatch(code, /UPSTASH_REDIS_REST_TOKEN['"]\s*\]/,
    '本番 token を参照している');
});

test('接続は canary 専用 env からのみ読む', () => {
  assert.match(code, /process\s*\.\s*env\s*\[\s*CANARY_REDIS_URL_ENV\s*\]/);
  assert.match(code, /process\s*\.\s*env\s*\[\s*CANARY_REDIS_TOKEN_ENV\s*\]/);
});

test('Redis へ 1 コマンド送る前に隔離チェックを通す', () => {
  const i = code.indexOf('async function redisCmd');
  assert.ok(i > -1, 'redisCmd が見つからない');
  const body = code.slice(i, i + 700);
  const gate = body.indexOf('checkCanaryIsolation');
  const fetchAt = body.indexOf('fetch(');
  assert.ok(gate > -1, 'redisCmd 内で隔離チェックをしていない');
  assert.ok(gate < fetchAt, '隔離チェックより先に fetch している');
});

test('ハンドラ側でも Redis 到達前に 403 で断る', () => {
  const enabled = code.indexOf('CUSTOMER_IMPORT_CANARY_ENABLED');
  const iso = code.indexOf('checkCanaryIsolation(process.env)', enabled);
  assert.ok(iso > enabled, '有効化ゲートの直後に隔離チェックが無い');
});

test('URL / token を応答にもログにも出さない', () => {
  // ログに認証情報そのものを流していない
  assert.doesNotMatch(code, /console\.(log|warn|error)\([^)]*\b(url|token)\b\s*[,)]/,
    'ログへ url / token を渡している');
  // json(...) の第 2 引数へ url / token をそのまま入れていない
  assert.doesNotMatch(code, /json\(\s*\d+\s*,\s*\{[^}]*\b(url|token)\s*[,:}]/,
    '応答に url / token を含めている');
});
