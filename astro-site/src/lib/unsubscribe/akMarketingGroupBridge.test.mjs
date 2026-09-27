/**
 * AK Marketing group ⇄ AK Customers の配信停止の橋渡し（`akMarketingGroupBridge.js`）。
 *
 * 固定すること:
 *  - AK Marketing（34108）の group_unsubscribe だけが Customers を止める
 *  - KI / テスト / 不明 group は Customers に 1 ビットも触らない
 *  - AK → SendGrid は AK Marketing の group suppression だけ（global / KI group に書かない）
 *  - 何度流しても状態が増えない（冪等）
 *  - group_resubscribe も AK Marketing のものだけ。古い再開で新しい停止を消さない
 *  - gate が閉じていれば書かない
 *  - 応答・要約にアドレス・recordId・鍵を出さない
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AK_MARKETING_GROUP, BRIDGE_GATE_ENV, CUSTOMER_UNSUBSCRIBE_FIELDS, BRIDGE_IGNORE, BRIDGE_NOOP,
  classifyGroupEvent, planGroupEvents, decideCustomerChange,
  applyGroupEventsToCustomers, addToAkMarketingGroupSuppression, isBridgeEnabled,
} from './akMarketingGroupBridge.js';

const AK = AK_MARKETING_GROUP.id;
const KI = 29174;          // KEIBA Intelligence メルマガ（2026-09-27 read-only 実測）
const TEST_GROUP = 28368;  // テストグループ
const T0 = 1790000000;     // 秒
const ENV_ON = {
  [BRIDGE_GATE_ENV]: 'true',
  AIRTABLE_API_KEY: 'fake-airtable-key-for-tests',
  AIRTABLE_BASE_ID_ANALYTICS_KEIBA: 'appFAKEBASE000000',
  SENDGRID_API_KEY: 'fake-sendgrid-key-for-tests',
};

const ev = (event, group, email = 'member@example.jp', ts = T0) => ({
  event, email, timestamp: ts, ...(group === undefined ? {} : { asm_group_id: group }),
});

test('AK Marketing の id と名前は read-only 実測値（34108 / AK Marketing）', () => {
  assert.equal(AK_MARKETING_GROUP.id, 34108);
  assert.equal(AK_MARKETING_GROUP.name, 'AK Marketing');
});

// ─── 分類 ─────────────────────────────────────────────────────────

test('AK Marketing の group_unsubscribe / group_resubscribe だけを扱う', () => {
  assert.equal(classifyGroupEvent(ev('group_unsubscribe', AK)).kind, 'unsubscribe');
  assert.equal(classifyGroupEvent(ev('group_resubscribe', AK)).kind, 'resubscribe');
  assert.equal(classifyGroupEvent(ev('group_unsubscribe', String(AK))).kind, 'unsubscribe', '文字列の id も同じ');
});

test('KI / テスト group は foreign_group として無視する', () => {
  for (const g of [KI, TEST_GROUP]) {
    for (const type of ['group_unsubscribe', 'group_resubscribe']) {
      assert.deepEqual(classifyGroupEvent(ev(type, g)), { kind: 'ignore', reason: BRIDGE_IGNORE.FOREIGN_GROUP });
    }
  }
});

test('group が分からないイベントは unknown_group（fail closed）', () => {
  for (const g of [undefined, null, '', 'abc', 34108.5, -1, '34108x']) {
    const c = classifyGroupEvent(ev('group_unsubscribe', g));
    assert.equal(c.kind, 'ignore', String(g));
    assert.ok([BRIDGE_IGNORE.UNKNOWN_GROUP, BRIDGE_IGNORE.FOREIGN_GROUP].includes(c.reason), String(g));
  }
  assert.equal(classifyGroupEvent(ev('group_unsubscribe', undefined)).reason, BRIDGE_IGNORE.UNKNOWN_GROUP);
});

test('通常の unsubscribe・bounce・spam 等は扱わない（既存処理へ関与しない）', () => {
  for (const type of ['unsubscribe', 'bounce', 'blocked', 'dropped', 'spamreport', 'delivered', 'open', 'click']) {
    assert.deepEqual(classifyGroupEvent(ev(type, AK)), { kind: 'ignore', reason: BRIDGE_IGNORE.NOT_GROUP_EVENT });
  }
});

test('同じ人の複数イベントは新しいほう、同時刻は停止を優先', () => {
  const later = planGroupEvents([ev('group_unsubscribe', AK, 'a@example.jp', T0), ev('group_resubscribe', AK, 'a@example.jp', T0 + 5)]);
  assert.deepEqual(later.ops.map((o) => o.action), ['resubscribe']);
  const tie = planGroupEvents([ev('group_resubscribe', AK, 'a@example.jp', T0), ev('group_unsubscribe', AK, 'a@example.jp', T0)]);
  assert.deepEqual(tie.ops.map((o) => o.action), ['unsubscribe']);
  const mixed = planGroupEvents([ev('group_unsubscribe', KI), ev('group_unsubscribe'), ev('open', AK)]);
  assert.equal(mixed.ops.length, 0);
  assert.deepEqual(mixed.ignored, { [BRIDGE_IGNORE.FOREIGN_GROUP]: 1, [BRIDGE_IGNORE.UNKNOWN_GROUP]: 1 });
});

// ─── Customers への反映 ────────────────────────────────────────────

const AT = CUSTOMER_UNSUBSCRIBE_FIELDS.at;
const FLAG = CUSTOMER_UNSUBSCRIBE_FIELDS.flag;
const iso = (sec) => new Date(sec * 1000).toISOString();
const stoppedAt = (sec) => ({ [FLAG]: true, [AT]: iso(sec) });

test('停止: 未停止なら立てる / 同じ時刻・古い停止は何もしない（冪等）', () => {
  const on = decideCustomerChange({ fields: {}, action: 'unsubscribe', atMs: T0 * 1000, nowMs: 0 });
  assert.deepEqual(on.write, { [FLAG]: true, [AT]: iso(T0) });
  for (const sec of [T0, T0 - 60]) {
    const again = decideCustomerChange({ fields: stoppedAt(T0), action: 'unsubscribe', atMs: sec * 1000, nowMs: 0 });
    assert.equal(again.write, null, String(sec));
    assert.equal(again.noop, BRIDGE_NOOP.ALREADY_UNSUBSCRIBED);
  }
});

test('停止: 既に停止中でも、より新しい停止なら停止時刻を進める（旗は触らない）', () => {
  const d = decideCustomerChange({ fields: stoppedAt(T0), action: 'unsubscribe', atMs: (T0 + 600) * 1000, nowMs: 0 });
  assert.deepEqual(d.write, { [AT]: iso(T0 + 600) });
  const noTime = decideCustomerChange({ fields: { [FLAG]: true }, action: 'unsubscribe', atMs: T0 * 1000, nowMs: 0 });
  assert.deepEqual(noTime.write, { [AT]: iso(T0) }, '停止時刻が読めなければ時刻のある停止で埋める');
});

test('再開: AK の停止時刻が無い・読めないなら解除しない', () => {
  for (const f of [{ [FLAG]: true }, { [FLAG]: true, [AT]: '' }, { [FLAG]: true, [AT]: 'not-a-date' }]) {
    const d = decideCustomerChange({ fields: f, action: 'resubscribe', atMs: (T0 + 600) * 1000, nowMs: 0 });
    assert.equal(d.write, null, JSON.stringify(f));
    assert.equal(d.noop, BRIDGE_NOOP.STALE_RESUBSCRIBE);
  }
});

test('再開: 同時刻・より古い・時刻なしは解除しない／厳密に新しいときだけ解除', () => {
  for (const at of [T0 * 1000, (T0 - 60) * 1000, null, NaN]) {
    const d = decideCustomerChange({ fields: stoppedAt(T0), action: 'resubscribe', atMs: at, nowMs: 0 });
    assert.equal(d.write, null, String(at));
    assert.equal(d.noop, BRIDGE_NOOP.STALE_RESUBSCRIBE);
  }
  const newer = decideCustomerChange({ fields: stoppedAt(T0), action: 'resubscribe', atMs: T0 * 1000 + 1, nowMs: 0 });
  assert.deepEqual(newer.write, { [FLAG]: false, [AT]: null });
  const notStopped = decideCustomerChange({ fields: {}, action: 'resubscribe', atMs: T0 * 1000, nowMs: 0 });
  assert.equal(notStopped.noop, BRIDGE_NOOP.ALREADY_SUBSCRIBED);
});

/** 偽 Airtable。Customers を 1 件（または 0 / 2 件）持ち、呼ばれた method を記録する */
function fakeAirtable({ records }) {
  const calls = [];
  const state = records.map((r) => ({ ...r, fields: { ...r.fields } }));
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ method, url: String(url) });
    const u = new URL(url);
    assert.equal(u.hostname, 'api.airtable.com');
    if (method === 'GET') {
      const f = u.searchParams.get('filterByFormula') || '';
      const m = /LOWER\(\{Email\}\) = "(.*)"$/.exec(f);
      const hits = m ? state.filter((r) => String(r.fields.Email).toLowerCase() === m[1]) : [];
      return { ok: true, json: async () => ({ records: hits.map((r) => ({ id: r.id, fields: { ...r.fields } })) }) };
    }
    if (method === 'PATCH') {
      const id = u.pathname.split('/').pop();
      const rec = state.find((r) => r.id === id);
      Object.assign(rec.fields, JSON.parse(init.body).fields);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({}) };
  };
  return { fetchImpl, calls, state };
}

