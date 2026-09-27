/**
 * 元々の会員メール再開 A/B/C 比較用 read-only 監査（`nativeMemberMailAudit.js`）の固定。
 *
 * 固定すること:
 *  - 書き込み経路が無い（GET 以外・Redis 書き込みコマンドは送る前に拒否）
 *  - 件数だけ（アドレス・氏名・recordId・offset・secret を返さない）
 *  - 窓 + cursor で進み、上限で黙って打ち切らない / 未知の入力は fail closed
 *  - 元々の会員の定義は importCohort の単一源（formula と再確認の両方）
 *  - 除外理由は audienceSegments.resolveSegmentExclusion と同じ順序・コード
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runNativeMailAudit, createReadOnlyFetch, createReadOnlyRedis, buildNativeMemberFormula,
  NATIVE_AUDIT_PHASES, NATIVE_AUDIT_FAIL, NATIVE_AUDIT_REQUEST_KEYS, WINDOW_MAX_PAGES,
  UNAVAILABLE_BY_READ_ONLY_CONTRACT, FREQUENCY_POLICY_FACTS, openCursor, findPii,
  summarizeNativeWindow, drmCampaignIds, primaryBucket,
} from './nativeMemberMailAudit.js';
import { IMPORT_SOURCE_PREFIX } from './importCohort.js';
import { SEG_EXCLUDE } from '../crm/audienceSegments.js';

const SECRET = 'test-cursor-secret-0123456789abcdef';
const AT_KEY = 'fake-airtable-key-for-tests-only';
const SG_KEY = 'fake-sendgrid-key-for-tests-only';
const NOW = Date.parse('2026-09-27T03:00:00Z');

const rid = (n) => `rec${String(n).padStart(14, '0')}`;

function customer(n, extra = {}) {
  return { id: rid(n), createdTime: '2026-01-01T00:00:00.000Z', fields: { Email: `user${String(n).padStart(4, '0')}@example.jp`, ...extra } };
}

/**
 * 偽 Airtable / SendGrid。呼ばれた method と URL を全部記録する。
 * Customers は formula を**実際に解釈せず**、元々の会員だけを返す（本物と同じ結果）。
 * `leakImported: true` なら取り込み由来も混ぜて返す（再確認の fail closed を見る）。
 */
function fakeWorld({ customers, blacklist = [], deliveries = [], jobs = [], leakImported = false, sg = {} } = {}) {
  const calls = [];
  const sorted = [...customers].sort((a, b) => String(a.fields.Email || '').localeCompare(String(b.fields.Email || '')));
  const native = leakImported ? sorted : sorted.filter((c) => !String(c.fields.Source || '').startsWith(IMPORT_SOURCE_PREFIX));
  const page = (rows, u) => {
    const off = Number(String(u.searchParams.get('offset') || 'itr00000000000000/0').split('/')[1]
      .replace(/^rec/, '')) || 0;
    const slice = rows.slice(off, off + 100);
    const next = off + 100 < rows.length ? `itr${'0'.repeat(14)}/rec${String(off + 100).padStart(14, '0')}` : undefined;
    return { records: slice, ...(next ? { offset: next } : {}) };
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: String(init.method || 'GET').toUpperCase(), url: String(url), hasBody: init.body != null });
    const u = new URL(url);
    if (u.hostname === 'api.airtable.com') {
      const table = decodeURIComponent(u.pathname.split('/')[3]);
      if (table === 'Customers') {
        assert.equal(u.searchParams.get('filterByFormula'), buildNativeMemberFormula());
        return ok(page(native, u));
      }
      if (table === 'EmailBlacklist') return ok(page(blacklist, u));
      if (table === 'CampaignDeliveries') {
        const f = u.searchParams.get('filterByFormula') || '';
        const rows = f.startsWith('OR(IS_AFTER') ? deliveries.filter((d) => d.since)
          : deliveries.filter((d) => drmCampaignIds().nurture.some((id) => String(d.fields.CampaignType).startsWith(`${id}:v`)));
        return ok(page(rows, u));
      }
      if (table === 'ScheduledEmails') return ok(page(jobs, u));
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.hostname === 'api.sendgrid.com') {
      if (u.pathname.startsWith('/v3/suppression/') || u.pathname.startsWith('/v3/asm/')) {
        const list = (sg.suppressed || {})[u.pathname] || [];
        return ok(Number(u.searchParams.get('offset') || 0) > 0 ? [] : list);
      }
      if (u.pathname === '/v3/marketing/lists') return ok({ result: sg.lists || [], _metadata: {} });
      if (u.pathname === '/v3/marketing/segments/2.0') return ok({ result: sg.segments || [], _metadata: {} });
      if (u.pathname === '/v3/marketing/singlesends') return ok({ result: sg.singlesends || [], _metadata: {} });
      return { ok: false, status: 404, json: async () => ({}) };
    }
    throw new Error(`unexpected host ${u.hostname}`);
  };
  return { fetchImpl, calls };
}

