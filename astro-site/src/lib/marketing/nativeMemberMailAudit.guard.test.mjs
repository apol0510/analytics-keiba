/**
 * `admin-marketing` の `nativeMailAudit` 配線の guard。
 *
 * - 既存の管理 secret 認可を**通ってから**分岐する（認可を弱めない）
 * - 認可なしでは外部へ 1 回も出ない
 * - この action は書き込み経路（履歴 POST / engagement 除外リストの書き込み / 送信）へ分岐しない
 * - 監査モジュールは書き込み系の I/O を持たない
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FN = read('../../../netlify/functions/admin-marketing.js');
const MOD = read('./nativeMemberMailAudit.js');

function handlerSource() {
  const start = FN.indexOf('async function handleNativeMailAudit(');
  assert.ok(start > 0, 'handleNativeMailAudit が無い');
  const end = FN.indexOf('\n}\n', start);
  return FN.slice(start, end + 2);
}

test('認可（x-admin-secret 照合）の後で分岐する', () => {
  const auth = FN.indexOf("if (provided !== SECRET) return json(403");
  const branch = FN.indexOf('if (action === NATIVE_AUDIT_ACTION)');
  assert.ok(auth > 0 && branch > 0);
  assert.ok(branch > auth, 'nativeMailAudit が認可より前で分岐している');
});

test('handler は監査モジュールへ依存を渡すだけ（書き込み経路を呼ばない）', () => {
  const src = handlerSource();
  for (const banned of [
    'fetchDeliveriesByEmails', 'loadCustomerMarketing', 'resolveEngagementView',
    'createEngagementBlocklistStore', 'fetchByRecordIds', 'patch', 'PATCH', "'POST'",
    'enqueue', 'dispatch', 'sendEmail', 'fetchAll(',
  ]) {
    assert.ok(!src.includes(banned), `handleNativeMailAudit に ${banned} がある`);
  }
  assert.match(src, /runNativeMailAudit\(/);
});

test('監査モジュールは書き込み系の I/O を持たない', () => {
  // HTTP method を指定する箇所は createReadOnlyFetch の判定だけ
  const methods = MOD.match(/method\s*:\s*['"][A-Z]+['"]/g) || [];
  assert.deepEqual(methods.filter((m) => !m.includes("'GET'")), [], `GET 以外の method 指定: ${methods}`);
  for (const banned of [/\.write\(/, /listRecords/, /['`]\/v3\/marketing\/contacts/, /\bPUT\b['"]/, /\bDELETE\b['"]/]) {
    assert.ok(!banned.test(MOD), `監査モジュールに ${banned} がある`);
  }
  // 素の fetch を直接呼ばない（必ず read-only ラッパー経由）
  assert.ok(!/[^.\w]fetch\(/.test(MOD.replace(/typeof fetch/g, '')), '素の fetch() を呼んでいる');
});

test('認可なし・誤った secret では外部へ出ずに 403', async () => {
  const prev = { ...process.env };
  const origFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('should not be called'); };
  try {
    process.env.MARKETING_ADMIN_SECRET = 'correct-secret-value-0123456789';
    process.env.AIRTABLE_API_KEY = 'x';
    process.env.AIRTABLE_BASE_ID = 'appX';
    const { handler } = await import('../../../netlify/functions/admin-marketing.js');
    const body = JSON.stringify({ action: 'nativeMailAudit', phase: 'baseline' });
    const noAuth = await handler({ httpMethod: 'POST', headers: {}, body });
    assert.equal(noAuth.statusCode, 403);
    const wrong = await handler({ httpMethod: 'POST', headers: { 'x-admin-secret': 'wrong' }, body });
    assert.equal(wrong.statusCode, 403);
    const get = await handler({ httpMethod: 'GET', headers: {}, body });
    assert.equal(get.statusCode, 405);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = origFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('クライアント script は nativeMailAudit だけを呼び、結果をファイルへ書かない', () => {
  const S = read('../../../scripts/native-mail-audit.mjs');
  assert.match(S, /const ACTION = 'nativeMailAudit';/);
  const actions = S.match(/action:\s*[^,}]+/g) || [];
  assert.deepEqual(actions, ['action: ACTION'], `action の指定: ${actions}`);
  assert.ok(!/writeFile|appendFile|createWriteStream|from 'node:fs'|require\('fs'\)/.test(S), 'ファイルへ書いている');
  // 変数 SECRET そのものを出力へ渡していない（env 名を案内する文字列は可）
  assert.ok(!/console\.(log|error)\([^)'"]*\bSECRET\b/.test(S), 'secret を出力している');
  assert.equal((S.match(/\bSECRET\b/g) || []).length, 3, 'SECRET の使用箇所は 定義・存在確認・ヘッダ の 3 つだけ');
  // 本番 URL は正本どおり（推測で生成しない）
  assert.match(S, /https:\/\/analytics\.keiba\.link\/\.netlify\/functions\/admin-marketing/);
});

// ─── 頻度上限の実効状況（事実の固定。**直さない**。直したらこのテストと FREQUENCY_POLICY_FACTS を更新する）──

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(m?js|ts|astro)$/.test(name) && !/\.test\.|\.guard\./.test(name)) out.push(p);
  }
  return out;
}

test('事実: 7 日 2 通 cap は recentSendAtMs を誰も渡さないため本番で効いていない', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const setters = [];
  for (const dir of ['src', 'netlify', 'scripts']) {
    for (const f of sourceFiles(join(root, dir))) {
      if (/sequencePolicy\.js$|nativeMemberMailAudit\.js$/.test(f)) continue;
      if (readFileSync(f, 'utf8').includes('recentSendAtMs')) setters.push(f.slice(root.length));
    }
  }
  assert.deepEqual(setters, [],
    'recentSendAtMs を渡す経路ができた＝cap が効き始める。FREQUENCY_POLICY_FACTS と progress の記録を更新すること');
});

test('事実: 24h 横断ガードの材料は CampaignDeliveries の campaign 行だけ（SendGrid MC 送信は入らない）', () => {
  const D = read('../../../netlify/functions/marketing-campaign-dispatch.js');
  const start = D.indexOf('function buildRecentContactMap(deliveries, excludeJobId)');
  assert.ok(start > 0);
  const body = D.slice(start, D.indexOf('\n}\n', start));
  assert.match(body, /f\.EmailType !== 'campaign'/);
  assert.match(body, /f\.RecipientEmail/);
});
