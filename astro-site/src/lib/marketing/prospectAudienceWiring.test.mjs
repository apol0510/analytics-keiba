/**
 * prospectAudienceWiring.test.mjs — **移行しても 8/31 の 2 通目が届き、
 * Airtable の行が 1 行も増えない**ことを固定する
 *   node --test src/lib/marketing/prospectAudienceWiring.test.mjs
 *
 * 守る条件:
 *   1. prospect プールから受信対象を作れる（移した瞬間に配信が止まらない）
 *   2. 索引・台帳を**読めなかったら中止**（0 件と混同しない）
 *   3. 台帳の書き分けで **prospect の行は Airtable に 1 つも作られない**
 *   4. cron と admin の両方が**その書き分けを実際に通っている**（guard）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  loadActiveProspects, loadProspectSequenceInputs, tagRecipientSources, AUDIENCE_FAIL,
} from './prospectAudienceSource.js';
import { buildProspect, applySend, applyDelivered } from './prospectPolicy.js';
import { emailHash } from './prospectStore.js';
import { buildSequenceProgress, SEQ_STATUS } from './sequenceProgress.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { buildDeliveryRecords } from './campaignSend.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import { partitionRecipientsForLedger, RECIPIENT_SOURCE } from './deliveryKeySource.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 31);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const BATCH = 'imp-2026-08-09-001';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 5,
  subject: `件名${n}`, preheader: `プリヘッダー${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
});
const CAMPAIGN = Object.freeze({
  campaignId: 'wiring-test', version: 1, name: '配線検証',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true,
  sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

const keyFor = (email, n) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** step1 を送って届いた prospect */
function sent(email, atMs = NOW - 6 * DAY) {
  let p = buildProspect({ email, nowMs: atMs, batchId: BATCH, source: 'csv' });
  p.hash = emailHash(email);
  p = applySend({ prospect: p, nowMs: atMs, runId: 'run1' });
  p = applyDelivered({ prospect: p, nowMs: atMs }).prospect;
  return p;
}

const EMAILS = ['p1@example.com', 'p2@example.com', 'p3@example.com'];

/** 索引と本体を持つだけの fake store */
function fakeStore(prospects, { indexThrows = false, loadThrows = false } = {}) {
  const byHash = new Map(prospects.map((p) => [p.hash, p]));
  return {
    async activeHashes() {
      if (indexThrows) throw new Error('index down');
      return [...byHash.keys()];
    },
    async loadMany(hashes) {
      if (loadThrows) throw new Error('load down');
      return hashes.map((h) => byHash.get(h)).filter(Boolean);
    },
  };
}
function fakeLedger(keys, { throws = false } = {}) {
  const set = new Set(keys);
  return {
    async filterDelivered({ keys: want }) {
      if (throws) throw new Error('ledger down');
      return want.filter((k) => set.has(k));
    },
  };
}

/* ── 1. prospect から受信対象を作れる ─────────────────────────── */

test('prospect プールから 8/31 の step2 対象を作れる（Customers が 0 件でも）', async () => {
  const prospects = EMAILS.map((e) => sent(e));
  const inputs = await loadProspectSequenceInputs({
    store: fakeStore(prospects), deliveryKeyStore: fakeLedger(EMAILS.map((e) => keyFor(e, 1))),
    campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  });
  assert.equal(inputs.ok, true);
  assert.equal(inputs.rows.length, 3);
  assert.equal(inputs.deliveries.length, 3, '既送信 step1 が台帳から復元されている');

  const progress = buildSequenceProgress({
    campaign: CAMPAIGN, selected: inputs.rows, deliveries: inputs.deliveries,
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: inputs.providerSuppressed, softBounced: new Set(),
    engagementByEmail: inputs.engagementByEmail,
  });
  assert.equal(progress.summary.due, 3);
  assert.equal(progress.summary.dueByStep[2], 3, '2 通目が対象になっている');
});

test('プールが空でも中止しない（0 件は事実）', async () => {
  const inputs = await loadProspectSequenceInputs({
    store: fakeStore([]), deliveryKeyStore: fakeLedger([]),
    campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  });
  assert.equal(inputs.ok, true);
  assert.equal(inputs.rows.length, 0);
});

