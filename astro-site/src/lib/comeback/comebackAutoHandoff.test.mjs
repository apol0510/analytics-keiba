/**
 * comebackAutoHandoff.test.mjs — 付与成功者を**自動で**メール工程へ渡す
 *   node --test src/lib/comeback/comebackAutoHandoff.test.mjs
 *
 * ── 何を守るか ────────────────────────────────────────────────
 * 付与のあと、運用者に operationId を探させない。かつ、自動化したせいで
 *   ・付与に失敗した人へ「付与しました」と案内する
 *   ・過去の操作や別の操作の人が混ざる
 *   ・同じ相手へ二重にキュー登録・送信する
 * が起きないこと。対象は**毎回サーバーが operationId から再導出**し、
 * ブラウザは人数と offerId しか持たない（アドレス・recordId は持たない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_TTL_MS, HANDOFF_STORAGE_KEY, HANDOFF_BLOCK,
  collectGrantedRecipients, buildHandoffTicket, validateHandoffResolution,
  pickLatestGrantOperation, saveHandoff, loadHandoff, markHandoffQueued,
  describeHandoff, handoffNote,
} from './comebackEmailHandoff.js';
import { recommendCampaignForGrant, buildGrantOffersFromKinds } from './comebackGrantCampaign.js';
import { getComebackPolicyByOfferId } from '../entitlements/comebackPolicy.js';

const NOW = Date.UTC(2026, 7, 4, 3, 37, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const OP = 'cb-light-30d-free-TESTOP-newer';
const OLD_OP = 'cb-light-lifetime-free-TESTOP-older';

/** 付与に成功した行（Light 30 日） */
const granted = (id, op = OP, at = NOW - 60000) => ({
  recordId: id,
  fields: {
    Email: `${id}@example.com`,
    LightGrantUntil: iso(at + 30 * DAY),
    LightGrantedAt: iso(at),
    LightGrantOp: op,
  },
});
/** 付与できなかった行（フィールドが 1 つも書かれていない） */
const notGranted = (id) => ({ recordId: id, fields: { Email: `${id}@example.com` } });

/** sessionStorage 互換のダミー */
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

// ── 成功者だけを引き継ぐ ────────────────────────────────────────

test('付与に成功した人だけを引き継ぐ（失敗者は構造的に入らない）', () => {
  const records = [granted('r1'), granted('r2'), notGranted('r3'), notGranted('r4')];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds.sort(), ['r1', 'r2']);
  assert.equal(r.byTier.light, 2);
});

test('別の操作 ID の人は混ざらない（既存 28 名や過去操作を巻き込まない）', () => {
  const records = [granted('r1'), granted('old1', OLD_OP, NOW - 20 * 3600000)];
  assert.deepEqual(collectGrantedRecipients({ records, operationId: OP, nowMs: NOW }).recordIds, ['r1']);
  assert.deepEqual(collectGrantedRecipients({ records, operationId: OLD_OP, nowMs: NOW }).recordIds, ['old1']);
});

test('取り消した付与は引き継がない', () => {
  const revoked = granted('r1');
  revoked.fields.LightGrantRevokedAt = iso(NOW);
  assert.deepEqual(collectGrantedRecipients({ records: [revoked], operationId: OP, nowMs: NOW }).recordIds, []);
});

// ── 引き継ぎ票（ブラウザが持つもの）────────────────────────────

test('票に個人情報を載せない（人数と offerId だけ）', () => {
  const ticket = buildHandoffTicket({
    operationId: OP, grantedCount: 36, selectedCount: 37, skippedCount: 1,
    skippedDetail: [{ reason: 'duplicate_email', label: '同一メールアドレス', count: 1 }],
    grantOffers: { light: 'light-30d-free' }, nowMs: NOW,
  });
  const s = memStorage();
  assert.equal(saveHandoff(s, ticket), true);
  const raw = s._dump()[HANDOFF_STORAGE_KEY];
  for (const b of ['@example.com', 'recA', '氏名', 'RecipientEmail']) {
    assert.equal(raw.includes(b), false, `${b} が保存されている`);
  }
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), [
    'expiresAtMs', 'grantOffers', 'grantedCount', 'issuedAtMs',
    'notGrantedCount', 'notGrantedReasons', 'operationId', 'queuedJobIds',
  ]);
  assert.equal(saved.grantedCount, 36);
  assert.equal(saved.notGrantedCount, 1);
});

