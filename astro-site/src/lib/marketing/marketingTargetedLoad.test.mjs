import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  chunkList, isSafeIdentifier, buildRecordIdFormula, buildDeliveryKeyFormula,
  assertFetchComplete, summarizeTargetedFetch, TARGETED_CHUNK,
} from './marketingTargetedLoad.js';

const FN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');

test('chunkList: 空・重複を落として size ごとに割る', () => {
  assert.deepEqual(chunkList([], 2), []);
  assert.deepEqual(chunkList(['a', 'a', 'b', ' ', 'c'], 2), [['a', 'b'], ['c']]);
  assert.equal(chunkList(Array.from({ length: 120 }, (_, i) => `r${i}`)).length,
    Math.ceil(120 / TARGETED_CHUNK));
});

test('isSafeIdentifier: formula へ入れてよい形だけ通す', () => {
  assert.equal(isSafeIdentifier('recABC123'), true);
  assert.equal(isSafeIdentifier("rec'OR 1=1"), false, 'クォートを含む値を通さない');
  assert.equal(isSafeIdentifier(''), false);
  assert.equal(isSafeIdentifier(null), false);
});

test('buildRecordIdFormula: RECORD_ID() の OR を組む / 不正値は落とす', () => {
  assert.equal(buildRecordIdFormula(['recA', 'recB']),
    "OR(RECORD_ID()='recA',RECORD_ID()='recB')");
  assert.equal(buildRecordIdFormula(["rec'X"]), null, '不正値だけなら formula を作らない');
  assert.equal(buildRecordIdFormula([]), null);
});

test('buildDeliveryKeyFormula: campaignType と鍵の AND を組む', () => {
  const f = buildDeliveryKeyFormula({ campaignType: 'dormant-reactivation:v2', keys: ['abc123'] });
  assert.match(f, /^AND\(\{CampaignType\}='dormant-reactivation:v2',OR\(\{DeliveryKey\}='abc123'\)\)$/);
  assert.equal(buildDeliveryKeyFormula({ campaignType: "x'", keys: ['abc'] }), null);
  assert.equal(buildDeliveryKeyFormula({ campaignType: 'x:v1', keys: [] }), null);
});

test('assertFetchComplete: 取り残しがあれば投げる（黙って短い結果を返さない）', () => {
  assert.equal(assertFetchComplete({ table: 'Customers', offset: null, pages: 3, maxPages: 20 }), true);
  assert.throws(
    () => assertFetchComplete({ table: 'Customers', offset: 'itr123', pages: 20, maxPages: 20 }),
    /打ち切られました/,
  );
});

test('summarizeTargetedFetch: 要求したのに引けなかった recordId を数える', () => {
  const r = summarizeTargetedFetch({
    requested: ['recA', 'recB', 'recC'],
    received: [{ id: 'recA' }, { id: 'recC' }],
  });
  assert.equal(r.requested, 3);
  assert.equal(r.received, 2);
  assert.deepEqual(r.missing, ['recB']);
  assert.equal(r.complete, false);
});

// ── 回帰ガード（2026-08-09 の実害）─────────────────────────────
//
// Customers 15,967 件に対し `fetchAll` は MAX_PAGES=40（4,000 件）で **黙って打ち切る**。
// 送信計画がこれを使っていたため、4,000 件目より後ろの顧客が `unknown_customer`
// として静かに除外され、カナリア受信者が実際に落ちた。
// 同じ打ち切りは既送信突合にも効き、配信実績が 4,000 行を超えると
// `already_delivered` を見落として二重送信する。

test('guard: 送信計画は選択対象を名指しで引く（全件走査へ戻さない）', () => {
  assert.match(FN, /async function fetchByRecordIds\(/,
    'recordId 名指し取得の関数が要る');
  assert.match(FN, /loadMarketingForRecordIds\(\{ KEY, BASE, now, recordIds: targetIds \}\)/,
    'handlePlan は名指し取得の結果から byId を作ること');

  const plan = FN.slice(FN.indexOf('const targeted = await loadMarketingForRecordIds'));
  const upToPlanBuild = plan.slice(0, plan.indexOf('buildCampaignPlan'));
  assert.doesNotMatch(upToPlanBuild, /loadCustomerMarketing\(/,
    '選択送信の経路で Customers 全件走査へ戻さない');
});

test('guard: 既送信突合を campaign 単位の全件取得へ戻さない', () => {
  assert.match(FN, /async function fetchDeliveredKeys\(/,
    'DeliveryKey 名指し取得の関数が要る');
  assert.doesNotMatch(
    FN,
    /fetchAll\(\{[^}]*table: DELIVERIES_TABLE,\s*filterByFormula: `AND\(\{CampaignType\}/s,
    'campaign 単位で CampaignDeliveries を全件読む実装は二重送信を許す',
  );
  assert.match(FN, /deliveredKeys = await fetchDeliveredKeys\(/,
    'deliveredKeys は名指し取得から作ること');
});

test('guard: 取得漏れは 502 で止める（unknown_customer として黙って除外しない）', () => {
  assert.match(FN, /summarizeTargetedFetch\(\{ requested: targetIds, received: targeted\.records \}\)/);
  assert.match(FN, /if \(!fetchAudit\.complete\) \{/);
  assert.match(FN, /不完全なまま送信しません/);
});

test('guard: 名指し取得はページ打ち切りを例外にする', () => {
  const calls = FN.match(/assertFetchComplete\(/g) || [];
  assert.ok(calls.length >= 3,
    `名指し取得の各ループが打ち切りを検知すること（現在 ${calls.length} 箇所）`);
});

// ── dispatcher 側も同じ打ち切りに晒されていた ──────────────────
//
// `marketing-campaign-dispatch.js` は Customers を全件走査して
// `unsubscribed` / `suspended` / `fieldsByEmail` を作っていた。40 ページで
// 打ち切られると、後ろの宛先は「配信停止していない」ではなく
// **「確認できていない」まま送信対象になる**（= suppression の取りこぼし）。

const DISPATCH = readFileSync(
  new URL('../../../netlify/functions/marketing-campaign-dispatch.js', import.meta.url), 'utf8',
);

test('guard: dispatcher は宛先ぶんの Customers だけを引く', () => {
  assert.match(DISPATCH, /async function fetchByEmailsReadOnly\(/);
  assert.match(DISPATCH, /fetchCustomersByEmails\(\{ KEY, BASE, emails: jobEmails \}\)/);
  assert.doesNotMatch(DISPATCH, /fetchAll\(\{ KEY, BASE, table: CUSTOMERS_TABLE \}\)/,
    'Customers の全件走査へ戻さない');
});

test('guard: dispatcher の 24h 履歴も宛先ぶんだけ引く', () => {
  assert.match(DISPATCH, /fetchCampaignDeliveriesForEmails\(\{ KEY, BASE, emails: jobEmails \}\)/);
  assert.doesNotMatch(
    DISPATCH,
    /fetchAll\(\{\s*KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `\{EmailType\}='campaign'`,?\s*\}\)/,
    'CampaignDeliveries の全件走査へ戻さない',
  );
});

test('guard: 顧客レコードを引けない宛先には送らない（fail closed）', () => {
  assert.match(DISPATCH, /if \(!fieldsByEmail\.has\(email\)\) \{/);
  assert.match(DISPATCH, /customer_record_missing/);
});