/* ── 2. 読めなかったら中止（fail closed）───────────────────────── */

test('⚠️ 索引を読めなければ中止する（対象 0 人で 2 通目が黙って止まるのを防ぐ）', async () => {
  const inputs = await loadProspectSequenceInputs({
    store: fakeStore(EMAILS.map((e) => sent(e)), { indexThrows: true }),
    deliveryKeyStore: fakeLedger([]),
    campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  });
  assert.equal(inputs.ok, false);
  assert.equal(inputs.reason, AUDIENCE_FAIL.INDEX_UNAVAILABLE);
});

test('⚠️ 本体を読めなければ部分結果を返さない', async () => {
  const r = await loadActiveProspects({ store: fakeStore(EMAILS.map((e) => sent(e)), { loadThrows: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, AUDIENCE_FAIL.LOAD_FAILED);
  assert.deepEqual(r.prospects, []);
});

test('⚠️ 台帳を読めなければ中止する（全員へ再送するのを防ぐ）', async () => {
  const inputs = await loadProspectSequenceInputs({
    store: fakeStore(EMAILS.map((e) => sent(e))),
    deliveryKeyStore: fakeLedger([], { throws: true }),
    campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  });
  assert.equal(inputs.ok, false);
  assert.equal(inputs.reason, AUDIENCE_FAIL.LEDGER_UNAVAILABLE);
});

/* ── 3. Airtable の行が増えない ───────────────────────────────── */

test('⚠️ 8/31 の 2 通目: prospect の配信行は Airtable に 1 つも作られない', () => {
  const recipients = tagRecipientSources({
    recipients: [
      { email: 'p1@example.com', deliveryKey: keyFor('p1@example.com', 2), recordId: 'prospect:h1' },
      { email: 'p2@example.com', deliveryKey: keyFor('p2@example.com', 2), recordId: 'prospect:h2' },
      { email: 'c1@example.com', deliveryKey: keyFor('c1@example.com', 2), recordId: 'rec1' },
    ],
    prospectEmails: new Set(['p1@example.com', 'p2@example.com']),
  });
  const airtableRecipients = recipients.filter((r) => r['出所'] !== RECIPIENT_SOURCE.PROSPECT);
  const rows = buildDeliveryRecords({
    campaign: resolveSequenceStep(CAMPAIGN, 2), recipients: airtableRecipients,
    jobIdByEmail: new Map(), nowMs: NOW,
  });
  assert.equal(rows.length, 1, 'Airtable へ書くのは customer の 1 件だけ');
  assert.equal(rows[0].fields.RecipientEmail, 'c1@example.com');

  const split = partitionRecipientsForLedger({ mode: 'dual', recipients });
  assert.equal(split.airtableKeys.length, 1);
  assert.equal(split.redisKeys.length, 3, 'Redis へは全員（記録が無いと次回二重送信）');
});

test('出所を書き忘れた受信者は customer 扱い（prospect へ勝手に倒さない）', () => {
  const tagged = tagRecipientSources({ recipients: [{ email: 'x@example.com' }], prospectEmails: new Set() });
  assert.equal(tagged[0]['出所'], 'customer');
});

/* ── 4. 実際にその経路を通っているか（guard）──────────────────── */

const cronSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)), 'utf8');
const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');

test('guard: cron が prospect プールを受信対象に含めている', () => {
  assert.match(cronSrc, /loadProspectSequenceInputs/, 'cron が prospect を読んでいない');
  assert.match(cronSrc, /tagRecipientSources/, 'cron が出所を付けていない');
  assert.match(cronSrc, /partitionRecipientsForLedger/, 'cron が台帳を書き分けていない');
});

