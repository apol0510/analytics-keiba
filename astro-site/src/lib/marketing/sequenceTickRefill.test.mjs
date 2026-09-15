/**
 * sequenceTickRefill.test.mjs — **1 tick の枠を埋める**（逓減の再発防止）
 *   node --test src/lib/marketing/sequenceTickRefill.test.mjs
 *
 * ## なぜ要るか（2026-09-15 本番実測）
 *
 * `MAX_PER_TICK=50` は「計画時に 50 人選ぶ」の意味でしか効いておらず、
 * そのあとの安全条件で削られたぶんが**補充されなかった**。
 *
 * | 時刻 | 対象 | 登録 | 登録済みのため除外 |
 * |---|---|---|---|
 * | 04:30Z | 50 | 20 | 30 |
 * | 04:40Z | 50 | 13 | 37 |
 * | 04:50Z | 50 |  4 | 46 |
 *
 * step2 の due は 1,800 人以上残っているのに 1 tick で 4 人。**送るほど遅くなる**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { refillSendable, DEFAULT_CHUNK, DEFAULT_MAX_SCAN } from './sequenceTickRefill.js';
import { CANDIDATE_SUPPLY } from './sequenceAutomation.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);
const row = (i) => ({ recordId: `rec-${i}`, fields: { Email: `u${i}@example.invalid` } });

/**
 * ## これが事故そのもの
 * 「先頭 50 が全員既登録だが、51 人目以降に未登録が居る」
 */
test('【重要】先頭 50 が全員既登録でも、51 人目以降から補充する', async () => {
  const candidates = Array.from({ length: 500 }, (_, i) => row(i));
  const blocked = new Set(candidates.slice(0, 50).map((r) => r.recordId));
  const out = await refillSendable({
    candidates, maxRecipients: 50, chunkSize: 25,
    isSendable: async (chunk) => chunk.filter((r) => !blocked.has(r.recordId)),
  });
  assert.equal(out.picked.length, 50, '枠が埋まっていない');
  assert.equal(out.picked.some((r) => blocked.has(r.recordId)), false, '既登録を積んでいる');
  assert.equal(out.picked[0].recordId, 'rec-50', '順序が変わっている');
});

test('【重要】上限は絶対に超えない', async () => {
  const candidates = Array.from({ length: 500 }, (_, i) => row(i));
  for (const cap of [1, 7, 50]) {
    const out = await refillSendable({
      candidates, maxRecipients: cap, chunkSize: 100, isSendable: async (c) => c,
    });
    assert.equal(out.picked.length, cap, `上限 ${cap} を超えた/満たない`);
  }
});

test('【重要】積める人が足りなければ、その人数で終わる（水増ししない）', async () => {
  const candidates = Array.from({ length: 30 }, (_, i) => row(i));
  const out = await refillSendable({
    candidates, maxRecipients: 50, isSendable: async (c) => c.slice(0, 1),
  });
  assert.ok(out.picked.length < 50);
  assert.equal(out.exhausted, true, '見切ったのに続きがある扱い');
});

test('【重要】見に行く範囲は有限（無限に探さない）', async () => {
  const candidates = Array.from({ length: 100000 }, (_, i) => row(i));
  let seen = 0;
  const out = await refillSendable({
    candidates, maxRecipients: 50, maxScan: 200, chunkSize: 50,
    isSendable: async (c) => { seen += c.length; return []; },
  });
  assert.equal(out.picked.length, 0);
  assert.ok(seen <= 200, `見すぎている: ${seen}`);
  assert.equal(out.exhausted, false, '見切っていないのに見切った扱い');
});

test('【重要】安全判定は呼び出し側のまま（ここでは何も判定しない）', () => {
  const lib = readFileSync(fileURLToPath(new URL('./sequenceTickRefill.js', import.meta.url)), 'utf8');
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['computeCampaignDeliveryKey', 'DeliveryKey', 'claimDelivered',
    'fetchActiveDeliveryKeys', 'applyAudienceFilter', 'applyEntryAllowlist', 'sendgrid']) {
    assert.equal(code.includes(banned), false, `補充が安全判定を抱えている: ${banned}`);
  }
});

test('順序は入力のまま（並べ替えない）', async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => row(i));
  const out = await refillSendable({
    candidates, maxRecipients: 10, chunkSize: 3, isSendable: async (c) => c,
  });
  assert.deepEqual(out.picked.map((r) => r.recordId), candidates.map((r) => r.recordId));
});

test('空・壊れた入力でも落ちない', async () => {
  assert.deepEqual((await refillSendable({})).picked, []);
  assert.deepEqual((await refillSendable({ candidates: [], maxRecipients: 5 })).picked, []);
  assert.deepEqual((await refillSendable({ candidates: [row(1)], maxRecipients: 0, isSendable: async (c) => c })).picked, []);
  assert.equal(DEFAULT_CHUNK > 0, true);
});

// ══════════════════════════════════════════════════════════════════
//  tick への配線
// ══════════════════════════════════════════════════════════════════