function fakeRedis(store = {}) {
  const calls = [];
  const cmd = async (args) => {
    calls.push(args[0]);
    if (args[0] === 'SMEMBERS') return store.members || [];
    if (args[0] === 'GET') return store.meta ?? null;
    if (args[0] === 'SCARD') return (store.members || []).length;
    throw new Error('unexpected');
  };
  return { cmd, calls };
}

const deps = (world, extra = {}) => ({
  fetchImpl: world.fetchImpl, redisCmd: null, airtableKey: AT_KEY, baseId: 'appTEST0000000000',
  sendgridKey: SG_KEY, cursorSecret: SECRET, nowMs: NOW, ...extra,
});

/** 全窓を歩く（クライアントと同じ手順） */
async function walk(phase, world, extra = {}, pages = 1) {
  const out = [];
  let cursor;
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runNativeMailAudit({ req: { action: 'nativeMailAudit', phase, pages, ...(cursor ? { cursor } : {}) }, deps: deps(world, extra) });
    out.push(r);
    if (r.status !== 200 || r.body.done) break;
    cursor = r.body.next;
  }
  return out;
}

// ─── 書き込み不可 ──────────────────────────────────────────────

test('read-only fetch: GET 以外と body 付きは送る前に拒否する', async () => {
  const sent = [];
  const rf = createReadOnlyFetch(async (u, i) => { sent.push(i.method); return { ok: true }; });
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    await assert.rejects(rf('https://api.airtable.com/v0/x/Customers', { method: m }), { message: NATIVE_AUDIT_FAIL.WRITE_FORBIDDEN });
  }
  await assert.rejects(rf('https://api.airtable.com/v0/x/Customers', { body: '{}' }), { message: NATIVE_AUDIT_FAIL.WRITE_FORBIDDEN });
  await rf('https://api.airtable.com/v0/x/Customers');
  assert.deepEqual(sent, ['GET']);
});

test('read-only redis: 読み取りコマンド以外は送る前に拒否する', async () => {
  const r = fakeRedis();
  const ro = createReadOnlyRedis(r.cmd);
  for (const c of ['SET', 'DEL', 'SADD', 'SREM', 'HSET', 'EXPIRE', 'EVAL', 'set']) {
    await assert.rejects(ro([c, 'k', 'v']), { message: NATIVE_AUDIT_FAIL.REDIS_COMMAND_FORBIDDEN });
  }
  await ro(['GET', 'k']);
  await ro(['SMEMBERS', 'k']);
  assert.deepEqual(r.calls, ['GET', 'SMEMBERS']);
});