const member = (email = 'member@example.jp', extra = {}) => ({ id: 'recAAAAAAAAAAAAAA1', fields: { Email: email, ...extra } });

test('webhook: AK Marketing の group_unsubscribe で Customers の停止が立つ', async () => {
  const at = fakeAirtable({ records: [member()] });
  const s = await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK)], env: ENV_ON, fetchImpl: at.fetchImpl });
  assert.equal(s.written.unsubscribe, 1);
  assert.equal(at.state[0].fields.UnsubscribedAnalyticsKeiba, true);
  assert.deepEqual(Object.keys(at.state[0].fields).sort(), ['Email', 'UnsubscribedAnalyticsKeiba', 'UnsubscribedAtAnalyticsKeiba'], 'AK の 2 列だけを書く');
});

test('webhook: KI / テスト / 不明 group は Customers に 1 回も書かない（読みもしない）', async () => {
  const at = fakeAirtable({ records: [member()] });
  const s = await applyGroupEventsToCustomers({
    events: [ev('group_unsubscribe', KI), ev('group_unsubscribe', TEST_GROUP), ev('group_unsubscribe'), ev('group_resubscribe', KI)],
    env: ENV_ON, fetchImpl: at.fetchImpl,
  });
  assert.equal(at.calls.length, 0);
  assert.equal(s.targeted, 0);
  assert.equal(at.state[0].fields.UnsubscribedAnalyticsKeiba, undefined);
});

