/**
 * campaignControl.test.mjs — 運営が**止められる**こと、止めたら本当に出ないことを固定する
 *
 * 割引はお金なので、運営が止めたいときに止まらないのが一番まずい。
 * 逆に「確認できないから配る」も同じくらいまずい（止めたはずの割引が出続ける）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveCampaignAllowed, describeCampaignControl, CAMPAIGN_BLOCK } from './campaignControl.js';
import { createCampaignControlStore, isSafeRecordId } from './campaignControlStore.js';
import { describeCampaignForMember, resolveCampaignPricing } from './campaignOffers.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const OK = { available: true, paused: false };
const IN = Date.parse('2026-08-25T03:00:00Z');

// ── 配ってよいかの判定 ──────────────────────────────────────
test('期間内・停止なし・除外なし のときだけ配る', () => {
  assert.equal(resolveCampaignAllowed({ withinWindow: true, control: OK, excluded: false }).allowed, true);
});

test('運営が止めたら配らない', () => {
  const r = resolveCampaignAllowed({ withinWindow: true, control: { available: true, paused: true }, excluded: false });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, CAMPAIGN_BLOCK.PAUSED);
});

test('個別に対象外にした会員には配らない', () => {
  const r = resolveCampaignAllowed({ withinWindow: true, control: OK, excluded: true });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, CAMPAIGN_BLOCK.EXCLUDED);
});

test('停止スイッチを読めないときは配らない（fail closed）', () => {
  const r = resolveCampaignAllowed({ withinWindow: true, control: { available: false }, excluded: false });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, CAMPAIGN_BLOCK.UNKNOWN);
  assert.match(r.note, /確認できない/);
});

test('除外かどうかを判断できないときも配らない', () => {
  const r = resolveCampaignAllowed({ withinWindow: true, control: OK, excluded: null });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, CAMPAIGN_BLOCK.UNKNOWN);
});

test('期間外は配らない', () => {
  assert.equal(resolveCampaignAllowed({ withinWindow: false, control: OK, excluded: false }).reason,
    CAMPAIGN_BLOCK.OUTSIDE_WINDOW);
});

// ── 案内と適用が同じ条件で決まる ────────────────────────────
test('止めたら案内も申込の割引も出ない（片方だけ残らない）', () => {
  const blocked = resolveCampaignAllowed({ withinWindow: true, control: { available: true, paused: true }, excluded: false });
  // 案内
  assert.equal(describeCampaignForMember({ entitlements: {}, nowMs: IN, allowed: blocked }).offers.length, 0);
  // 申込
  assert.equal(resolveCampaignPricing({
    planName: 'Premium', planType: 'Annual', entitlements: {}, nowMs: IN, allowed: blocked,
    registered: true,
  }).applied, false);
});

test('止めていなければ両方出る（塞ぎすぎない）', () => {
  const ok = resolveCampaignAllowed({ withinWindow: true, control: OK, excluded: false });
  assert.ok(describeCampaignForMember({ entitlements: {}, nowMs: IN, allowed: ok }).offers.length > 0);
  assert.equal(resolveCampaignPricing({
    planName: 'Premium', planType: 'Annual', entitlements: {}, nowMs: IN, allowed: ok,
    registered: true,
  }).applied, true);
});

// ── 保存先 ──────────────────────────────────────────────────
function fakeRedis() {
  const store = new Map();
  const hash = new Map();
  return {
    store, hash,
    cmd: async (args) => {
      const [op, ...rest] = args;
      if (op === 'GET') return store.has(rest[0]) ? store.get(rest[0]) : null;
      if (op === 'SET') { store.set(rest[0], rest[1]); return 'OK'; }
      if (op === 'DEL') { store.delete(rest[0]); return 1; }
      if (op === 'HSET') { hash.set(rest[1], rest[2]); return 1; }
      if (op === 'HDEL') { hash.delete(rest[1]); return 1; }
      if (op === 'HGET') return hash.has(rest[1]) ? hash.get(rest[1]) : null;
      if (op === 'HKEYS') return [...hash.keys()];
      return null;
    },
  };
}

test('止める・再開する・対象外にする・戻す が保存される', async () => {
  const r = fakeRedis();
  const s = createCampaignControlStore({ redisCmd: r.cmd });
  assert.deepEqual(await s.readControl(), { available: true, paused: false, reason: '' });

  await s.setPaused({ paused: true, actor: 'MK' });
  assert.equal((await s.readControl()).paused, true);
  await s.setPaused({ paused: false, actor: 'MK' });
  assert.equal((await s.readControl()).paused, false);

  const id = 'recSYNTH000000010';
  assert.equal(await s.isExcluded(id), false);
  await s.setExcluded({ recordId: id, excluded: true, actor: 'MK', reason: 'テスト' });
  assert.equal(await s.isExcluded(id), true);
  assert.deepEqual((await s.listExcluded()).ids, [id]);
  await s.setExcluded({ recordId: id, excluded: false, actor: 'MK' });
  assert.equal(await s.isExcluded(id), false);
});

test('保存先が無い / 読めないときは「止まっていない」と言わない', async () => {
  const off = createCampaignControlStore({ redisCmd: null });
  assert.equal((await off.readControl()).available, false);
  assert.equal(await off.isExcluded('recSYNTH000000010'), null);
  assert.equal((await off.listExcluded()).available, false);

  const broken = createCampaignControlStore({ redisCmd: async () => { throw new Error('down'); } });
  assert.equal((await broken.readControl()).available, false);
  assert.equal(await broken.isExcluded('recSYNTH000000010'), null);
});

test('会員 ID の形が違えば書かない（他の値を鍵にしない）', async () => {
  assert.equal(isSafeRecordId('recSYNTH000000010'), true);
  assert.equal(isSafeRecordId('recSHORT'), false);
  assert.equal(isSafeRecordId('../etc'), false);
  const r = fakeRedis();
  const s = createCampaignControlStore({ redisCmd: r.cmd });
  const out = await s.setExcluded({ recordId: 'bad', excluded: true, actor: 'MK' });
  assert.equal(out.ok, false);
  assert.equal(r.hash.size, 0);
});

// ── 管理画面 ────────────────────────────────────────────────
test('管理画面の状態表示は「確認できない」を隠さない', () => {
  assert.equal(describeCampaignControl({ control: { available: false } }).state, 'unavailable');
  assert.equal(describeCampaignControl({ control: { available: false } }).excludedCountText, '確認できない');
  assert.equal(describeCampaignControl({ control: OK, withinWindow: true, excludedCount: 2 }).state, 'live');
  assert.equal(describeCampaignControl({ control: { available: true, paused: true }, withinWindow: true }).state, 'paused');
  assert.equal(describeCampaignControl({ control: OK, withinWindow: false }).state, 'outside');
});

test('管理 Function は割引額・期間を変更できない（コードが正本）', () => {
  const fn = read('../../../netlify/functions/admin-campaign.js');
  // 変更できるのは停止スイッチと個別除外だけ
  assert.match(fn, /action === 'pause'/);
  assert.match(fn, /action === 'exclude'/);
  assert.ok(!/setOfferPrice|setDiscount|action === 'setAmount'/.test(fn), '金額を変更できる経路がある');
  // Customers を書かない
  assert.ok(!/method: 'PATCH'/.test(fn), 'Customers を書いている');
  // 操作者名は必須
  assert.match(fn, /code: 'missing_actor'/);
  // 認可
  assert.match(fn, /x-admin-secret/);
  assert.match(fn, /return json\(403, \{ error: 'Forbidden' \}\)/);
});

test('管理画面は金額を組み立てない（サーバーの文字列を出すだけ）', () => {
  const page = read('../../pages/admin/campaign.astro');
  assert.match(page, /o\.line/, 'サーバーの文言を使っていない');
  assert.doesNotMatch(page.slice(page.indexOf('<script')), /4,?980|49,?800|78,?000|19,?820/, '金額を直書きしている');
  // 通信断は成功とも失敗とも言わない
  assert.match(page, /書き込まれたか分かりません/);
});