test('全 phase を歩いても外部へ出るのは GET だけ・Redis は読み取りだけ', async () => {
  const world = fakeWorld({
    customers: Array.from({ length: 250 }, (_, i) => customer(i)),
    deliveries: [{ id: rid(9001), since: true, createdTime: '2026-09-24T01:00:00.000Z', fields: { RecipientEmail: 'user0001@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'campaign-discount-free:v1', SentAt: '2026-09-24T01:00:00.000Z' } }],
    sg: { lists: [{ name: 'ak-drm-engaged', contact_count: 806 }] },
  });
  const redis = fakeRedis({ members: [], meta: null });
  for (const phase of NATIVE_AUDIT_PHASES) {
    // eslint-disable-next-line no-await-in-loop
    const rs = await walk(phase, world, { redisCmd: redis.cmd });
    for (const r of rs) assert.equal(r.status, 200, `${phase}: ${JSON.stringify(r.body)}`);
  }
  assert.ok(world.calls.length > 0);
  assert.ok(world.calls.every((c) => c.method === 'GET' && !c.hasBody), JSON.stringify(world.calls.filter((c) => c.method !== 'GET')));
  assert.ok(redis.calls.every((c) => ['GET', 'SMEMBERS', 'SCARD'].includes(c)));
  // SendGrid contacts の検索（POST）は呼ばない
  assert.ok(!world.calls.some((c) => c.url.includes('/contacts/search')));
});

test('未知の入力キー（apply / confirm 等）・未知の phase は fail closed', async () => {
  const world = fakeWorld({ customers: [customer(1)] });
  for (const k of ['apply', 'confirm', 'send', 'live', 'write']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runNativeMailAudit({ req: { phase: 'baseline', [k]: true }, deps: deps(world) });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, NATIVE_AUDIT_FAIL.UNKNOWN_REQUEST_KEY);
  }
  for (const phase of ['', 'send', 'repair', 'customers2', undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runNativeMailAudit({ req: { phase }, deps: deps(world) });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, NATIVE_AUDIT_FAIL.UNKNOWN_PHASE);
  }
  assert.equal(world.calls.length, 0, '入力が不正なら外部へ 1 回も出ない');
  assert.deepEqual([...NATIVE_AUDIT_REQUEST_KEYS].sort(), ['action', 'cursor', 'pages', 'phase']);
});

test('設定が欠けていれば 503（推測で進めない）', async () => {
  const world = fakeWorld({ customers: [customer(1)] });
  for (const miss of ['airtableKey', 'baseId', 'cursorSecret', 'fetchImpl']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runNativeMailAudit({ req: { phase: 'baseline' }, deps: { ...deps(world), [miss]: '' } });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, NATIVE_AUDIT_FAIL.CONFIG_MISSING);
  }
});

// ─── 窓・cursor ───────────────────────────────────────────────

test('窓: pages は 1〜5 に限る・1 窓で全件を読まない', async () => {
  const world = fakeWorld({ customers: Array.from({ length: 1234 }, (_, i) => customer(i)) });
  for (const p of [0, 6, 100, 1.5, '3']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runNativeMailAudit({ req: { phase: 'baseline', pages: p }, deps: deps(world) });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, NATIVE_AUDIT_FAIL.INVALID_PAGES);
  }
  const r = await runNativeMailAudit({ req: { phase: 'baseline', pages: WINDOW_MAX_PAGES }, deps: deps(world) });
  assert.equal(r.status, 200);
  assert.equal(r.body.window.records, 500);
  assert.equal(r.body.done, false);
  assert.ok(r.body.next);
});

test('cursor で最後まで歩くと母数と digest が一致する（足し合わせ可能）', async () => {
  const world = fakeWorld({ customers: Array.from({ length: 1234 }, (_, i) => customer(i)) });
  const a = await walk('baseline', world, {}, 3);
  const b = await walk('baseline', world, {}, 1);
  const sum = (rs) => rs.reduce((acc, r) => ({ count: acc.count + r.body.digest.count, sum: acc.sum + r.body.digest.sum }), { count: 0, sum: 0 });
  assert.equal(sum(a).count, 1234);
  assert.deepEqual(sum(a), sum(b), '窓の大きさに依らず同じ digest');
  assert.equal(a.length, 5);
  assert.equal(b.length, 13);
});

