/**
 * sendgridSelectionExit.test.mjs — 「反応したら選別 list から即時に外れる」の契約
 *
 * - 外すのは **ENGAGED / PROMOTED / SUPPRESSED / EXHAUSTED** だけ
 * - 触る list は **`ak-prospect-select-start-N` だけ**（KI / KMA の資産に触れない）
 * - **べき等**（同じ人を何度外しても結果が変わらない・重複は 1 回）
 * - **SendGrid が落ちても例外を投げない**（webhook は 200 を返し続ける）
 * - **アドレスを戻り値・ログに出さない**
 * - 止めるのは env 1 つ。**既定は有効**（env を足さなくても動く）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  planSelectionExit, applySelectionExit, createSelectionExitClient,
  isSelectionExitDisabled, EXIT_STATES, CRITICAL_EXIT_STATES, SELECTION_LIST_NAMES,
  MAX_EXIT_PER_CALL, EXIT_DISABLE_ENV, REMOVE_ATTEMPTS,
} from './sendgridSelectionExit.js';
import { createEventOnceStore } from '../webhooks/webhookEventOnce.js';
import { PROSPECT_STATE, classifyEvent } from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { containsEmailLike } from './sendgridNextMessage.js';
import { listNameFor } from './sendgridAutomationPlan.js';

const WEBHOOK = fileURLToPath(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url));
const webhookSrc = readFileSync(WEBHOOK, 'utf8');

/** 選別 list だけを持つ偽 SendGrid */
function fakeClient({
  failListFetch = false, failRemove = false, throwOn = null, lookupFails = false, failTimes = 0,
} = {}) {
  const calls = { lists: 0, search: 0, remove: [] };
  let failsLeft = failTimes;
  return {
    calls,
    async selectionListIds() {
      calls.lists += 1;
      if (throwOn === 'lists') throw new Error('boom');
      if (failListFetch) return null;
      return ['id-1', 'id-2', 'id-3'];
    },
    async contactIds(emails) {
      calls.search += 1;
      if (throwOn === 'search') throw new Error('boom');
      return emails.map((e) => `c-${e}`);
    },
    async contactIdsChecked(emails) {
      calls.search += 1;
      if (throwOn === 'search') throw new Error('boom');
      if (lookupFails) return { byEmail: new Map(), lookupFailed: true };
      return { byEmail: new Map(emails.map((e) => [e, `c-${e}`])), lookupFailed: false };
    },
    async removeFromList({ listId, contactIds }) {
      calls.remove.push({ listId, n: contactIds.length });
      if (throwOn === 'remove') throw new Error('boom');
      if (failsLeft > 0) { failsLeft -= 1; return { status: 500, removed: 0 }; }
      return failRemove ? { status: 500, removed: 0 } : { status: 202, removed: contactIds.length };
    },
  };
}