test('webhook: 同じイベントを 2 回流しても書くのは 1 回（冪等）', async () => {
  const at = fakeAirtable({ records: [member()] });
  await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK)], env: ENV_ON, fetchImpl: at.fetchImpl });
  const second = await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK)], env: ENV_ON, fetchImpl: at.fetchImpl });
  assert.equal(second.written.unsubscribe, 0);
  assert.equal(second.noop[BRIDGE_NOOP.ALREADY_UNSUBSCRIBED], 1);
  assert.equal(at.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('webhook: AK Marketing の group_resubscribe は解除、KI の resubscribe は触らない', async () => {
  const stoppedAt = new Date((T0 - 100) * 1000).toISOString();
  const at = fakeAirtable({ records: [member('member@example.jp', { UnsubscribedAnalyticsKeiba: true, UnsubscribedAtAnalyticsKeiba: stoppedAt })] });
  await applyGroupEventsToCustomers({ events: [ev('group_resubscribe', KI)], env: ENV_ON, fetchImpl: at.fetchImpl });
  assert.equal(at.state[0].fields.UnsubscribedAnalyticsKeiba, true, 'KI の再開で AK は解除されない');
  const s = await applyGroupEventsToCustomers({ events: [ev('group_resubscribe', AK)], env: ENV_ON, fetchImpl: at.fetchImpl });
  assert.equal(s.written.resubscribe, 1);
  assert.equal(at.state[0].fields.UnsubscribedAnalyticsKeiba, false);
});

test('webhook: gate が閉じていれば数えるだけで書かない', async () => {
  const at = fakeAirtable({ records: [member()] });
  for (const env of [{}, { ...ENV_ON, [BRIDGE_GATE_ENV]: 'false' }, { ...ENV_ON, [BRIDGE_GATE_ENV]: '1' }]) {
    // eslint-disable-next-line no-await-in-loop
    const s = await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK)], env, fetchImpl: at.fetchImpl });
    assert.equal(s.enabled, false);
    assert.equal(s.targeted, 1);
  }
  assert.equal(at.calls.length, 0);
});