test('1 人も付与できていなければ引き継がせない', () => {
  const t = buildHandoffTicket({ operationId: OP, grantedCount: 0, nowMs: NOW });
  assert.equal(t.canHandoff, false);
  assert.equal(t.blockReason, HANDOFF_BLOCK.NO_RECIPIENTS);
});

test('画面表示に operationId を出さない', () => {
  const text = describeHandoff({ operationId: OP, grantedCount: 36, expiresAtMs: NOW + 3600000 }, NOW);
  assert.equal(text.includes(OP), false, '内部 ID が画面に出る');
  assert.match(text, /36 名/);
  assert.match(text, /期限/);
});

// ── 改ざん・期限切れ・再読込 ────────────────────────────────────

test('票を書き換えても対象は増えない（正本はサーバー側の再導出）', () => {
  const records = [granted('r1'), granted('r2'), notGranted('r3')];
  const s = memStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, grantOffers: { light: 'light-30d-free' }, nowMs: NOW }));
  // 人数を 999 に改ざんしても…
  const tampered = JSON.parse(s._dump()[HANDOFF_STORAGE_KEY]);
  tampered.grantedCount = 999;
  s.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(tampered));
  // …サーバーは operationId から数え直すので 2 名のまま
  assert.equal(collectGrantedRecipients({ records, operationId: OP, nowMs: NOW }).recordIds.length, 2);
});

test('別の operationId へ書き換えても、その操作の成功者しか出ない', () => {
  const records = [granted('r1'), granted('old1', OLD_OP, NOW - 20 * 3600000)];
  const v = collectGrantedRecipients({ records, operationId: OLD_OP, nowMs: NOW });
  assert.deepEqual(v.recordIds, ['old1'], '書き換えた ID の対象が正しく限定されない');
});

test('期限はサーバーが付与時刻から測る（保存値を信用しない）', () => {
  const records = [granted('r1', OP, NOW - 25 * 3600000)];   // 25 時間前の付与
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  const v = validateHandoffResolution({
    operationId: OP, recordIds: r.recordIds, latestGrantedAtMs: r.latestGrantedAtMs, nowMs: NOW,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.EXPIRED);
});

test('保存側の期限切れも読み出しで弾く', () => {
  const s = memStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 36, nowMs: NOW - HANDOFF_TTL_MS - 1000 }));
  const r = loadHandoff(s, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, HANDOFF_BLOCK.EXPIRED);
});

test('壊れた票は malformed で弾く', () => {
  const s = memStorage();
  s.setItem(HANDOFF_STORAGE_KEY, '{ not json');
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.MALFORMED);
  s.setItem(HANDOFF_STORAGE_KEY, JSON.stringify({ grantedCount: 5 }));
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.MALFORMED);
});

test('同じタブの再読み込みでは復元できる', () => {
  const s = memStorage();
  saveHandoff(s, buildHandoffTicket({
    operationId: OP, grantedCount: 36, grantOffers: { light: 'light-30d-free' }, nowMs: NOW,
  }));
  const r = loadHandoff(s, NOW + 5 * 60000);
  assert.equal(r.ok, true);
  assert.equal(r.handoff.operationId, OP);
  assert.equal(r.handoff.grantedCount, 36);
  assert.equal(r.handoff.grantOffers.light, 'light-30d-free');
});

// ── 二重キュー登録の防止 ────────────────────────────────────────

