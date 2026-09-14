/**
 * dispatchableLedger.test.mjs — 「送れない置き場所の相手を積まない」
 *   node --test src/lib/marketing/dispatchableLedger.test.mjs
 *
 * ## 何を守るか（2026-09-14 の本番実測）
 *
 * prospect（CSV 取り込み由来）は Airtable に配信行を作らない運用だが、
 * dispatcher は `custom_args` を **Airtable の配信行からしか**作れない。
 * 行が無い相手は必ず `delivery_not_found` で skip される。
 *
 * それでもキューへ積むと、**送れないのに Redis の予約だけが焼かれ**、
 * あとから経路を直しても**その人には二度と届かない**。
 * だから「積む前に止める」ことを機械で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  canDispatchWithLedger, partitionByDispatchable, LEDGER_DISPATCH_BLOCK, AIRTABLE_ROW_REQUIRED,
} from './dispatchableLedger.js';
import { resolveRecipientLedgerPolicy, RECIPIENT_SOURCE, DELIVERY_STORE } from './deliveryKeySource.js';

test('Airtable に行を作る相手は送れる', () => {
  const v = canDispatchWithLedger({ writeAirtable: true });
  assert.equal(v.ok, true);
  assert.equal(v.reason, null);
});

test('【重要】Airtable に行を作らない相手は「送れない」と判定する', () => {
  const v = canDispatchWithLedger({ writeAirtable: false });
  assert.equal(v.ok, false);
  assert.equal(v.reason, LEDGER_DISPATCH_BLOCK.NO_AIRTABLE_ROW);
});

test('壊れた入力は送れない側へ倒す（fail closed）', () => {
  for (const p of [null, undefined, {}, { writeAirtable: 'true' }, 'x']) {
    assert.equal(canDispatchWithLedger(p).ok, false, JSON.stringify(p));
  }
});

test('【重要】prospect は現在の送信経路では送れない（どのモードでも）', () => {
  for (const mode of Object.values(DELIVERY_STORE)) {
    const policy = resolveRecipientLedgerPolicy({ mode, source: RECIPIENT_SOURCE.PROSPECT });
    assert.equal(policy.writeAirtable, false, `${mode}: prospect が Airtable へ書く設定になっている`);
    assert.equal(canDispatchWithLedger(policy).ok, false, `${mode}: prospect が送れる判定になっている`);
  }
});

test('Customers 由来は従来どおり送れる（Airtable へ書くモードのとき）', () => {
  const policy = resolveRecipientLedgerPolicy({
    mode: DELIVERY_STORE.DUAL, source: RECIPIENT_SOURCE.CUSTOMER,
  });
  assert.equal(policy.writeAirtable, true);
  assert.equal(canDispatchWithLedger(policy).ok, true);
});

test('受信者を「積んでよい人」と「積まない人」に分け、理由を数える', () => {
  const items = [
    { email: 'a@example.com', 出所: RECIPIENT_SOURCE.CUSTOMER },
    { email: 'b@example.com', 出所: RECIPIENT_SOURCE.PROSPECT },
    { email: 'c@example.com', 出所: RECIPIENT_SOURCE.PROSPECT },
  ];
  const out = partitionByDispatchable({
    items,
    policyOf: (r) => resolveRecipientLedgerPolicy({ mode: DELIVERY_STORE.DUAL, source: r['出所'] }),
  });
  assert.equal(out.sendable.length, 1);
  assert.equal(out.blocked.length, 2);
  assert.equal(out.blockedByReason[LEDGER_DISPATCH_BLOCK.NO_AIRTABLE_ROW], 2);
});

test('【重要】解禁するときは送信側と計測側を同時に直す（片方だけ変えさせない）', () => {
  const src = readFileSync(fileURLToPath(new URL('./dispatchableLedger.js', import.meta.url)), 'utf8');
  // 旗を false にしたら、なぜ false にしてよいのかが `campaignCustomArgs` 側の変更と
  // 対になっていることを読み手が辿れる状態にしておく
  assert.match(src, /campaignCustomArgs\.js/);
  assert.match(src, /emailEventLedger\.js/);
  // いまは Airtable の行が必須（解禁されていないこと自体を固定する）
  assert.equal(AIRTABLE_ROW_REQUIRED, true);
});

test('キュー登録の cron がこの判定を実際に使っている', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
    'utf8',
  );
  assert.match(src, /canDispatchWithLedger/);
  // 判定を通さずに prospect を claim していないこと（claim は判定のあと）
  const iCheck = src.indexOf('canDispatchWithLedger(');
  const iClaim = src.indexOf('claimDelivered(');
  assert.ok(iCheck > 0 && iClaim > 0, '呼び出しが見つからない');
  assert.ok(iCheck < iClaim, '予約（claim）より後で送信可否を判定している');
});