test('外すのは 4 つの状態だけ（送信継続中の人は外さない）', () => {
  assert.deepEqual(EXIT_STATES, ['ENGAGED', 'PROMOTED', 'SUPPRESSED', 'EXHAUSTED']);
  const r = planSelectionExit({
    changes: [
      { email: 'a@example.test', state: PROSPECT_STATE.ENGAGED },
      { email: 'b@example.test', state: PROSPECT_STATE.SUPPRESSED },
      { email: 'c@example.test', state: PROSPECT_STATE.PROMOTED },
      { email: 'd@example.test', state: PROSPECT_STATE.EXHAUSTED },
      { email: 'e@example.test', state: PROSPECT_STATE.SENDING },   // 継続中 → 外さない
      { email: 'f@example.test', state: PROSPECT_STATE.NEW },       // 同上
    ],
  });
  assert.deepEqual(r.emails.sort(), ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test']);
  assert.equal(r.skipped[PROSPECT_STATE.SENDING], 1);
  assert.equal(r.skipped[PROSPECT_STATE.NEW], 1);
});

test('重複は 1 回にまとめ、上限を超えたぶんは数える（べき等・暴走しない）', () => {
  const many = Array.from({ length: MAX_EXIT_PER_CALL + 5 }, (_, i) => ({
    email: `u${i}@example.test`, state: PROSPECT_STATE.ENGAGED,
  }));
  const dup = [
    { email: 'X@Example.test', state: PROSPECT_STATE.ENGAGED },
    { email: 'x@example.test', state: PROSPECT_STATE.ENGAGED },
  ];
  const r = planSelectionExit({ changes: [...dup, ...many] });
  assert.equal(r.emails.length, MAX_EXIT_PER_CALL);
  assert.equal(r.skipped.duplicate, 1, '大文字小文字違いも同じ人として畳む');
  assert.equal(r.capped, 5 + 1);
});

test('触る list は選別用の 3 本だけ', () => {
  assert.deepEqual(SELECTION_LIST_NAMES, [listNameFor(1), listNameFor(2), listNameFor(3)]);
  for (const n of SELECTION_LIST_NAMES) assert.match(n, /^ak-prospect-select-start-[123]$/);
});

test('反応した人を 3 本すべてから外す（どこに居るか分からなくても残さない）', async () => {
  const client = fakeClient();
  const out = await applySelectionExit({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }],
    client, env: {},
  });
  assert.equal(out.enabled, true);
  assert.equal(out['対象'], 1);
  assert.equal(out['list数'], 3);
  assert.equal(client.calls.remove.length, 3);
  assert.equal(out['除外した延べ件数'], 3);
  assert.equal(out.errors, 0);
  assert.equal(containsEmailLike(out), false, '戻り値にアドレスが混ざっている');
});

test('SendGrid が失敗しても例外を投げない（webhook は 200 を返し続ける）', async () => {
  for (const opts of [{ failListFetch: true }, { failRemove: true }, { throwOn: 'search' }, { throwOn: 'remove' }]) {
    // eslint-disable-next-line no-await-in-loop -- 4 パターン
    const out = await applySelectionExit({
      changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }],
      client: fakeClient(opts), env: {},
    });
    assert.ok(out, '例外が投げられた');
    assert.equal(containsEmailLike(out), false);
  }
});

test('SendGrid 未設定なら何もしない / env 1 つで止められる（既定は有効）', async () => {
  assert.equal(isSelectionExitDisabled({}), false, '既定で無効になっている');
  assert.equal(isSelectionExitDisabled({ [EXIT_DISABLE_ENV]: 'true' }), true);
  assert.equal(createSelectionExitClient({ apiKey: '' }), null);

  const none = await applySelectionExit({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }], client: null, env: {},
  });
  assert.equal(none.reason, 'sendgrid_not_configured');

  const off = await applySelectionExit({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }],
    client: fakeClient(), env: { [EXIT_DISABLE_ENV]: 'true' },
  });
  assert.equal(off.reason, 'disabled_by_env');
  assert.equal(off.enabled, false);
});

test('group_unsubscribe を安全に処理できる（トグルを ON にしてよい）', () => {
  // classifyEvent は group_unsubscribe を抑止として扱う
  assert.deepEqual(classifyEvent('group_unsubscribe').kind, 'suppress');
  const { updates } = planProspectEventUpdates({
    events: [
      { email: 'g@example.test', event: 'group_unsubscribe' },
      { email: 'h@example.test', event: 'unsubscribe' },
      { email: 'i@example.test', event: 'spamreport' },
      { email: 'j@example.test', event: 'bounce' },
    ],
    classify: classifyEvent,
  });
  assert.equal(updates.length, 4);
  for (const u of updates) assert.equal(u.action, 'suppress');
  // 抑止は選別からも外れる
  const plan = planSelectionExit({
    changes: updates.map((u) => ({ email: u.email, state: PROSPECT_STATE.SUPPRESSED })),
  });
  assert.equal(plan.emails.length, 4);
});