test('一度キュー登録した引き継ぎは使い切り（二重登録・二重送信を防ぐ）', () => {
  const s = memStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 36, nowMs: NOW }));
  assert.equal(loadHandoff(s, NOW).ok, true);
  markHandoffQueued(s, ['mkt-comeback-light-30d-granted-v2-abcd-1']);
  const again = loadHandoff(s, NOW);
  assert.equal(again.ok, false);
  assert.equal(again.reason, HANDOFF_BLOCK.ALREADY_QUEUED);
});

test('監査用の印にアドレスを入れない', () => {
  assert.equal(handoffNote(OP), `handoff:${OP}`);
  assert.equal(handoffNote(''), '');
});

// ── キャンペーンの自動選択 ──────────────────────────────────────

test('付与内容から案内キャンペーンを自動で決める', () => {
  const rec = recommendCampaignForGrant({ light: 'light-30d-free', premium: null });
  assert.equal(rec.campaignId, 'comeback-light-30d-granted');
  assert.equal(rec.reason, null);
  // 施策の宣言と一致していること（campaignId は宣言から来る）
  assert.equal(getComebackPolicyByOfferId('light-30d-free').campaignId, rec.campaignId);
  assert.equal(getComebackPolicyByOfferId('light-30d-free').campaignVersion, 2);
});

test('実データの付与種別から offerId を逆引きして自動選択できる', () => {
  const kinds = { light: { count: 36, lifetime: false, durationDays: 30 }, premium: null };
  const offers = buildGrantOffersFromKinds(kinds);
  assert.equal(offers.light, 'light-30d-free');
  assert.equal(recommendCampaignForGrant(offers).campaignId, 'comeback-light-30d-granted');
});

test('対応文面が無い付与は自動選択しない（違う案内を送らない）', () => {
  assert.equal(recommendCampaignForGrant({ light: 'light-lifetime-free' }).campaignId, null);
  assert.equal(recommendCampaignForGrant({ light: 'light-30d-free', premium: 'premium-30d-free' }).campaignId, null);
  assert.equal(recommendCampaignForGrant({}).campaignId, null);
});

// ── 直近の付与操作を 1 クリックで復元 ──────────────────────────

test('直近の付与操作を実データから特定する（入力なし）', () => {
  const records = [
    granted('old1', OLD_OP, NOW - 5 * 3600000),
    granted('r1', OP, NOW - 60000),
    granted('r2', OP, NOW - 60000),
    notGranted('r3'),
  ];
  const r = pickLatestGrantOperation({ records, nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.operationId, OP, '古い操作を選んでいる');
  assert.equal(r.grantedCount, 2, '付与できなかった人まで数えている');
  assert.equal(r.expiresAtMs, r.latestGrantedAtMs + HANDOFF_TTL_MS);
});

test('直近でも TTL を過ぎていれば復元しない', () => {
  const r = pickLatestGrantOperation({ records: [granted('r1', OP, NOW - 25 * 3600000)], nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, HANDOFF_BLOCK.EXPIRED);
  assert.equal(r.operationId, null, '期限切れでも ID を返している');
});

test('付与が 1 件も無ければ復元しない', () => {
  for (const records of [[], [notGranted('r1')], null]) {
    const r = pickLatestGrantOperation({ records, nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.grantedCount, 0);
  }
});

test('取り消し済みしか無い操作は復元しない', () => {
  const revoked = granted('r1');
  revoked.fields.LightGrantRevokedAt = iso(NOW);
  assert.equal(pickLatestGrantOperation({ records: [revoked], nowMs: NOW }).ok, false);
});

test('付与時刻が読めない行は「直近」の判定に使わない', () => {
  const noAt = granted('r1');
  delete noAt.fields.LightGrantedAt;
  const r = pickLatestGrantOperation({ records: [noAt, granted('r2', OLD_OP, NOW - 3600000)], nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.operationId, OLD_OP);
});