test('webhook: 同じアドレスが 2 件なら書かない / 居なければ何もしない', async () => {
  const dup = fakeAirtable({ records: [member(), { ...member(), id: 'recAAAAAAAAAAAAAA2' }] });
  const s1 = await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK)], env: ENV_ON, fetchImpl: dup.fetchImpl });
  assert.equal(s1.noop[BRIDGE_NOOP.AMBIGUOUS], 1);
  assert.equal(dup.calls.filter((c) => c.method === 'PATCH').length, 0);
  const none = fakeAirtable({ records: [] });
  const s2 = await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK)], env: ENV_ON, fetchImpl: none.fetchImpl });
  assert.equal(s2.noop[BRIDGE_NOOP.NOT_FOUND], 1);
});

test('webhook: 要約にアドレス・recordId・鍵を出さない', async () => {
  const at = fakeAirtable({ records: [member()] });
  const s = await applyGroupEventsToCustomers({ events: [ev('group_unsubscribe', AK), ev('group_unsubscribe', KI, 'other@example.jp')], env: ENV_ON, fetchImpl: at.fetchImpl });
  const j = JSON.stringify(s);
  for (const leak of ['@', 'recAAAA', ENV_ON.AIRTABLE_API_KEY, ENV_ON.AIRTABLE_BASE_ID_ANALYTICS_KEIBA]) assert.ok(!j.includes(leak), leak);
});

// ─── AK → SendGrid ────────────────────────────────────────────────

function fakeSendgrid({ groupName = 'AK Marketing', groupId = AK, getOk = true, postOk = true } = {}) {
  const calls = [];
  const suppressed = new Set();
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ method, url: String(url), body: init.body || null });
    const u = new URL(url);
    assert.equal(u.hostname, 'api.sendgrid.com');
    if (method === 'GET') return { ok: getOk, json: async () => ({ id: groupId, name: groupName }) };
    if (method === 'POST') {
      for (const e of JSON.parse(init.body).recipient_emails) suppressed.add(e);
      return { ok: postOk, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({}) };
  };
  return { fetchImpl, calls, suppressed };
}

test('AK unsubscribe → AK Marketing group suppression へ追加（global / KI group へは書かない）', async () => {
  const sg = fakeSendgrid();
  const r = await addToAkMarketingGroupSuppression({ email: 'Member@Example.jp', env: ENV_ON, fetchImpl: sg.fetchImpl });
  assert.equal(r.status, 'synced');
  assert.deepEqual([...sg.suppressed], ['member@example.jp']);
  for (const c of sg.calls) {
    assert.ok(c.url.startsWith(`https://api.sendgrid.com/v3/asm/groups/${AK}`), c.url);
    assert.ok(!c.url.includes(`/${KI}`) && !c.url.includes(`/${TEST_GROUP}`));
    assert.ok(!c.url.includes('/v3/asm/suppressions/global') && !c.url.includes('/unsubscribes'), '全体停止を使わない');
    assert.ok(!c.url.includes('/contacts/search'), 'contact 検索をしない');
  }
});

