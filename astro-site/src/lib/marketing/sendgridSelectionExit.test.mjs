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
  isSelectionExitDisabled, EXIT_STATES, SELECTION_LIST_NAMES, MAX_EXIT_PER_CALL, EXIT_DISABLE_ENV,
} from './sendgridSelectionExit.js';
import { PROSPECT_STATE, classifyEvent } from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { containsEmailLike } from './sendgridNextMessage.js';
import { listNameFor } from './sendgridAutomationPlan.js';

const WEBHOOK = fileURLToPath(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url));
const webhookSrc = readFileSync(WEBHOOK, 'utf8');

/** 選別 list だけを持つ偽 SendGrid */
function fakeClient({ failListFetch = false, failRemove = false, throwOn = null } = {}) {
  const calls = { lists: 0, search: 0, remove: [] };
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
    async removeFromList({ listId, contactIds }) {
      calls.remove.push({ listId, n: contactIds.length });
      if (throwOn === 'remove') throw new Error('boom');
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
  assert.match(webhookSrc, /selectionExit = \{ enabled: false, errors: 1, reason: 'unexpected_error' \}/);
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

test('【KI/KMA 影響 0】触る API は list の取得・contact 検索・list からの除去だけ', () => {
  const src = readFileSync(fileURLToPath(new URL('./sendgridSelectionExit.js', import.meta.url)), 'utf8');
  const paths = [...src.matchAll(/'(\/v3\/[^']+)'/g)].map((m) => m[1].split('?')[0]);
  const uniq = [...new Set(paths)].sort();
  assert.deepEqual(uniq, ['/v3/marketing/contacts/search/emails', '/v3/marketing/lists']);
  // DELETE は list の members に対してだけ（テンプレート文字列側）
  assert.match(src, /\/v3\/marketing\/lists\/\$\{encodeURIComponent\(listId\)\}\/contacts\?contact_ids=/);
  // 送信・contact 作成・suppression 操作の経路を持たない
  for (const bad of ['/v3/mail/send', '/v3/marketing/singlesends', 'PUT', 'PATCH']) {
    assert.equal(src.includes(bad), false, `${bad} を持っている`);
  }
});