test('webhook が配線されている（新しい cron を作っていない）', () => {
  assert.match(webhookSrc, /applySelectionExit/);
  assert.match(webhookSrc, /createSelectionExitClient/);
  // 応答・ログにアドレス（changes）を出さない
  assert.match(webhookSrc, /const \{ changes: _prospectChanges, \.\.\.prospectCounts \} = prospect/);
  assert.match(webhookSrc, /prospect: prospectCounts/);
  assert.equal(/prospect,\n\s*\}\);/.test(webhookSrc), false, 'changes を含む prospect をそのまま返している');
  // 失敗しても 200（catch で握って応答へ載せる）
  assert.match(webhookSrc, /selectionExit = \{ enabled: false, errors: 1, reason: 'unexpected_error', criticalFailure: true \}/);
  // cron の宣言を足していない
  assert.equal(/export const config[\s\S]*schedule/.test(webhookSrc), false, 'webhook に schedule を足している');
});

test('【KI/KMA 影響 0】選別 list 以外の id は絶対に返さない', async () => {
  const seen = [];
  const client = createSelectionExitClient({
    apiKey: 'seed',
    fetchImpl: async (url, init) => {
      seen.push(`${(init && init.method) || 'GET'} ${String(url).split('?')[0]}`);
      return {
        status: 200,
        json: async () => ({
          result: [
            { id: 'ki-1', name: 'keiba-intelligence' },
            { id: 'nankan-1', name: 'nankan-analytics' },
            { id: 'ak-1', name: listNameFor(1) },
            { id: 'ak-3', name: listNameFor(3) },
          ],
        }),
      };
    },
  });
  const ids = await client.selectionListIds();
  assert.deepEqual(ids, ['ak-1', 'ak-3'], 'AK 以外の list を掴んでいる');
  assert.deepEqual(seen, ['GET https://api.sendgrid.com/v3/marketing/lists']);
});

test('【KI/KMA 影響 0】触る API は list 取得・contact 検索・list からの除去・継続 list への追加だけ', () => {
  const src = readFileSync(fileURLToPath(new URL('./sendgridSelectionExit.js', import.meta.url)), 'utf8');
  const paths = [...src.matchAll(/'(\/v3\/[^']+)'/g)].map((m) => m[1].split('?')[0]);
  const uniq = [...new Set(paths)].sort();
  /**
   * 2026-09-19 に 1 つだけ増えた: `PUT /v3/marketing/contacts`。
   * **反応した人を継続配信の list へ渡す**ためだけに使う（止めて終わりにしない）。
   * contact を作る API と同じ口だが、渡す list は継続 list 1 本に限る。
   */
  assert.deepEqual(uniq, [
    '/v3/marketing/contacts', '/v3/marketing/contacts/search/emails', '/v3/marketing/lists',
  ]);
  // DELETE は list の members に対してだけ（テンプレート文字列側）
  assert.match(src, /\/v3\/marketing\/lists\/\$\{encodeURIComponent\(listId\)\}\/contacts\?contact_ids=/);
  // PUT は継続 list への追加 1 か所だけ
  assert.equal((src.match(/call\('PUT'/g) || []).length, 1);
  assert.match(src, /list_ids: \[String\(listId\)\]/);
  // 送信・予約・suppression 操作の経路を持たない
  for (const bad of ['/v3/mail/send', '/v3/marketing/singlesends', 'PATCH', '/suppression']) {
    assert.equal(src.includes(bad), false, `${bad} を持っている`);
  }
});

test('継続 list が無ければ何もしない（webhook が list を作らない）', async () => {
  const { applySelectionExit: apply } = await import('./sendgridSelectionExit.js');
  const client = {
    async selectionListIds() { return ['ak-1']; },
    async contactIdsChecked() { return { byEmail: new Map([['a@example.test', 'c1']]), lookupFailed: false }; },
    async removeFromList() { return { status: 200, removed: 1 }; },
    async continuationListId() { return null; },
    async addToContinuation() { throw new Error('作ってはいけない'); },
  };
  const out = await apply({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }], client, env: {},
  });
  assert.equal(out.continuation.skipped, 'continuation_list_not_found');
  assert.equal(out.continuation.入れた件数, 0);
});