test('AK → SendGrid: 2 回呼んでも suppression は 1 件（冪等）', async () => {
  const sg = fakeSendgrid();
  await addToAkMarketingGroupSuppression({ email: 'member@example.jp', env: ENV_ON, fetchImpl: sg.fetchImpl });
  await addToAkMarketingGroupSuppression({ email: 'member@example.jp', env: ENV_ON, fetchImpl: sg.fetchImpl });
  assert.equal(sg.suppressed.size, 1);
});

test('AK → SendGrid: group の名前か id が違えば書かない（fail closed）', async () => {
  for (const over of [{ groupName: 'KEIBA Intelligence メルマガ' }, { groupId: KI }, { getOk: false }]) {
    const sg = fakeSendgrid(over);
    // eslint-disable-next-line no-await-in-loop
    const r = await addToAkMarketingGroupSuppression({ email: 'member@example.jp', env: ENV_ON, fetchImpl: sg.fetchImpl });
    assert.notEqual(r.status, 'synced');
    assert.equal(sg.calls.filter((c) => c.method === 'POST').length, 0, JSON.stringify(over));
  }
});

test('AK → SendGrid: gate が閉じていれば外へ出ない', async () => {
  const sg = fakeSendgrid();
  const r = await addToAkMarketingGroupSuppression({ email: 'member@example.jp', env: { ...ENV_ON, [BRIDGE_GATE_ENV]: '' }, fetchImpl: sg.fetchImpl });
  assert.equal(r.status, 'skipped_gate');
  assert.equal(sg.calls.length, 0);
  assert.equal(isBridgeEnabled({}), false);
});

test('AK → SendGrid: 戻り値は状態コードだけ（アドレス・鍵を含まない）', async () => {
  const sg = fakeSendgrid();
  const r = await addToAkMarketingGroupSuppression({ email: 'member@example.jp', env: ENV_ON, fetchImpl: sg.fetchImpl });
  assert.deepEqual(Object.keys(r), ['status']);
});

test('webhook: バッチをまたいだ到着順の逆転でも新しい停止が勝つ（停止 9/1 → 停止 9/10 → 遅れて再開 9/5）', async () => {
  const d = (m, day) => Date.UTC(2026, m - 1, day) / 1000;
  const at = fakeAirtable({ records: [member()] });
  const run = (e) => applyGroupEventsToCustomers({ events: [e], env: ENV_ON, fetchImpl: at.fetchImpl });
  await run(ev('group_unsubscribe', AK, 'member@example.jp', d(9, 1)));
  const adv = await run(ev('group_unsubscribe', AK, 'member@example.jp', d(9, 10)));
  assert.equal(adv.written.stopTimeAdvanced, 1);
  assert.equal(at.state[0].fields[AT], iso(d(9, 10)));
  const late = await run(ev('group_resubscribe', AK, 'member@example.jp', d(9, 5)));
  assert.equal(late.written.resubscribe, 0);
  assert.equal(late.noop[BRIDGE_NOOP.STALE_RESUBSCRIBE], 1);
  assert.equal(at.state[0].fields[FLAG], true, '古い再開で解除されない');
  // その後、本当に新しい再開なら解除できる
  const fresh = await run(ev('group_resubscribe', AK, 'member@example.jp', d(9, 12)));
  assert.equal(fresh.written.resubscribe, 1);
  assert.equal(at.state[0].fields[FLAG], false);
});

test('webhook: 同じバッチで同時刻の停止と再開が来たら停止が勝つ', async () => {
  const at = fakeAirtable({ records: [member('member@example.jp', stoppedAt(T0 - 100))] });
  const s = await applyGroupEventsToCustomers({
    events: [ev('group_resubscribe', AK, 'member@example.jp', T0), ev('group_unsubscribe', AK, 'member@example.jp', T0)],
    env: ENV_ON, fetchImpl: at.fetchImpl,
  });
  assert.equal(s.written.resubscribe, 0);
  assert.equal(at.state[0].fields[FLAG], true);
});