test('⚠️ guard: cron が全受信者ぶんの配信行を Airtable へ書いていない', () => {
  assert.doesNotMatch(
    cronSrc,
    /buildDeliveryRecords\(\{\s*campaign: sending, recipients: built\.recipients/,
    'prospect を含む全員ぶんの行を Airtable へ書いている（上限を食い潰す）',
  );
  assert.match(cronSrc, /recipients: airtableRecipients/);
});

test('⚠️ guard: admin の enqueue も prospect を Airtable へ書かない', () => {
  assert.match(adminSrc, /resolveRecipientLedgerPolicy/);
  assert.match(adminSrc, /recipients: airtableRecipients, jobIdByEmail/);
  assert.match(adminSrc, /prospect_ledger_unavailable/, '予約できないときに中止していない');
});

test('⚠️ guard: prospect の冪等性は **queue の前の予約**で確定している', () => {
  // 2026-08-27 恒久修正: 「書いたあと読み戻す」ではなく「書く前に予約する」へ変えた。
  // 後から記録する順序は、記録が落ちた瞬間に未送信へ戻り二重 queue になる。
  assert.match(adminSrc, /claimDelivered\(/);
  assert.match(cronSrc, /claimDelivered\(/);
  assert.match(adminSrc, /releaseProspectClaims\(/);
  assert.match(cronSrc, /releaseClaims\(/);
});

/* ── 検証を索引の窓で分割する（移行後の read-only 確認）──────────── */

import { loadActiveProspects as loadWindow } from './prospectAudienceSource.js';

/** 索引の順序が安定した fake store（窓の検証用） */
function orderedStore(n) {
  const list = Array.from({ length: n }, (_, i) => {
    const p = buildProspect({ email: `w${i}@example.com`, nowMs: NOW, batchId: BATCH, source: 'csv' });
    p.hash = `h${String(i).padStart(4, '0')}`;
    return p;
  });
  const byHash = new Map(list.map((p) => [p.hash, p]));
  return {
    list,
    async activeHashes() { return [...byHash.keys()]; },
    async loadMany(hashes) { return hashes.map((h) => byHash.get(h)).filter(Boolean); },
  };
}

test('窓: offset / limit で分割しても全員をちょうど 1 回ずつ読む', async () => {
  const store = orderedStore(250);
  const seen = new Set();
  let offset = 0;
  let pages = 0;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await loadWindow({ store, offset, maxRecipients: 60 });
    assert.equal(r.ok, true);
    assert.equal(r.indexSize, 250, '索引全体の件数は窓を掛けても変わらない');
    pages += 1;
    for (const p of r.prospects) {
      assert.equal(seen.has(p.email), false, `${p.email} を 2 回読んでいる`);
      seen.add(p.email);
    }
    offset += r.prospects.length;
    if (offset >= r.indexSize) break;
  }
  assert.equal(seen.size, 250, '読み落としがある');
  assert.equal(pages, 5);
});

test('窓: 範囲を超えた offset は 0 件（例外にしない）', async () => {
  const r = await loadWindow({ store: orderedStore(10), offset: 99, maxRecipients: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.prospects.length, 0);
  assert.equal(r.indexSize, 10, '⚠️ 索引が空になったと誤解させない');
});

test('窓: 指定なしなら従来どおり全件', async () => {
  const r = await loadWindow({ store: orderedStore(30) });
  assert.equal(r.prospects.length, 30);
});

test('⚠️ 窓: 索引を読めなければ窓に関係なく中止する', async () => {
  const store = orderedStore(10);
  store.activeHashes = async () => { throw new Error('down'); };
  const r = await loadWindow({ store, offset: 0, maxRecipients: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, AUDIENCE_FAIL.INDEX_UNAVAILABLE);
});

test('窓: loadProspectSequenceInputs も indexSize を全体として返す', async () => {
  const store = orderedStore(120);
  const keys = store.list.map((p) => keyFor(p.email, 1));
  const inputs = await loadProspectSequenceInputs({
    store, deliveryKeyStore: fakeLedger(keys),
    campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, nowMs: NOW,
    offset: 100, maxRecipients: 50,
  });
  assert.equal(inputs.ok, true);
  assert.equal(inputs.indexSize, 120);
  assert.equal(inputs.rows.length, 20, '窓の残りぶんだけ返る');
});

test('⚠️ guard: 検証は窓で分割し、復元を 2 回作らない', () => {
  assert.match(adminSrc, /prospectSequenceCheck/);
  assert.match(adminSrc, /nextOffset/);
  assert.match(adminSrc, /const rowsOnce = buildProspectSequenceRows/,
    '時刻ごとに復元を作り直している（実行時間を使い切る）');
});