test('集合が変われば digest が変わる（クライアントが fail closed できる）', async () => {
  const base = Array.from({ length: 150 }, (_, i) => customer(i));
  const d = async (list) => (await walk('baseline', fakeWorld({ customers: list }), {}, 5))
    .reduce((acc, r) => ({ count: acc.count + r.body.digest.count, sum: acc.sum + r.body.digest.sum }), { count: 0, sum: 0 });
  const x = await d(base);
  const swapped = await d([...base.slice(1), customer(9999)]);
  assert.equal(x.count, swapped.count);
  assert.notEqual(x.sum, swapped.sum);
});

test('cursor は封がされている: 改ざん・別 phase・別 secret は拒否', async () => {
  const world = fakeWorld({ customers: Array.from({ length: 250 }, (_, i) => customer(i)) });
  const r = await runNativeMailAudit({ req: { phase: 'baseline', pages: 1 }, deps: deps(world) });
  const token = r.body.next;
  assert.ok(!/itr|rec[0-9]/.test(token), 'offset（recordId を含む）が素のまま出ない');
  assert.equal(openCursor(token, 'other-secret'), null);
  const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
  const t = await runNativeMailAudit({ req: { phase: 'baseline', cursor: tampered }, deps: deps(world) });
  assert.equal(t.body.code, NATIVE_AUDIT_FAIL.INVALID_CURSOR);
  const m = await runNativeMailAudit({ req: { phase: 'customers', cursor: token }, deps: deps(world) });
  assert.equal(m.body.code, NATIVE_AUDIT_FAIL.CURSOR_PHASE_MISMATCH);
});

