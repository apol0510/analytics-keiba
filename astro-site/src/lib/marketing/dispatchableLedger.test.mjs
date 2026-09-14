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

test('【確定仕様】prospect は送れる（送信側を直したので Airtable の行は要らない）', () => {
  assert.equal(AIRTABLE_ROW_REQUIRED, false, 'prospect へ送れない設定に戻っている');
  for (const mode of Object.values(DELIVERY_STORE)) {
    const policy = resolveRecipientLedgerPolicy({ mode, source: RECIPIENT_SOURCE.PROSPECT });
    assert.equal(policy.writeAirtable, false, `${mode}: prospect が Airtable へ書く設定になっている`);
    assert.equal(canDispatchWithLedger(policy).ok, true, `${mode}: prospect が送れない判定になっている`);
  }
});

test('Customers 由来は従来どおり送れる', () => {
  const policy = resolveRecipientLedgerPolicy({
    mode: DELIVERY_STORE.DUAL, source: RECIPIENT_SOURCE.CUSTOMER,
  });
  assert.equal(policy.writeAirtable, true);
  assert.equal(canDispatchWithLedger(policy).ok, true);
});

test('全員が「積んでよい人」に入る（いまは誰も塞がれない）', () => {
  const items = [
    { email: 'a@example.com', 出所: RECIPIENT_SOURCE.CUSTOMER },
    { email: 'b@example.com', 出所: RECIPIENT_SOURCE.PROSPECT },
    { email: 'c@example.com', 出所: RECIPIENT_SOURCE.PROSPECT },
  ];
  const out = partitionByDispatchable({
    items,
    policyOf: (r) => resolveRecipientLedgerPolicy({ mode: DELIVERY_STORE.DUAL, source: r['出所'] }),
  });
  assert.equal(out.sendable.length, 3);
  assert.equal(out.blocked.length, 0);
});

// ── 栓としての性質は残す（また送れなくなったときに積むのを止められる）──────
test('【重要】旗を立てれば、Airtable に行を作らない相手を積まないように戻せる', async () => {
  // 旗そのものは定数なので、判定関数の契約（writeAirtable=false を塞ぐ）を直接確かめる
  const src = readFileSync(fileURLToPath(new URL('./dispatchableLedger.js', import.meta.url)), 'utf8');
  assert.match(src, /AIRTABLE_ROW_REQUIRED && !writesAirtable/, '旗が判定に効いていない');
  assert.match(src, /LEDGER_DISPATCH_BLOCK\.NO_AIRTABLE_ROW/);
  assert.ok(LEDGER_DISPATCH_BLOCK.NO_AIRTABLE_ROW);
});

test('【重要】真偽値の true 以外は「書く」と読まない（fail closed の向き）', () => {
  const src = readFileSync(fileURLToPath(new URL('./dispatchableLedger.js', import.meta.url)), 'utf8');
  assert.match(src, /policy\.writeAirtable === true/, '緩い真偽判定に戻っている');
});

test('【重要】送信側と計測側は対で動く（片方だけ変えさせない）', () => {
  const src = readFileSync(fileURLToPath(new URL('./dispatchableLedger.js', import.meta.url)), 'utf8');
  assert.match(src, /campaignCustomArgs\.js/);
  assert.match(src, /emailEventLedger\.js/);
  assert.match(src, /prospectDeliveryDescriptor\.js/, '鍵の持ち回し先が書かれていない');
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
