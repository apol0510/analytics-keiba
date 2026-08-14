/**
 * plusNotifiedStatus.test.mjs — 「販売可なのに未案内」の判定を固定する
 *   node --test src/lib/premiumPlus/plusNotifiedStatus.test.mjs
 *
 * ここで守りたい事故は 2 つ、向きが逆であることに注意する。
 *
 *   A. 送っていないのに「案内済み」と表示する
 *      → 運用者は動かない。その会員は**永久に案内されない**。これが最悪。
 *   B. 送ったのに「未案内」と表示する
 *      → 二重送信を誘発する。
 *
 * どちらも避けるため、読めないときは **どちらでもない「未確認」** に倒す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUS_CAMPAIGN_IDS,
  PLUS_NOTIFIED,
  PLUS_NOTIFIED_LABEL,
  buildPlusDeliveryFormula,
  indexPlusDeliveries,
  describePlusNotified,
  summarizePlusNotified,
  isSafeEmailLiteral,
} from './plusNotifiedStatus.js';

const REC = 'recM7t6T6W3YRgXuA'.replace(/./g, (c, i) => (i < 3 ? c : 'x')); // 形だけの合成 ID
const ID_A = 'recAAAAAAAAAAAAAA';
const ID_B = 'recBBBBBBBBBBBBBB';

const delivery = (over = {}) => ({
  id: 'recDEL0000000001',
  fields: {
    CampaignType: 'premium-plus-offer:v2',
    Status: 'sent',
    SentAt: '2026-08-01T03:00:00.000Z',
    CustomerRecordId: ID_A,
    RecipientEmail: 'a@example.com',
    ...over,
  },
});

// ── formula: 全件走査を作らない / 名指しで引く ───────────────────────
test('対象が空なら formula を作らない（全件走査にしない）', () => {
  assert.equal(buildPlusDeliveryFormula({ recordIds: [], emails: [] }), null);
  assert.equal(buildPlusDeliveryFormula(), null);
});

test('recordId とアドレスの両方で引く（片方だけだと取りこぼす）', () => {
  const f = buildPlusDeliveryFormula({ recordIds: [ID_A], emails: ['A@Example.com'] });
  assert.match(f, /\{CustomerRecordId\}='recAAAAAAAAAAAAAA'/);
  assert.match(f, /LOWER\(\{RecipientEmail\}\)='a@example\.com'/);
  assert.match(f, /^AND\(/);
});

test('CampaignType は前方一致で引く（版が上がっても案内済みが消えない）', () => {
  const f = buildPlusDeliveryFormula({ recordIds: [ID_A] });
  assert.match(f, /FIND\('premium-plus-offer:', \{CampaignType\}\) = 1/);
  assert.ok(!f.includes(':v1'), '特定の版に固定してはいけない');
});

test('危険な識別子・アドレスは formula へ入れない（injection を作らない）', () => {
  const f = buildPlusDeliveryFormula({
    recordIds: ["rec')=1,'"],
    emails: ["x'@example.com", 'ok@example.com'],
  });
  assert.ok(!f.includes("')=1"), 'recordId の injection が通った');
  assert.ok(!f.includes("x'@"), 'アドレスの injection が通った');
  assert.match(f, /'ok@example\.com'/);
});

test('危険な識別子しか無ければ null（無条件の formula を作らない）', () => {
  assert.equal(buildPlusDeliveryFormula({ recordIds: ["rec'x"], emails: ["y'@z.com"] }), null);
});

test('未知の campaignId は使わない', () => {
  assert.equal(buildPlusDeliveryFormula({ recordIds: [ID_A], campaignIds: ["evil') = 1, ("] }), null);
  assert.equal(buildPlusDeliveryFormula({ recordIds: [ID_A], campaignIds: [] }), null);
});

test('isSafeEmailLiteral', () => {
  assert.equal(isSafeEmailLiteral('a@b.co'), true);
  assert.equal(isSafeEmailLiteral("a'@b.co"), false);
  assert.equal(isSafeEmailLiteral(''), false);
  assert.equal(isSafeEmailLiteral('not-an-email'), false);
});

test('PLUS_CAMPAIGN_IDS は campaignCatalog の premium-plus-offer を指す', () => {
  assert.deepEqual([...PLUS_CAMPAIGN_IDS], ['premium-plus-offer']);
});

// ── index: recordId でもアドレスでも引ける ──────────────────────────
test('配信行は recordId とアドレスの両方から引ける', () => {
  const { byRecordId, byEmail } = indexPlusDeliveries([delivery()]);
  assert.equal(byRecordId.get(ID_A).length, 1);
  assert.equal(byEmail.get('a@example.com').length, 1);
});

test('CustomerRecordId が空でもアドレスで拾える（古い配信行の救済）', () => {
  const { byRecordId, byEmail } = indexPlusDeliveries([delivery({ CustomerRecordId: '' })]);
  assert.equal(byRecordId.size, 0);
  assert.equal(byEmail.get('a@example.com').length, 1);
});

test('SentAt が無ければ QueuedAt で代替する', () => {
  const { byRecordId } = indexPlusDeliveries([
    delivery({ SentAt: '', QueuedAt: '2026-08-02T01:00:00.000Z' }),
  ]);
  assert.equal(byRecordId.get(ID_A)[0].atMs, Date.parse('2026-08-02T01:00:00.000Z'));
});

// ── 状態判定 ───────────────────────────────────────────────────
test('読めないときは必ず「未確認」。0 通にしない・要対応にもしない', () => {
  const v = describePlusNotified({ entries: null, available: false, upsellChannel: 'plus' });
  assert.equal(v.state, PLUS_NOTIFIED.UNKNOWN);
  assert.equal(v.label, '未確認');
  assert.equal(v.available, false);
  assert.equal(v.needsAction, false, '読めていないのに要対応と断定してはいけない');
  assert.match(v.note, /0 通という意味ではありません/);
});

test('送信済みが 1 通でもあれば「案内済み」', () => {
  const v = describePlusNotified({ entries: [{ status: 'sent', atMs: 1 }], available: true, upsellChannel: 'plus' });
  assert.equal(v.state, PLUS_NOTIFIED.NOTIFIED);
  assert.equal(v.sentCount, 1);
  assert.equal(v.needsAction, false);
});

test('最後に送った時刻を返す（複数通のときは最新）', () => {
  const a = Date.parse('2026-08-01T00:00:00.000Z');
  const b = Date.parse('2026-08-05T00:00:00.000Z');
  const v = describePlusNotified({
    entries: [{ status: 'sent', atMs: a }, { status: 'sent', atMs: b }],
    available: true,
  });
  assert.equal(v.sentCount, 2);
  assert.equal(v.lastSentAt, new Date(b).toISOString());
});

test('失敗しかないときは「案内済み」にしない（本人へ届いていない）', () => {
  const v = describePlusNotified({ entries: [{ status: 'failed', atMs: 1 }], available: true, upsellChannel: 'plus' });
  assert.equal(v.state, PLUS_NOTIFIED.UNDELIVERED);
  assert.equal(v.sentCount, 0);
  assert.equal(v.failedCount, 1);
  assert.equal(v.needsAction, true);
  assert.match(v.actionNote, /届いていません/);
});

test('1 通も無ければ「未案内」。channel=plus なら要対応', () => {
  const v = describePlusNotified({ entries: [], available: true, upsellChannel: 'plus' });
  assert.equal(v.state, PLUS_NOTIFIED.NEVER);
  assert.equal(v.needsAction, true);
  assert.match(v.actionNote, /気づく経路がありません/);
});

test('channel が plus でなければ未案内でも要対応にしない（売る相手ではない）', () => {
  for (const ch of ['sanrenpuku', 'none', '']) {
    const v = describePlusNotified({ entries: [], available: true, upsellChannel: ch });
    assert.equal(v.state, PLUS_NOTIFIED.NEVER);
    assert.equal(v.needsAction, false, `channel=${ch} で要対応になった`);
    assert.equal(v.actionNote, '');
  }
});

test('queued（送信待ち）は「送った」に数えない', () => {
  const v = describePlusNotified({ entries: [{ status: 'queued', atMs: 1 }], available: true, upsellChannel: 'plus' });
  assert.equal(v.state, PLUS_NOTIFIED.NEVER);
  assert.equal(v.needsAction, true);
});

test('cancelled も「送った」に数えない', () => {
  const v = describePlusNotified({ entries: [{ status: 'cancelled', atMs: 1 }], available: true });
  assert.equal(v.state, PLUS_NOTIFIED.NEVER);
});

test('失敗が混ざっていても送信済みがあれば「案内済み」', () => {
  const v = describePlusNotified({
    entries: [{ status: 'failed', atMs: 1 }, { status: 'sent', atMs: 2 }],
    available: true, upsellChannel: 'plus',
  });
  assert.equal(v.state, PLUS_NOTIFIED.NOTIFIED);
  assert.equal(v.failedCount, 1);
  assert.equal(v.needsAction, false);
});

test('ラベルは 4 状態すべてに用意されている', () => {
  for (const s of Object.values(PLUS_NOTIFIED)) {
    assert.equal(typeof PLUS_NOTIFIED_LABEL[s], 'string');
    assert.ok(PLUS_NOTIFIED_LABEL[s].length > 0, `${s} のラベルが空`);
  }
});

// ── 集計 ──────────────────────────────────────────────────────
test('集計は要対応の人数を出す', () => {
  const rows = [
    { plusNotified: describePlusNotified({ entries: [], available: true, upsellChannel: 'plus' }) },
    { plusNotified: describePlusNotified({ entries: [{ status: 'sent', atMs: 1 }], available: true, upsellChannel: 'plus' }) },
    { plusNotified: describePlusNotified({ entries: [], available: true, upsellChannel: 'none' }) },
  ];
  const s = summarizePlusNotified(rows);
  assert.equal(s.total, 3);
  assert.equal(s.never, 2);
  assert.equal(s.notified, 1);
  assert.equal(s.needsAction, 1);
  assert.match(s.note, /1 名/);
});

test('1 人でも読めなければ集計全体を「未確認あり」にする', () => {
  const rows = [
    { plusNotified: describePlusNotified({ entries: [{ status: 'sent', atMs: 1 }], available: true }) },
    { plusNotified: describePlusNotified({ entries: null, available: false }) },
  ];
  const s = summarizePlusNotified(rows);
  assert.equal(s.available, false);
  assert.equal(s.unknown, 1);
  assert.match(s.note, /0 通という意味ではありません/);
});

// ── 本番で観測した状況をそのまま固定する ─────────────────────────────
test('本番の実測（premium-plus-offer の配信 0 件）を再現すると全員が要対応になる', () => {
  // 販売導線が plus の会員 3 名。CampaignDeliveries には 1 行も無い。
  const { byRecordId, byEmail } = indexPlusDeliveries([]);
  const rows = [ID_A, ID_B, REC].map((id) => ({
    recordId: id,
    plusNotified: describePlusNotified({
      entries: byRecordId.get(id) || byEmail.get(`${id}@example.com`) || [],
      available: true,
      upsellChannel: 'plus',
    }),
  }));
  const s = summarizePlusNotified(rows);
  assert.equal(s.never, 3);
  assert.equal(s.needsAction, 3, '案内 0 件なのに要対応が出ないなら、この機能は無意味');
  for (const r of rows) assert.equal(r.plusNotified.label, '未案内');
});