test('Airtable の iterator 失効・429 は理由つきで止まる（黙って短くしない）', async () => {
  const mk = (status, body) => async () => ({ ok: false, status, json: async () => body });
  const e = await runNativeMailAudit({ req: { phase: 'baseline' }, deps: { ...deps(fakeWorld({ customers: [] })), fetchImpl: mk(422, { error: { type: 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE' } }) } });
  assert.equal(e.body.code, NATIVE_AUDIT_FAIL.CURSOR_EXPIRED);
  const l = await runNativeMailAudit({ req: { phase: 'baseline' }, deps: { ...deps(fakeWorld({ customers: [] })), fetchImpl: mk(429, {}) } });
  assert.equal(l.body.code, NATIVE_AUDIT_FAIL.AIRTABLE_RATE_LIMITED);
  assert.equal(l.body.retryable, true);
  assert.equal(l.body.ok, false);
});

test('補助テーブルが上限を超えたら fail closed（部分を全体として数えない）', async () => {
  const bl = Array.from({ length: 2100 }, (_, i) => ({ id: rid(50000 + i), fields: { Email: `b${i}@example.jp`, Status: 'SOFT_BOUNCE' } }));
  const world = fakeWorld({ customers: [customer(1)], blacklist: bl });
  const r = await runNativeMailAudit({ req: { phase: 'customers' }, deps: deps(world) });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, NATIVE_AUDIT_FAIL.AUX_SCAN_LIMIT);
});

// ─── 元々の会員の定義 ──────────────────────────────────────────

test('定義: formula は importCohort の IMPORT_SOURCE_PREFIX から組み立てる', () => {
  assert.equal(buildNativeMemberFormula(), `NOT(LEFT({Source}, ${IMPORT_SOURCE_PREFIX.length}) = '${IMPORT_SOURCE_PREFIX}')`);
});

test('定義: 取り込み由来が紛れたら fail closed（formula と単一源の食い違い）', async () => {
  const world = fakeWorld({
    customers: [customer(1), customer(2, { Source: `${IMPORT_SOURCE_PREFIX}imp-2026-08-04-001` })],
    leakImported: true,
  });
  for (const phase of ['baseline', 'customers']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runNativeMailAudit({ req: { phase }, deps: deps(world) });
    assert.equal(r.body.code, NATIVE_AUDIT_FAIL.COHORT_MISMATCH, phase);
  }
});

test('定義: Source が空・別文字列の人は元々の会員として数える', async () => {
  const world = fakeWorld({
    customers: [customer(1), customer(2, { Source: 'signup' }), customer(3, { Source: `${IMPORT_SOURCE_PREFIX}x` })],
  });
  const [r] = await walk('baseline', world);
  assert.equal(r.body.digest.count, 2);
});

// ─── 集計（件数だけ・除外理由は単一源）─────────────────────────

test('customers: 除外理由は resolveSegmentExclusion のコードで数え、合計が母数と一致', async () => {
  const cs = [
    customer(1),
    customer(2, { UnsubscribedAnalyticsKeiba: true }),
    customer(3, { Status: 'suspended' }),
    customer(4, { Email: 'not-an-email' }),
    customer(5),
    customer(6, { Email: '' }),
    customer(7, { WithdrawalRequested: true }),
  ];
  const world = fakeWorld({
    customers: cs,
    blacklist: [{ id: rid(80001), fields: { Email: 'user0005@example.jp', Status: 'HARD_BOUNCE' } }],
  });
  const [r] = await walk('customers', world, {}, 5);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.sendability;
  assert.equal(s.balanced, true);
  assert.equal(r.body.noEmail, 1);
  assert.equal(s.byReason[SEG_EXCLUDE.UNSUBSCRIBED], 1);
  assert.equal(s.byReason[SEG_EXCLUDE.SUSPENDED_OR_TEST], 1);
  assert.equal(s.byReason[SEG_EXCLUDE.INVALID_EMAIL], 1);
  assert.equal(s.byReason[SEG_EXCLUDE.BLACKLIST_HARD], 1);
  assert.equal(s.sendable, 2, '1 と 7（退会は除外しない）');
  assert.equal(r.body.withdrawn.total, 1);
  assert.equal(r.body.withdrawn.sendable, 1);
  assert.equal(r.body.breakdown.withdrawn, 1);
  for (const code of Object.keys(s.byReason)) assert.ok(Object.values(SEG_EXCLUDE).includes(code), code);
});

test('customers: 配信基盤の停止リストが読めなければ全員 provider_unknown（fail closed）', async () => {
  const world = fakeWorld({ customers: [customer(1), customer(2)] });
  const [r] = await walk('customers', world, { sendgridKey: '' });
  assert.equal(r.body.sendability.sendable, 0);
  assert.equal(r.body.sendability.byReason[SEG_EXCLUDE.PROVIDER_UNKNOWN], 2);
  assert.equal(r.body.inputs.providerSuppression.available, false);
});

test('customers: 窓の境目をまたぐ重複アドレスを検出する', async () => {
  const cs = Array.from({ length: 100 }, (_, i) => customer(i));
  cs.push({ id: rid(777777), fields: { Email: 'user0099@example.jp' } }); // 100 件目と同じアドレス
  const world = fakeWorld({ customers: cs });
  const rs = await walk('customers', world, {}, 1);
  assert.equal(rs.length, 2);
  assert.equal(rs[1].body.boundaryDuplicate, true);
});

test('customers: 9/24 以降の旧 AK 経路の受信と DRM 育成の受信を人数で数える', async () => {
  const cs = [customer(1), customer(2), customer(3)];
  const deliveries = [
    { id: rid(9101), since: true, createdTime: '2026-09-24T00:00:00.000Z', fields: { RecipientEmail: 'user0001@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'campaign-discount-free:v1', SentAt: '2026-09-24T00:00:00.000Z' } },
    { id: rid(9102), since: true, createdTime: '2026-09-25T00:00:00.000Z', fields: { RecipientEmail: 'user0001@example.jp', Status: 'queued', EmailType: 'campaign', CampaignType: 'campaign-discount-free:v1', QueuedAt: '2026-09-25T00:00:00.000Z' } },
    { id: rid(9103), since: false, createdTime: '2026-09-15T00:00:00.000Z', fields: { RecipientEmail: 'user0002@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'free-signup-onboarding:v1', SentAt: '2026-09-15T00:00:00.000Z' } },
    { id: rid(9104), since: true, createdTime: '2026-09-20T00:00:00.000Z', fields: { RecipientEmail: 'user0003@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'campaign-discount-free:v1', SentAt: '2026-09-20T00:00:00.000Z' } },
  ];
  const world = fakeWorld({ customers: cs, deliveries });
  const [r] = await walk('customers', world);
  assert.equal(r.body.since.recipients, 1, '境目より前の行（formula をすり抜けても）は数えない');
  assert.deepEqual(r.body.since.rowsByStatus, { sent: 1, queued: 1 });
  assert.equal(r.body.since.recipientsByCampaign['campaign-discount-free'], 1);
  assert.equal(r.body.drm.withNurtureDelivery, 1);
  assert.equal(r.body.drm.stage.free_to_paid, 3);
});

test('deliveries: 日別（JST）・campaign 別・状態別に数える', async () => {
  const deliveries = [
    { id: rid(1), since: true, createdTime: '2026-09-23T15:30:00.000Z', fields: { RecipientEmail: 'a@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'campaign-discount-light:v2', SentAt: '2026-09-23T15:30:00.000Z' } },
    { id: rid(2), since: true, createdTime: '2026-09-25T02:00:00.000Z', fields: { RecipientEmail: 'b@example.jp', Status: 'failed', EmailType: 'campaign', CampaignType: 'free-signup-onboarding:v1' } },
    { id: rid(3), since: true, createdTime: '2026-09-23T14:00:00.000Z', fields: { RecipientEmail: 'c@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'x:v1', SentAt: '2026-09-23T14:00:00.000Z' } },
  ];
  const world = fakeWorld({ customers: [], deliveries, jobs: [{ id: rid(4), fields: { Status: 'SENT', RecipientCount: 3, SentCount: 2, FailedCount: 1 } }] });
  const [r] = await walk('deliveries', world);
  const d = r.body.campaignDeliveries;
  assert.equal(d.rows, 2);
  assert.deepEqual(d.byDay, { '2026-09-24': { sent: 1 }, '2026-09-25': { failed: 1 } });
  assert.deepEqual(d.byCampaign, { 'campaign-discount-light': { sent: 1 }, 'free-signup-onboarding': { failed: 1 } });
  assert.equal(r.body.scheduledEmails.jobs, 1);
  assert.equal(r.body.scheduledEmails.sentCount, 2);
});

// ─── SendGrid・方針の事実 ──────────────────────────────────────

test('sendgrid: GET で見える状態だけ返し、contacts 在籍は測らず理由コード', async () => {
  const world = fakeWorld({
    customers: [],
    sg: {
      lists: [{ name: 'ak-drm-engaged', contact_count: 806 }, { name: 'leak@example.jp', contact_count: 1 }],
      segments: [{ name: 'seg-a', contacts_count: 12 }],
      singlesends: [{ name: 'w1', status: 'scheduled', send_at: '2026-10-01T00:00:00Z' }, { name: 'w0', status: 'triggered' }],
    },
  });
  const [r] = await walk('sendgrid', world);
  assert.equal(r.status, 200);
  assert.equal(r.body.nativeInSendgridContacts.status, UNAVAILABLE_BY_READ_ONLY_CONTRACT);
  assert.equal(r.body.singleSends.scheduled.length, 1);
  assert.deepEqual(r.body.singleSends.byStatus, { scheduled: 1, triggered: 1 });
  assert.ok(r.body.lists.some((l) => l.name === '[redacted]'), 'アドレス形の名前は伏せる');
});

test('policy: 7 日 2 通 cap は本番実効なし・24h ガードは SendGrid MC に効かない（事実の記録）', async () => {
  const [r] = await walk('policy', fakeWorld({ customers: [] }));
  assert.equal(FREQUENCY_POLICY_FACTS.sevenDayTwoSendCap.productionEffect, 'none');
  assert.equal(FREQUENCY_POLICY_FACTS.crossCampaign24hGuard.scope, 'old_ak_dispatch_only');
  assert.equal(r.body.frequencyPolicy.sevenDayTwoSendCap.productionEffect, 'none');
});

// ─── PII ────────────────────────────────────────────────────────

test('どの phase の応答にもアドレス・recordId・offset・鍵が含まれない', async () => {
  const cs = Array.from({ length: 230 }, (_, i) => customer(i, { 氏名: `山田 ${i}`, Name: `Taro ${i}` }));
  const world = fakeWorld({
    customers: cs,
    deliveries: [{ id: rid(9201), since: true, createdTime: '2026-09-24T00:00:00.000Z', fields: { RecipientEmail: 'user0001@example.jp', Status: 'sent', EmailType: 'campaign', CampaignType: 'campaign-discount-free:v1', SentAt: '2026-09-24T00:00:00.000Z' } }],
    sg: { lists: [{ name: 'l', contact_count: 1 }] },
  });
  for (const phase of NATIVE_AUDIT_PHASES) {
    // eslint-disable-next-line no-await-in-loop
    for (const r of await walk(phase, world, {}, 1)) {
      const { next, ...rest } = r.body;
      const s = JSON.stringify(rest);
      assert.equal(findPii(rest, [AT_KEY, SG_KEY, SECRET]), null, `${phase}: ${s.slice(0, 200)}`);
      assert.ok(!s.includes('山田') && !s.includes('Taro') && !s.includes('example.jp'), phase);
    }
  }
});

test('PII guard: 応答に紛れたら中身を捨てて fail closed', () => {
  assert.equal(findPii({ a: 'x@example.jp' }), 'pattern_0');
  assert.equal(findPii({ a: rid(1) }), 'pattern_1');
  assert.equal(findPii({ a: 'contains-secret-value' }, ['secret-value']), 'secret_value');
  assert.equal(findPii({ a: 1, b: 'ok' }), null);
});

test('summarizeNativeWindow は件数だけを返す（アドレスの配列・Set を返さない）', () => {
  const s = summarizeNativeWindow({
    records: [customer(1), customer(2)], nowMs: NOW, hard: new Set(), soft: new Set(),
    providerSuppressed: new Set(), engagementBlocked: null, sinceRows: [], drmRows: [], carryIn: null, secret: SECRET,
  });
  const walkValues = (v) => {
    if (v instanceof Set || v instanceof Map) throw new Error('Set/Map を返している');
    if (Array.isArray(v)) throw new Error('配列を返している');
    if (v && typeof v === 'object') Object.values(v).forEach(walkValues);
  };
  const { carryOut, ...rest } = s;
  walkValues(rest);
  assert.match(carryOut, /^[a-f0-9]{24}$/);
  assert.equal(s.sendability.sendable, 2);
});

test('primaryBucket: 退会 → 判定不能 → 期限切れ → premium → light → free の順に畳む', () => {
  assert.equal(primaryBucket({ withdrawn: true, contract: 'active', plan: 'premium' }), 'withdrawn');
  assert.equal(primaryBucket({ contract: 'unknown', plan: 'premium' }), 'undeterminable');
  assert.equal(primaryBucket({ contract: 'expired', plan: 'light' }), 'expired');
  assert.equal(primaryBucket({ contract: 'active', plan: 'premium_sanrenpuku' }), 'premium');
  assert.equal(primaryBucket({ contract: 'expiring_soon', plan: 'light' }), 'light');
  assert.equal(primaryBucket({ contract: 'none', plan: 'free' }), 'free');
  assert.equal(primaryBucket({ contract: 'none', plan: '???' }), 'undeterminable');
});