test('反応した人は継続 list へ渡す（外してから入れる）', async () => {
  const { applySelectionExit: apply } = await import('./sendgridSelectionExit.js');
  const order = [];
  const client = {
    async selectionListIds() { return ['ak-1']; },
    async contactIdsChecked() { return { byEmail: new Map([['a@example.test', 'c1']]), lookupFailed: false }; },
    async removeFromList() { order.push('remove'); return { status: 200, removed: 1 }; },
    async continuationListId() { return 'cont-1'; },
    async addToContinuation({ listId, emails }) {
      order.push('add');
      assert.equal(listId, 'cont-1');
      assert.deepEqual(emails, ['a@example.test']);
      return { status: 202, added: 1 };
    },
  };
  const out = await apply({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }], client, env: {},
  });
  assert.deepEqual(order, ['remove', 'add'], '入れてから外している');
  assert.equal(out.continuation.入れた件数, 1);
});

test('止めた人・配り終えた人は継続 list へ渡さない', async () => {
  const { applySelectionExit: apply } = await import('./sendgridSelectionExit.js');
  const client = {
    async selectionListIds() { return ['ak-1']; },
    async contactIdsChecked() { return { byEmail: new Map([['b@example.test', 'c2']]), lookupFailed: false }; },
    async removeFromList() { return { status: 200, removed: 1 }; },
    async continuationListId() { return 'cont-1'; },
    async addToContinuation() { throw new Error('渡してはいけない'); },
  };
  const out = await apply({
    changes: [
      { email: 'b@example.test', state: PROSPECT_STATE.SUPPRESSED },
      { email: 'c@example.test', state: PROSPECT_STATE.EXHAUSTED },
    ],
    client,
    env: {},
  });
  assert.equal(out.continuation.対象, 0);
});

// ── 失敗を握り潰さない（ENGAGED / PROMOTED）─────────────────────────
test('反応者（ENGAGED / PROMOTED）の除去失敗は握り潰さない', async () => {
  assert.deepEqual(CRITICAL_EXIT_STATES, ['ENGAGED', 'PROMOTED']);
  for (const opts of [{ failRemove: true }, { failListFetch: true }, { lookupFails: true }, { throwOn: 'remove' }]) {
    // eslint-disable-next-line no-await-in-loop -- 4 パターン
    const out = await applySelectionExit({
      changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }],
      client: fakeClient(opts), env: {},
    });
    assert.equal(out.criticalFailure, true, `${JSON.stringify(opts)} で失敗が握り潰された`);
  }
});

test('抑止（SUPPRESSED / EXHAUSTED）だけの失敗は再送を求めない（suppression が独立して効く）', async () => {
  const out = await applySelectionExit({
    changes: [
      { email: 'b@example.test', state: PROSPECT_STATE.SUPPRESSED },
      { email: 'c@example.test', state: PROSPECT_STATE.EXHAUSTED },
    ],
    client: fakeClient({ failRemove: true }), env: {},
  });
  assert.equal(out.criticalFailure, false);
  assert.ok(out.errors > 0, '失敗自体は数えている');
});

test('一時失敗は同じ呼び出しの中で retry して成功する', async () => {
  const client = fakeClient({ failTimes: 1 });   // 1 回だけ 500
  const out = await applySelectionExit({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }],
    client, env: {},
  });
  assert.equal(out.criticalFailure, false, '再試行で成功すべき');
  assert.ok(client.calls.remove.length > 3, `retry されていない: ${client.calls.remove.length}`);
  assert.ok(REMOVE_ATTEMPTS >= 2);
});

test('SendGrid 未設定でも反応者が居れば失敗として扱う', async () => {
  const out = await applySelectionExit({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }], client: null, env: {},
  });
  assert.equal(out.criticalFailure, true);
});

