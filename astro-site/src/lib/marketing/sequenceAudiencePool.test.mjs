/**
 * sequenceAudiencePool.test.mjs — **prospect が構造的に選ばれない**を直す
 *   node --test src/lib/marketing/sequenceAudiencePool.test.mjs
 *
 * ## なぜ要るか（2026-09-15 の本番実測）
 *
 * `campaign-discount-free` の canary を `sourceFilter=prospect` で 1 tick 回したら、
 * **prospect が 1 人も選ばれなかった**。prospect の step2 due は **11,643 名**居た。
 *
 * 原因は絞り込みを掛ける位置。`planSequenceTick` が先頭 N 人で打ち切った**後**に
 * 絞っていたので、due な Customers が N 人以上先に並んでいると
 * `prospect` 指定は**構造的に 0 件**になる。
 * 同じ理由で、絞り込み無しの**定期配信でも prospect は永久に選ばれない**。
 *
 * ## 固定すること
 *
 *   1. 絞り込みは**計画（打ち切り）より手前**で母集団に掛かる
 *   2. `prospect` 限定なら Customers も出所不明も **0**
 *   3. `all` は出所を**交互**に並べる＝どちらの出所も枯れない
 *   4. 並べ替えは**1 件も足さない・減らさない**（安定）
 *   5. `DeliveryKey` を作り直さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scopeAudiencePool, interleaveBySource } from './sequenceAudiencePool.js';
import { AUDIENCE_FILTER } from './sequenceAudienceFilter.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);

const row = (email) => ({ recordId: `rec-${email}`, fields: { Email: email } });
const P = (n) => row(`p${n}@example.invalid`);
const C = (n) => row(`c${n}@example.invalid`);
const prospectEmails = (rows) => new Set(rows.map((r) => r.fields.Email.toLowerCase()));

test('【重要】prospect 限定なら Customers も出所不明も残らない', () => {
  const ps = [P(1), P(2), P(3)];
  const rows = [C(1), C(2), ...ps, { recordId: 'rec-x', fields: {} }];
  const out = scopeAudiencePool({
    rows, prospectEmails: prospectEmails(ps), filter: AUDIENCE_FILTER.PROSPECT,
  });
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.rows.map((r) => r.fields.Email).sort(), ps.map((r) => r.fields.Email).sort());
  assert.equal(out.bySource.customer, 2);
  assert.equal(out.bySource.unknown, 1);
  assert.equal(out.dropped, 3);
});

/**
 * ## これが今回の事故そのもの
 *
 * Customers が上限（50）以上先に並んでいると、**打ち切りの後**で絞る実装では
 * prospect が 0 件になる。**手前**で絞れば 50 人ぶん全部 prospect になる。
 */
test('【重要】Customers が上限を超えて先に並んでいても prospect が取れる', () => {
  const ps = Array.from({ length: 200 }, (_, i) => P(i));
  const rows = [...Array.from({ length: 500 }, (_, i) => C(i)), ...ps];
  const MAX = 50;

  // 旧: 先頭 50 で打ち切ってから絞る → 0 件（事故の再現）
  const oldWay = rows.slice(0, MAX)
    .filter((r) => prospectEmails(ps).has(r.fields.Email.toLowerCase()));
  assert.equal(oldWay.length, 0, '事故が再現しない（前提が変わった）');

  // 新: 先に絞ってから打ち切る → 50 件
  const scoped = scopeAudiencePool({
    rows, prospectEmails: prospectEmails(ps), filter: AUDIENCE_FILTER.PROSPECT,
  });
  assert.equal(scoped.rows.slice(0, MAX).length, 50);
});

test('【重要】all は 1 件も減らさない（従来どおり）', () => {
  const ps = [P(1)];
  const rows = [C(1), C(2), P(1)];
  const out = scopeAudiencePool({ rows, prospectEmails: prospectEmails(ps), filter: AUDIENCE_FILTER.ALL });
  assert.equal(out.rows.length, 3);
  assert.equal(out.dropped, 0);
});

test('【重要】all は出所を交互に並べる（どちらの出所も枯れない）', () => {
  const ps = Array.from({ length: 100 }, (_, i) => P(i));
  const rows = [...Array.from({ length: 500 }, (_, i) => C(i)), ...ps];
  const mixed = interleaveBySource({ rows, prospectEmails: prospectEmails(ps) });
  const head = mixed.slice(0, 50);
  const pin = head.filter((r) => prospectEmails(ps).has(r.fields.Email.toLowerCase())).length;
  assert.ok(pin >= 20, `先頭 50 に prospect が少なすぎる: ${pin}`);
  assert.ok(pin <= 30, `先頭 50 が prospect に偏りすぎ: ${pin}`);
});