test('【重要】tick は候補を上限より多く持ち、補充してから積む', () => {
  assert.match(CRON, /plan\.candidateIds/, '候補を多めに受け取っていない');
  assert.match(CRON, /refillSendable\(\{/, '補充していない');
  const iRefill = CRON.indexOf('refillSendable({');
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iRefill > 0 && iRefill < iClaim, '補充が予約より後ろにある');
});

test('【重要】補充は安全条件を迂回しない（順序もそのまま）', () => {
  const i = CRON.indexOf('isSendable: async (chunk)');
  assert.ok(i > 0, '補充の判定が無い');
  const body = CRON.slice(i, i + 1600);
  const iActive = body.indexOf('fetchActiveDeliveryKeys({');
  const iFilter = body.indexOf('applyAudienceFilter({');
  const iAllow = body.indexOf('applyEntryAllowlist({');
  assert.ok(iActive > 0 && iFilter > iActive && iAllow > iFilter,
    '既登録除外 → 出所フィルタ → 許可リスト の順になっていない');
  // 台帳を読めなければ積まない
  assert.match(body, /if \(active === null\) \{ ledgerFailed = true; return \[\]; \}/,
    '台帳を読めないときに積んでしまう');
});

test('【重要】上限は plan.recipients（= MAX_PER_TICK）を使う', () => {
  assert.match(CRON, /const cap = Number\.isInteger\(plan\.recipients\)/, '上限の出どころが変わっている');
  assert.match(CRON, /maxRecipients: cap,/, '補充へ上限を渡していない');
});

test('【重要】枠を空けたことを黙らない（補充の実績をログへ）', () => {
  assert.match(CRON, /summary\['補充'\]/, '補充の実績を残していない');
  assert.match(CRON, /summary\['台帳走査'\]/, '走査の周回を残していない');
});

// ══════════════════════════════════════════════════════════════════
//  候補の供給範囲と探索上限を一致させる（2026-09-15 追補）
// ══════════════════════════════════════════════════════════════════

/**
 * ## なぜ要るか
 *
 * 補充は「見に行ける上限」まで探せる。ところが**候補の供給**がそれより少ないと、
 * 上限まで探す前に候補が尽きて後続へ到達できない。
 *
 * 当初の実装は 供給 = `maxRecipients × 10` = **500**、探索上限 = **1,000** だった。
 * 「先頭 500 が全部既登録で、501 人目以降に未登録が居る」場合、
 * **501 人目以降へ永久に届かない**。
 */
test('【重要】候補の供給範囲は補充の探索上限と一致する', () => {
  assert.equal(CANDIDATE_SUPPLY, DEFAULT_MAX_SCAN,
    `供給 ${CANDIDATE_SUPPLY} と探索上限 ${DEFAULT_MAX_SCAN} が食い違っている`);
});

test('【重要】先頭 500 が全員既登録でも、501 人目以降から補充する', async () => {
  const candidates = Array.from({ length: CANDIDATE_SUPPLY }, (_, i) => row(i));
  const blocked = new Set(candidates.slice(0, 500).map((r) => r.recordId));
  const out = await refillSendable({
    candidates, maxRecipients: 50, chunkSize: DEFAULT_CHUNK,
    isSendable: async (chunk) => chunk.filter((r) => !blocked.has(r.recordId)),
  });
  assert.equal(out.picked.length, 50, '501 人目以降へ到達できていない');
  assert.equal(out.picked[0].recordId, 'rec-500', '順序が変わっている');
  assert.equal(out.picked.some((r) => blocked.has(r.recordId)), false, '既登録を積んでいる');
});

test('【重要】探索上限に達したら有限で止まる（その先は次の tick へ）', async () => {
  // 供給ぶん全部が既登録 → 1 人も積めないが、見た数は上限を超えない
  const candidates = Array.from({ length: CANDIDATE_SUPPLY * 3 }, (_, i) => row(i));
  let seen = 0;
  const out = await refillSendable({
    candidates, maxRecipients: 50, chunkSize: DEFAULT_CHUNK, maxScan: DEFAULT_MAX_SCAN,
    isSendable: async (c) => { seen += c.length; return []; },
  });
  assert.equal(out.picked.length, 0);
  assert.equal(seen, DEFAULT_MAX_SCAN, `探索上限どおりに止まっていない: ${seen}`);
  assert.equal(out.exhausted, false, '見切っていないのに見切った扱い');
});

test('【重要】探索上限の中に 50 人未満しか居なければ、その人数だけ', async () => {
  const candidates = Array.from({ length: CANDIDATE_SUPPLY }, (_, i) => row(i));
  const sendable = new Set(candidates.slice(0, 7).map((r) => r.recordId));
  const out = await refillSendable({
    candidates, maxRecipients: 50, chunkSize: DEFAULT_CHUNK,
    isSendable: async (chunk) => chunk.filter((r) => sendable.has(r.recordId)),
  });
  assert.equal(out.picked.length, 7, '居ない人を水増ししている');
});

test('【重要】供給が上限まであっても MAX_PER_TICK は超えない', async () => {
  const candidates = Array.from({ length: CANDIDATE_SUPPLY }, (_, i) => row(i));
  const out = await refillSendable({
    candidates, maxRecipients: 50, chunkSize: DEFAULT_CHUNK, isSendable: async (c) => c,
  });
  assert.equal(out.picked.length, 50);
  assert.ok(out.scanned <= DEFAULT_MAX_SCAN);
});

test('【重要】planner の供給は定数を直書きしない（単一源から取る）', () => {
  const auto = readFileSync(fileURLToPath(new URL('./sequenceAutomation.js', import.meta.url)), 'utf8');
  assert.match(auto, /export const CANDIDATE_SUPPLY = REFILL_MAX_SCAN;/, '供給が単一源から来ていない');
  assert.match(auto, /const candidateIds = next\.recordIds\.slice\(0, CANDIDATE_SUPPLY\)/,
    '供給の切り方が変わっている');
  assert.equal(/maxRecipients \* CANDIDATE_OVERSELECT/.test(auto), false, '旧実装（倍率）に戻っている');
});