test('未投入（contact が見つからない）は失敗ではない', async () => {
  const client = {
    async selectionListIds() { return ['l1']; },
    async contactIdsChecked() { return { byEmail: new Map(), lookupFailed: false }; },
    async removeFromList() { return { status: 202, removed: 0 }; },
  };
  const out = await applySelectionExit({
    changes: [{ email: 'a@example.test', state: PROSPECT_STATE.ENGAGED }], client, env: {},
  });
  assert.equal(out.criticalFailure, false);
  assert.equal(out.reason, 'contacts_not_found');
});

// ── 再送（duplicate webhook）で二重に数えない ───────────────────────
test('同じイベントが再送されても 1 回しか処理しない（delivered を二重に数えない）', async () => {
  const store = new Map();
  const redisCmd = async (args) => {
    const [op, key, , nx] = args;
    if (op !== 'SET') throw new Error('unsupported');
    if (String(nx).toUpperCase() === 'NX' && store.has(key)) return null;
    store.set(key, '1');
    return 'OK';
  };
  const once = createEventOnceStore({ redisCmd });
  const events = [
    { email: 'a@example.test', event: 'delivered', sg_event_id: 'sg-evt-00000001' },
    { email: 'b@example.test', event: 'open', sg_event_id: 'sg-evt-00000002' },
  ];
  const first = await once.filterUnseen(events);
  assert.equal(first.events.length, 2);
  assert.equal(first.seen, 0);
  assert.equal(first.guarded, true);

  const retry = await once.filterUnseen(events);          // SendGrid の再送
  assert.equal(retry.events.length, 0, '再送で同じイベントを処理している');
  assert.equal(retry.seen, 2);
  assert.equal(retry.guarded, true);
});

test('印を付けられないときは再送を要求しない（guarded=false）', async () => {
  const noRedis = createEventOnceStore({});
  const r1 = await noRedis.filterUnseen([{ email: 'a@example.test', event: 'open', sg_event_id: 'sg-evt-00000003' }]);
  assert.equal(r1.guarded, false);
  assert.equal(r1.events.length, 1, 'Redis が無くても処理は続ける');

  const noId = createEventOnceStore({ redisCmd: async () => 'OK' });
  const r2 = await noId.filterUnseen([{ email: 'a@example.test', event: 'open' }]);  // sg_event_id 無し
  assert.equal(r2.guarded, false);
  assert.equal(r2.events.length, 1);

  const broken = createEventOnceStore({ redisCmd: async () => { throw new Error('down'); } });
  const r3 = await broken.filterUnseen([{ email: 'a@example.test', event: 'open', sg_event_id: 'sg-evt-00000004' }]);
  assert.equal(r3.guarded, false);
  assert.equal(r3.errors, 1);
  assert.equal(r3.events.length, 1);
});

test('webhook は「反応者を外せない ＋ 重複防止あり」のときだけ 503 を返す', () => {
  assert.match(webhookSrc, /const retryForExit = selectionExit\.criticalFailure === true && unseen\.guarded === true/);
  assert.match(webhookSrc, /return jsonResponse\(503, \{ \.\.\.body, retry: 'selection_exit_failed' \}\)/);
  // 再送で二重加算しないよう、prospect 反映は重複除去後のイベントだけ
  assert.match(webhookSrc, /applyProspectEvents\(\{ events: unseen\.events/);
  // 再送の 2 回目でも外せるよう、状態が変わっていなくても対象へ積む
  assert.match(webhookSrc, /if \(r\.prospect\) out\.changes\.push\(\{ email: u\.email, state: r\.prospect\.state \}\)/);
});

test('sg_event_id が無い / 形が違うイベントは重複判定できない（保証を外す）', async () => {
  const once = createEventOnceStore({ redisCmd: async () => 'OK' });
  const r = await once.filterUnseen([
    { email: 'a@example.test', event: 'open', sg_event_id: 'short' },   // 短すぎる
    { email: 'b@example.test', event: 'open' },                          // ID 無し
  ]);
  assert.equal(r.guarded, false);
  assert.equal(r.events.length, 2, '判定できなくても処理は止めない');
});