test('【重要】並べ替えは 1 件も足さない・減らさない（安定）', () => {
  const ps = [P(1), P(2)];
  const rows = [C(1), P(1), C(2), P(2), C(3)];
  const pe = prospectEmails(ps);
  const a = interleaveBySource({ rows, prospectEmails: pe });
  const b = interleaveBySource({ rows, prospectEmails: pe });
  assert.equal(a.length, rows.length);
  assert.deepEqual(a.map((r) => r.recordId).sort(), rows.map((r) => r.recordId).sort());
  assert.deepEqual(a.map((r) => r.recordId), b.map((r) => r.recordId), '同じ入力で並びが変わる');
  // 出所の中では元の順序を保つ
  const cs = a.filter((r) => !pe.has(r.fields.Email.toLowerCase())).map((r) => r.recordId);
  assert.deepEqual(cs, ['rec-c1@example.invalid', 'rec-c2@example.invalid', 'rec-c3@example.invalid']);
});

test('空の入力でも壊れない', () => {
  assert.deepEqual(scopeAudiencePool({}).rows, []);
  assert.deepEqual(interleaveBySource({}), []);
});

// ══════════════════════════════════════════════════════════════════
//  tick への配線（完成条件）
// ══════════════════════════════════════════════════════════════════

test('【重要】絞り込みは計画より手前で母集団へ掛かる', () => {
  const iScope = CRON.indexOf('scopeAudiencePool({');
  const iPlan = CRON.indexOf('planSequenceTick({');
  assert.ok(iScope > 0, '母集団の絞り込みが無い');
  assert.ok(iPlan > iScope, '絞り込みが計画より後ろにある（打ち切りで prospect が 0 になる）');
});

test('【重要】all のときは交互に並べてから計画する', () => {
  const iMix = CRON.indexOf('interleaveBySource({');
  const iPlan = CRON.indexOf('planSequenceTick({');
  assert.ok(iMix > 0 && iPlan > iMix, '並べ替えが計画より後ろにある');
  assert.match(CRON, /audienceFilter === AUDIENCE_FILTER\.ALL\s*\n?\s*\?\s*interleaveBySource/,
    'all 以外でも並べ替えている（絞り込み済みなら並べ替えは不要）');
});

/**
 * ⚠️ **「読めなかった」を「0 人」と読み替えない。**
 *    prospect を読めていないのに `prospect` 限定を求められたら、
 *    0 件は事実ではなく確認できていないということ。fail closed で止める。
 */
test('【重要】prospect を読めないまま prospect 限定なら止まる', () => {
  assert.match(CRON, /abort: 'prospect_source_unavailable'/, '読めないときに止めていない');
  const iCheck = CRON.indexOf("abort: 'prospect_source_unavailable'");
  const iPlan = CRON.indexOf('planSequenceTick({');
  assert.ok(iCheck > 0 && iCheck < iPlan, '判定が計画より後ろにある');
});

test('【重要】0 件の応答に「読めなかった理由」を必ず添える', () => {
  assert.match(CRON, /prospectSkipped: prospectDegraded/, '理由を添えていない');
  assert.match(CRON, /pool: \{ 全体: mergedRows\.length/, '母集団の人数を出していない');
});

test('【重要】DeliveryKey を作り直さない（母集団の操作は鍵に触らない）', () => {
  const raw = readFileSync(fileURLToPath(new URL('./sequenceAudiencePool.js', import.meta.url)), 'utf8');
  // ⚠️ 注意書きに語が出るのは構わない。**コード**が鍵に触っていないことを見る
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['computeCampaignDeliveryKey', 'DeliveryKey', 'sha256', 'createHash']) {
    assert.equal(code.includes(banned), false, `母集団の単一源が鍵に触っている: ${banned}`);
  }
});

/**
 * DRM は `runSequenceTick` へ**必ず `entryAllowlist` を渡す**ので、
 * 最終集合は planner の recordId 部分集合に縛られる。
 * recordId を持たない prospect は構造的に外れる＝並び順を変えても audience は壊れない。
 */
test('【重要】DRM の audience を壊さない（許可リストが最終集合を縛る）', () => {
  const drm = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/cron-drm-autostart.js', import.meta.url)), 'utf8');
  assert.match(drm, /entryAllowlist: allowlist/, 'DRM が許可リストを渡さなくなった');
  assert.match(CRON, /assertWithinAllowlist\(\{ targets, allowlist \}\)/, '許可リストの最終確認が消えている');
});
