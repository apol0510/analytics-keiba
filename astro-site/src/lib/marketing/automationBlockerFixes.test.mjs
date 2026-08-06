/**
 * automationBlockerFixes.test.mjs — 導入前監査の blocker を再発させない
 *   node --test src/lib/marketing/automationBlockerFixes.test.mjs
 *
 * `docs/marketing-automation-preprod-audit.md` の A-1〜A-6 / B-1〜B-2 に 1 対 1 で対応する。
 * ⚠️ 実 Redis / 実 Airtable / 実送信は一切行わない（fake だけ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAutomationStore, DEF_FIELDS } from './automationStore.js';
import { transition, AUTOMATION_STATUS } from './automationModel.js';
import {
  isDue, detectDrift, DRIFT, verifySnapshotBeforeDispatch,
} from './automationScheduler.js';
import { createAutomationAdminApi, API_REJECT, pinCampaign } from './automationAdminApi.js';
import {
  readGates, authorizeInvocation, ARMED_ENV, CRON_SECRET_ENV, CRON_SECRET_HEADER,
} from '../../../netlify/functions/cron-marketing-automation.js';

const ADMIN_FN = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing-automation.js', import.meta.url)), 'utf8');
const UI = readFileSync(fileURLToPath(
  new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');

// ── fake Redis ────────────────────────────────────────────────

function fakeRedis(seed = {}) {
  const store = new Map(Object.entries(seed));
  const cmd = async (a) => {
    const [op, key] = a;
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'SET') { store.set(key, a[2]); return 'OK'; }
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'SADD') { const s = store.get(key) || new Set(); s.add(a[2]); store.set(key, s); return 1; }
    if (op === 'SREM') { const s = store.get(key); if (s) s.delete(a[2]); return 1; }
    if (op === 'SMEMBERS') { const s = store.get(key); return s ? [...s] : []; }
    if (op === 'EVAL') {
      const n = Number(a[2]); const keys = a.slice(3, 3 + n); const argv = a.slice(3 + n);
      const cur = store.get(keys[0]);
      if (!cur) { if (argv[1] === '') { store.set(keys[0], argv[0]); return 'OK'; } return 'MISSING'; }
      const m = /"configVersion":(\d+)/.exec(cur);
      if (!m || m[1] !== argv[1]) return 'CONFLICT';
      store.set(keys[0], argv[0]); return 'OK';
    }
    return 'OK';
  };
  return { cmd, store };
}

const NOW = Date.parse('2026-08-06T05:00:00.000Z');   // JST 14:00（静音時間外）

// ⚠️ campaign の版・本文はカタログが正本。固定文字列を書くと campaign_drift で
//    別の理由で落ち、検証したい条件に届かない。**実カタログから取る。**
const PINNED = pinCampaign('premium-renewal');

const def = (over = {}) => ({
  automationId: 'expiry-d7', presetId: 'expiry-d7', name: '期限前リマインド',
  status: 'DRAFT',
  campaignId: PINNED.campaignId, campaignVersion: PINNED.campaignVersion,
  shellVersion: PINNED.shellVersion, contentHash: PINNED.contentHash,
  schedule: 'daily', timezone: 'Asia/Tokyo', quietHours: { start: 21, end: 8 },
  maxRecipients: 100, trigger: { kind: 'days_before_expiry', days: 7 }, audience: {},
  createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
  configVersion: 1, lastRunAt: null, nextRunAt: null,
  snapshotFingerprint: 'fp1', snapshotCount: 42, snapshotOccurrenceDate: '2026-08-06',
  ...over,
});

// ── A-1: enabled の永続化 ─────────────────────────────────────

test('A-1: ACTIVE 化した Definition は保存・読み戻し後も due になる', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const t = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-06T00:00:00.000Z' });
  await s.saveDefinition({ definition: t.definition, expectedVersion: '' });

  const back = await s.loadDefinition('expiry-d7');
  assert.equal(back.status, 'ACTIVE');
  assert.equal(back.enabled, true, 'enabled が保存・復元されていない');
  assert.deepEqual(isDue({ definition: back, nowMs: NOW }), {
    due: true, reason: null, occurrenceDate: '2026-08-06',
  });
});

test('A-1: enabled は DEF_FIELDS に含まれ、status から導出し直される', async () => {
  assert.ok(DEF_FIELDS.includes('enabled'));
  // 保存時に enabled=true でも status が ACTIVE でなければ読み戻しで false（食い違わせない）
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def({ status: 'PAUSED', enabled: true }), expectedVersion: '' });
  const back = await s.loadDefinition('expiry-d7');
  assert.equal(back.enabled, false, 'status と enabled が食い違ったまま返った');
  assert.equal(isDue({ definition: back, nowMs: NOW }).reason, 'not_active');
});

// ── A-2: snapshotCount の永続化と drift 判定 ───────────────────

test('A-2: snapshotCount / 暦日が保存され、対象が減っても snapshot_grew にならない', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def(), expectedVersion: '' });
  const back = await s.loadDefinition('expiry-d7');
  assert.equal(back.snapshotCount, 42);
  assert.equal(back.snapshotOccurrenceDate, '2026-08-06');

  const same = detectDrift({
    dryRun: back,
    current: { snapshotFingerprint: 'fp1', snapshotCount: 40, campaignVersion: PINNED.campaignVersion, contentHash: PINNED.contentHash, occurrenceDate: '2026-08-06' },
  });
  assert.equal(same.drifts.includes(DRIFT.SNAPSHOT_GREW), false, '減っているのに増加扱い');
});

test('A-2: 承認済み snapshot が無ければ件数比較へ進まず snapshot_missing', () => {
  const d = detectDrift({ dryRun: { campaignVersion: PINNED.campaignVersion }, current: { snapshotCount: 5 } });
  assert.deepEqual(d, { ok: false, drifts: [DRIFT.SNAPSHOT_MISSING] });
});

// ── A-3: 実行直前の指紋照合 ───────────────────────────────────

test('A-3: 件数が同じでも中身が入れ替わっていれば実行前に止まる', () => {
  const base = {
    definition: def(), currentCount: 42, occurrenceDate: '2026-08-06',
    currentCampaignVersion: PINNED.campaignVersion, currentContentHash: PINNED.contentHash,
  };
  assert.equal(verifySnapshotBeforeDispatch({ ...base, currentFingerprint: 'fp1' }).ok, true);

  const swapped = verifySnapshotBeforeDispatch({ ...base, currentFingerprint: 'fp-OTHER' });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, DRIFT.SNAPSHOT_FINGERPRINT_CHANGED);
});

test('A-3: 承認した暦日と違う日に実行しようとしたら止まる', () => {
  const v = verifySnapshotBeforeDispatch({
    definition: def(), currentFingerprint: 'fp1', currentCount: 42,
    currentCampaignVersion: PINNED.campaignVersion, currentContentHash: PINNED.contentHash, occurrenceDate: '2026-08-07',
  });
  assert.equal(v.ok, false);
  assert.ok(v.drifts.includes(DRIFT.SNAPSHOT_STALE));
});

test('A-3: snapshot 未承認・campaign 変更でも実行前に止まる（fail-closed）', () => {
  assert.equal(verifySnapshotBeforeDispatch({
    definition: def({ snapshotFingerprint: null, snapshotCount: null }),
    currentFingerprint: 'fp1', currentCount: 42, occurrenceDate: '2026-08-06',
  }).reason, DRIFT.SNAPSHOT_MISSING);

  assert.ok(verifySnapshotBeforeDispatch({
    definition: def(), currentFingerprint: 'fp1', currentCount: 42,
    currentCampaignVersion: '999', currentContentHash: 'zzz', occurrenceDate: '2026-08-06',
  }).drifts.includes(DRIFT.CAMPAIGN_VERSION_CHANGED));
});

// ── A-4 / B-2 / dry-run と保存と実行の一致 ────────────────────

const cust = (email) => ({
  id: email,
  fields: {
    'メールアドレス': email, Email: email, 'プラン': 'Premium', PlanType: 'Annual',
    Status: 'active', '有効期限': '2026-08-13',
  },
});
const CUSTOMERS = [cust('a@example.invalid'), cust('b@example.invalid')];

function makeApi({ redis, env = { MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED: 'true' }, customers = CUSTOMERS }) {
  return createAutomationAdminApi({
    store: createAutomationStore({ cmd: redis.cmd }), env, now: () => NOW,
    loadCustomers: async () => customers,
    loadBlacklist: async () => new Set(),
  });
}

test('A-4: ACTIVE のまま update できない（PAUSED を経由させる）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  const t = transition({ definition: def(), to: AUTOMATION_STATUS.ACTIVE, nowIso: '2026-08-06T00:00:00.000Z' });
  await s.saveDefinition({ definition: t.definition, expectedVersion: '' });

  const api = makeApi({ redis: r });
  const res = await api.update({
    automationId: 'expiry-d7', expectedVersion: '1',
    overrides: { trigger: { kind: 'days_before_expiry', days: 90 } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, API_REJECT.ACTIVE_LOCKED);

  // 保存内容が書き換わっていない
  const after = await s.loadDefinition('expiry-d7');
  assert.equal(after.trigger.days, 7, 'ACTIVE のまま条件が書き換わった');
  assert.equal(after.snapshotFingerprint, 'fp1');
});

test('A-4: PAUSED で update すると承認済み snapshot が破棄される', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def({ status: 'PAUSED' }), expectedVersion: '' });

  const api = makeApi({ redis: r });
  const res = await api.update({
    automationId: 'expiry-d7', expectedVersion: '1',
    overrides: { trigger: { kind: 'days_before_expiry', days: 30 } },
  });
  assert.equal(res.ok, true);
  const after = await s.loadDefinition('expiry-d7');
  assert.equal(after.trigger.days, 30);
  assert.equal(after.snapshotFingerprint, null, '古い承認済み snapshot が残っている');
  assert.equal(after.snapshotCount, null);
});

test('B-2: preview は保存済み設定を基準にする（preset で代用しない）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def({ status: 'PAUSED', maxRecipients: 7 }), expectedVersion: '' });

  const api = makeApi({ redis: r });
  const out = await api.preview({ automationId: 'expiry-d7' });
  assert.equal(out.ok, true);
  assert.equal(out['基準'], 'saved');
  assert.equal(out['上限'], 7, '保存済みの上限が反映されていない');
  assert.equal(out.configVersion, 1);
  assert.equal(out.status, 'PAUSED');
});

test('B-2: 保存済みが無いときだけ preset を基準にする', async () => {
  const r = fakeRedis();
  const api = makeApi({ redis: r });
  const out = await api.preview({ automationId: 'expiry-d7' });
  assert.equal(out.ok, true);
  assert.equal(out['基準'], 'preset');
});

test('dry-run と ACTIVE 化で同じ対象集合を使う（申告した指紋は再計算と一致が必要）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def({ status: 'DRAFT', snapshotFingerprint: null, snapshotCount: null, snapshotOccurrenceDate: null }), expectedVersion: '' });
  const api = makeApi({ redis: r });

  const pv = await api.preview({ automationId: 'expiry-d7' });
  assert.equal(pv.ok, true);

  // 偽の指紋では通らない
  const bad = await api.activate({ automationId: 'expiry-d7', expectedVersion: '1', snapshotFingerprint: 'deadbeef' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, API_REJECT.SNAPSHOT_MISMATCH);
  assert.equal((await s.loadDefinition('expiry-d7')).status, 'DRAFT', '不一致なのに ACTIVE 化された');

  // dry-run の指紋なら通り、件数と暦日まで保存される
  const ok = await api.activate({ automationId: 'expiry-d7', expectedVersion: '1', snapshotFingerprint: pv.snapshotFingerprint });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const saved = await s.loadDefinition('expiry-d7');
  assert.equal(saved.status, 'ACTIVE');
  assert.equal(saved.enabled, true);
  assert.equal(saved.snapshotFingerprint, pv.snapshotFingerprint);
  assert.equal(saved.snapshotCount, pv.snapshotCount);
  assert.equal(saved.snapshotOccurrenceDate, pv.occurrenceDate);

  // 実行直前の照合も同じ値で通る
  assert.equal(verifySnapshotBeforeDispatch({
    definition: saved, currentFingerprint: pv.snapshotFingerprint, currentCount: pv.snapshotCount,
    currentCampaignVersion: saved.campaignVersion, currentContentHash: saved.contentHash,
    occurrenceDate: pv.occurrenceDate,
  }).ok, true);
});

test('ACTIVE 化の申告が対象集合の変化後なら通らない（顧客が増えた場合）', async () => {
  const r = fakeRedis();
  const s = createAutomationStore({ cmd: r.cmd });
  await s.saveDefinition({ definition: def({ status: 'DRAFT', snapshotFingerprint: null, snapshotCount: null, snapshotOccurrenceDate: null }), expectedVersion: '' });

  const pv = await makeApi({ redis: r }).preview({ automationId: 'expiry-d7' });
  // dry-run 後に対象が 1 件増えた状態で承認しようとする
  const grown = makeApi({
    redis: r,
    customers: [...CUSTOMERS, cust('c@example.invalid')],
  });
  const res = await grown.activate({ automationId: 'expiry-d7', expectedVersion: '1', snapshotFingerprint: pv.snapshotFingerprint });
  assert.equal(res.ok, false);
  assert.equal(res.code, API_REJECT.SNAPSHOT_MISMATCH);
  assert.equal((await s.loadDefinition('expiry-d7')).status, 'DRAFT');
});

// ── A-5: cron の認可 ──────────────────────────────────────────

test('A-5: cron は全呼び出しで専用 secret を要求する', () => {
  const env = { [CRON_SECRET_ENV]: 'cron-sec' };
  assert.equal(authorizeInvocation({ event: { headers: {} }, env }).code, 'forbidden');
  assert.equal(authorizeInvocation({ event: { headers: { [CRON_SECRET_HEADER]: 'wrong' } }, env }).code, 'forbidden');
  // 長さ違いでも落ちずに false
  assert.equal(authorizeInvocation({ event: { headers: { [CRON_SECRET_HEADER]: 'x' } }, env }).ok, false);
  const ok = authorizeInvocation({ event: { headers: { [CRON_SECRET_HEADER]: 'cron-sec' } }, env });
  assert.equal(ok.ok, true);
  assert.equal(ok.via, 'secret');
  // secret 未設定なら誰も実行できない（fail-closed）
  assert.equal(authorizeInvocation({
    event: { headers: { [CRON_SECRET_HEADER]: 'cron-sec' } }, env: {},
  }).code, 'secret_not_configured');
});

test('A-5: 詐称された schedule ヘッダでは通らない', () => {
  const env = { [CRON_SECRET_ENV]: 'cron-sec' };
  // ⚠️ 呼び出し元が自称する印は認証根拠にしない
  for (const ev of [
    { headers: { 'x-netlify-event': 'schedule' } },
    { headers: { 'X-Netlify-Event': 'SCHEDULE' } },
    { headers: { 'x-netlify-event': 'schedule', 'user-agent': 'Netlify' } },
    { headers: {}, isScheduled: true },
    { headers: { 'x-netlify-event': 'schedule' }, isScheduled: true },
    { headers: { 'x-netlify-event': 'schedule', [CRON_SECRET_HEADER]: 'wrong' } },
  ]) {
    const r = authorizeInvocation({ event: ev, env });
    assert.equal(r.ok, false, `詐称ヘッダで通った: ${JSON.stringify(ev)}`);
    assert.equal(r.code, 'forbidden');
  }
  // 正しい secret があれば、schedule ヘッダの有無に関係なく通る
  assert.equal(authorizeInvocation({
    event: { headers: { 'x-netlify-event': 'schedule', [CRON_SECRET_HEADER]: 'cron-sec' } }, env,
  }).ok, true);
});

test('A-5: 管理画面の secret では cron を起動できない（鍵を共用しない）', () => {
  const env = {
    [CRON_SECRET_ENV]: 'cron-sec',
    PREMIUM_PLUS_ADMIN_SECRET: 'admin-sec', MARKETING_ADMIN_SECRET: 'mk-sec',
  };
  for (const h of [
    { 'x-admin-secret': 'admin-sec' },
    { 'x-admin-secret': 'mk-sec' },
    { [CRON_SECRET_HEADER]: 'admin-sec' },
    { [CRON_SECRET_HEADER]: 'mk-sec' },
  ]) {
    assert.equal(authorizeInvocation({ event: { headers: h }, env }).ok, false,
      `管理 secret で通った: ${JSON.stringify(h)}`);
  }
  // 専用 env が無ければ他の secret へフォールバックしない
  assert.equal(authorizeInvocation({
    event: { headers: { 'x-admin-secret': 'admin-sec' } },
    env: { PREMIUM_PLUS_ADMIN_SECRET: 'admin-sec', MARKETING_ADMIN_SECRET: 'mk-sec' },
  }).code, 'secret_not_configured');
});

test('A-5: 認証コードは他 secret を参照していない（構造）', () => {
  const CRON = readFileSync(fileURLToPath(
    new URL('../../../netlify/functions/cron-marketing-automation.js', import.meta.url)), 'utf8');
  // コメントを除いた実コードだけを見る（禁止語が説明文に出るのは許す）
  const code = CRON.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const fn = code.slice(code.indexOf('export function authorizeInvocation'),
    code.indexOf('function redisCmd'));
  for (const bad of ['PREMIUM_PLUS_ADMIN_SECRET', 'MARKETING_ADMIN_SECRET',
    'x-netlify-event', 'isScheduled', 'x-admin-secret']) {
    assert.equal(fn.includes(bad), false, `${bad} を認証根拠にしている`);
    // ファイル全体でも、実コードとしては参照しない
    assert.equal(code.includes(bad), false, `${bad} を実コードで参照している`);
  }
  // 一定時間比較を使う
  assert.match(code, /timingSafeEqual/);
  assert.match(code, /CRON_SECRET_ENV = 'MARKETING_AUTOMATION_CRON_SECRET'/);
});

test('A-5: handler は認可前に Redis へ接続しない', async () => {
  const { handler } = await import('../../../netlify/functions/cron-marketing-automation.js');
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[CRON_SECRET_ENV] = 'cron-sec';
  process.env.MARKETING_AUTOMATION_SCHEDULER_ENABLED = 'true';
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  try {
    // 無認証
    const res = await handler({ headers: {} });
    assert.equal(res.statusCode, 403);
    // ⚠️ 詐称された schedule ヘッダでも接続しない
    const spoof = await handler({ headers: { 'x-netlify-event': 'schedule' }, isScheduled: true });
    assert.equal(spoof.statusCode, 403);
    // ⚠️ 管理画面の secret でも通らない
    const wrongKey = await handler({ headers: { 'x-admin-secret': 'sec' } });
    assert.equal(wrongKey.statusCode, 403);
    assert.equal(calls, 0, '無認証・詐称なのに接続した');
    // ゲートの設定状況も出さない
    for (const r of [res, spoof, wrongKey]) {
      assert.equal(String(r.body).includes('MARKETING_CAMPAIGN_ENABLED'), false);
    }

    // 専用 secret 未設定なら 503（Redis へは触れない）
    delete process.env[CRON_SECRET_ENV];
    const unset = await handler({ headers: { [CRON_SECRET_HEADER]: 'cron-sec' } });
    assert.equal(unset.statusCode, 503);
    assert.equal(JSON.parse(unset.body).reason, 'secret_not_configured');
    assert.equal(calls, 0, 'secret 未設定なのに接続した');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

// ── A-6: 単一 env 依存にしない ────────────────────────────────

test('A-6: 既存 2 env が true でも、自動化専用ゲート 2 つが揃わなければ開かない', () => {
  const base = { MARKETING_CAMPAIGN_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' };
  // scheduler だけ開けても駄目（当日武装が要る）
  const g1 = readGates({ ...base, MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true' }, NOW);
  assert.equal(g1.allOpen, false);
  assert.ok(g1.missing.some((m) => m.startsWith(ARMED_ENV)));

  // 武装だけでも駄目
  assert.equal(readGates({ ...base, [ARMED_ENV]: '2026-08-06' }, NOW).allOpen, false);

  // 両方揃って初めて開く
  assert.equal(readGates({
    ...base, MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true', [ARMED_ENV]: '2026-08-06',
  }, NOW).allOpen, true);
});

test('A-6: 当日武装は日付が変わると自動的に閉じる', () => {
  const env = {
    MARKETING_CAMPAIGN_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
    MARKETING_AUTOMATION_SCHEDULER_ENABLED: 'true', [ARMED_ENV]: '2026-08-06',
  };
  assert.equal(readGates(env, NOW).allOpen, true);
  // 翌日
  assert.equal(readGates(env, NOW + 24 * 60 * 60 * 1000).allOpen, false);
});

// ── B-1: 顧客一覧の打ち切り ───────────────────────────────────

test('B-1: 顧客一覧はページ上限に達したら黙って打ち切らず失敗する', async () => {
  const { handler } = await import('../../../netlify/functions/admin-marketing-automation.js');
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  // offset を永遠に返す = 何ページ取っても終わらない
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.airtable.com')) {
      return { ok: true, json: async () => ({ records: [{ id: 'r', fields: {} }], offset: 'next' }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env.AIRTABLE_API_KEY = 'k'; process.env.AIRTABLE_BASE_ID = 'b';
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'preview', automationId: 'expiry-d7' }),
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 503);
    assert.equal(body.code, 'customers_truncated');
    assert.equal(body.sideEffects, 'none');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('B-1: 打ち切りコードは黙って握りつぶされない', () => {
  assert.match(ADMIN_FN, /CustomerFetchTruncatedError/);
  assert.equal(/if \(offset && pages >= MAX_PAGES\) break;/.test(ADMIN_FN), false, 'break で黙って打ち切っている');
});

// ── C-1: UI の write 連動 ─────────────────────────────────────

test('C-1: UI は writeEnabled と連動し、初期は disabled', () => {
  for (const id of ['autoSave', 'autoActivate', 'autoPause', 'autoCancel']) {
    const m = new RegExp(`id="${id}"[^>]*disabled`).test(UI);
    assert.ok(m, `${id} の初期状態が disabled でない`);
  }
  assert.match(UI, /function autoApplyWriteGate\(enabled\)/);
  // どの応答でも反映し直す
  assert.match(UI, /typeof data\.writeEnabled === 'boolean'\) autoApplyWriteGate\(data\.writeEnabled\)/);
  // 拒否されたら閉じる
  assert.match(UI, /data\.code === 'write_blocked'\) autoApplyWriteGate\(false\)/);
});

test('C-1: configVersion を固定値で送らない / snapshot 無しで ACTIVE 化しない', () => {
  assert.equal(/expectedVersion: '1'/.test(UI), false, 'configVersion が固定値のまま');
  assert.match(UI, /const autoExpected = \(\) => String\(autoVersion \?\? ''\)/);
  assert.match(UI, /if \(!autoSnapshot\)/);
  assert.match(UI, /function autoInvalidateSnapshot\(\)/);
});
