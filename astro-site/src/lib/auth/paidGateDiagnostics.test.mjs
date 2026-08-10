/**
 * paidGateDiagnostics.test.mjs — 認可失敗の診断ログが「reason コードだけ」を出すことを固定する
 *   node --test src/lib/auth/paidGateDiagnostics.test.mjs
 *
 * 2026-08-08 の障害では、Airtable の一時障害で有効会員が締め出されていたのに
 * **本番で観測する手段が無かった**（paidPageGate に console.* が 0 件）。
 * 再発と復旧を確認できるようにする。ただし顧客を特定しうる情報は一切出さない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { gatePaidPage } from './paidPageGate.js';
import { LOGGED_DENY_REASONS, PAID_GATE_LOG_TAG, logPaidGateDeny } from '../observability/paidGateLog.js';

const GATE = fileURLToPath(new URL('./paidPageGate.js', import.meta.url));
const LOG = fileURLToPath(new URL('../observability/paidGateLog.js', import.meta.url));
const gateCode = readFileSync(GATE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = readFileSync(LOG, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function capture(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  return Promise.resolve(fn()).finally(() => { console.warn = orig; }).then(() => lines);
}

const env = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b', SESSION_SIGNING_SECRET: 'x'.repeat(48) };
const req = (cookie) => ({ headers: { get: (h) => (String(h).toLowerCase() === 'cookie' ? (cookie || '') : null) } });

test('匿名アクセス（Cookie 無し）ではログを出さない（bot で埋もれさせない）', async () => {
  const lines = await capture(() => gatePaidPage({ request: req(''), requiredPlan: 'premium', env, now: 1 }));
  assert.deepEqual(lines, [], `匿名で出力された: ${lines.join(' / ')}`);
});

test('設定ミス（unknown_required_plan / env_missing）は出す', async () => {
  const a = await capture(() => gatePaidPage({ request: req(''), requiredPlan: '存在しない', env, now: 1 }));
  assert.equal(a.length, 1);
  assert.ok(a[0].includes('unknown_required_plan'));

  const b = await capture(() => gatePaidPage({ request: req(''), requiredPlan: 'premium', env: null, now: 1 }));
  assert.equal(b.length, 1);
  assert.ok(b[0].includes('env_missing'));
});

test('ログは 1 行 1 レコードで、目印と JSON だけ', async () => {
  const lines = await capture(() => gatePaidPage({ request: req(''), requiredPlan: '不明', env, now: 1 }));
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.startsWith(PAID_GATE_LOG_TAG), `目印が先頭にない: ${line}`);
  const json = JSON.parse(line.slice(PAID_GATE_LOG_TAG.length).trim());
  assert.deepEqual(Object.keys(json).sort(), ['reason', 'requiredPlan']);
});

test('ログに PII / 認証情報を含めない', async () => {
  const cookie = 'ak_session=SECRET_TOKEN_VALUE_123; other=x';
  const lines = await capture(() => gatePaidPage({
    request: req(cookie), requiredPlan: 'premium', env, now: 1,
    lookup: async () => ({ ok: false, reason: 'unavailable' }),
  }));
  const all = lines.join(' ');
  for (const bad of ['SECRET_TOKEN_VALUE_123', 'ak_session', '@', 'rec']) {
    assert.ok(!all.includes(bad), `ログに ${bad} が混ざっている: ${all}`);
  }
});

test('出力対象の reason は運用異常のみ（匿名系を含めない）', () => {
  for (const r of ['no_cookie', 'no_session', 'invalid_session', 'bad_signature', 'entitlement_denied']) {
    assert.ok(!LOGGED_DENY_REASONS.includes(r), `${r} を出力対象にしている（ノイズになる）`);
  }
  for (const r of ['lookup_unavailable', 'lookup_failed', 'customer_not_found']) {
    assert.ok(LOGGED_DENY_REASONS.includes(r), `${r} を出力対象にしていない（障害を観測できない）`);
  }
});

test('auth モジュール自身は標準出力へ書かない（既存 guard を弱めない）', () => {
  assert.doesNotMatch(gateCode, /console\s*\./,
    'paidPageGate に出力処理が戻っている（staticGuards が禁止している）');
  assert.match(gateCode, /logPaidGateDeny\(/, 'observability 側の関数を呼んでいない');
});

test('ログ関数は文字列 2 つしか受け取らない（オブジェクトを渡せない）', async () => {
  const lines = await capture(() => {
    logPaidGateDeny('lookup_unavailable', 'premium');
    logPaidGateDeny({ reason: 'lookup_unavailable', sub: 'recSECRET' }, 'premium');
  });
  assert.equal(lines.length, 1, 'オブジェクトを渡したものまで出力している');
  assert.ok(!lines[0].includes('recSECRET'));
});

test('未知の requiredPlan は other に丸める（自由文字列を出さない）', async () => {
  const lines = await capture(() => logPaidGateDeny('lookup_failed', 'user@example.com'));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('@'), `自由文字列が出ている: ${lines[0]}`);
  assert.ok(lines[0].includes('other'));
});

test('出力処理を detach して呼ばない（空ログ退行の予防）', () => {
  assert.doesNotMatch(code, /\?[^\n]*console\.(warn|log)\s*\)\s*\(/);
  assert.doesNotMatch(code, /=\s*console\.(warn|log)\s*[;,\n]/);
  assert.match(code, /console\.warn\(`\$\{PAID_GATE_LOG_TAG\}/, '目印付き 1 引数で呼んでいない');
});

test('ログ失敗で認可処理を止めない', async () => {
  const orig = console.warn;
  console.warn = () => { throw new Error('log sink down'); };
  try {
    const r = await gatePaidPage({ request: req(''), requiredPlan: '不明', env, now: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.response, 'ログ例外で response が返らなくなっている');
  } finally { console.warn = orig; }
});

test('認可の判定そのものは変えていない（fail closed 維持）', async () => {
  const r = await gatePaidPage({ request: req(''), requiredPlan: 'premium', env, now: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 302);
  // 2026-08-10: 遷移理由を非機微コードで伝えるため `?r=` が付く（行き先は /login のまま）。
  assert.equal(r.response.headers.get('location'), '/login/?r=no_session');
});
