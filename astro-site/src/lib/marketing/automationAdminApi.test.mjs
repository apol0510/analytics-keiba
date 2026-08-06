/**
 * automationAdminApi.test.mjs — 管理 API の write ゲート・CAS・遷移・整合を固定する
 *   node --test src/lib/marketing/automationAdminApi.test.mjs
 *
 * ⚠️ **本番 Redis / Airtable / メールへ 1 回も出ない。** fake だけで全経路を通す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createAutomationAdminApi, isWriteEnabled, pinCampaign, checkCampaignDrift,
  WRITE_ACTIONS, READ_ACTIONS, WRITE_GATE_ENV, API_REJECT,
} from './automationAdminApi.js';
import { createAutomationStore } from './automationStore.js';
import { AUTOMATION_STATUS } from './automationModel.js';
import { CAMPAIGNS } from './campaignCatalog.js';

const NOW = Date.parse('2026-08-06T03:00:00.000Z');
const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-marketing-automation.js', import.meta.url)), 'utf8');
const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const TOML = readFileSync(
  fileURLToPath(new URL('../../../netlify.toml', import.meta.url)), 'utf8');

function fakeRedis() {
  const store = new Map();
  const cmd = async (args) => {
    const [op, key] = args;
    if (op === 'INCR') { const n = Number(store.get(key) || 0) + 1; store.set(key, String(n)); return n; }
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'SADD') { const s = store.get(key) || new Set(); s.add(args[2]); store.set(key, s); return 1; }
    if (op === 'SREM') { const s = store.get(key); if (s) s.delete(args[2]); return 1; }
    if (op === 'SMEMBERS') { const s = store.get(key); return s ? [...s] : []; }
    if (op === 'SET') { if (args.includes('NX') && store.has(key)) return null; store.set(key, args[2]); return 'OK'; }
    if (op === 'EVAL') {
      const script = args[1]; const n = Number(args[2]);
      const keys = args.slice(3, 3 + n); const argv = args.slice(3 + n);
      if (script.includes('configVersion')) {
        const cur = store.get(keys[0]);
        if (!cur) { if (argv[1] === '') { store.set(keys[0], argv[0]); return 'OK'; } return 'MISSING'; }
        const m = /"configVersion":(\d+)/.exec(cur);
        if (!m || m[1] !== argv[1]) return 'CONFLICT';
        store.set(keys[0], argv[0]); return 'OK';
      }
      const cur = store.get(keys[0]);
      if (!cur) return 'LOST';
      return cur === argv[0] ? 'OK' : 'STOLEN';
    }
    throw new Error('unsupported ' + op);
  };
  return { cmd, store };
}

const mkApi = (over = {}) => {
  const r = fakeRedis();
  const api = createAutomationAdminApi({
    store: createAutomationStore({ cmd: r.cmd }),
    env: { [WRITE_GATE_ENV]: 'true' },
    now: () => NOW,
    loadCustomers: async () => [],
    loadBlacklist: async () => new Set(),
    ...over,
  });
  return { api, redis: r };
};

const usableCampaign = CAMPAIGNS.find((c) => c.campaignId === 'expired-comeback') || CAMPAIGNS[0];

// ── write ゲート ──────────────────────────────────────────────

test('write ゲートは既定で閉じている', () => {
  assert.equal(isWriteEnabled({}), false);
  assert.equal(isWriteEnabled({ [WRITE_GATE_ENV]: 'false' }), false);
  assert.equal(isWriteEnabled({ [WRITE_GATE_ENV]: 'true' }), true);
});

test('write action と read action の分類が仕様どおり', () => {
  assert.deepEqual([...WRITE_ACTIONS].sort(), ['activate', 'cancel', 'create', 'pause', 'update']);
  for (const a of ['list', 'get', 'preview', 'runs', 'status']) assert.ok(READ_ACTIONS.includes(a));
});

test('handler: write env 未設定なら Redis 初期化より前に 403（接続 0）', async () => {
  const { handler } = await import('../../../netlify/functions/admin-marketing-automation.js');
  const prevFetch = globalThis.fetch;
  const prev = { ...process.env };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env.AIRTABLE_API_KEY = 'k'; process.env.AIRTABLE_BASE_ID = 'b';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  delete process.env[WRITE_GATE_ENV];
  try {
    for (const action of WRITE_ACTIONS) {
      const res = await handler({
        httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
        body: JSON.stringify({ action, automationId: 'expiry-d7', presetId: 'expiry-d7' }),
      });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 403, `${action} が通ってしまう`);
      assert.equal(body.code, 'write_blocked');
      assert.deepEqual(body.接続, { redis: false, airtable: false });
    }
    assert.equal(calls, 0, 'ゲート閉なのに接続した');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('guard: write ゲートは store 初期化より前にある', () => {
  const gateAt = FN.indexOf('WRITE_ACTIONS.includes(action)');
  const storeAt = FN.indexOf('createAutomationStore({ cmd: redisCmd })');
  assert.ok(gateAt > -1 && gateAt < storeAt, 'ゲートが store 初期化より後ろ');
});

test('read は Redis 未設定でも推測データを返さず fail-closed で示す', async () => {
  const api = createAutomationAdminApi({
    store: null, env: {}, now: () => NOW,
    loadCustomers: async () => [], loadBlacklist: async () => new Set(),
  });
  const l = await api.list();
  assert.equal(l.保存済み, null, '推測データを返している');
  assert.equal(l.保存先.code, API_REJECT.STORE_UNAVAILABLE);
  const g = await api.get({ automationId: 'expiry-d7' });
  assert.equal(g.ok, false);
  assert.equal(g.code, API_REJECT.STORE_UNAVAILABLE);
});

// ── campaign 固定 ─────────────────────────────────────────────

test('campaign はカタログが正本。存在しない ID は保存できない', async () => {
  assert.equal(pinCampaign('存在しないID').ok, false);
  const p = pinCampaign(usableCampaign.campaignId);
  assert.equal(p.ok, true);
  assert.equal(p.campaignVersion, String(usableCampaign.version));
  assert.match(p.contentHash, /^[a-f0-9]{8,}$/);

  const { api } = mkApi();
  const res = await api.create({ presetId: 'manual-condition', overrides: { campaignId: '存在しないID' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, API_REJECT.UNKNOWN_CAMPAIGN);
});

test('保存時に campaignVersion / shellVersion / contentHash を固定する', async () => {
  const { api } = mkApi();
  const res = await api.create({ presetId: 'comeback-d7' });
  assert.equal(res.ok, true);
  for (const k of ['campaignId', 'campaignVersion', 'shellVersion', 'contentHash']) {
    assert.ok(res.definition[k], `${k} を固定していない`);
  }
});

test('保存後に campaign の版・本文が変われば ACTIVE を拒否する', () => {
  const okDef = { campaignId: usableCampaign.campaignId, ...pinCampaign(usableCampaign.campaignId) };
  assert.equal(checkCampaignDrift(okDef).ok, true);
  assert.equal(checkCampaignDrift({ ...okDef, campaignVersion: '999' }).code, API_REJECT.CAMPAIGN_DRIFT);
  assert.equal(checkCampaignDrift({ ...okDef, contentHash: 'zzz' }).code, API_REJECT.CAMPAIGN_DRIFT);
  assert.equal(checkCampaignDrift({ ...okDef, shellVersion: '99' }).code, API_REJECT.CAMPAIGN_DRIFT);
});

test('campaign 不整合の Definition は activate できない', async () => {
  const { api } = mkApi();
  const c = await api.create({ presetId: 'comeback-d7' });
  // 版が変わった状態を模擬
  await api.update({ automationId: c.definition.automationId, expectedVersion: '1', overrides: { name: 'x' } });
  const cur = await api.get({ automationId: c.definition.automationId });
  const broken = { ...cur.definition, contentHash: 'drifted' };
  // store を直接汚してから activate
  const { api: api2, redis } = mkApi();
  await api2.create({ presetId: 'comeback-d7' });
  redis.store.set('ak:marketing-automation:def:comeback-d7', JSON.stringify({ ...broken, configVersion: 1 }));
  const act = await api2.activate({ automationId: 'comeback-d7', expectedVersion: '1', snapshotFingerprint: 'fp' });
  assert.equal(act.ok, false);
  assert.equal(act.code, API_REJECT.CAMPAIGN_DRIFT);
});

// ── CAS・状態遷移 ─────────────────────────────────────────────

test('version 不一致の更新は拒否する', async () => {
  const { api } = mkApi();
  await api.create({ presetId: 'expiry-d7' });
  const bad = await api.update({ automationId: 'expiry-d7', expectedVersion: '99', overrides: { name: 'x' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, API_REJECT.VERSION_CONFLICT);
  const good = await api.update({ automationId: 'expiry-d7', expectedVersion: '1', overrides: { name: '新名称' } });
  assert.equal(good.ok, true);
  assert.equal(good.definition.name, '新名称');
  assert.equal(good.definition.configVersion, 2);
});

test('DRAFT → ACTIVE → PAUSED → ACTIVE → CANCELLED を通す', async () => {
  const { api } = mkApi();
  await api.create({ presetId: 'comeback-d7' });
  // ⚠️ activate は申告された指紋を鵜呑みにせず**再計算して照合**するので、
  //    dry-run で得た指紋を渡す（固定文字列では通らないのが正しい）
  const fp = async () => (await api.preview({ automationId: 'comeback-d7' })).snapshotFingerprint;
  const a = await api.activate({ automationId: 'comeback-d7', expectedVersion: '1', snapshotFingerprint: await fp() });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.definition.status, AUTOMATION_STATUS.ACTIVE);
  const p = await api.pause({ automationId: 'comeback-d7', expectedVersion: String(a.definition.configVersion) });
  assert.equal(p.definition.status, AUTOMATION_STATUS.PAUSED);
  const a2 = await api.activate({ automationId: 'comeback-d7', expectedVersion: String(p.definition.configVersion), snapshotFingerprint: await fp() });
  assert.equal(a2.definition.status, AUTOMATION_STATUS.ACTIVE);
  const c = await api.cancel({ automationId: 'comeback-d7', expectedVersion: String(a2.definition.configVersion) });
  assert.equal(c.definition.status, AUTOMATION_STATUS.CANCELLED);
});

test('CANCELLED からは復帰できない', async () => {
  const { api } = mkApi();
  await api.create({ presetId: 'comeback-d7' });
  const c = await api.cancel({ automationId: 'comeback-d7', expectedVersion: '1' });
  const back = await api.activate({
    automationId: 'comeback-d7', expectedVersion: String(c.definition.configVersion), snapshotFingerprint: 'fp',
  });
  assert.equal(back.ok, false);
  assert.equal(back.code, API_REJECT.INVALID_TRANSITION);
});

test('snapshot 未確認では ACTIVE にできない', async () => {
  const { api } = mkApi();
  await api.create({ presetId: 'comeback-d7' });
  const a = await api.activate({ automationId: 'comeback-d7', expectedVersion: '1' });
  assert.equal(a.ok, false);
  assert.equal(a.code, API_REJECT.NO_SNAPSHOT);
});

test('RUNNING 中の Definition は直接変更できない', async () => {
  const { api, redis } = mkApi();
  await api.create({ presetId: 'comeback-d7' });
  const cur = JSON.parse(redis.store.get('ak:marketing-automation:def:comeback-d7'));
  redis.store.set('ak:marketing-automation:def:comeback-d7', JSON.stringify({ ...cur, status: 'RUNNING' }));
  const u = await api.update({ automationId: 'comeback-d7', expectedVersion: '1', overrides: { name: 'x' } });
  assert.equal(u.ok, false);
  assert.equal(u.code, API_REJECT.RUNNING);
});

// ── cancel plan ───────────────────────────────────────────────

test('cancel は未送信だけの計画を返し、SENT を取消対象にしない', async () => {
  const { api } = mkApi();
  await api.create({ presetId: 'comeback-d7' });
  const c = await api.cancel({
    automationId: 'comeback-d7', expectedVersion: '1',
    queueSnapshot: { pending: 12, sent: 30, processing: 2 },
  });
  assert.equal(c.ok, true);
  assert.equal(c.cancelPlan['PENDING取消予定'], 12);
  assert.equal(c.cancelPlan['SENT取消不可'], 30);
  assert.equal(c.cancelPlan['rollback不可（送信済み）'], 30);
  assert.equal(c.cancelPlan.airtable実行, false, 'Airtable 実取消を行っている');
  assert.match(c.cancelPlan.note, /SENT は取消も再送もしません/);
});

// ── read は書かない ───────────────────────────────────────────

test('list / get / preview は 1 行も書かない', async () => {
  const { api, redis } = mkApi();
  const before = redis.store.size;
  await api.list();
  await api.get({ automationId: 'expiry-d7' });
  await api.preview({ automationId: 'expiry-d7' });
  assert.equal(redis.store.size, before, 'read が書き込んだ');
});

test('run 履歴を取得できる', async () => {
  const { api, redis } = mkApi();
  redis.store.set('ak:marketing-automation:run:auto:expiry-d7:2026-08-06', JSON.stringify({
    runId: 'auto:expiry-d7:2026-08-06', automationId: 'expiry-d7', status: 'ENQUEUED',
    queued: 8, excluded: 2, failed: 0, snapshotCount: 10,
  }));
  const runs = await api.runs({ automationId: 'expiry-d7' });
  assert.equal(runs.ok, true);
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].queued, 8);
  const d = await api.runDetail({ runId: 'auto:expiry-d7:2026-08-06' });
  assert.equal(d.run.excluded, 2);
});

// ── scheduler は本番登録しない ────────────────────────────────

test('guard: scheduler の schedule が netlify.toml に登録されていない', () => {
  assert.equal(TOML.includes('cron-marketing-automation'), false, 'scheduler が本番登録されている');
  assert.equal(/\[functions\."cron-marketing-automation"\]/.test(TOML), false);
});

// ── 画面 ──────────────────────────────────────────────────────

const SECTION_AT = PAGE.indexOf('aria-labelledby="autoH"');
const SECTION = PAGE.slice(SECTION_AT, PAGE.indexOf('</section>', SECTION_AT));

test('guard(ui): Phase B の必要項目が画面にある', () => {
  for (const label of ['プリセット', '名前', 'campaign', 'campaignVersion', '実行条件',
    'quiet hours', '最大件数', 'snapshot', '次回実行日時', '最終実行結果',
    'queued', 'excluded', 'failed', 'reconciliation', 'autoRuns']) {
    assert.ok(SECTION.includes(label), `画面に「${label}」が無い`);
  }
});

test('guard(ui): 未有効時は保存系ボタンが disabled かつ明示される', () => {
  for (const id of ['autoSave', 'autoActivate', 'autoPause', 'autoCancel']) {
    const i = SECTION.indexOf(`id="${id}"`);
    assert.ok(i > -1, `${id} が無い`);
    assert.match(SECTION.slice(i, i + 180), /disabled/, `${id} が既定で有効`);
  }
  assert.ok(SECTION.includes('本番自動配信は未有効'), '未有効の明示が無い');
});

test('guard(ui): UI で隠すだけにしない（API も 403）', () => {
  assert.match(FN, /WRITE_ACTIONS\.includes\(action\) && !isWriteEnabled\(process\.env\)/);
  assert.match(FN, /code: 'write_blocked'/);
});

test('guard(ui): campaign は選択式（自由入力で存在しない ID を保存できない）', () => {
  assert.ok(SECTION.includes('id="autoCampaign"'), 'campaign 選択が無い');
  assert.match(SECTION, /<select id="autoCampaign"/, 'campaign が自由入力になっている');
});

test('guard: Customers / 決済 / 会員 / 特典を書かない', () => {
  const code = FN.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ["method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'", 'PaymentConfirmed:', 'PlanType:']) {
    assert.equal(code.includes(bad), false, `${bad} を持っている`);
  }
});

test('guard: KMA の名称・prefix・env が混入していない', () => {
  const all = FN + readFileSync(fileURLToPath(new URL('./automationAdminApi.js', import.meta.url)), 'utf8');
  for (const bad of ['keiba-marketing-automation', 'KMA_', 'tenantId', '_MarketingAutomation', 'payemail:', 'customer-import:']) {
    assert.equal(all.includes(bad), false, `${bad} が混入`);
  }
});
